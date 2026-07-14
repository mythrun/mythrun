import { useEffect } from 'react'

// useForegroundRefetch (MYT-91): the web liveness FALLBACK layered on top of the
// party-staging roster's primary signal (the status SSE, folded by client-core's
// useLiveRoster). It adds the two browser-native "the tab is back / is being
// watched" signals the SSE can't provide:
//   1. a `window` `focus` → an immediate `reload` (the owner tabbed back to the
//      staging screen — refresh the roster now, don't wait for a poll).
//   2. a SLOW poll (default 15s) that runs ONLY while the tab is visible, paused on
//      `visibilitychange` to hidden (spec §3, "a slow poll while foregrounded") — a
//      coarse safety net for a stream that dropped without recovering, without
//      burning a request on a backgrounded tab.
//
// It lives under `src/platform/web/**` — the ONE place the web app may touch a
// browser global (R1) — so the screen consumes it as a plain `(reload) => void` and
// a native shell slots its own impl in later behind the same signature.

const DEFAULT_POLL_MS = 15_000

/** Reload on foreground focus + a visibility-gated slow poll. `reload` should be a
 *  stable reference (the effect re-subscribes if it changes). */
export function useForegroundRefetch(reload: () => void, pollMs: number = DEFAULT_POLL_MS): void {
  useEffect(() => {
    let intervalId: ReturnType<typeof setInterval> | undefined

    const stopPoll = (): void => {
      if (intervalId !== undefined) {
        clearInterval(intervalId)
        intervalId = undefined
      }
    }
    // Poll only while foregrounded: start the interval when visible, clear it when
    // hidden. Idempotent — a redundant visibilitychange never doubles the interval.
    const syncPoll = (): void => {
      if (document.hidden) {
        stopPoll()
      } else {
        intervalId ??= setInterval(reload, pollMs)
      }
    }
    const onFocus = (): void => {
      reload()
    }

    window.addEventListener('focus', onFocus)
    document.addEventListener('visibilitychange', syncPoll)
    syncPoll()

    return () => {
      window.removeEventListener('focus', onFocus)
      document.removeEventListener('visibilitychange', syncPoll)
      stopPoll()
    }
  }, [reload, pollMs])
}
