import { forwardRef, useEffect, useState } from 'react'
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
// THE REVEAL BEAT: when entities start streaming, the consumer flips
// `revealReady` and the screen grows the "watch your world be born" button.
// Generation keeps running regardless — pressing it only fires `onReveal` (the
// consumer swaps to the graph view). The screen never transitions on its own.
//
// REDUCED MOTION: the Spinner degrades itself to a static dither; the CYCLER
// also respects `prefers-reduced-motion` — when reduced, no interval starts and
// the first flavor line holds (a timed text swap is motion enough to respect the
// preference). The subscription mirrors Spinner's, so a runtime toggle
// starts/stops the rotation.
//
// a11y: the Spinner's `role="status"` + `spinnerLabel` carry the busy meaning to
// AT. The flavor line is DECORATIVE prose (not a live region — announcing a new
// line every few seconds would be noise), so it is aria-hidden; the reveal
// button is a real DS Button. The vertical footprint matches the graph pane's
// (`clamp(18rem,62dvh,46rem)`) so the act-one → act-two swap doesn't jump.

const DEFAULT_INTERVAL_MS = 3000

const SCREEN_CLASS = cn(
  'flex min-h-[clamp(18rem,62dvh,46rem)] w-full min-w-0 flex-col items-center justify-center',
  'gap-[var(--space-5)] p-[var(--space-6)] text-center',
)
const FLAVOR_CLASS = 'font-body text-sm text-ink-secondary leading-[1.4] max-w-[24rem]'

const REDUCED_MOTION_QUERY = '(prefers-reduced-motion: reduce)'

// Read the current reduced-motion preference (web-only package, so `window` and
// `matchMedia` exist; guarded for any non-window environment).
function prefersReducedMotion(): boolean {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return false
  return window.matchMedia(REDUCED_MOTION_QUERY).matches
}

export const WorldGenLoading = forwardRef<HTMLDivElement, WorldGenLoadingProps>(
  function WorldGenLoading(
    {
      flavorLabels,
      intervalMs = DEFAULT_INTERVAL_MS,
      spinnerLabel,
      revealReady = false,
      revealLabel = '[ph: watch your world be born]',
      onReveal,
      'data-testid': dataTestId,
    },
    ref,
  ) {
    const [index, setIndex] = useState(0)
    // Whether motion is reduced — initialized from the media query, kept in sync
    // (same pattern as Spinner) so a runtime toggle starts/stops the cycler.
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

    // The cycler. Keyed on the COUNT (not the array identity) so a parent that
    // rebuilds the label array every render doesn't reset the rotation. No interval
    // under reduced motion (the first line holds) or when there's nothing to
    // rotate through (0–1 lines).
    const count = flavorLabels.length
    useEffect(() => {
      setIndex(0)
      if (reduced || count < 2) return
      const id = window.setInterval(() => {
        setIndex((i) => (i + 1) % count)
      }, intervalMs)
      return () => {
        window.clearInterval(id)
      }
    }, [reduced, count, intervalMs])

    const flavor = count > 0 ? flavorLabels[index % count] : undefined

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
        {revealReady && (
          <Button
            data-testid="worldgen-loading-reveal"
            {...(onReveal !== undefined ? { onPress: onReveal } : {})}
          >
            {revealLabel}
          </Button>
        )}
      </div>
    )
  },
)
