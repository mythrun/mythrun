import { afterEach, describe, expect, it, vi } from 'vitest'
import { render } from '@testing-library/react'
import { axe } from 'jest-axe'
import type { FogFieldEntity } from '@mythrun/client-core/contract'
import { WorldGenFogField } from './WorldGenFogField.tsx'

// WorldGenFogField is a DECORATIVE fog canvas (aria-hidden — jsdom can't paint it), so
// its whole testable contract is structural: the aria-hidden layer, the ref/testid
// wiring, and the MOTION contract (a rAF loop when motion is allowed; a static settle,
// NO rAF, under reduced motion). Pixel output is out of scope (getContext is null under
// jsdom; we stub a permissive context so the draw paths run without throwing).

const ENTITIES: FogFieldEntity[] = [
  { x: 270, y: 141, kind: 'LOCATION', name: 'Stillwater' },
  { x: 558, y: 178, kind: 'LOCATION', name: 'Belltoe' },
  { x: 396, y: 282, kind: 'FACTION', name: 'Bell-Wardens' },
  { x: 648, y: 329, kind: 'NPC', name: 'Abbot Sennel' },
]

/** A permissive fake 2D context: methods are no-ops, property writes are absorbed, and
 *  `measureText` returns a plausible width — enough for the settle/loop draw paths to run
 *  under jsdom (whose real getContext returns null) so the rAF behaviour is observable. */
function fakeCtx(): CanvasRenderingContext2D {
  return new Proxy(
    {},
    {
      get: (_t, prop) => (prop === 'measureText' ? (s: string) => ({ width: s.length * 7 }) : () => undefined),
      set: () => true,
    },
  ) as unknown as CanvasRenderingContext2D
}

/** `fakeCtx`, but counting `fillRect` (painted fog quads) and `clearRect` (one per
 *  repaint) — the probes for the reduced-motion settle wiring tests below. */
function countingCtx(counts: { fillRect: number; clearRect: number }): CanvasRenderingContext2D {
  return new Proxy(
    {},
    {
      get: (_t, prop) => {
        if (prop === 'measureText') return (s: string) => ({ width: s.length * 7 })
        if (prop === 'fillRect')
          return () => {
            counts.fillRect += 1
          }
        if (prop === 'clearRect')
          return () => {
            counts.clearRect += 1
          }
        return () => undefined
      },
      set: () => true,
    },
  ) as unknown as CanvasRenderingContext2D
}

function stubGetContext(value: CanvasRenderingContext2D | null): void {
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(value)
}

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
})

const BASE = { entities: ENTITIES, shownEntities: ENTITIES.length, totalEntities: 12 }

describe('WorldGenFogField — decorative canvas', () => {
  it('renders an aria-hidden canvas (the graph list carries all meaning)', () => {
    stubGetContext(null)
    const { container } = render(<WorldGenFogField {...BASE} />)
    const canvas = container.querySelector('canvas')
    expect(canvas).not.toBeNull()
    expect(canvas).toHaveAttribute('aria-hidden', 'true')
  })

  it('forwards data-testid and the canvas ref to the underlying canvas', () => {
    stubGetContext(null)
    const ref = { current: null as HTMLCanvasElement | null }
    const { getByTestId } = render(<WorldGenFogField {...BASE} ref={ref} data-testid="fog" />)
    expect(getByTestId('fog').tagName).toBe('CANVAS')
    expect(ref.current).toBe(getByTestId('fog'))
  })

  it('has no a11y violations (an aria-hidden decorative layer)', async () => {
    stubGetContext(null)
    const { container } = render(<WorldGenFogField {...BASE} />)
    expect(await axe(container)).toHaveNoViolations()
  })
})

describe('WorldGenFogField — motion contract', () => {
  it('reducedMotion renders WITHOUT starting a requestAnimationFrame loop', () => {
    stubGetContext(fakeCtx())
    const raf = vi.spyOn(window, 'requestAnimationFrame').mockReturnValue(1)
    render(<WorldGenFogField {...BASE} reducedMotion />)
    // A static settle-to-convergence redraw only — no rAF churn.
    expect(raf).not.toHaveBeenCalled()
  })

  it('starts (and on unmount cancels) a rAF loop when motion is allowed', () => {
    stubGetContext(fakeCtx())
    const raf = vi.spyOn(window, 'requestAnimationFrame').mockReturnValue(1)
    const caf = vi.spyOn(window, 'cancelAnimationFrame').mockImplementation(() => undefined)
    const { unmount } = render(<WorldGenFogField {...BASE} />)
    expect(raf).toHaveBeenCalled()
    unmount()
    expect(caf).toHaveBeenCalled()
  })

  it('does not start a loop with no 2D context (jsdom / server) — inert', () => {
    stubGetContext(null)
    const raf = vi.spyOn(window, 'requestAnimationFrame').mockReturnValue(1)
    render(<WorldGenFogField {...BASE} />)
    expect(raf).not.toHaveBeenCalled()
  })

  it('paints an INSTANT amplitude-correct field under reduced motion (the dsm=dens seed wiring)', () => {
    // The static settle runs only a couple of SYNCHRONOUS sub-steps before
    // `settleDensity` snaps the temporal low-pass to converged amplitude (the
    // myth-9w7mw fix). Without the seed those few sub-steps leave the smoothed field
    // at ~6% amplitude and almost nothing clears the dither threshold (~85 painted
    // cells, probe-measured); with it the full converged cloud paints (~2700). The
    // synchronously-painted quad count therefore pins that the seed is actually wired
    // into the reduced-motion path — dropping the `settleDensity` call (or ordering
    // it before the population snap) collapses the count well under the bar.
    const counts = { fillRect: 0, clearRect: 0 }
    stubGetContext(countingCtx(counts))
    render(<WorldGenFogField {...BASE} reducedMotion />)
    expect(counts.fillRect).toBeGreaterThan(1000)
  })

  it('matures the settle in the background and repaints ONCE when converged', () => {
    // The instant seeded frame paints synchronously (one clearRect); the remaining
    // sub-steps of the 120-step budget run as chunked macrotasks (`fog-converge`) and
    // the completion repaint (the second clearRect) swaps in the genuinely converged
    // field. Fake timers drive the whole chunk chain deterministically; the budget is
    // bounded, so no third repaint can arrive.
    vi.useFakeTimers()
    const counts = { fillRect: 0, clearRect: 0 }
    stubGetContext(countingCtx(counts))
    render(<WorldGenFogField {...BASE} reducedMotion />)
    expect(counts.clearRect).toBe(1) // the instant frame
    const instantFills = counts.fillRect
    vi.advanceTimersByTime(10_000)
    expect(counts.clearRect).toBe(2) // the completion repaint — exactly one
    // …and the converged field is still a populated cloud, not a decayed remnant.
    expect(counts.fillRect - instantFills).toBeGreaterThan(1000)
  })

  it('cancels a mid-flight background convergence on unmount (no orphan repaint)', () => {
    vi.useFakeTimers()
    const counts = { fillRect: 0, clearRect: 0 }
    stubGetContext(countingCtx(counts))
    const { unmount } = render(<WorldGenFogField {...BASE} reducedMotion />)
    expect(counts.clearRect).toBe(1)
    unmount()
    vi.advanceTimersByTime(10_000)
    expect(counts.clearRect).toBe(1) // the worker died with the component
  })

  it('re-settles statically when the shown-entity count changes (reduced motion)', () => {
    stubGetContext(fakeCtx())
    const raf = vi.spyOn(window, 'requestAnimationFrame').mockReturnValue(1)
    const { rerender } = render(<WorldGenFogField {...BASE} shownEntities={2} reducedMotion />)
    rerender(<WorldGenFogField {...BASE} shownEntities={3} reducedMotion />)
    // Still no rAF — the drain-progress repaint is a synchronous settle (snapped to
    // the new scaled population), not a loop.
    expect(raf).not.toHaveBeenCalled()
  })
})
