import { useEffect, useRef, useState } from 'react'
import type { ApiContext } from '../api/endpoint.ts'
import { useApiContext } from '../api/client-context.tsx'
import {
  getCharacterCreationProgress,
  type CharacterCreationProgress,
} from '../api/characters.ts'

// useCreationProgressPoll (myth-qkjdq): the RELIABLE, SSE-independent liveness for
// the character-creation waiting screen. The loading beat's animation rides the
// campaign status SSE (use-character-creation-stream.ts), but the SSE can die at
// the CloudFront edge without ever reaching the browser — leaving the screen
// unable to advance even on success. This hook backoff-POLLS the durable progress
// GET (the same endpoint the finalize board reads, confirmed live on staging) and
// flips `done`/`failed` off the viewer's own concept status. The screen advances
// whether or not a single SSE frame arrives.
//
// STORM-SAFE (mirrors session/start-flow.ts's waiting poll): a jittered
// exponential backoff (calm ~3–5s), a single in-flight probe at a time, the loop
// STOPS the instant the viewer's concept reaches a terminal state (no polling a
// finished pipeline), and the effect cleanup cancels a scheduled poll so nothing
// fires into a torn-down screen. A transient probe failure is calm — it just
// re-polls on the next backoff step; the durable status remains the only signal.
//
// ZFC: pure orchestration over the contract-blessed `status` string — no
// heuristics, no pattern-matching on prose.

/** The jittered-exponential backoff for the poll. Calm by default (~3–5s) — the
 *  creation wait is ~30s, so a gentle cadence never bursts. Injectable so tests
 *  pin the spacing deterministically. */
export interface CreationPollConfig {
  readonly baseMs: number
  readonly capMs: number
  readonly factor: number
  readonly jitterMs: number
}

/** 3s → 4.5s → 5s (capped), +0..1s jitter → an effective ~3–6s cadence that never
 *  approaches a rate that could storm the API. */
export const DEFAULT_CREATION_POLL: CreationPollConfig = {
  baseMs: 3000,
  capMs: 5000,
  factor: 1.5,
  jitterMs: 1000,
}

/** Injected progress source + backoff/rng — default to the real GET and the calm
 *  schedule; tests substitute hand-driven ones. */
export interface CreationProgressPollDeps {
  readonly fetchProgress?: (
    ctx: ApiContext,
    campaignId: string,
  ) => Promise<CharacterCreationProgress>
  readonly backoff?: CreationPollConfig
  /** [0,1) source for the additive jitter — defaults to `Math.random`. */
  readonly rng?: () => number
}

/** The viewer's terminal creation state as the durable poll sees it. Both stay
 *  false while the concept is pre-terminal (submitted/processing) or the viewer
 *  has no concept row; exactly one latches true at the terminal read. */
export interface CreationProgressPoll {
  readonly done: boolean
  readonly failed: boolean
}

/** The delay (ms) before the next poll: exponential from `baseMs`, capped at
 *  `capMs`, with an additive `jitterMs` decorrelation. `attempt` is 0-indexed. */
export function creationPollDelay(
  attempt: number,
  cfg: CreationPollConfig,
  rng: () => number,
): number {
  const raw = Math.min(cfg.capMs, cfg.baseMs * cfg.factor ** attempt)
  return Math.round(raw + rng() * cfg.jitterMs)
}

export function useCreationProgressPoll(
  campaignId: string,
  userId: string,
  deps: CreationProgressPollDeps = {},
): CreationProgressPoll {
  const ctx = useApiContext()

  const [done, setDone] = useState(false)
  const [failed, setFailed] = useState(false)

  // Latest-ref for the injectable inputs: the loop reads the current values, but
  // they are NOT effect deps, so a re-render that hands fresh `backoff`/`rng`/
  // `fetchProgress` identities (the common case — inline literals) does NOT tear
  // down + restart the poll (which would re-fetch on every render — a self-storm).
  const fetchProgressRef = useRef(deps.fetchProgress ?? getCharacterCreationProgress)
  const backoffRef = useRef(deps.backoff ?? DEFAULT_CREATION_POLL)
  const rngRef = useRef(deps.rng ?? Math.random)
  fetchProgressRef.current = deps.fetchProgress ?? getCharacterCreationProgress
  backoffRef.current = deps.backoff ?? DEFAULT_CREATION_POLL
  rngRef.current = deps.rng ?? Math.random

  // The whole poll loop lives in ONE effect keyed only on its stable identity
  // (ctx + the target). A local `cancelled` flag (flipped by the cleanup) + a
  // timer handle supersede any in-flight or scheduled poll on unmount — a late
  // resolve then no-ops instead of setStating into a torn-down screen.
  useEffect(() => {
    let cancelled = false
    let timer: ReturnType<typeof setTimeout> | null = null
    let attempt = 0

    const schedule = (): void => {
      const delay = creationPollDelay(attempt, backoffRef.current, rngRef.current)
      attempt += 1
      // The cleanup clears this timer synchronously on cancel, so the callback
      // never fires post-cancel — no inner `cancelled` re-check needed. The
      // in-flight `poll()` resolutions carry the `cancelled` guard themselves.
      timer = setTimeout(() => {
        timer = null
        poll()
      }, delay)
    }

    const poll = (): void => {
      fetchProgressRef
        .current(ctx, campaignId)
        .then((progress) => {
          if (cancelled) return
          const mine = progress.concepts.find((c) => c.userId === userId)
          // Terminal → latch + STOP (no reschedule): a finished pipeline is never
          // re-polled. Pre-terminal (or no concept row yet) → keep waiting.
          if (mine?.status === 'completed') {
            setDone(true)
          } else if (mine?.status === 'failed') {
            setFailed(true)
          } else {
            schedule()
          }
        })
        .catch(() => {
          // Calm: a transient probe failure just re-polls on the next backoff step.
          if (!cancelled) schedule()
        })
    }

    poll()
    return () => {
      cancelled = true
      if (timer !== null) clearTimeout(timer)
    }
  }, [ctx, campaignId, userId])

  return { done, failed }
}
