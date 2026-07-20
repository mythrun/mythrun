// backend/src/session/turn-context.ts
//
// MYT-68/§3.10 + MYT-72 — the per-turn context resolvers the turn worker runs on
// its fresh-run arm: the enforced-ignorance prep doc (session_preps.ft_context)
// fallback, and the campaign's world id (blob-cached) that scopes the FT's
// world-knowledge lookup tools. Extracted from turn-worker.ts as pure, narrowly-
// typed, directly-unit-tested helpers (keeps the worker module under its
// length budget and the §8 scoping explicit — no secret-bearing reads here).

import type { SessionState } from '../redis/session-state.js'
import type { SessionMessage } from '../repo/types.js'
import type { AccessLevel } from '../repo/facts.js'
import {
  ENTITY_CARD_CAP,
  buildEntityCardBlock,
  firstMentionIndex,
  formatEntityCard,
  scanMentionedEntities,
  toHaystack,
} from './entity-card-scan.js'

/** Minimal pino-compatible logger surface these resolvers need (structured warn
 *  with an optional message; matches the worker's MinimalLogger). */
export interface ContextLogger {
  warn: (objOrMsg: Record<string, unknown> | string, msg?: string) => void
}

/** The narrow repo surface `reloadFtContext` reads — the session-row → session-
 *  number read + the prep ft_context read. `TurnWorkerRepo` structurally
 *  satisfies it, so the worker passes its `repo` straight through. */
export interface ReloadFtContextRepo {
  readonly sessions: {
    getById(id: string): Promise<{ sessionNumber: number } | null>
  }
  readonly sessionPreps: {
    getBy(campaignId: string, sessionNumber: number): Promise<{ ftContext: string } | null>
  }
}

/**
 * §3.10 — resolve the enforced-ignorance-safe prep doc (session_preps.ft_context)
 * when the `:state` blob doesn't carry it (a session started before the prep
 * wiring parked it on the blob, or an evicted blob). Reads the session row for
 * its session_number → `sessionPreps.getBy` → `.ftContext`. Absent → '' with a
 * LOUD warn (a turn with no prep context is degraded but must not crash).
 */
export async function reloadFtContext(
  repo: ReloadFtContextRepo,
  campaignId: string,
  sessionId: string,
  logger?: ContextLogger,
): Promise<string> {
  const session = await repo.sessions.getById(sessionId)
  if (session === null) {
    logger?.warn({ campaignId, sessionId }, 'reloadFtContext: no session row; ft_context defaults to empty')
    return ''
  }
  const prep = await repo.sessionPreps.getBy(campaignId, session.sessionNumber)
  if (prep === null) {
    logger?.warn(
      { campaignId, sessionId, sessionNumber: session.sessionNumber },
      'reloadFtContext: no session_prep row; ft_context defaults to empty',
    )
    return ''
  }
  return prep.ftContext
}

/** The narrow deps `resolveWorldId` needs: the blob cache (read + write) and the
 *  PUBLIC campaigns world-id lookup. Pinned narrowly so the unit test fakes stay
 *  small and the §8 scoping is explicit (no secret-bearing read here). */
export interface ResolveWorldIdDeps {
  readonly sessionState: Pick<SessionState, 'getState' | 'setState'>
  readonly repo: { campaigns: { getWorldId(id: string): Promise<string | null> } }
}

/**
 * MYT-72 — resolve the campaign's world id for the FT's world-knowledge lookup
 * tools, blob-cached so the PG read happens at most once per session.
 *
 *   - Blob carries `worldId` → return it (no `getWorldId`, no re-write).
 *   - Blob present but missing `worldId` → read `campaigns.getWorldId` (null →
 *     '') and back-fill the blob (merge onto the prior fields) so later turns hit
 *     the cache.
 *   - Blob null (session not fully initialized — an edge) → read the worldId for
 *     THIS turn but DON'T cache (there's no blob to merge onto; the connect path
 *     rebuilds the blob, which will carry the worldId once parked).
 *
 * Returns a string (never null): a campaign with no `world_id` yields '' so the
 * lookup-tool deps stay typed (the tools relay a clean "no such world" blank).
 */
export async function resolveWorldId(
  deps: ResolveWorldIdDeps,
  campaignId: string,
  sessionId: string,
): Promise<string> {
  void sessionId // reserved for symmetry with reloadFtContext; worldId keys on campaign
  const state = await deps.sessionState.getState(campaignId)
  if (state?.worldId !== undefined) return state.worldId
  const worldId = (await deps.repo.campaigns.getWorldId(campaignId)) ?? ''
  // Only back-fill when there IS a blob to merge onto. A null blob is the
  // not-fully-initialized edge — resolve for this turn, skip the cache write.
  if (state !== null) {
    await deps.sessionState.setState(campaignId, { ...state, worldId })
  }
  return worldId
}

/** How many trailing transcript rows form the "recent scene" name-scan window.
 *  A canon NPC who entered a few turns ago and is still on stage should keep
 *  their card injected; one mentioned once far in the past should not. ~40 rows
 *  is a few turns of DM prose + player messages. The bound also caps the scan
 *  cost — the FT re-injection is idempotent because the base ft_context is
 *  re-derived from scratch every turn (we never persist the appended block). */
const ENTITY_SCAN_WINDOW_ROWS = 40

/** The narrow repo surface `augmentFtContextWithEntityCards` reads. The full
 *  `Repo` (and a tx client) structurally satisfies it, so the worker passes its
 *  `repo` straight through. Every read is KNOWN-tier by construction — there is
 *  no path here that touches discoverable/secret rows (enforced ignorance). */
export interface EntityCardRepo {
  readonly sessionMessages: {
    listFtContextRows(sessionId: string, maxPlayerSeq: number): Promise<readonly SessionMessage[]>
  }
  readonly entities: {
    listByWorld(
      worldId: string,
      opts?: { readonly accessLevels?: readonly AccessLevel[] },
    ): Promise<readonly { readonly id: string; readonly name: string; readonly entityType: string }[]>
  }
  readonly facts: {
    listByEntities(
      entityIds: readonly string[],
      opts: { readonly accessLevels: readonly AccessLevel[]; readonly liveOnly?: boolean },
    ): Promise<readonly { readonly entityId: string; readonly content: string }[]>
  }
}

/**
 * myth-dwyuw — augment the enforced-ignorance-safe ft_context with KNOWN-tier
 * cards for any canon entity NAMED in the recent transcript window whose card is
 * not already grounded in the prep doc. Fixes the FT inventing attributes for an
 * NPC that enters play by name mid-session (canon-female Roud rendered male for
 * a whole session because her card never reached the FT's context).
 *
 * Flow (every arm KNOWN-tier only — enforced ignorance is structural here):
 *   1. Read the recent transcript window (tail of listFtContextRows) as the
 *      name-detection haystack — it includes this turn's player message(s).
 *   2. Load the world's KNOWN entities (never discoverable/secret), dropping PCs
 *      (already grounded via the roster + party ledger).
 *   3. Drop entities already named in the BASE ft_context (idempotent — the prep
 *      doc already grounds session-start entities; no duplicate cards).
 *   4. Scan the haystack for the survivors (normalized ≥2-token matching, capped).
 *   5. Fetch KNOWN-tier facts ONLY for the matches, format one card each, and
 *      append the labelled block to the base ft_context.
 *
 * TOTAL / fail-soft: never throws — any failure logs and returns the base
 * ft_context unchanged (a degraded turn must not crash; grounding is additive).
 * Returns the (possibly unchanged) ft_context string.
 */
export async function augmentFtContextWithEntityCards(
  repo: EntityCardRepo,
  args: {
    readonly worldId: string
    readonly sessionId: string
    readonly maxConsumedSeq: number
    readonly baseFtContext: string
  },
  logger?: ContextLogger,
): Promise<string> {
  try {
    if (args.worldId === '') return args.baseFtContext

    const rows = await repo.sessionMessages.listFtContextRows(args.sessionId, args.maxConsumedSeq)
    if (rows.length === 0) return args.baseFtContext
    const haystackText = rows
      .slice(-ENTITY_SCAN_WINDOW_ROWS)
      .map((r) => r.content)
      .join('\n')

    // KNOWN-tier entities only. `type:'pc'` is dropped — a player character is
    // grounded by the roster + the per-turn party ledger; re-carding it wastes
    // budget and could shadow those live sources.
    const known = (await repo.entities.listByWorld(args.worldId, { accessLevels: ['known'] })).filter(
      (e) => e.entityType !== 'pc',
    )
    if (known.length === 0) return args.baseFtContext

    // Suppress entities the prep doc already grounds (idempotent, no duplication).
    const baseHaystack = toHaystack(args.baseFtContext)
    const candidates = known.filter((e) => firstMentionIndex(e.name, baseHaystack) === null)
    if (candidates.length === 0) return args.baseFtContext

    const matched = scanMentionedEntities(candidates, haystackText, { cap: ENTITY_CARD_CAP })
    if (matched.length === 0) return args.baseFtContext

    // KNOWN-tier facts ONLY — the single structural enforced-ignorance gate.
    const facts = await repo.facts.listByEntities(
      matched.map((m) => m.id),
      { accessLevels: ['known'] },
    )
    const byEntity = new Map<string, string[]>()
    for (const f of facts) {
      const arr = byEntity.get(f.entityId) ?? []
      arr.push(f.content)
      byEntity.set(f.entityId, arr)
    }

    const cards = matched.map((m) => formatEntityCard(m.name, m.entityType, byEntity.get(m.id) ?? []))
    return args.baseFtContext + buildEntityCardBlock(cards)
  } catch (err) {
    logger?.warn(
      { err, sessionId: args.sessionId, worldId: args.worldId },
      'augmentFtContextWithEntityCards failed; using base ft_context',
    )
    return args.baseFtContext
  }
}
