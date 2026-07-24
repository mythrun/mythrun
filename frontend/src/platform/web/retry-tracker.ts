// Web realization of the route-error RETRY BURST counter (myth-t1ccl). The route
// error boundary's "try again" does a full `navigate(0)` reload, so React state
// can't survive a retry — the attempt count lives in sessionStorage (tab-scoped,
// cleared on tab close). Lives under src/platform/web/** (the one place web
// globals are allowed, R1); the boundary reaches it only through these functions.
//
// A BURST WINDOW self-resets the counter once retries stop: reads older than the
// window count as a fresh 0. That gives "reset on recovery" WITHOUT a success hook
// the error boundary (which only mounts on failure) can't provide — a later,
// unrelated error simply starts a new burst.
const KEY = 'mythrun_retry_burst'
const BURST_WINDOW_MS = 60_000

interface Burst {
  readonly count: number
  readonly at: number
}

/** The stored burst, or 0 when absent / corrupt / stale (past the burst window). */
function read(now: number): number {
  try {
    const raw = sessionStorage.getItem(KEY)
    if (raw === null) return 0
    const parsed = JSON.parse(raw) as Partial<Burst>
    if (typeof parsed.count !== 'number' || typeof parsed.at !== 'number') return 0
    // A gap longer than the window means the user stopped hammering "try again";
    // the next failure is a fresh incident, not a continuation of the burst.
    if (now - parsed.at > BURST_WINDOW_MS) return 0
    return parsed.count
  } catch {
    return 0
  }
}

/** How many retries have already been made in the current burst (0 on a fresh error). */
export function readRetryAttempts(now: number = Date.now()): number {
  return read(now)
}

/** Record one more retry in the current burst; returns the new attempt count. */
export function recordRetryAttempt(now: number = Date.now()): number {
  const next = read(now) + 1
  try {
    sessionStorage.setItem(KEY, JSON.stringify({ count: next, at: now } satisfies Burst))
  } catch {
    // Storage unavailable (private mode / quota) — degrade to no counting. The
    // boundary still retries; it just can't escalate. Never throw from here.
  }
  return next
}

/** Clear the burst counter outright. (Used by the error-boundary specimen to seed a
 *  deterministic starting count; the runtime relies on the burst window to self-reset.) */
export function clearRetryAttempts(): void {
  try {
    sessionStorage.removeItem(KEY)
  } catch {
    // Storage unavailable — nothing to clear.
  }
}
