import { useEffect, useRef, useState } from 'react'

// useWhisperCycle — the loading-surface flavor rotation, shared by the two
// long-wait screens (WorldGenLoading + SessionPreparing; ux-run2 myth-i2pdo
// extracted it from WorldGenLoading so both cycle one way). A SHUFFLED
// permutation (Fisher-Yates over the injectable `random` — the FogSim pattern;
// UI jitter, not game mechanics) walked to exhaustion and re-shuffled, with the
// reshuffle's head swapped away when it matches the just-shown line, so no line
// ever repeats back-to-back across the boundary. Every line shows once before
// any shows twice.
//
// THE LEDGER (myth-i2pdo — "the growing list IS the progress indicator"): each
// advance settles the previous line into `history` (newest first, capped), so
// the surface can stack past whispers as a faint ledger beneath the current one
// — texture that a wait has been LIVED through, not just endured.
//
// REDUCED MOTION: when `prefers-reduced-motion` is set, no interval starts —
// the opening line holds and the ledger stays empty (a timed text swap is
// motion enough to respect the preference). The media-query subscription stays
// live, so a runtime toggle starts/stops the rotation.

const REDUCED_MOTION_QUERY = '(prefers-reduced-motion: reduce)'

// Read the current reduced-motion preference (web-only package, so `window` and
// `matchMedia` exist; guarded for any non-window environment).
function prefersReducedMotion(): boolean {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return false
  return window.matchMedia(REDUCED_MOTION_QUERY).matches
}

/** The live reduced-motion preference as state — initialized from the media
 *  query and kept in sync (the Spinner pattern), for composing components whose
 *  OWN motion (e.g. a BeatFigure) needs the boolean alongside the cycle. */
export function useReducedMotionPref(): boolean {
  const [reduced, setReduced] = useState(prefersReducedMotion)
  useEffect(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return
    const mql = window.matchMedia(REDUCED_MOTION_QUERY)
    const onChange = (): void => {
      setReduced(mql.matches)
    }
    mql.addEventListener('change', onChange)
    return () => {
      mql.removeEventListener('change', onChange)
    }
  }, [])
  return reduced
}

/** A random permutation of `[0, count)` (Fisher-Yates over the injected RNG).
 *  When the fresh permutation's head matches `avoidFirst` (the just-shown
 *  line), the head swaps to the tail — no immediate repeat across a reshuffle
 *  boundary. The `?? i`/`?? 0` fallbacks are unreachable (indices are in
 *  range) but keep the indexed access honest under noUncheckedIndexedAccess. */
function shuffledOrder(count: number, random: () => number, avoidFirst?: number): number[] {
  const order = Array.from({ length: count }, (_, i) => i)
  for (let i = count - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1))
    const swapped = order[j] ?? j
    // `order[i]` reads an index < count, and the seeded 0..count-1 range never
    // holes (even an out-of-contract RNG only extends the array at indices
    // ≥ count) — the `?? i` arm is a noUncheckedIndexedAccess artifact,
    // unreachable at runtime.
    /* v8 ignore next */
    order[j] = order[i] ?? i
    order[i] = swapped
  }
  if (count > 1 && order[0] === avoidFirst) {
    // Indices 0 and count-1 are inside the always-populated 0..count-1 range
    // (holes can only sit at indices ≥ count), so both `?? 0` arms are
    // noUncheckedIndexedAccess artifacts, unreachable at runtime.
    /* v8 ignore next 2 */
    const head = order[0] ?? 0
    order[0] = order[count - 1] ?? 0
    order[count - 1] = head
  }
  return order
}

/** The cycler's position (the current permutation + where in it we are) plus
 *  the settled-ledger indices (newest first, capped by the hook). */
interface Cycle {
  readonly order: readonly number[]
  readonly pos: number
  readonly history: readonly number[]
}

/** One tick: settle the shown line into the ledger, then walk the permutation;
 *  on exhaustion re-shuffle, barring an immediate repeat of the line just
 *  shown (the old permutation's tail). */
function advanceCycle(cycle: Cycle, count: number, random: () => number, maxHistory: number): Cycle {
  const shown = cycle.order[cycle.pos]
  const history =
    shown === undefined ? cycle.history : [shown, ...cycle.history].slice(0, maxHistory)
  const next = cycle.pos + 1
  if (next < cycle.order.length) return { order: cycle.order, pos: next, history }
  const justShown = cycle.order[cycle.order.length - 1]
  return { order: shuffledOrder(count, random, justShown), pos: 0, history }
}

export interface WhisperCycle {
  /** The line currently showing (undefined only when `labels` is empty). */
  readonly current: string | undefined
  /** Previously shown lines, NEWEST FIRST, capped — the faint ledger. */
  readonly history: readonly string[]
}

/**
 * Cycle `labels` every `intervalMs`, accumulating shown lines into a capped
 * ledger. Identity churn on `labels` is ignored (only a COUNT change re-seeds,
 * so a parent that rebuilds the array every render never resets the rotation);
 * the same rule applies to `random`.
 */
export function useWhisperCycle(
  labels: readonly string[],
  intervalMs: number,
  random: () => number,
  maxHistory = 4,
): WhisperCycle {
  const count = labels.length
  // Lazily seeded so the OPENING line is already the shuffle's (no first-paint
  // flash of the listed order).
  const [cycle, setCycle] = useState<Cycle>(() => ({
    order: shuffledOrder(count, random),
    pos: 0,
    history: [],
  }))
  const reduced = useReducedMotionPref()
  // The latest RNG, read inside the interval — a consumer passing an inline fn
  // must not restart (and thereby reset) the rotation every render.
  const randomRef = useRef(random)
  useEffect(() => {
    randomRef.current = random
  }, [random])

  // Re-seed the permutation only when the label COUNT changes.
  useEffect(() => {
    setCycle((c) =>
      c.order.length === count
        ? c
        : { order: shuffledOrder(count, randomRef.current), pos: 0, history: [] },
    )
  }, [count])

  // The cycler. No interval under reduced motion (the opening line holds) or
  // when there's nothing to rotate through (0–1 lines).
  useEffect(() => {
    if (reduced || count < 2) return
    const id = window.setInterval(() => {
      setCycle((c) => advanceCycle(c, count, randomRef.current, maxHistory))
    }, intervalMs)
    return () => {
      window.clearInterval(id)
    }
  }, [reduced, count, intervalMs, maxHistory])

  const currentIndex = cycle.order[cycle.pos] ?? 0
  return {
    current: count > 0 ? labels[currentIndex % count] : undefined,
    history: cycle.history.map((i) => labels[i % count] ?? '').filter((l) => l !== ''),
  }
}
