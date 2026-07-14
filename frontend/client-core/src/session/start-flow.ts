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

// start-flow (MYT-92 A7): the session-start classifier + the `useSessionStart`
// async state machine over it. `POST /start` DEBITS the campaign owner's session
// credit; its arms (recorded live in tmp/sdd/myt92-verify-notes.md) each mean a
// different next screen, so the classifier maps a caught endpoint error to a
// discriminated `StartOutcome` and the hook resolves it to a render `phase`:
//
//   200                          → ready{sessionId}          (mount useSession)
//   409 session_already_active   → join → GET /active        → ready{sessionId}
//        (post-DEV-1 this is the TRUTHFUL mid-session-join signal — the backend now
//         checks the active-session guard before the prep guard, so a late joiner
//         gets session_already_active, not prep_not_ready)
//   409 prep_not_ready           → prep                      (SessionStartBeat[prep])
//   402 insufficient_credits     → purchase{moment}          (the MYT-95 seam)
//   409 campaign_not_active /
//       reconcile_pending /
//       session_ending           → blocked{code}             (a calm retry notice)
//   anything else                → error                     (a calm retry notice)
//
// ZFC: this is pure orchestration over the contract-blessed `code`/`status` — no
// heuristics, no pattern-matching on prose. The prep arm resolves UPWARD: the route
// watches `useSessionPrep` and calls `retry()` (= `start()`) when prep goes ready.

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
 *  still needs a `/active` lookup to resolve a sessionId; the rest map straight to a
 *  phase. */
export type StartOutcome =
  | { kind: 'join' }
  | { kind: 'prep' }
  | { kind: 'purchase'; body: InsufficientCreditsBody }
  | { kind: 'blocked'; code: string }
  | { kind: 'error' }

export type StartFlowState =
  | { phase: 'idle' }
  | { phase: 'starting' }
  | { phase: 'prep' }
  | { phase: 'ready'; sessionId: string }
  | { phase: 'purchase'; moment: PurchaseMoment }
  | { phase: 'blocked'; code: string }
  | { phase: 'error' }

export interface StartFlow {
  readonly state: StartFlowState
  /** Stable callbacks (a shared `useCallback` reference) — `retry` IS `start`; the
   *  route calls `retry` when prep goes ready. */
  readonly start: () => void
  readonly retry: () => void
}

export interface SessionStartInput {
  readonly campaignId: string
  readonly viewerIsOwner: boolean
}

type StartFn = (input: { campaignId: string }, ctx: ApiContext) => Promise<StartSessionResponse>
type ActiveFn = (input: { campaignId: string }, ctx: ApiContext) => Promise<ActiveSessionResponse>

/** Injected endpoints — default to the real slice; tests substitute spies. */
export interface SessionStartDeps {
  readonly startSession?: StartFn
  readonly getActiveSession?: ActiveFn
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

/** Pure: map a caught start error to a `StartOutcome`. Keys ONLY on the
 *  contract-blessed `status`/`code`/`body` — nothing semantic. */
export function classifyStartError(err: unknown): StartOutcome {
  if (!isHttpError(err)) return { kind: 'error' }
  if (err.status === 402) {
    const parsed = insufficientCreditsSchema.safeParse(err.body)
    return parsed.success ? { kind: 'purchase', body: parsed.data } : { kind: 'error' }
  }
  if (err.status === 409 && err.code !== undefined) return classify409(err.code)
  return { kind: 'error' }
}

function classify409(code: string): StartOutcome {
  switch (code) {
    case 'session_already_active':
      return { kind: 'join' }
    case 'prep_not_ready':
      return { kind: 'prep' }
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

/** Run one start attempt to its terminal state — never rejects (every arm resolves
 *  to a `StartFlowState`). */
async function runStartFlow(args: StartArgs): Promise<StartFlowState> {
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
    case 'prep':
      return { phase: 'prep' }
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
      return { phase: 'blocked', code: outcome.code }
    case 'error':
      return { phase: 'error' }
  }
}

/** The `session_already_active` join path: resolve the running session's id from
 *  `/active`. A null result is the vanished-session race (the session ended between
 *  /start and /active) — surface it as retryable `blocked` under the triggering
 *  code rather than inventing a non-contract token. */
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

  const [state, setState] = useState<StartFlowState>({ phase: 'idle' })
  const mountedRef = useMountedRef()

  const start = useCallback((): void => {
    setState({ phase: 'starting' })
    void runStartFlow({ ctx, campaignId, viewerIsOwner, startFn, activeFn }).then((next) => {
      if (mountedRef.current) setState(next)
    })
  }, [ctx, campaignId, viewerIsOwner, startFn, activeFn, mountedRef])

  return { state, start, retry: start }
}
