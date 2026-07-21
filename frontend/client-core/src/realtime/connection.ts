import { createStore, type StoreApi } from 'zustand/vanilla'
import { useStore } from 'zustand/react'

// The shared connection primitive every realtime client (WS session + SSE
// status) is built on. "Shared code, per-instance state": the backoff/ceiling
// state machine lives here ONCE, but each client factory mints its OWN store via
// `createConnection()` — never a module-level `create()` singleton — so two live
// clients (a play session + a world-gen stream, say) hold independent connection
// state.
//
// Invariants this module is the home of (the WS/SSE client tasks consume them):
//   - Single-flight connect: every socket open takes a `nextGeneration()` token;
//     a superseded socket's late `close` callback compares its captured token to
//     `generation()` and self-ignores. This module owns the monotonic counter.
//   - The attempt counter resets on a successful open (`onOpenSuccess()`), so
//     cumulative drops over a long session never trip the ceiling.
//   - `close()` cancels any pending reconnect timer: the timer handle lives in the
//     consuming client (it owns `setTimeout`), which MUST clear it before calling
//     `markClosed()`/`reset()`. Documented here because this is where the
//     reconnection contract is defined.
//   - `store` (a zustand/vanilla `StoreApi`) is subscribe/`getState`-usable
//     without React; `useConnectionState` is the React read seam so flows and the
//     harness never import `zustand` directly.

export type ConnectionStatus =
  | 'connecting'
  | 'connected'
  | 'reconnecting'
  | 'closed'
  | 'failed'

/** Why a connection ended in `failed`. `denied` is terminal (a ticket 403/404 — no
 *  session / not a member). `exhausted` is re-armable (the backoff ceiling was hit;
 *  a flow MAY call the client's `connect()` again). `no_character` is terminal (the
 *  server closed the socket 4404 because the member has no integrated character —
 *  myth-mnik3): reconnecting would just be rejected again, so the flow routes it to
 *  an explicit "make a character" surface, not the reconnect line. */
export type ConnectionFailureReason = 'denied' | 'exhausted' | 'no_character'

export interface ConnectionState {
  status: ConnectionStatus
  /** Reconnect attempt counter: 0 while connecting/connected/closed; 1..ceiling
   *  while reconnecting; frozen at the ceiling once `failed{exhausted}`. */
  attempt: number
  /** Present only when `status === 'failed'`. */
  failedReason?: ConnectionFailureReason
}

export interface Connection {
  /** The per-instance state store. A client re-exposes this as `connectionState`. */
  readonly store: StoreApi<ConnectionState>
  /** A socket opened / `session_ready`: → `connected`, attempt reset to 0. */
  onOpenSuccess(): void
  /** Record a transient drop. Under the ceiling: → `reconnecting{attempt+1}` and
   *  returns `true` (the client then waits `nextDelayMs()` and re-opens). At the
   *  ceiling: → `failed{exhausted}` and returns `false`. */
  recordDrop(): boolean
  /** Backoff delay (ms) for the CURRENT reconnecting attempt. Pure — no state change. */
  nextDelayMs(): number
  /** A readable terminal/exhausted signal → `failed{reason}`. The client routes a
   *  ticket 403/404 here as `denied`; `exhausted` is normally reached via `recordDrop`. */
  fail(reason: ConnectionFailureReason): void
  /** Clean teardown (a `session_end` frame or an explicit `close()`) → `closed`. */
  markClosed(): void
  /** (Re)start a fresh connect cycle → `connecting`, attempt 0 (clearing any prior
   *  `failedReason`). The client's public `connect()` calls this; the internal
   *  reconnect loop does NOT (it must keep the climbing attempt counter). */
  reset(): void
  /** Mint the next single-flight generation token (call on each socket open). */
  nextGeneration(): number
  /** The current single-flight generation token. */
  generation(): number
}

export interface CreateConnectionOptions {
  /** The reconnect-attempt ceiling (≈10). Once this many attempts have been made,
   *  the next drop yields `failed{exhausted}` instead of another retry. */
  ceiling: number
  /** Override the backoff schedule (tests inject a deterministic, jitter-free fn).
   *  Default: 1s→2s→4s→8s→30s (capped) with ±10% jitter. */
  backoff?: (attempt: number) => number
}

/** The explicit backoff steps (ms). After the last step the delay holds at the cap. */
const BACKOFF_STEPS_MS = [1000, 2000, 4000, 8000] as const
const MAX_BACKOFF_MS = 30_000
/** ±10% jitter to de-correlate a thundering herd of simultaneous reconnects. */
const JITTER_RATIO = 0.1

function defaultBackoff(attempt: number): number {
  const safe = Math.max(1, attempt)
  // The `?? MAX_BACKOFF_MS` fallback is a noUncheckedIndexedAccess artifact: a
  // 1..4 index into BACKOFF_STEPS_MS is never `undefined`, so the nullish arm is
  // structurally unreachable (the ternary's two real arms ARE exercised).
  /* v8 ignore next 3 */
  const base =
    (safe <= BACKOFF_STEPS_MS.length ? BACKOFF_STEPS_MS[safe - 1] : MAX_BACKOFF_MS) ??
    MAX_BACKOFF_MS
  const jitter = base * JITTER_RATIO * (Math.random() * 2 - 1)
  return Math.round(base + jitter)
}

const INITIAL_STATE: ConnectionState = { status: 'connecting', attempt: 0 }

export function createConnection(opts: CreateConnectionOptions): Connection {
  const { ceiling } = opts
  const backoff = opts.backoff ?? defaultBackoff
  // Minted INSIDE the factory — per-instance state, never a shared singleton.
  const store = createStore<ConnectionState>(() => ({ ...INITIAL_STATE }))
  let generation = 0

  return {
    store,
    onOpenSuccess() {
      store.setState({ status: 'connected', attempt: 0 }, true)
    },
    recordDrop() {
      const { attempt } = store.getState()
      if (attempt >= ceiling) {
        store.setState({ status: 'failed', attempt, failedReason: 'exhausted' }, true)
        return false
      }
      store.setState({ status: 'reconnecting', attempt: attempt + 1 }, true)
      return true
    },
    nextDelayMs() {
      return backoff(store.getState().attempt)
    },
    fail(reason) {
      const { attempt } = store.getState()
      store.setState({ status: 'failed', attempt, failedReason: reason }, true)
    },
    markClosed() {
      store.setState({ status: 'closed', attempt: 0 }, true)
    },
    reset() {
      store.setState({ ...INITIAL_STATE }, true)
    },
    nextGeneration() {
      generation += 1
      return generation
    },
    generation() {
      return generation
    },
  }
}

/** The React read seam: subscribe a component to a client's connection store so
 *  flows/harness never import `zustand` directly. */
export function useConnectionState(client: {
  connectionState: StoreApi<ConnectionState>
}): ConnectionState {
  return useStore(client.connectionState)
}
