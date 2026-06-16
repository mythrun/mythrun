// backend/src/session/tiers/lookup-wiring.ts
//
// MYT-72 T9 — the FastThinker world-knowledge lookup wiring, extracted from the
// turn worker's (c8-ignored, real-FT) makeTiers block into a PURE, fully-covered
// function. This builds the lookup portion of `FtToolDeps`:
// search / graph / resolveEntityId / recentNarrative / vet / askerSummary.
//
// SECURITY BOUNDARY (enforced ignorance is STRUCTURAL):
//   - The secret `sd_playbook` is read ONLY through the narrow `LookupVetRepo`
//     surface and captured ONLY inside the `vet` closure. It NEVER appears on the
//     returned object (the `LookupDeps` Pick has no `sdPlaybook` key), so the FT
//     tool layer that spreads this result can never reach the playbook.
//   - The FT-side `TurnWorkerRepo.sessionPreps.getBy` stays `{ftContext}`-only
//     (the MYT-69 split). This module reads the FULL row off the CONCRETE repo —
//     a separate surface, referenced only by the vet — mirroring `StEvalRepo`.

import type { Repo } from '../../repo/index.js'
import type { VoyageEmbedder } from '../../llm/embed.js'
import { createSearchResolvers } from '../../world/retrieval/search.js'
import type { GraphDeps } from '../../world/retrieval/graph.js'
import { runStLookupVet } from '../../llm/st-lookup-vet.js'
import type { WorldFactLookupVet } from '../world-fact-lookup.js'
import type { KnowledgeSkill } from '../world-lookup-config.js'
import type { WorkingSetItem, WorkingSetProposal } from '../working-set/types.js'
import type { FtToolDeps } from './ft-tools.js'

/** Minimal pino-compatible logger surface this module needs (structured warn). */
interface WiringLogger {
  warn: (objOrMsg: Record<string, unknown> | string, msg?: string) => void
}

/** The secret-bearing prep read for the world-lookup ST-vet. Kept on a DEDICATED
 *  narrow surface (mirrors `StEvalRepo`) — NOT the FT-side `{ftContext}`-only
 *  `TurnWorkerRepo.sessionPreps.getBy`. The full `repo.sessionPreps.getBy` row
 *  (incl. `sdPlaybook`) is assignable to this `{ sdPlaybook } | null` shape. */
export interface LookupVetRepo {
  readonly sessionPreps: {
    getBy(campaignId: string, sessionNumber: number): Promise<{ sdPlaybook: string } | null>
  }
}

/** The concrete-repo surface `buildLookupDeps` reads. A `Pick` over `Repo` so the
 *  real `createRepo(pool)` fits with no adapter, and so it stays in lockstep with
 *  the concrete repo. Covers: the search read tx (`transaction`), the graph
 *  binder (`worldRetrieval`), the name→id resolve (`entities`), the
 *  session-number read (`sessions`), and the secret playbook read
 *  (`sessionPreps`, narrowed to the vet's use). */
export type LookupWiringRepo = Pick<
  Repo,
  'transaction' | 'worldRetrieval' | 'entities' | 'sessions' | 'sessionPreps'
>

export interface LookupWiringDeps {
  readonly repo: LookupWiringRepo
  /** The boot-probed, shared Voyage embedder — NOT the raw key (per-turn embedder
   *  construction would silently degrade on a transient key blip the boot probe
   *  caught; §6). */
  readonly embedder: VoyageEmbedder
  readonly logger: WiringLogger
}

export interface LookupWiringArgs {
  /** The campaign's world id, scoping every lore search + entity-name resolution. */
  readonly worldId: string
  /** The campaign id — the vet reads the secret sd_playbook for THIS campaign. */
  readonly campaignId: string
  /** The session id — the vet resolves the session_number off `sessions.getById`. */
  readonly sessionId: string
  /** The recent player-visible narration the ST-vet reasons over. */
  readonly recentNarrative: string
  /** The turn-scoped working-set sink (MYT-73). A lookup whose ST-vet relays or
   *  invents a fact records the VETTED relay text (already secret-free) into the
   *  working set; threaded straight through to `FtToolDeps`. */
  readonly recordInjection: (p: WorkingSetProposal) => void
  /** The per-turn working-set thunk (MYT-73 read-after-write). search_lore loads
   *  the turn's working set and cosine-merges near-query items into the canon
   *  LoreHit[] BEFORE the ST-vet reads the rendered block, so a fact invented
   *  turn 5 is findable turn 9. Threaded straight through to `FtToolDeps`. */
  readonly workingSet: () => Promise<WorkingSetItem[]>
}

/** The lookup portion of `FtToolDeps`. Pinned as a `Pick` so the spread at the
 *  call site provably satisfies `buildFtTools`'s full `FtToolDeps`, and so any
 *  future field added to the lookup surface is caught here. The secret
 *  `sdPlaybook` is deliberately ABSENT (captured inside the vet closure). */
export type LookupDeps = Pick<
  FtToolDeps,
  | 'worldId'
  | 'search'
  | 'graph'
  | 'resolveEntityId'
  | 'recentNarrative'
  | 'vet'
  | 'askerSummary'
  | 'recordInjection'
  | 'workingSet'
  | 'cosine'
>

/**
 * Build the world-knowledge lookup deps for one turn. PURE — no side effects at
 * construction (the closures defer their I/O). The vet closure captures the
 * secret `sdPlaybook`; it never lands on the returned object.
 */
export function buildLookupDeps(deps: LookupWiringDeps, args: LookupWiringArgs): LookupDeps {
  const { repo, embedder, logger } = deps
  const { worldId, campaignId, sessionId, recentNarrative, recordInjection, workingSet } = args

  // SearchLogger.warn widens its first arg to `unknown`; WiringLogger.warn narrows
  // it to `string | Record<string, unknown>`, so it isn't directly assignable
  // (contravariant param). `forwardWarn` normalizes `unknown` onto the union.
  const searchLogger = {
    warn: (obj: unknown, msg?: string): void => {
      forwardWarn(logger, obj, msg)
    },
  }
  // `repo.transaction` already has the exact `Pick<Repo,'transaction'>` signature
  // createSearchResolvers wants (same `TxRepo`/`RollbackSignal`/`TxOpts` types), so
  // a narrow `{ transaction }` view passes with no adapter.
  const search = createSearchResolvers({
    embedder,
    repo: { transaction: repo.transaction },
    logger: searchLogger,
  })
  const graph: GraphDeps = { repo }
  const resolveEntityId = (name: string): Promise<string | null> =>
    repo.entities.findIdByWorldAndNormalizedName(worldId, name)

  // BOUNDARY-CRITICAL: the secret sd_playbook is read ONLY through this dedicated
  // narrow surface (mirrors StEvalRepo), NEVER the FT-side
  // TurnWorkerRepo.sessionPreps.getBy ({ftContext}-only — the MYT-69 split). The
  // concrete `repo.sessionPreps.getBy` returns the full row (incl. sdPlaybook);
  // it's narrowed here and referenced ONLY inside the vet closure, so `sdPlaybook`
  // is captured there and never lands on the returned LookupDeps.
  const lookupVetRepo: LookupVetRepo = {
    sessionPreps: { getBy: (cid, sn) => repo.sessionPreps.getBy(cid, sn) },
  }
  const vet: WorldFactLookupVet = async (vetInput) => {
    const session = await repo.sessions.getById(sessionId)
    const sessionNumber = session?.sessionNumber ?? 0
    const prep =
      sessionNumber > 0 ? await lookupVetRepo.sessionPreps.getBy(campaignId, sessionNumber) : null
    const sdPlaybook = prep?.sdPlaybook ?? '' // the secret is captured HERE, never escapes
    const r = await runStLookupVet({ ...vetInput, sdPlaybook })
    // tier is surfaced out (MYT-73) so recordInjection can stamp the working-set
    // fact with the ST's access level; text/mode stay the vet's authoritative prose.
    return {
      mode: r.result.mode,
      text: r.result.text,
      tier: r.result.tier,
      repairAttempted: r.repairAttempted,
    }
  }

  // The PUBLIC asker-standing summary the gate reads. Public-only by construction
  // — it closes over NO secret state. NPC → the speaking NPC's public name + that
  // they're recalling the topic. DM → a generic-but-useful "a player character
  // recalling {topic}{ via {skill}}" line. (v1 limitation: the DM line is NOT
  // PC-sheet-specific — the asker's mechanical aptitude already flows through the
  // real roll modifier, and secret-aware standing is the ST-vet's job; richer DM
  // public-standing text is a documented follow-up.)
  const askerSummary = (
    channel: 'dm' | 'npc',
    detail: { skill?: KnowledgeSkill; npcName?: string; topic: string },
  ): Promise<string> => {
    if (channel === 'npc') {
      return Promise.resolve(
        `${detail.npcName ?? 'An onlooker'}, recalling what they know of ${detail.topic}.`,
      )
    }
    return Promise.resolve(
      `A player character recalling ${detail.topic}${detail.skill ? ` via ${detail.skill}` : ''}.`,
    )
  }

  return {
    worldId,
    search,
    graph,
    resolveEntityId,
    recentNarrative: () => recentNarrative,
    vet,
    askerSummary,
    recordInjection,
    // MYT-73 read-after-write: the per-turn working-set thunk + the pure cosine
    // ranker the search_lore closure uses to merge near-query working-set items
    // into the canon LoreHit[] (against searchLore's SAME queryVec).
    workingSet,
    cosine: cosineSimilarity,
  }
}

/** Cosine similarity of two equal-length numeric vectors, in [-1, 1]. Defensive:
 *  an empty vector, a mismatched length, or a zero-magnitude vector → 0 (no
 *  divide-by-zero, no NaN). MYT-73 ranks working-set embeddings against the
 *  searchLore query vector with this — no second Voyage call. */
export function cosineSimilarity(a: readonly number[], b: readonly number[]): number {
  if (a.length === 0 || a.length !== b.length) return 0
  let dot = 0
  let normA = 0
  let normB = 0
  for (let i = 0; i < a.length; i++) {
    // The `?? 0` arms satisfy noUncheckedIndexedAccess only: `i` is always in
    // bounds (loop bound is a.length, lengths are equal), so the fallback is
    // unreachable. c8-ignore the dead nullish arms.
    /* c8 ignore next 2 -- in-bounds index; the ?? 0 fallback is unreachable */
    const x = a[i] ?? 0
    const y = b[i] ?? 0
    dot += x * y
    normA += x * x
    normB += y * y
  }
  if (normA === 0 || normB === 0) return 0
  return dot / (Math.sqrt(normA) * Math.sqrt(normB))
}

/** Forward a `SearchLogger.warn(obj: unknown, msg?)` onto a worker logger whose
 *  first arg is the narrower `string | Record<string, unknown>`. search.ts only
 *  ever warns with an object payload ({ err, worldId }) — the reachable path,
 *  covered by the searchLore-failure test. The string/wrap arms are a defensive
 *  bridge for the wider `unknown` contract and are never reached through the real
 *  resolvers, so they're c8-ignored. Free-standing so the reachable object arm
 *  carries no coverage-tracked branch. */
function forwardWarn(logger: WiringLogger, obj: unknown, msg?: string): void {
  // The reachable arm (object payload) is asserted by the searchLore-failure
  // test; the null / string / wrap arms are a defensive bridge for the wider
  // `unknown` contract that search.ts never exercises (it always passes a non-null
  // object). c8-ignore the unreachable branch arms wholesale — the function itself
  // is still invoked (function coverage holds) and the object path is asserted.
  /* c8 ignore start -- defensive normalizer; search.ts always passes a non-null object */
  if (typeof obj !== 'object' || obj === null) {
    logger.warn(typeof obj === 'string' ? obj : { value: obj }, msg)
    return
  }
  /* c8 ignore stop */
  logger.warn({ ...obj }, msg)
}
