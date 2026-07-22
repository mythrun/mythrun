import { forwardRef, useEffect, useRef, useState } from 'react'
import type { WorldGenLoadingProps } from '@mythrun/client-core/contract'
import { cn } from '../../lib/cn.ts'
import { Spinner } from '../Spinner/Spinner.tsx'
import { Button } from '../Button/Button.tsx'

// WorldGenLoading (MYT-89 two-act generating flow, act ONE) — the generic
// pre-entity loading screen. While the prep stages (concept_intake → world_color
// → vocabulary_intake) run there is NOTHING to draw — no entities, no graph — so
// this surface holds the beat: the DS Spinner (the brand's locked diagonal
// dither wave) over a single FLAVOR line that cycles short playful loading
// messages every few seconds (Claude-Code-"thinking" style). A hard text swap,
// deliberately unanimated — the brand's only sanctioned motion is an opacity
// fade, and the Spinner already owns the screen's motion.
//
// THE RANDOM CYCLE (MYT-89 waiting-feedback): the line order is a SHUFFLED
// permutation (Fisher-Yates over the injectable `random`, default Math.random —
// the FogSim pattern; UI jitter, not game mechanics), walked to exhaustion and
// re-shuffled — with the reshuffle's head swapped away when it matches the
// just-shown line, so no line ever repeats back-to-back across the boundary.
// Every line shows once before any shows twice.
//
// THE COUNTDOWN (MYT-89 waiting-feedback): under the flavor line, an optional
// `countdownLabel` — the consumer-ticked per-second `~M:SS` to the wiki reveal
// (derived from `remainingWaitMs` over the stage-timings history). This screen
// only RENDERS it; the consumer owns the 1s interval + formatting and
// re-supplies the string each second. A quiet mono/tabular line — no urgency
// theatrics; omitted on cold-start (no history), the surface degrades to
// flavor-only.
//
// THE WATCH BEAT: when entities start streaming, the consumer flips
// `watchReady` and the screen grows the "watch your world be born" button.
// Generation keeps running regardless — pressing it only fires `onWatch` (the
// consumer swaps to the graph view). The screen never transitions on its own.
//
// REDUCED MOTION: the Spinner degrades itself to a static dither; the CYCLER
// also respects `prefers-reduced-motion` — when reduced, no interval starts and
// the OPENING flavor line holds (a timed text swap is motion enough to respect
// the preference). The countdown is NOT gated on it — the ticking number is
// CONTENT (the remaining wait), not decoration; freezing it would show a wrong
// number. The subscription mirrors Spinner's, so a runtime toggle starts/stops
// the rotation.
//
// a11y: the Spinner's `role="status"` + `spinnerLabel` carry the busy meaning to
// AT. The flavor line is DECORATIVE prose and the countdown changes EVERY SECOND
// (a live region would be noise), so both are aria-hidden; the watch button is a
// real DS Button. The vertical footprint matches the graph pane's
// (`clamp(18rem,62dvh,46rem)`) so the act-one → act-two swap doesn't jump.

const DEFAULT_INTERVAL_MS = 3000

const SCREEN_CLASS = cn(
  'flex min-h-[clamp(18rem,62dvh,46rem)] w-full min-w-0 flex-col items-center justify-center',
  'gap-[var(--space-5)] p-[var(--space-6)] text-center',
)
const FLAVOR_CLASS = 'font-body text-sm text-ink-secondary leading-[1.4] max-w-[24rem]'
// The countdown: quiet mono/tabular, paper register — mirrors the status card's
// countdown line so the two waiting surfaces read as one voice.
const COUNTDOWN_CLASS = 'font-ui text-xs tabular-nums text-ink-tertiary leading-none'

const REDUCED_MOTION_QUERY = '(prefers-reduced-motion: reduce)'

// Read the current reduced-motion preference (web-only package, so `window` and
// `matchMedia` exist; guarded for any non-window environment).
function prefersReducedMotion(): boolean {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return false
  return window.matchMedia(REDUCED_MOTION_QUERY).matches
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
    order[j] = order[i] ?? i
    order[i] = swapped
  }
  if (count > 1 && order[0] === avoidFirst) {
    const head = order[0] ?? 0
    order[0] = order[count - 1] ?? 0
    order[count - 1] = head
  }
  return order
}

/** The cycler's position: the current permutation + where in it we are. */
interface Cycle {
  readonly order: readonly number[]
  readonly pos: number
}

/** One tick: walk the permutation; on exhaustion re-shuffle, barring an
 *  immediate repeat of the line just shown (the old permutation's tail). */
function advanceCycle(cycle: Cycle, count: number, random: () => number): Cycle {
  const next = cycle.pos + 1
  if (next < cycle.order.length) return { order: cycle.order, pos: next }
  const justShown = cycle.order[cycle.order.length - 1]
  return { order: shuffledOrder(count, random, justShown), pos: 0 }
}

export const WorldGenLoading = forwardRef<HTMLDivElement, WorldGenLoadingProps>(
  function WorldGenLoading(
    {
      flavorLabels,
      intervalMs = DEFAULT_INTERVAL_MS,
      random = Math.random,
      countdownLabel,
      spinnerLabel,
      watchReady = false,
      watchLabel,
      onWatch,
      'data-testid': dataTestId,
    },
    ref,
  ) {
    const count = flavorLabels.length
    // The permutation + position. Lazily seeded so the OPENING line is already
    // the shuffle's (no first-paint flash of the listed order).
    const [cycle, setCycle] = useState<Cycle>(() => ({
      order: shuffledOrder(count, random),
      pos: 0,
    }))
    // Whether motion is reduced — initialized from the media query, kept in sync
    // (same pattern as Spinner) so a runtime toggle starts/stops the cycler.
    const [reduced, setReduced] = useState(prefersReducedMotion)
    // The latest RNG, read inside the interval — a consumer passing an inline
    // fn must not restart (and thereby reset) the rotation every render.
    const randomRef = useRef(random)
    useEffect(() => {
      randomRef.current = random
    }, [random])

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

    // Re-seed the permutation only when the label COUNT changes (identity churn
    // ignored — a parent that rebuilds the array every render must not reset
    // the rotation).
    useEffect(() => {
      setCycle((c) =>
        c.order.length === count ? c : { order: shuffledOrder(count, randomRef.current), pos: 0 },
      )
    }, [count])

    // The cycler. No interval under reduced motion (the opening line holds) or
    // when there's nothing to rotate through (0–1 lines).
    useEffect(() => {
      if (reduced || count < 2) return
      const id = window.setInterval(() => {
        setCycle((c) => advanceCycle(c, count, randomRef.current))
      }, intervalMs)
      return () => {
        window.clearInterval(id)
      }
    }, [reduced, count, intervalMs])

    const flavorIndex = cycle.order[cycle.pos] ?? 0
    const flavor = count > 0 ? flavorLabels[flavorIndex % count] : undefined

    return (
      <div
        ref={ref}
        {...(dataTestId !== undefined ? { 'data-testid': dataTestId } : {})}
        className={SCREEN_CLASS}
      >
        <Spinner size="lg" {...(spinnerLabel !== undefined ? { label: spinnerLabel } : {})} />
        {flavor !== undefined && (
          <p aria-hidden="true" data-testid="worldgen-loading-flavor" className={FLAVOR_CLASS}>
            {flavor}
          </p>
        )}
        {countdownLabel !== undefined && (
          <p
            aria-hidden="true"
            data-testid="worldgen-loading-countdown"
            className={COUNTDOWN_CLASS}
          >
            {countdownLabel}
          </p>
        )}
        {watchReady && (
          <Button
            data-testid="worldgen-loading-watch"
            {...(onWatch !== undefined ? { onPress: onWatch } : {})}
          >
            {watchLabel}
          </Button>
        )}
      </div>
    )
  },
)
