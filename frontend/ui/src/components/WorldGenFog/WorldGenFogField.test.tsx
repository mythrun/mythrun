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

function stubGetContext(value: CanvasRenderingContext2D | null): void {
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(value)
}

afterEach(() => {
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

  it('re-settles statically when the shown-entity count changes (reduced motion)', () => {
    stubGetContext(fakeCtx())
    const raf = vi.spyOn(window, 'requestAnimationFrame').mockReturnValue(1)
    const { rerender } = render(<WorldGenFogField {...BASE} shownEntities={2} reducedMotion />)
    rerender(<WorldGenFogField {...BASE} shownEntities={3} reducedMotion />)
    // Still no rAF — the fade-progress repaint is a synchronous settle, not a loop.
    expect(raf).not.toHaveBeenCalled()
  })
})
