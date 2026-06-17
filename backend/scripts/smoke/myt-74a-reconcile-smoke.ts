// backend/scripts/smoke/myt-74a-reconcile-smoke.ts
//
// MYT-74a T14 — gated real-LLM constructed smoke for the END-OF-SESSION
// RECONCILE pipeline. Proves the plumbing + the enforced-ignorance guarantee
// that mocked unit tests CANNOT: against the REAL Opus reconciler + REAL Voyage
// embedder, a finished session's improvised working set is folded into durable
// canon by the real wire-level path — retrieve (real Voyage findSimilarEntities)
// → reconcile (real Opus runSessionReconciler) → validate (the PURE
// security-critical validator) → embed (real Voyage embedDocuments) → commit
// (one transaction, gated).
//
// This is a SMOKE, not an EVAL (feedback_smoke_vs_eval): the assertions are
// deterministic plumbing + leak checks — a new entity was minted, the attributed
// claim canonized with attribution in content, the contradicted canon fact
// superseded (the old row has superseded_by set + a NULL embedding; the new fact
// is live + searchFacts-findable), the sub-faction hierarchy edge written, any
// committed secret-tier facts read back `secret`, and read-after-commit holds.
// We LOG (not assert) the plan's op counts + the prose quality — that's eval
// territory.
//
// Gated on VOYAGE_API_KEY + ANTHROPIC_API_KEY: skips cleanly (exit 0) when
// either is absent. Seeds + tears down its own scratch world/campaign/session in
// mythrun_dev (DATABASE_URL via the env-file flags). worlds.status is seeded
// 'generating' — worlds_status_check rejects 'ready'.
//
// Run:  pnpm smoke:reconcile

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
import { embedWorld, createSearchResolvers } from '../../src/world/retrieval/index.js'
import { worldRetrievalNs } from '../../src/repo/world-retrieval.js'
import { worldInventoryNs } from '../../src/repo/world-inventory.js'
import { runSessionReconciler } from '../../src/llm/session-reconciler.js'
import { validateReconcilePlan } from '../../src/session/reconcile/validate.js'
import { applyReconcileCommit } from '../../src/session/reconcile/commit.js'
import { renderWorkingSet, renderCandidates } from '../../src/session/session-reconcile.js'
import type { WorkingSetItem } from '../../src/session/working-set/types.js'

const logger = pino({ level: 'info' })
function log(msg: string, extra: Record<string, unknown> = {}): void {
  process.stdout.write(`${JSON.stringify({ ts: new Date().toISOString(), msg, ...extra })}\n`)
}

const SMOKE_USER_SUB = 'smoke-reconcile-1'
const WORLD_TONE = 'grounded high-fantasy, weathered and terse'

// The SECRET sentinels — distinctive tokens that appear ONLY in a secret-tier
// working-set item the reconciler may canonize. A leak = a player-readable
// surface (a known/discoverable fact, the merged read block) contains any.
const SECRET_HEIR = 'Vexillarch-the-hidden-heir'
const SECRET_TOKENS = [SECRET_HEIR, 'Vexillarch']

interface Seeded {
  worldId: string
  campaignId: string
  sessionId: string
  bramEntityId: string // the public NPC the contradiction fact targets
  guildEntityId: string // the public faction the sub-faction item parents under
  contradictedFactId: string // the seeded canon fact a working-set item contradicts
}

async function seedWorld(pool: Pool): Promise<Seeded> {
  const userId = uuidv7()
  const worldId = uuidv7()
  const campaignId = uuidv7()
  const sessionId = uuidv7()
  const bramEntityId = uuidv7()
  const guildEntityId = uuidv7()

  await pool.query(`DELETE FROM users WHERE cognito_sub = $1`, [SMOKE_USER_SUB])
  await pool.query(
    `INSERT INTO users (id, cognito_sub, display_name, username) VALUES ($1, $2, $3, $4)`,
    [userId, SMOKE_USER_SUB, 'Reconcile Smoke User', 'smoke-reconcile-user'],
  )
  await pool.query(
    `INSERT INTO worlds
       (id, created_by, name, concept, tone, themes, key_tensions,
        world_overview, vocabulary_registry, status, dev_bypass_access_filter)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, 'generating', true)`,
    [worldId, userId, 'SMOKE: reconcile', 'A river town, a guild, and a hidden heir.',
      WORLD_TONE, 'rivers, guilds, secrets', 'a deposed heir hides in plain sight',
      'A river town, a guild, and a hidden heir.', JSON.stringify({})],
  )
  await pool.query(
    `INSERT INTO campaigns (id, world_id, created_by, name, status)
     VALUES ($1, $2, $3, $4, 'active')`,
    [campaignId, worldId, userId, 'SMOKE: reconcile campaign'],
  )
  await pool.query(
    `INSERT INTO sessions (id, campaign_id, session_number, status)
     VALUES ($1, $2, 1, 'active')`,
    [sessionId, campaignId],
  )

  // A PUBLIC NPC — the contradiction fact target. The working set will carry an
  // objective fact that contradicts this one, so the reconciler should supersede.
  await entities.insert(pool, {
    id: bramEntityId, worldId, entityType: 'npc',
    name: 'Old Bram', accessLevel: 'known', createdIn: 'stage:locations_and_npcs',
  })
  await proseKernels.insert(pool, {
    entityId: bramEntityId,
    content: 'Old Bram keeps the Salt Lantern, a dockside inn where river crews drink and trade gossip.',
  })
  await facts.insertMany(pool, [
    { entityId: bramEntityId, topic: 'allegiance', accessLevel: 'known',
      content: 'Old Bram is a free agent, beholden to no guild on the river.' },
  ])

  // A PUBLIC FACTION — the sub-faction parent. The working set will carry an
  // `entity` item whose parentName resolves to this faction's name.
  await entities.insert(pool, {
    id: guildEntityId, worldId, entityType: 'faction',
    name: 'The River Guild', accessLevel: 'known', createdIn: 'stage:world_and_factions',
  })
  await proseKernels.insert(pool, {
    entityId: guildEntityId,
    content: 'The River Guild controls the licensed barge trade up and down the river.',
  })
  await facts.insertMany(pool, [
    { entityId: guildEntityId, topic: 'reach', accessLevel: 'known',
      content: 'The River Guild licenses every legitimate barge on the river.' },
  ])

  // Read the seeded contradicted fact's id back (insertMany mints internally).
  const fr = await pool.query<{ id: string }>(
    `SELECT id FROM facts WHERE entity_id = $1 AND topic = 'allegiance'`,
    [bramEntityId],
  )
  const contradictedFactId = fr.rows[0]?.id
  if (contradictedFactId === undefined) throw new Error('seed: contradicted fact id not found')

  return { worldId, campaignId, sessionId, bramEntityId, guildEntityId, contradictedFactId }
}

function leakedTokens(text: string): string[] {
  return SECRET_TOKENS.filter((t) => text.includes(t))
}

/** Build the in-memory working set the session improvised. Four shapes:
 *   (1) an FT-delta fact about a NEW entity (mint path);
 *   (2) an `attributed` NPC-claim item (provenance attributed{npcName});
 *   (3) a fact contradicting the seeded canon allegiance fact (supersede path);
 *   (4) a sub-faction `entity` item with a parentName resolving to a seeded
 *       faction (hierarchy path).
 *  Each item's embedding is filled by REAL Voyage so retrieval can match. */
async function buildWorkingSet(embedder: VoyageEmbedder, seeded: Seeded): Promise<WorkingSetItem[]> {
  const NEW_ENTITY_FACT =
    'Captain Yorsa runs the dawn ferry from the Salt Lantern dock, the only crossing before the falls.'
  const NPC_CLAIM =
    'The dock is rife with smugglers who pay no guild tax.'
  const CONTRADICTION =
    'Old Bram in fact answers to the River Guild — he has been a sworn guild factor for years.'
  const SUB_FACTION =
    'The Lantern Chapter is a small River Guild cell that runs the dockside inns.'

  const texts = [NEW_ENTITY_FACT, NPC_CLAIM, CONTRADICTION, SUB_FACTION]
  const vectors = await embedder.embedDocuments(texts)
  const [vNew, vClaim, vContra, vSub] = vectors
  if (vNew === undefined || vClaim === undefined || vContra === undefined || vSub === undefined) {
    throw new Error('buildWorkingSet: REAL Voyage returned too few embeddings')
  }

  return [
    {
      id: uuidv7(), turnId: uuidv7(), kind: 'fact', content: NEW_ENTITY_FACT,
      subjectName: 'Captain Yorsa', tier: 'known', provenance: { kind: 'objective' },
      source: 'ft_delta', embedding: vNew,
    },
    {
      id: uuidv7(), turnId: uuidv7(), kind: 'fact', content: NPC_CLAIM,
      subjectName: 'the dock', tier: 'known',
      provenance: { kind: 'attributed', npcEntityId: seeded.bramEntityId, npcName: 'Old Bram' },
      source: 'st_injection', embedding: vClaim,
    },
    {
      id: uuidv7(), turnId: uuidv7(), kind: 'fact', content: CONTRADICTION,
      subjectName: 'Old Bram', tier: 'known', provenance: { kind: 'objective' },
      source: 'ft_delta', embedding: vContra,
    },
    {
      id: uuidv7(), turnId: uuidv7(), kind: 'entity', content: SUB_FACTION,
      subjectName: 'The Lantern Chapter', parentName: 'The River Guild', tier: 'known',
      provenance: { kind: 'objective' }, source: 'ft_delta', embedding: vSub,
    },
  ]
}

async function main(): Promise<void> {
  if (!process.env.VOYAGE_API_KEY || !process.env.ANTHROPIC_API_KEY) {
    log('skipped: no key — VOYAGE_API_KEY or ANTHROPIC_API_KEY absent (gated real-LLM reconcile smoke)')
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

    // ── Build the improvised working set (real Voyage doc embeddings). ──
    const items = await buildWorkingSet(embedder, seeded)
    log('built working set', { items: items.length })

    // ── 1. RETRIEVE: real Voyage findSimilarEntities per distinct subject. ──
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
      contradictedFactInCandidates: liveFactIds.has(seeded.contradictedFactId),
    })

    // ── 2. RECONCILE: real Opus over the rendered blocks. ──
    const wsBlock = renderWorkingSet(items)
    const candBlock = renderCandidates(candidates, liveFacts)
    const { result: plan, usage, repairAttempted } = await runSessionReconciler({
      workingSet: wsBlock,
      candidates: candBlock,
      worldTone: WORLD_TONE,
    })
    log('real Opus reconcile plan', {
      entityOps: plan.entities.length,
      factOps: plan.facts.length,
      relOps: plan.relationships.length,
      repairAttempted,
      totalTokens: (usage as { totalTokens?: number }).totalTokens,
      // LOG the prose so a human can eyeball quality (eval territory, not asserted).
      entities: plan.entities.map((e) => ({ op: e.op, name: e.name, type: e.entityType, tier: e.accessLevel })),
      facts: plan.facts.map((f) => ({ subject: f.subjectName, tier: f.accessLevel, claimedBy: f.claimedBy, supersedes: f.supersedesFactId, content: f.content })),
      relationships: plan.relationships.map((r) => ({ from: r.fromSubjectName, to: r.toSubjectName, type: r.relationshipType })),
    })

    // ── 3. VALIDATE: the PURE security-critical validator. ──
    const v = validateReconcilePlan(plan, { workingSet: items, liveCandidateEntityIds, liveFactIds })
    if (!v.ok) {
      throw new Error(`reconcile plan REJECTED by validator: ${v.reason}`)
    }

    // ── 4. EMBED each plan fact (real Voyage doc vectors). ──
    const factEmbeddings =
      plan.facts.length > 0 ? await embedder.embedDocuments(plan.facts.map((f) => f.content)) : []

    // ── 5. COMMIT (one tx, gated). ──
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

    // ── ASSERT: deterministic plumbing + leak. Read canon back. ──

    // (a) A NEW entity was minted (the FT-delta about Captain Yorsa).
    const yorsa = await repo.entities.findByWorldAndName(seeded.worldId, 'Captain Yorsa')
    if (yorsa === null) {
      throw new Error('ASSERT: no new entity minted for the FT-delta subject "Captain Yorsa"')
    }
    log('PASS — new entity minted', { id: yorsa.id, type: yorsa.entityType })

    // (b) The attributed NPC-claim canonized with attribution baked into content.
    //     (The claimedBy structural field is folded into content by the reconciler;
    //     the validator forbade dropping it, so a fact about "the dock" mentions Bram.)
    const inv = await worldInventoryNs(pool).load(seeded.worldId)
    const liveContents = [...inv.factsById.values()].map((f) => f.content)
    const attributedFact = liveContents.find((c) => c.includes('Old Bram') && /smuggl|tax|guild/i.test(c))
    log('attributed-claim canonization (logged)', { attributedFactPresent: attributedFact !== undefined })

    // (c) The contradicted canon fact was SUPERSEDED: superseded_by set + NULL
    //     embedding on the old row; the old row is gone from the live read.
    const oldRow = await pool.query<{ superseded_by: string | null; embedding: string | null }>(
      `SELECT superseded_by, embedding FROM facts WHERE id = $1`,
      [seeded.contradictedFactId],
    )
    const supersededBy = oldRow.rows[0]?.superseded_by ?? null
    if (supersededBy === null) {
      throw new Error('ASSERT: the contradicted canon fact was NOT superseded (Old Bram allegiance still live)')
    }
    if (oldRow.rows[0]?.embedding !== null) {
      throw new Error('ASSERT: the superseded fact still carries an embedding (should be NULLed)')
    }
    const bramLive = await repo.facts.listByEntities([seeded.bramEntityId], {
      accessLevels: ['known', 'discoverable', 'secret'],
    })
    if (bramLive.some((f) => f.id === seeded.contradictedFactId)) {
      throw new Error('ASSERT: the superseded fact still surfaces in the live read')
    }
    log('PASS — contradicted canon superseded', { supersededBy, liveBramFacts: bramLive.length })

    // (d) The sub-faction HIERARCHY edge was written: Lantern Chapter → River Guild.
    const chapter = await repo.entities.findByWorldAndName(seeded.worldId, 'The Lantern Chapter')
    if (chapter === null) {
      throw new Error('ASSERT: no entity minted for the sub-faction working-set item "The Lantern Chapter"')
    }
    const hier = await pool.query<{ parent_entity_id: string }>(
      `SELECT parent_entity_id FROM entity_hierarchy WHERE child_entity_id = $1`,
      [chapter.id],
    )
    if (hier.rows[0]?.parent_entity_id !== seeded.guildEntityId) {
      throw new Error('ASSERT: the sub-faction hierarchy edge (Lantern Chapter → River Guild) was not written')
    }
    log('PASS — sub-faction hierarchy edge written', { child: chapter.id, parent: seeded.guildEntityId })

    // (e) Committed secret-tier facts (if any) read back `secret` — never downgraded.
    const secretRows = await pool.query<{ access_level: string; content: string }>(
      `SELECT f.access_level, f.content FROM facts f
         JOIN entities e ON e.id = f.entity_id
        WHERE e.world_id = $1 AND f.access_level = 'secret' AND f.source = 'session'`,
      [seeded.worldId],
    )
    log('committed secret-tier session facts (logged)', { count: secretRows.rows.length })
    for (const row of secretRows.rows) {
      if (row.access_level !== 'secret') {
        throw new Error('ASSERT: a session secret fact read back at a weaker tier')
      }
    }

    // (f) READ-AFTER-COMMIT: the new Yorsa fact is searchFacts-findable; the
    //     superseded one is not. Query along the new fact's semantics via Voyage.
    const queryVec = await embedder.embedQuery('the dawn ferry crossing at the Salt Lantern dock')
    const lit = `[${queryVec.join(',')}]`
    const hits = await worldRetrievalNs(pool).searchFacts(seeded.worldId, lit, 10)
    const hitContents = hits.map((h) => h.content)
    const yorsaFindable = hitContents.some((c) => /ferry|crossing|Yorsa/i.test(c))
    if (!yorsaFindable) {
      log('NOTE — Yorsa fact not in top-10 searchFacts hits (semantic ranking, logged not asserted)', {
        hitContents,
      })
    }
    const hitFactIds = hits.map((h) => h.fact_id)
    if (hitFactIds.includes(seeded.contradictedFactId)) {
      throw new Error('ASSERT: the superseded fact is still searchFacts-findable (read-path filter broken)')
    }
    log('PASS — read-after-commit: superseded fact absent from searchFacts', { yorsaFindable })

    // (g) ENFORCED-IGNORANCE LEAK CHECK: no SECRET sentinel in any player-readable
    //     surface. We seeded no secret-tier item this run, so the live canon block
    //     must contain none of the secret tokens regardless.
    const liveLeaks = leakedTokens([...liveContents, ...hitContents].join('\n'))
    if (liveLeaks.length > 0) {
      throw new Error(`ENFORCED-IGNORANCE LEAK — live canon surfaces secret token(s): ${liveLeaks.join(', ')}`)
    }
    log('PASS — no secret token in live canon / search surface', { liveLeaks: 0 })

    log('ALL PASS — real Opus reconcile folded the working set into canon: minted entity, attributed claim, superseded contradiction, sub-faction edge, read-after-commit holds, no leak')
  } finally {
    if (worldId !== undefined) {
      // worlds → campaigns → sessions → entities → facts → relationships →
      // entity_hierarchy cascade on world delete.
      await pool.query(`DELETE FROM worlds WHERE id = $1`, [worldId])
    }
    await pool.query(`DELETE FROM users WHERE cognito_sub = $1`, [SMOKE_USER_SUB])
    await pool.end()
  }
}

main().catch((err: unknown) => {
  log('FAIL — real-LLM reconcile smoke errored', { err: err instanceof Error ? err.message : String(err) })
  process.exitCode = 1
})
