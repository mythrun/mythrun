// backend/scripts/smoke/myt-73-scribe-smoke.ts
//
// MYT-73 T12 — gated real-LLM constructed smoke for the post-turn SCRIBE
// reconciler. Proves the plumbing + the load-bearing ENFORCED-IGNORANCE
// guarantee that mocked unit tests CANNOT: against the REAL Haiku secret
// tripwire + REAL Opus retcon-author + REAL Voyage embedder, a player-facing
// turn that BREAKS a core secret is caught (breached:true), a secret-preserving
// retcon `Z` is authored that reveals NONE of the secret sentinels, a
// player-less `correction`-kind turn is enqueued carrying that Z, and a `retcon`
// working-set supersede lands. Phase 2 proves FT-delta read-after-write: an
// invented public fact embedded via REAL Voyage is re-found by a semantically
// near search.
//
// This is a SMOKE, not an EVAL (feedback_smoke_vs_eval): the assertions are
// deterministic plumbing + leak checks — breached:true, a non-empty secret-free
// Z, the enqueued correction, the working-set supersede, the read-after-write
// re-find. We LOG (not assert) the tripwire confidence + the retcon prose
// quality — that's eval territory.
//
// Gated on VOYAGE_API_KEY + ANTHROPIC_API_KEY: skips cleanly (exit 0) when
// either is absent. Seeds + tears down its own scratch world/campaign/session in
// mythrun_dev (DATABASE_URL via the env-file flags). Inspected at the WIRE LEVEL
// (the in-process working-set Redis contents, the captured correction payload,
// logs) — the secret sentinel never appears in any player-facing surface.
//
// Run:  pnpm smoke:scribe

import { Pool } from 'pg'
import pino from 'pino'
import { loadEnv } from '../../src/config/env.js'
import { createRepo } from '../../src/repo/index.js'
import { uuidv7 } from '../../src/repo/uuidv7.js'
import { entities } from '../../src/repo/entities.js'
import { proseKernels } from '../../src/repo/prose-kernels.js'
import { facts } from '../../src/repo/facts.js'
import { createVoyageEmbedder, type VoyageEmbedder } from '../../src/llm/embed.js'
import { probeVoyageAtBoot } from '../../src/boot/voyage-probe.js'
import { createSearchResolvers } from '../../src/world/retrieval/index.js'
import { cosineSimilarity } from '../../src/session/tiers/lookup-wiring.js'
import { runSecretTripwire } from '../../src/llm/secret-tripwire.js'
import { runRetconAuthor } from '../../src/llm/retcon-author.js'
import { makeWorkingSetRepo } from '../../src/redis/working-set.js'
import { processScribeJob, type ScribeProcessorDeps } from '../../src/session/scribe-worker.js'
import { WORKING_SET_CAP } from '../../src/session/scribe-config.js'
import type { ScribeJobPayload } from '../../src/session/scribe-queue.js'
import type { TurnJobPayload } from '../../src/session/turn-queue.js'
import type { WorkingSetItem } from '../../src/session/working-set/types.js'

const logger = pino({ level: 'info' })
function log(msg: string, extra: Record<string, unknown> = {}): void {
  process.stdout.write(`${JSON.stringify({ ts: new Date().toISOString(), msg, ...extra })}\n`)
}

const SMOKE_USER_SUB = 'smoke-scribe-1'
const WORLD_TONE = 'grounded high-fantasy, weathered and terse'
const SESSION_NUMBER = 1

// The SECRET sentinels — distinctive tokens that appear ONLY in the sd_playbook
// (and the breaching prose), and must NEVER reach a player-facing surface. A
// leak = the retcon Z / correction payload / working set contains any of these.
const SECRET_HEIR = 'Vexillarch-the-hidden-heir'
const SECRET_CABAL = 'the Obsidian Syndicate'
const SECRET_TOKENS = [SECRET_HEIR, 'Vexillarch', 'Obsidian Syndicate']

// The ST's private playbook (the tripwire + retcon reason over this; the retcon
// must remove the contradiction WITHOUT revealing any of it).
const SD_PLAYBOOK =
  `CORE SECRET: the innkeeper of the Salt Lantern, "Old Bram", is secretly ` +
  `${SECRET_HEIR} — the deposed heir to the river throne, hiding in plain sight. ` +
  `He is bound to ${SECRET_CABAL}, a smuggling cabal. These facts are secret-tier: ` +
  `NEVER reveal the heir's true identity or the Syndicate to players.`

// The Fast Thinker's player-facing prose for this turn — it BREAKS the secret by
// stating the innkeeper's true identity openly (the breach the tripwire catches).
const BREACHING_PROSE =
  `Old Bram sets down the tankard and meets your eyes. "You've guessed it," he says quietly. ` +
  `"I am ${SECRET_HEIR}, the rightful heir to the river throne — and yes, ${SECRET_CABAL} ` +
  `answers to me. Keep your voice down."`

interface Seeded {
  worldId: string
  campaignId: string
  sessionId: string
  smugglerEntityId: string
}

async function seedWorld(pool: Pool): Promise<Seeded> {
  const userId = uuidv7()
  const worldId = uuidv7()
  const campaignId = uuidv7()
  const sessionId = uuidv7()
  const smugglerEntityId = uuidv7()

  await pool.query(`DELETE FROM users WHERE cognito_sub = $1`, [SMOKE_USER_SUB])
  await pool.query(
    `INSERT INTO users (id, cognito_sub, display_name, username) VALUES ($1, $2, $3, $4)`,
    [userId, SMOKE_USER_SUB, 'Scribe Smoke User', 'smoke-scribe-user'],
  )
  await pool.query(
    `INSERT INTO worlds
       (id, created_by, name, concept, tone, themes, key_tensions,
        world_overview, vocabulary_registry, status, dev_bypass_access_filter)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, 'generating', true)`,
    [worldId, userId, 'SMOKE: scribe', 'A river town and a hidden heir.',
      WORLD_TONE, 'rivers, exile, secrets', 'a deposed heir hides in plain sight',
      'A river town and a hidden heir.', JSON.stringify({})],
  )
  await pool.query(
    `INSERT INTO campaigns (id, world_id, created_by, name, status)
     VALUES ($1, $2, $3, $4, 'active')`,
    [campaignId, worldId, userId, 'SMOKE: scribe campaign'],
  )
  await pool.query(
    `INSERT INTO sessions (id, campaign_id, session_number, status)
     VALUES ($1, $2, $3, 'active')`,
    [sessionId, campaignId, SESSION_NUMBER],
  )
  // The prep row carries the SECRET sd_playbook — the Scribe job reads it through
  // its narrow ScribeRepo.sessionPreps.getBy surface.
  await pool.query(
    `INSERT INTO session_preps (id, campaign_id, session_number, ft_context, sd_playbook)
     VALUES ($1, $2, $3, $4, $5)`,
    [uuidv7(), campaignId, SESSION_NUMBER,
      'A weathered river town. The Salt Lantern is a dockside inn run by a man called Old Bram.',
      SD_PLAYBOOK],
  )

  // A PUBLIC entity so phase 2's search has canon to merge beside (the dragon-
  // mountain analogue): a public NPC the FT-delta fact will be about.
  await entities.insert(pool, {
    id: smugglerEntityId, worldId, entityType: 'npc',
    name: 'Old Bram', accessLevel: 'known', createdIn: 'stage:locations_and_npcs',
  })
  await proseKernels.insert(pool, {
    entityId: smugglerEntityId,
    content: 'Old Bram keeps the Salt Lantern, a dockside inn where river crews drink and trade gossip.',
  })
  await facts.insertMany(pool, [
    { entityId: smugglerEntityId, topic: 'reputation', accessLevel: 'known',
      content: 'Old Bram is known up and down the docks as a fair, tight-lipped innkeeper.' },
  ])

  return { worldId, campaignId, sessionId, smugglerEntityId }
}

function leakedTokens(text: string): string[] {
  return SECRET_TOKENS.filter((t) => text.includes(t))
}

/** An in-process working-set sink that round-trips items (the smoke can't reach
 *  a broker; this exercises the SAME WorkingSetRepo shape processScribeJob
 *  depends on). Backed by makeWorkingSetRepo over an in-memory store so the
 *  load/append/evict contract is the real one. */
interface InProcWorkingSet {
  workingSet: ScribeProcessorDeps['workingSet']
  dump: () => Promise<WorkingSetItem[]>
}

function makeInProcWorkingSet(campaignId: string): InProcWorkingSet {
  const store = new Map<string, string[]>()
  // A minimal ioredis-shaped object covering exactly the commands
  // makeWorkingSetRepo uses (lrange / rpush / expire / del). Kept tiny + typed
  // so the smoke needs no broker.
  const fakeRedis = {
    lrange: (key: string) => Promise.resolve([...(store.get(key) ?? [])]),
    rpush: (key: string, ...vals: string[]) => {
      const cur = store.get(key) ?? []
      cur.push(...vals)
      store.set(key, cur)
      return Promise.resolve(cur.length)
    },
    expire: () => Promise.resolve(1),
    del: (key: string) => {
      const had = store.delete(key)
      return Promise.resolve(had ? 1 : 0)
    },
  }
  // The smoke only needs the four commands above; the cast narrows the wide
  // ioredis Redis type to this in-process stand-in.
  const repo = makeWorkingSetRepo(fakeRedis as unknown as Parameters<typeof makeWorkingSetRepo>[0], 'smoke:')
  return {
    workingSet: {
      load: (c) => repo.load(c),
      append: (c, items) => repo.append(c, items),
      evictIfOver: (c, cap) => repo.evictIfOver(c, cap),
    },
    dump: () => repo.load(campaignId),
  }
}

/** Phase 1 — REAL tripwire (Haiku) catches the breach → REAL retcon (Opus)
 *  authors a secret-free Z → a correction turn is enqueued + a retcon supersede
 *  lands. Asserts the deterministic plumbing + the leak guarantee. */
async function phaseBreachRetcon(
  pool: Pool,
  embedder: VoyageEmbedder,
  seeded: Seeded,
): Promise<void> {
  const repo = createRepo(pool)
  const ws = makeInProcWorkingSet(seeded.campaignId)
  const enqueuedTurns: TurnJobPayload[] = []

  const deps: ScribeProcessorDeps = {
    repo: {
      sessions: { getActiveByCampaign: (c) => repo.sessions.getActiveByCampaign(c) },
      sessionPreps: { getBy: (c, n) => repo.sessionPreps.getBy(c, n) },
    },
    triggerState: { getRespondedSeq: () => Promise.resolve(0) },
    workingSet: ws.workingSet,
    embedder,
    runTripwire: runSecretTripwire,
    runRetcon: runRetconAuthor,
    sessionTurnQueue: {
      add: ((_name: string, payload: TurnJobPayload) => {
        enqueuedTurns.push(payload)
        return Promise.resolve({})
      }) as ScribeProcessorDeps['sessionTurnQueue']['add'],
    },
    logger,
  }

  const job: { data: ScribeJobPayload } = {
    data: {
      campaignId: seeded.campaignId,
      sessionId: seeded.sessionId,
      turnId: uuidv7(),
      worldId: seeded.worldId,
      prose: BREACHING_PROSE,
      worldDelta: null,
      injections: [],
    },
  }

  // The real tripwire confidence is interesting (LOG, don't assert). Run the
  // tripwire directly once so we can log its verdict, THEN drive the full job.
  const tw = await runSecretTripwire({ prose: BREACHING_PROSE, secrets: `[SECRET-1] ${SD_PLAYBOOK}` })
  log('phase1: real Haiku tripwire verdict', {
    breached: tw.result.breached,
    confidence: tw.result.confidence,
    secretRef: tw.result.secretRef,
    repairAttempted: tw.repairAttempted,
  })
  if (!tw.result.breached) {
    throw new Error('phase1: real tripwire did NOT flag the breaching prose — the secret check is not firing')
  }

  await processScribeJob(deps, job)

  // ── deterministic plumbing assertions ──
  if (enqueuedTurns.length !== 1) {
    throw new Error(`phase1: expected exactly one enqueued correction turn, got ${String(enqueuedTurns.length)}`)
  }
  const correction = enqueuedTurns[0]
  if (correction?.trigger.kind !== 'correction') {
    throw new Error('phase1: the enqueued turn is not a correction-kind turn')
  }
  const z = correction.correctionText ?? ''
  if (z.trim().length === 0) {
    throw new Error('phase1: the retcon Z (correctionText) is empty — retcon-author plumbing broken')
  }

  const dumped = await ws.dump()
  const retconItem = dumped.find((i) => i.source === 'retcon')
  if (retconItem === undefined) {
    throw new Error('phase1: no retcon supersede landed in the working set')
  }
  if (retconItem.content !== z) {
    throw new Error('phase1: the working-set retcon content does not match the enqueued Z')
  }

  // ── leak guarantee ──
  const zLeaks = leakedTokens(z)
  const wsLeaks = leakedTokens(JSON.stringify(dumped))
  const correctionLeaks = leakedTokens(JSON.stringify(correction))
  log('phase1: drove real tripwire→retcon→correction', {
    retconZ: z,
    supersededContent: retconItem.supersededContent,
    retconSubjectName: retconItem.subjectName,
    zLeaks,
    wsLeaks,
    correctionLeaks,
  })
  if (zLeaks.length > 0) {
    throw new Error(`phase1: ENFORCED-IGNORANCE LEAK — the retcon Z reveals secret token(s) ${zLeaks.join(', ')}: "${z}"`)
  }
  if (wsLeaks.length > 0) {
    throw new Error(`phase1: ENFORCED-IGNORANCE LEAK — the working set contains secret token(s) ${wsLeaks.join(', ')}`)
  }
  if (correctionLeaks.length > 0) {
    throw new Error(`phase1: ENFORCED-IGNORANCE LEAK — the correction payload contains secret token(s) ${correctionLeaks.join(', ')}`)
  }
  log('phase1: PASS — breach caught, secret-free retcon delivered, no leak', { zLeaks: 0, wsLeaks: 0 })
}

/** Phase 2 — FT-delta read-after-write. Append an FT-delta working-set item (a
 *  freshly "invented" PUBLIC fact) embedded via REAL Voyage, then run a real
 *  searchLore query semantically near it and cosine-merge (the SAME logic the
 *  search_lore tool uses) — assert the invented fact is re-found. */
async function phaseReadAfterWrite(
  pool: Pool,
  embedder: VoyageEmbedder,
  seeded: Seeded,
): Promise<void> {
  const repo = createRepo(pool)
  const ws = makeInProcWorkingSet(seeded.campaignId)

  // A freshly invented PUBLIC fact (an FT delta). Distinctive sentinel so the
  // re-find is unambiguous; carries NO secret.
  const INVENTED_FACT = 'Old Bram keeps a green-lacquered river skiff named the Heron moored behind the Salt Lantern.'
  const [vector] = await embedder.embedDocuments([INVENTED_FACT])
  if (vector === undefined || vector.length === 0) {
    throw new Error('phase2: REAL Voyage returned no embedding for the invented fact')
  }
  const ftDelta: WorkingSetItem = {
    id: uuidv7(),
    turnId: uuidv7(),
    kind: 'fact',
    content: INVENTED_FACT,
    subjectName: 'Old Bram',
    tier: 'known',
    provenance: { kind: 'objective' },
    source: 'ft_delta',
    embedding: vector,
  }
  await ws.workingSet.append(seeded.campaignId, [ftDelta])
  await ws.workingSet.evictIfOver(seeded.campaignId, WORKING_SET_CAP)

  // Run a real searchLore over the world for a semantically NEAR query, then
  // cosine-rank the working-set item against the SAME queryVec searchLore
  // embedded (the read-merge the search_lore tool performs — no second Voyage
  // call for the working-set ranking).
  const { searchLore } = createSearchResolvers({ embedder, repo, logger })
  const { hits, queryVec } = await searchLore(seeded.worldId, "Old Bram's boat behind the inn", { limit: 10 })
  const loaded = await ws.dump()
  const score = cosineSimilarity(queryVec, ftDelta.embedding)
  const merged = [
    ...hits.map((h) => `[canon] ${h.entityName}: ${h.content}`),
    // The working-set item merges only above the same small positive floor the
    // tool uses; the near query should clear it comfortably.
    ...loaded.filter((i) => cosineSimilarity(queryVec, i.embedding) >= 0.1).map((i) => `[ws] ${i.content}`),
  ].join('\n')

  log('phase2: read-after-write via real Voyage', {
    canonHits: hits.length,
    wsItemScoreVsQuery: score,
    merged,
  })

  if (!merged.includes(INVENTED_FACT)) {
    throw new Error(`phase2: the FT-delta invented fact was NOT re-found in the merged hits (score ${String(score)}) — read-after-write broken`)
  }
  // The invented fact carries no secret; assert the merged block is clean too.
  const mergeLeaks = leakedTokens(merged)
  if (mergeLeaks.length > 0) {
    throw new Error(`phase2: ENFORCED-IGNORANCE LEAK — the merged block contains secret token(s) ${mergeLeaks.join(', ')}`)
  }
  log('phase2: PASS — invented FT-delta fact re-found via real Voyage read-after-write', { reFound: true })
}

async function main(): Promise<void> {
  if (!process.env.VOYAGE_API_KEY || !process.env.ANTHROPIC_API_KEY) {
    log('skipped: no key — VOYAGE_API_KEY or ANTHROPIC_API_KEY absent (gated real-LLM scribe smoke)')
    return
  }
  const env = loadEnv()
  const pool = new Pool({ connectionString: env.databaseUrl })
  const embedder = createVoyageEmbedder({ apiKey: env.voyageApiKey })
  // Boot-probe Voyage exactly like the worker does — a misconfigured key fails
  // LOUD here rather than surfacing as a confusing mid-smoke embed error.
  await probeVoyageAtBoot(embedder, logger)

  let worldId: string | undefined
  try {
    const seeded = await seedWorld(pool)
    worldId = seeded.worldId
    log('seeded scratch world/campaign/session/prep', { ...seeded })

    await phaseBreachRetcon(pool, embedder, seeded)
    await phaseReadAfterWrite(pool, embedder, seeded)

    log('ALL PASS — real Haiku tripwire caught the breach, real Opus retcon stayed secret-free, real Voyage read-after-write re-found the invented fact')
  } finally {
    if (worldId !== undefined) {
      // worlds → campaigns → sessions → session_preps cascade on world delete.
      await pool.query(`DELETE FROM worlds WHERE id = $1`, [worldId])
    }
    await pool.query(`DELETE FROM users WHERE cognito_sub = $1`, [SMOKE_USER_SUB])
    await pool.end()
  }
}

main().catch((err: unknown) => {
  log('FAIL — real-LLM scribe smoke errored', { err: err instanceof Error ? err.message : String(err) })
  process.exitCode = 1
})
