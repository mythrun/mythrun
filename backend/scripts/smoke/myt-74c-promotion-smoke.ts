// backend/scripts/smoke/myt-74c-promotion-smoke.ts
//
// MYT-74c — gated real-Opus CONSTRUCTED smoke for RECONCILE-TIME TIER PROMOTION
// + the CAMPAIGN WIKI. Proves the plumbing + the enforced-ignorance guarantee
// that mocked unit tests CANNOT: against the REAL Opus reconciler + REAL Voyage
// embedder, a finished session's working set — restating facts the party
// DISCOVERED this session — drives the reconciler to PROMOTE the matched
// discoverable + the first (ST-sanctioned) secret up to `known`, while an
// UNTOUCHED secret stays secret. Then the member-readable campaign wiki reflects
// the promotions and leaks none of the secret.
//
// CONSTRUCTED-STATE (feedback_constructed_state_smoke): the natural smoke can't
// reliably steer the LLM into emitting `promotions`, so we seed canon to
// just-before-the-path (a discoverable fact + two secret facts) and a working set
// whose items RESTATE the discoverable + the first secret (the surfacing the ST
// would have sanctioned), then invoke the real reconciler directly. The
// load-bearing real-LLM proof (step 3) is that the returned plan promotes the
// matched fact ids and ONLY those — the over-promotion guard a mock can't prove.
//
// This is a SMOKE, not an EVAL (feedback_smoke_vs_eval): the assertions are
// deterministic plumbing + leak checks; the plan's op counts + prose are LOGGED,
// not asserted.
//
// Gated on VOYAGE_API_KEY + ANTHROPIC_API_KEY: skips cleanly (exit 0) when either
// is absent (the candidate retrieval needs real Voyage findSimilarEntities, like
// the 74a smoke). Seeds + tears down its own scratch world/campaign/session in
// mythrun_dev (DATABASE_URL via the env-file flags). worlds.status is seeded
// 'generating' — worlds_status_check rejects 'ready'. PG-only (no Redis).
//
// Run:  pnpm smoke:promotion

import { Pool } from 'pg'
import pino from 'pino'
import { loadEnv } from '../../src/config/env.js'
import { createRepo } from '../../src/repo/index.js'
import { uuidv7 } from '../../src/repo/uuidv7.js'
import { entities } from '../../src/repo/entities.js'
import { proseKernels } from '../../src/repo/prose-kernels.js'
import { facts } from '../../src/repo/facts.js'
import { campaignWikiView } from '../../src/repo/campaign-wiki-view.js'
import { createVoyageEmbedder, type VoyageEmbedder } from '../../src/llm/embed.js'
import { probeVoyageAtBoot } from '../../src/boot/voyage-probe.js'
import { embedWorld, createSearchResolvers } from '../../src/world/retrieval/index.js'
import { runSessionReconciler } from '../../src/llm/session-reconciler.js'
import { validateReconcilePlan } from '../../src/session/reconcile/validate.js'
import { applyReconcileCommit } from '../../src/session/reconcile/commit.js'
import { renderWorkingSet, renderCandidates } from '../../src/session/session-reconcile.js'
import type { WorkingSetItem } from '../../src/session/working-set/types.js'

const logger = pino({ level: 'info' })
function log(msg: string, extra: Record<string, unknown> = {}): void {
  process.stdout.write(`${JSON.stringify({ ts: new Date().toISOString(), msg, ...extra })}\n`)
}

const SMOKE_USER_SUB = 'smoke-promotion-1'
const WORLD_TONE = 'grounded high-fantasy, weathered and terse'

// The SECRET sentinel — a distinctive token that appears ONLY in the UNTOUCHED
// secret fact (the one the working set never restates). A leak = a player-readable
// surface (a known fact, the wiki) contains it. The first secret (the one the
// working set DOES surface) carries a different, promotable marker.
const SECRET_UNTOUCHED = 'Umbral-Vault-XYZZY'
const SECRET_TOKENS = [SECRET_UNTOUCHED, 'Umbral-Vault']

interface Seeded {
  worldId: string
  campaignId: string
  sessionId: string
  harbourEntityId: string // the public-ish NPC carrying the discoverable fact
  cabalEntityId: string // the secret faction carrying both secret facts
  discFactId: string // the discoverable canon fact the working set restates
  secret1FactId: string // the first secret fact the working set restates (ST-sanctioned)
  secret2FactId: string // the UNTOUCHED secret fact (carries SECRET_UNTOUCHED)
}

async function seedWorld(pool: Pool): Promise<Seeded> {
  const userId = uuidv7()
  const worldId = uuidv7()
  const campaignId = uuidv7()
  const sessionId = uuidv7()
  const harbourEntityId = uuidv7()
  const cabalEntityId = uuidv7()

  await pool.query(`DELETE FROM users WHERE cognito_sub = $1`, [SMOKE_USER_SUB])
  await pool.query(
    `INSERT INTO users (id, cognito_sub, display_name, username) VALUES ($1, $2, $3, $4)`,
    [userId, SMOKE_USER_SUB, 'Promotion Smoke User', 'smoke-promotion-user'],
  )
  await pool.query(
    `INSERT INTO worlds
       (id, created_by, name, concept, tone, themes, key_tensions,
        world_overview, vocabulary_registry, status, dev_bypass_access_filter)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, 'generating', true)`,
    [worldId, userId, 'SMOKE: promotion', 'A harbour town, a ledger, and a hidden cabal.',
      WORLD_TONE, 'harbours, ledgers, secrets', 'a cabal hides behind the harbour trade',
      'A harbour town, a ledger, and a hidden cabal.',
      JSON.stringify({
        entries: [
          { term: 'the Ledger', definition: 'the harbour record of every ship', source: 'stage_1_5', access_level: 'known' },
          { term: 'the Cabal', definition: 'the hidden ring behind the trade', source: 'stage_1_5', access_level: 'secret' },
        ],
        adjacent_franchises: [],
      })],
  )
  await pool.query(
    `INSERT INTO campaigns (id, world_id, created_by, name, status)
     VALUES ($1, $2, $3, $4, 'active')`,
    [campaignId, worldId, userId, 'SMOKE: promotion campaign'],
  )
  await pool.query(
    `INSERT INTO sessions (id, campaign_id, session_number, status)
     VALUES ($1, $2, 1, 'active')`,
    [sessionId, campaignId],
  )

  // The HARBOURMASTER — a discoverable NPC carrying a discoverable fact the party
  // discovers this session (the working set restates it → promotion target).
  await entities.insert(pool, {
    id: harbourEntityId, worldId, entityType: 'npc',
    name: 'The Harbourmaster', accessLevel: 'discoverable', createdIn: 'stage:locations_and_npcs',
  })
  await proseKernels.insert(pool, {
    entityId: harbourEntityId,
    content: 'The harbourmaster sits in a glass booth above the wharf, watching every hull come and go.',
  })

  // The CABAL — a secret faction carrying TWO secret facts: one the working set
  // surfaces (ST-sanctioned reveal → promotion), one it never touches (must stay
  // secret; it carries the SECRET_UNTOUCHED sentinel).
  await entities.insert(pool, {
    id: cabalEntityId, worldId, entityType: 'faction',
    name: 'The Obsidian Cabal', accessLevel: 'secret', createdIn: 'stage:world_and_factions',
  })
  await proseKernels.insert(pool, {
    entityId: cabalEntityId,
    content: 'The Obsidian Cabal launders its influence through the licensed harbour trade.',
  })

  // discoverable fact (promotion target) + two secret facts.
  await facts.insertMany(pool, [
    { entityId: harbourEntityId, topic: 'role', accessLevel: 'discoverable',
      content: 'The harbourmaster keeps a ledger recording every ship that docks at the wharf.' },
    { entityId: cabalEntityId, topic: 'cover', accessLevel: 'secret',
      content: 'The harbourmaster secretly answers to the Obsidian Cabal and doctors the ledger for them.' },
    { entityId: cabalEntityId, topic: 'vault', accessLevel: 'secret',
      content: `The Cabal's true treasury, the ${SECRET_UNTOUCHED}, lies beneath the old customs house — known to no one in the town.` },
  ])

  // Read the seeded fact ids back (insertMany mints internally).
  const dr = await pool.query<{ id: string }>(
    `SELECT id FROM facts WHERE entity_id = $1 AND topic = 'role'`,
    [harbourEntityId],
  )
  const discFactId = dr.rows[0]?.id
  if (discFactId === undefined) throw new Error('seed: discoverable fact id not found')

  const s1 = await pool.query<{ id: string }>(
    `SELECT id FROM facts WHERE entity_id = $1 AND topic = 'cover'`,
    [cabalEntityId],
  )
  const secret1FactId = s1.rows[0]?.id
  if (secret1FactId === undefined) throw new Error('seed: secret-1 fact id not found')

  const s2 = await pool.query<{ id: string }>(
    `SELECT id FROM facts WHERE entity_id = $1 AND topic = 'vault'`,
    [cabalEntityId],
  )
  const secret2FactId = s2.rows[0]?.id
  if (secret2FactId === undefined) throw new Error('seed: secret-2 fact id not found')

  return {
    worldId, campaignId, sessionId, harbourEntityId, cabalEntityId,
    discFactId, secret1FactId, secret2FactId,
  }
}

function leakedTokens(text: string): string[] {
  return SECRET_TOKENS.filter((t) => text.includes(t))
}

/** Build the working set the session improvised. Two `fact` items that RESTATE
 *  the seeded discoverable fact and the first secret fact (the surfacing the ST
 *  sanctioned), so the reconciler should match them onto canon + promote those
 *  ids. The UNTOUCHED secret is never mentioned. Each item's embedding is filled
 *  by REAL Voyage so retrieval can match the right canon entities. */
async function buildWorkingSet(embedder: VoyageEmbedder): Promise<WorkingSetItem[]> {
  const DISCOVERED_LEDGER =
    'The party confirmed the harbourmaster keeps a ledger of every ship that docks at the wharf.'
  const DISCOVERED_COVER =
    'The party uncovered that the harbourmaster secretly answers to the Obsidian Cabal and doctors the ledger.'

  const texts = [DISCOVERED_LEDGER, DISCOVERED_COVER]
  const vectors = await embedder.embedDocuments(texts)
  const [vLedger, vCover] = vectors
  if (vLedger === undefined || vCover === undefined) {
    throw new Error('buildWorkingSet: REAL Voyage returned too few embeddings')
  }

  return [
    {
      id: uuidv7(), turnId: uuidv7(), kind: 'fact', content: DISCOVERED_LEDGER,
      subjectName: 'The Harbourmaster', tier: 'discoverable', provenance: { kind: 'objective' },
      source: 'ft_delta', embedding: vLedger,
    },
    {
      // The ST-sanctioned secret surfacing: a secret-tier working-set item that
      // restates the first secret fact. The reconciler should promote that fact.
      id: uuidv7(), turnId: uuidv7(), kind: 'fact', content: DISCOVERED_COVER,
      subjectName: 'The Obsidian Cabal', tier: 'secret', provenance: { kind: 'objective' },
      source: 'st_injection', embedding: vCover,
    },
  ]
}

async function main(): Promise<void> {
  if (!process.env.VOYAGE_API_KEY || !process.env.ANTHROPIC_API_KEY) {
    log('skipped: no key — VOYAGE_API_KEY or ANTHROPIC_API_KEY absent (gated real-LLM promotion smoke)')
    return
  }
  const env = loadEnv()
  const pool = new Pool({ connectionString: env.databaseUrl })
  const embedder = createVoyageEmbedder({ apiKey: env.voyageApiKey })
  // Boot-probe Voyage exactly like the worker does — a misconfigured key fails
  // LOUD here rather than surfacing as a confusing mid-smoke embed error.
  await probeVoyageAtBoot(embedder, logger)

  const repo = createRepo(pool)
  let worldId: string | undefined
  try {
    const seeded = await seedWorld(pool)
    worldId = seeded.worldId
    log('seeded scratch world/campaign/session + canon', { ...seeded })

    // Embed the seeded canon (real Voyage) so retrieval + searchFacts can match.
    const embedSummary = await embedWorld({ embedder, repo }, seeded.worldId)
    log('embedWorld complete', { ...embedSummary })
    if (embedSummary.voyageErrors > 0) {
      throw new Error(`embedWorld reported ${String(embedSummary.voyageErrors)} Voyage errors`)
    }

    // ── 1. Build the improvised working set (real Voyage doc embeddings). ──
    const items = await buildWorkingSet(embedder)
    log('built working set', { items: items.length })

    // ── 2. RETRIEVE: real Voyage findSimilarEntities per distinct subject. ──
    const { findSimilarEntities } = createSearchResolvers({
      embedder,
      repo: { transaction: repo.transaction },
      logger: { warn: (obj, m) => { logger.warn({ obj }, m) } },
    })
    const subjects = [...new Set(items.map((i) => i.subjectName))]
    const candidateLists = await Promise.all(
      subjects.map((s) => findSimilarEntities(seeded.worldId, s, { limit: 5 })),
    )
    const seenCandidate = new Set<string>()
    const candidates = candidateLists.flat().filter((c) => {
      if (seenCandidate.has(c.entityId)) return false
      seenCandidate.add(c.entityId)
      return true
    })
    const liveCandidateEntityIds = new Set(candidates.map((c) => c.entityId))
    const liveFacts =
      liveCandidateEntityIds.size === 0
        ? []
        : await repo.facts.listByEntities([...liveCandidateEntityIds], {
            accessLevels: ['known', 'discoverable', 'secret'],
            liveOnly: true,
          })
    const liveFactIds = new Set(liveFacts.map((f) => f.id))
    log('retrieved canon candidates', {
      subjects, candidates: candidates.map((c) => c.name), liveFacts: liveFacts.length,
      discFactInCandidates: liveFactIds.has(seeded.discFactId),
      secret1FactInCandidates: liveFactIds.has(seeded.secret1FactId),
      secret2FactInCandidates: liveFactIds.has(seeded.secret2FactId),
    })

    // ── 3. RECONCILE: real Opus over the rendered blocks. ──
    const wsBlock = renderWorkingSet(items)
    const candBlock = renderCandidates(candidates, liveFacts)
    const { result: plan, usage, repairAttempted } = await runSessionReconciler({
      workingSet: wsBlock,
      candidates: candBlock,
      worldTone: WORLD_TONE,
      sessionId: seeded.sessionId,
    })
    log('real Opus reconcile plan', {
      entityOps: plan.entities.length,
      factOps: plan.facts.length,
      relOps: plan.relationships.length,
      promotionOps: plan.promotions.length,
      repairAttempted,
      totalTokens: (usage as { totalTokens?: number }).totalTokens,
      promotions: plan.promotions,
    })

    // The LOAD-BEARING real-LLM proof: the plan promotes the matched discoverable
    // + the first (surfaced) secret, and NOT the untouched secret.
    if (!plan.promotions.includes(seeded.discFactId)) {
      throw new Error('ASSERT: the reconciler did NOT promote the discovered discoverable fact')
    }
    if (!plan.promotions.includes(seeded.secret1FactId)) {
      throw new Error('ASSERT: the reconciler did NOT promote the ST-surfaced secret fact')
    }
    if (plan.promotions.includes(seeded.secret2FactId)) {
      throw new Error('OVER-PROMOTION: the reconciler promoted the UNTOUCHED secret fact')
    }
    log('PASS — reconciler promoted the matched facts and only those', {
      promotedDiscoverable: true, promotedSurfacedSecret: true, leftUntouchedSecret: true,
    })

    // ── 4. VALIDATE + COMMIT. ──
    const v = validateReconcilePlan(plan, { workingSet: items, liveCandidateEntityIds, liveFactIds })
    if (!v.ok) {
      throw new Error(`reconcile plan REJECTED by validator: ${v.reason}`)
    }
    const factEmbeddings =
      plan.facts.length > 0 ? await embedder.embedDocuments(plan.facts.map((f) => f.content)) : []
    const { committed } = await applyReconcileCommit(repo, {
      plan,
      map: v.map,
      workingSet: items,
      worldId: seeded.worldId,
      sessionId: seeded.sessionId,
      factEmbeddings,
    })
    if (!committed) {
      throw new Error('reconcile commit returned committed:false on a fresh session — the gate misfired')
    }
    log('committed reconcile plan to canon')

    // ── 5. ASSERT canon state: promoted facts + their entities are `known`; the
    //       untouched secret stays `secret`. ──
    const discKnown = await repo.facts.listByEntities([seeded.harbourEntityId], { accessLevels: ['known'] })
    if (!discKnown.some((f) => f.id === seeded.discFactId)) {
      throw new Error('ASSERT: the promoted discoverable fact did not read back `known`')
    }
    const harbour = await repo.entities.findByWorldAndName(seeded.worldId, 'The Harbourmaster')
    if (harbour?.accessLevel !== 'known') {
      throw new Error('ASSERT: the harbourmaster entity did not follow its promoted fact to `known`')
    }

    const cabalKnown = await repo.facts.listByEntities([seeded.cabalEntityId], { accessLevels: ['known'] })
    if (!cabalKnown.some((f) => f.id === seeded.secret1FactId)) {
      throw new Error('ASSERT: the ST-surfaced secret fact did not read back `known`')
    }
    const cabal = await repo.entities.findByWorldAndName(seeded.worldId, 'The Obsidian Cabal')
    if (cabal?.accessLevel !== 'known') {
      throw new Error('ASSERT: the cabal entity did not follow its promoted secret fact to `known`')
    }

    // The UNTOUCHED secret fact stays secret (the over-promotion guard at commit).
    const cabalSecret = await repo.facts.listByEntities([seeded.cabalEntityId], { accessLevels: ['secret'] })
    if (!cabalSecret.some((f) => f.id === seeded.secret2FactId)) {
      throw new Error('OVER-PROMOTION: the untouched secret fact no longer reads back `secret`')
    }
    log('PASS — promoted facts + entities are `known`; the untouched secret stays `secret`', {
      cabalEntityNowKnown: true, untouchedSecretStaysSecret: true,
    })

    // ── 6. WIKI: the member-readable narrow `known` projection. ──
    const wiki = await campaignWikiView.fetch(pool, seeded.worldId)
    const wikiFactIds = wiki.facts.map((f) => f.id)
    const wikiEntityIds = wiki.entities.map((e) => e.id)

    if (!wikiFactIds.includes(seeded.discFactId)) {
      throw new Error('ASSERT: the promoted discoverable fact is absent from the campaign wiki')
    }
    if (!wikiFactIds.includes(seeded.secret1FactId)) {
      throw new Error('ASSERT: the promoted (surfaced) secret fact is absent from the campaign wiki')
    }
    if (wikiFactIds.includes(seeded.secret2FactId)) {
      throw new Error('ENFORCED-IGNORANCE LEAK — the untouched secret fact appears in the campaign wiki')
    }
    if (wikiEntityIds.includes(seeded.cabalEntityId)) {
      // The cabal entity is NOW `known` (it followed its promoted secret fact), so
      // it legitimately appears. Its UNTOUCHED secret fact must NOT. We assert the
      // wiki carries no secret-token prose below; the entity row is name+type only.
      log('NOTE — cabal entity is in the wiki (promoted to known); its untouched secret fact is filtered', {})
    }

    // Narrow projection: no owner `concept`, no prose kernels, no stat blocks.
    if ('concept' in wiki.world) {
      throw new Error('LEAK — the campaign wiki world summary carries the owner `concept`')
    }
    if ('proseKernels' in wiki || 'statBlocks' in wiki) {
      throw new Error('LEAK — the campaign wiki body carries owner-only prose kernels / stat blocks')
    }

    // ENFORCED-IGNORANCE LEAK CHECK: no SECRET sentinel anywhere in the wiki.
    const wikiLeaks = leakedTokens(JSON.stringify(wiki))
    if (wikiLeaks.length > 0) {
      throw new Error(`ENFORCED-IGNORANCE LEAK — the campaign wiki surfaces secret token(s): ${wikiLeaks.join(', ')}`)
    }
    log('PASS — wiki surfaces the promoted facts, excludes the untouched secret, no concept/kernels/statblocks, no leak', {
      wikiFacts: wikiFactIds.length, wikiEntities: wikiEntityIds.length,
    })

    log('ALL PASS — real Opus promoted the discovered facts (and only those); commit flipped them + their entities to known; the untouched secret stayed secret; the campaign wiki reflects the promotions and leaks nothing')
  } finally {
    if (worldId !== undefined) {
      // worlds → campaigns → sessions → entities → facts → relationships →
      // entity_hierarchy cascade on world delete (no characters/participants seeded).
      await pool.query(`DELETE FROM worlds WHERE id = $1`, [worldId])
    }
    await pool.query(`DELETE FROM users WHERE cognito_sub = $1`, [SMOKE_USER_SUB])
    await pool.end()
  }
}

main().catch((err: unknown) => {
  log('FAIL — real-LLM promotion smoke errored', { err: err instanceof Error ? err.message : String(err) })
  process.exitCode = 1
})
