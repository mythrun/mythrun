import { useCallback, useEffect, useRef, useState } from 'react'
import { z } from 'zod'
import type { ApiContext } from '../api/endpoint.ts'
import { isHttpError } from '../api/errors.ts'
import {
  getActiveSession,
  startSession,
  type ActiveSessionResponse,
  type InsufficientCreditsBody,
  type StartSessionResponse,
} from '../api/play-session.ts'

// start-flow (MYT-92 A7; storm fix myth-ep74g): the session-start classifier + the
// `useSessionStart` async state machine over it. `POST /start` DEBITS the campaign
// owner's session credit; its arms each mean a different next screen, so the
// classifier maps a caught endpoint error to a discriminated `StartOutcome` and the
// hook resolves it to a render `phase`:
//
//   200                          → ready{sessionId}          (mount useSession)
//   409 session_already_active   → join → GET /active        → ready{sessionId}
//   409 prep_not_ready /
//       reconcile_pending /
//       session_ending           → waiting{code}             (the calm interstitial)
//   402 insufficient_credits     → purchase{moment}          (the MYT-95 seam)
//   409 campaign_not_active /
//       (any off-contract 409)   → blocked{code}             (a calm retry notice)
//   anything else                → error                     (a calm retry notice)
//
// TWO CHANGES vs. the original A7 wiring, both from the myth-ep74g weekend playtest:
//
//  1. THE RETRY STORM. The between-sessions window (a session just ended, the next
//     session's prep isn't ready) is a `prep_not_ready` / `reconcile_pending` /
//     `session_ending` answer. The old flow re-attempted `POST /start` IMMEDIATELY
//     (the prep beat's SSE `ready` re-fired `retry()` with zero backoff), which the
//     server met with another wait code — a tight loop that hit the `/start`
//     rate limit (10/min) and 429'd the player right after every session close.
//     The fix: these transient codes collapse to ONE `waiting` phase, and the hook
//     BACKOFF-POLLS `/start` from inside it — 2s → 4s → 8s → capped ~12s, jittered
//     — staying in `waiting` across polls (no phase thrash, no burst). No SSE-driven
//     immediate re-attempt exists anymore; the poll IS the readiness probe.
//
//  2. THE 409 JOIN NOISE. Returning to a running game answered `POST /start` with
//     `409 session_already_active`, which the browser logs as a red "Failed to load
//     resource" on every load (there is no app-level logger to silence — it is the
//     network stack's own console line). The fix: the manual/initial attempt PROBES
//     `GET /active` FIRST (a clean 200, read-only, no debit) and joins a running
//     session with no `POST` at all — so the common "return to an active game" path
//     never issues a 409. The 409 join path is kept only for the rare race (a
//     session started between our probe and our POST).
//
// ZFC: pure orchestration over the contract-blessed `code`/`status` — no heuristics,
// no pattern-matching on prose.

/** The typed purchase signal MYT-95's `PurchasePrompt` consumes. Defined HERE and
 *  exported — this exact shape is the cross-issue seam (spec §4/§7); MYT-95 imports
 *  it, so it MUST NOT be renamed at the 95-merge. `viewerIsOwner` decides whether
 *  the moment offers a buy CTA (owner) or the "owner is out of credits" notice. */
export interface PurchaseMoment {
  readonly available: number
  readonly required: number
  readonly viewerIsOwner: boolean
}

/** The classifier's output — a caught start error narrowed to its meaning. `join`
 *  still needs a `/active` lookup to resolve a sessionId; `wait` carries the
 *  transient between-sessions code the calm interstitial backoff-polls through;
 *  the rest map straight to a phase. */
export type StartOutcome =
  | { kind: 'join' }
  | { kind: 'wait'; code: string }
  | { kind: 'purchase'; body: InsufficientCreditsBody }
  | { kind: 'blocked'; code: string; memberNames?: readonly string[] }
  | { kind: 'error' }

type StartFlowState =
  | { phase: 'idle' }
  | { phase: 'starting' }
  // The calm between-sessions hold — prep_not_ready / reconcile_pending /
  // session_ending. The hook backoff-polls `/start` from here; `code` is the
  // triggering answer (for diagnostics — the interstitial copy is uniform).
  | { phase: 'waiting'; code: string }
  | { phase: 'ready'; sessionId: string }
  | { phase: 'purchase'; moment: PurchaseMoment }
  | { phase: 'blocked'; code: string; memberNames?: readonly string[] }
  | { phase: 'error' }

export interface StartFlow {
  readonly state: StartFlowState
  /** Stable callbacks (a shared `useCallback` reference) — `retry` IS `start`; a
   *  manual retry resets the backoff and re-attempts at once (probing `/active`). */
  readonly start: () => void
  readonly retry: () => void
}

export interface SessionStartInput {
  readonly campaignId: string
  readonly viewerIsOwner: boolean
}

type StartFn = (input: { campaignId: string }, ctx: ApiContext) => Promise<StartSessionResponse>
type ActiveFn = (input: { campaignId: string }, ctx: ApiContext) => Promise<ActiveSessionResponse>

/** Backoff schedule for the `waiting` poll (myth-ep74g). Exponential from `baseMs`,
 *  capped at `capMs`, with an additive `jitterMs` decorrelation. Injectable so tests
 *  pin the spacing deterministically. */
export interface BackoffConfig {
  readonly baseMs: number
  readonly capMs: number
  readonly factor: number
  readonly jitterMs: number
}

/** 2s → 4s → 8s → 12s (capped), +0..2s jitter → an effective ~2–14s ramp that never
 *  approaches the `/start` 10/min rate limit (≈5 polls/min at the cap). */
export const DEFAULT_BACKOFF: BackoffConfig = { baseMs: 2000, capMs: 12000, factor: 2, jitterMs: 2000 }

/** Injected endpoints + backoff/rng — default to the real slice; tests substitute. */
export interface SessionStartDeps {
  readonly startSession?: StartFn
  readonly getActiveSession?: ActiveFn
  readonly backoff?: BackoffConfig
  /** [0,1) source for the additive jitter — defaults to `Math.random`. */
  readonly rng?: () => number
}

/** The exponentially-backed-off, jittered delay before the next `waiting` poll.
 *  `attempt` is 0-indexed (0 = the first re-poll after entering `waiting`). Pure. */
export function backoffDelay(attempt: number, cfg: BackoffConfig, rng: () => number): number {
  const raw = Math.min(cfg.capMs, cfg.baseMs * cfg.factor ** attempt)
  return Math.round(raw + rng() * cfg.jitterMs)
}

/** The 402 body validator. play-session declares `InsufficientCreditsBody` as a
 *  plain type (the endpoint layer reads error bodies as `unknown`), so the runtime
 *  check lives here at the point of consumption — a malformed 402 cannot yield a
 *  half-built purchase moment. */
const insufficientCreditsSchema = z.object({
  code: z.string(),
  available: z.number(),
  required: z.number(),
})

/** The members_without_characters 409 body (myth-mnik3 guard): the server names
 *  every confirmed member still without an integrated character so the owner can
 *  see exactly WHO the table is waiting on — the legibility point of the guard.
 *  Malformed → the arm degrades to the bare blocked hold (never a crash). */
const membersWithoutCharactersSchema = z.object({
  members: z.array(z.object({ userId: z.string(), displayName: z.string() })),
})

/** Pure: map a caught start error to a `StartOutcome`. Keys ONLY on the
 *  contract-blessed `status`/`code`/`body` — nothing semantic. */
export function classifyStartError(err: unknown): StartOutcome {
  if (!isHttpError(err)) return { kind: 'error' }
  if (err.status === 402) {
    const parsed = insufficientCreditsSchema.safeParse(err.body)
    return parsed.success ? { kind: 'purchase', body: parsed.data } : { kind: 'error' }
  }
  if (err.status === 409 && err.code !== undefined) return classify409(err.code, err.body)
  return { kind: 'error' }
}

function classify409(code: string, body: unknown): StartOutcome {
  switch (code) {
    case 'session_already_active':
      return { kind: 'join' }
    // The transient between-sessions codes: the next session is being prepared /
    // the last one is reconciling / ending. All resolve on their own — the calm
    // interstitial backoff-polls through them (myth-ep74g).
    case 'prep_not_ready':
    case 'reconcile_pending':
    case 'session_ending':
      return { kind: 'wait', code }
    // The myth-mnik3 start guard: the session can't run until every confirmed
    // member has an integrated character. Not transient (someone must finish
    // creation), so it renders as the blocked hold — but WITH the missing
    // members' names, so the owner knows exactly who the table waits on.
    case 'members_without_characters': {
      const parsed = membersWithoutCharactersSchema.safeParse(body)
      return {
        kind: 'blocked',
        code,
        ...(parsed.success
          ? { memberNames: parsed.data.members.map((m) => m.displayName) }
          : {}),
      }
    }
    // `campaign_not_active` (and any off-contract 409) is NOT transient — a manual
    // retry notice, not an auto-poll.
    default:
      return { kind: 'blocked', code }
  }
}

interface StartArgs {
  readonly ctx: ApiContext
  readonly campaignId: string
  readonly viewerIsOwner: boolean
  readonly startFn: StartFn
  readonly activeFn: ActiveFn
}

/** Probe for an already-running session WITHOUT a `POST /start` (myth-ep74g): a
 *  read-only `GET /active` that joins a live session with no debit and no 409 —
 *  the silent "return to an active game" path. A null result (no running session)
 *  or a probe failure both fall through to `POST /start` — the probe is a
 *  best-effort short-circuit, never a gate. Returns the joinable sessionId or null. */
async function probeActive(args: StartArgs): Promise<string | null> {
  try {
    const { session } = await args.activeFn({ campaignId: args.campaignId }, args.ctx)
    return session === null ? null : session.id
  } catch {
    return null
  }
}

/** Run one start attempt to its terminal `StartFlowState` — never rejects (every arm
 *  resolves). When `probe`, first try to join a running session via `/active` (no
 *  409); otherwise (or if none is running) `POST /start` and classify the answer. */
async function runStartFlow(args: StartArgs, probe: boolean): Promise<StartFlowState> {
  if (probe) {
    const activeId = await probeActive(args)
    if (activeId !== null) return { phase: 'ready', sessionId: activeId }
  }
  try {
    const { sessionId } = await args.startFn({ campaignId: args.campaignId }, args.ctx)
    return { phase: 'ready', sessionId }
  } catch (err) {
    return resolveOutcome(classifyStartError(err), args)
  }
}

async function resolveOutcome(outcome: StartOutcome, args: StartArgs): Promise<StartFlowState> {
  switch (outcome.kind) {
    case 'join':
      return resolveJoin(args)
    case 'wait':
      return { phase: 'waiting', code: outcome.code }
    case 'purchase':
      return {
        phase: 'purchase',
        moment: {
          available: outcome.body.available,
          required: outcome.body.required,
          viewerIsOwner: args.viewerIsOwner,
        },
      }
    case 'blocked':
      return {
        phase: 'blocked',
        code: outcome.code,
        ...(outcome.memberNames !== undefined ? { memberNames: outcome.memberNames } : {}),
      }
    case 'error':
      return { phase: 'error' }
  }
}

/** The `session_already_active` join path (the rare race — a session started between
 *  our `/active` probe and our `POST /start`): resolve the running session's id from
 *  `/active`. A null result is the vanished-session race (it ended between /start and
 *  /active) — surface it as retryable `blocked` under the triggering code rather than
 *  inventing a non-contract token. */
async function resolveJoin(args: StartArgs): Promise<StartFlowState> {
  try {
    const { session } = await args.activeFn({ campaignId: args.campaignId }, args.ctx)
    if (session === null) return { phase: 'blocked', code: 'session_already_active' }
    return { phase: 'ready', sessionId: session.id }
  } catch {
    return { phase: 'error' }
  }
}

/** A mounted flag as a ref, so a late start resolution never setStates after
 *  teardown. */
function useMountedRef(): { readonly current: boolean } {
  const ref = useRef(true)
  useEffect(() => {
    ref.current = true
    return () => {
      ref.current = false
    }
  }, [])
  return ref
}

export function useSessionStart(
  ctx: ApiContext,
  input: SessionStartInput,
  deps: SessionStartDeps = {},
): StartFlow {
  const { campaignId, viewerIsOwner } = input
  const startFn = deps.startSession ?? startSession
  const activeFn = deps.getActiveSession ?? getActiveSession
  const backoff = deps.backoff ?? DEFAULT_BACKOFF
  const rng = deps.rng ?? Math.random

  const [state, setState] = useState<StartFlowState>({ phase: 'idle' })
  const mountedRef = useMountedRef()
  // The backoff poll counter (reset on each manual start), the scheduled-poll timer,
  // and a generation token — a manual retry (or unmount) bumps `gen` so an in-flight
  // or scheduled attempt from a superseded generation is ignored.
  const attemptRef = useRef(0)
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const genRef = useRef(0)
  // Break the attempt↔schedule cycle: the scheduled poll calls the LATEST attempt.
  const attemptRef2 = useRef<(gen: number, probe: boolean) => Promise<void>>(() => Promise.resolve())

  const clearTimer = useCallback((): void => {
    if (timerRef.current !== null) {
      clearTimeout(timerRef.current)
      timerRef.current = null
    }
  }, [])

  const attempt = useCallback(
    async (gen: number, probe: boolean): Promise<void> => {
      const next = await runStartFlow({ ctx, campaignId, viewerIsOwner, startFn, activeFn }, probe)
      // Ignore a resolution from a superseded generation or after unmount.
      if (gen !== genRef.current || !mountedRef.current) return
      setState(next)
      if (next.phase !== 'waiting') return
      // Still not startable → schedule the NEXT poll with growing backoff. Stay in
      // `waiting` (no phase thrash); the poll re-attempts WITHOUT the /active probe
      // (nothing is active — we are waiting for prep/reconcile), so it is a single
      // `POST /start`, not a probe+post pair.
      const delay = backoffDelay(attemptRef.current, backoff, rng)
      attemptRef.current += 1
      clearTimer()
      timerRef.current = setTimeout(() => {
        if (gen === genRef.current && mountedRef.current) void attemptRef2.current(gen, false)
      }, delay)
    },
    [ctx, campaignId, viewerIsOwner, startFn, activeFn, backoff, rng, mountedRef, clearTimer],
  )
  attemptRef2.current = attempt

  const start = useCallback((): void => {
    clearTimer()
    attemptRef.current = 0
    const gen = ++genRef.current
    setState({ phase: 'starting' })
    void attempt(gen, true)
  }, [attempt, clearTimer])

  // Clear any scheduled poll on unmount (the mounted-ref guard covers in-flight
  // resolutions; this stops the timer itself from firing after teardown).
  useEffect(() => clearTimer, [clearTimer])

  return { state, start, retry: start }
}
