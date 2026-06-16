// backend/src/session/turn-context.ts
//
// MYT-68/§3.10 + MYT-72 — the per-turn context resolvers the turn worker runs on
// its fresh-run arm: the enforced-ignorance prep doc (session_preps.ft_context)
// fallback, and the campaign's world id (blob-cached) that scopes the FT's
// world-knowledge lookup tools. Extracted from turn-worker.ts as pure, narrowly-
// typed, directly-unit-tested helpers (keeps the worker module under its
// length budget and the §8 scoping explicit — no secret-bearing reads here).

import type { SessionState } from '../redis/session-state.js'

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
