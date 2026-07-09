import { afterEach, describe, expect, it, vi } from 'vitest'
import { render } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { axe } from 'jest-axe'
import type { GraphEdge, GraphNode } from '@mythrun/client-core/contract'
import { MAX_DENSITY_EDGES, MAX_DENSITY_NODES } from './max-density-fixture.ts'
import { WorldGenGraph } from './WorldGenGraph.tsx'

// WorldGenGraph has TWO phases (§3.4). The DEFAULT is the GENERATION graph — a fog layer
// behind mono-ink glyphs, GATED: no selection (the fog is the ambient animation; selection
// belongs to the reveal). The REVEAL opts in with `interactive`, which wires Canvas
// tap-to-select. NEITHER phase renders an entity list (MYT-89 audit v3 killed it — the
// wiki is the browse surface); the canvases are decorative under jsdom (getContext
// stubbed), so the testable DOM surface is layout classes + the camera's touch-action.

const node = (synthKey: string, kind: string, name: string): GraphNode => ({
  synthKey,
  kind,
  name,
  displayId: synthKey,
  state: 'live',
  lastEventIndex: 0,
})

const FIXTURE: GraphNode[] = [
  node('s1/reach', 'location', 'Ashfen Reach'),
  node('s2/maeris', 'npc', 'Maeris Vale'),
  node('s3/guild', 'faction', 'The Tallow Guild'),
]
const EDGES: GraphEdge[] = [
  { synthKey: 'e1', from: 's2/maeris', to: 's3/guild', relationship: 'leads', arrivalIndex: 0, sourceStage: 'weave' },
]

/** A permissive fake 2D context: methods are no-ops, property writes are absorbed, and
 *  `measureText` returns a plausible width — enough for the fog's obstacle build + the
 *  draw paths to run under jsdom (whose real getContext returns null) so the rAF/settle
 *  behaviour is observable without throwing. */
function fakeCtx(): CanvasRenderingContext2D {
  return new Proxy(
    {},
    {
      get: (_t, prop) => (prop === 'measureText' ? (s: string) => ({ width: s.length * 7 }) : () => undefined),
      set: () => true,
    },
  ) as unknown as CanvasRenderingContext2D
}

/** Stub HTMLCanvasElement.getContext for one test (restored by afterEach). */
function stubGetContext(value: CanvasRenderingContext2D | null): void {
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(value)
}

/** Stub `matchMedia` to a chosen viewport regime (jsdom has none). `narrow: true`
 *  fails the wide query (`min-width: 640px`) — the phone form factor; other queries
 *  (`pointer: fine`) report `matches` so pointer paths stay live. The MQL carries
 *  listener no-ops (useViewportNarrow subscribes to runtime changes). */
function stubViewport(narrow: boolean): void {
  vi.stubGlobal(
    'matchMedia',
    vi.fn().mockImplementation((query: string) => ({
      matches: query === '(min-width: 640px)' ? !narrow : true,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    })),
  )
}

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

describe('WorldGenGraph — generation gate (§3.4)', () => {
  it('does NOT render the entity list during generation (the default, gated)', () => {
    stubGetContext(null)
    const { queryByRole, queryAllByRole } = render(
      <WorldGenGraph nodes={FIXTURE} edges={EDGES} onSelect={vi.fn()} />,
    )
    expect(queryByRole('list')).toBeNull()
    expect(queryAllByRole('button')).toHaveLength(0)
  })

  it('node selection is inert during generation (no list surface to fire onSelect)', async () => {
    stubGetContext(null)
    const onSelect = vi.fn()
    const user = userEvent.setup()
    const { queryByText } = render(<WorldGenGraph nodes={FIXTURE} edges={EDGES} onSelect={onSelect} />)
    // Names are NOT rendered as selectable list items during generation, and the Canvas
    // is a jsdom no-op — so there is nothing to activate and onSelect can never fire.
    const maeris = queryByText('Maeris Vale')
    if (maeris !== null) await user.click(maeris)
    expect(onSelect).not.toHaveBeenCalled()
  })

  it('still renders the decorative canvases (fog + graph), aria-hidden', () => {
    stubGetContext(null)
    const { container } = render(<WorldGenGraph nodes={FIXTURE} edges={EDGES} onSelect={vi.fn()} />)
    const canvases = container.querySelectorAll('canvas')
    expect(canvases.length).toBeGreaterThanOrEqual(2) // fog behind + graph on top
    for (const canvas of canvases) expect(canvas).toHaveAttribute('aria-hidden', 'true')
  })

  it('has no a11y violations while generating (decorative aria-hidden layers only)', async () => {
    stubGetContext(null)
    const { container } = render(<WorldGenGraph nodes={FIXTURE} edges={EDGES} onSelect={vi.fn()} />)
    expect(await axe(container)).toHaveNoViolations()
  })
})

describe('WorldGenGraph — reveal (interactive): no entity list (MYT-89 audit v3)', () => {
  // The list was the reveal's browse surface until the wiki replaced it; audit v3
  // removed it outright. The reveal graph renders NO list and NO buttons on either
  // breakpoint — the canvases own the whole pane.
  it('renders no list and no buttons on a wide viewport', () => {
    stubViewport(false)
    stubGetContext(null)
    const { queryByRole, queryAllByRole } = render(
      <WorldGenGraph interactive nodes={FIXTURE} edges={EDGES} onSelect={vi.fn()} />,
    )
    expect(queryByRole('list')).toBeNull()
    expect(queryAllByRole('button')).toHaveLength(0)
  })

  it('renders no list and no buttons on a narrow viewport (nothing stacks below the pane)', () => {
    stubViewport(true)
    stubGetContext(null)
    const { queryByRole, queryAllByRole, container } = render(
      <WorldGenGraph interactive nodes={FIXTURE} edges={EDGES} onSelect={vi.fn()} />,
    )
    expect(queryByRole('list')).toBeNull()
    expect(queryAllByRole('button')).toHaveLength(0)
    // The pane's band is the root's only child — no sibling surface stacked after it.
    const band = container.querySelector('canvas')?.parentElement?.parentElement
    expect(band?.parentElement?.childElementCount).toBe(1)
  })

  it('has no a11y violations (decorative aria-hidden layers only)', async () => {
    stubGetContext(null)
    const { container } = render(
      <WorldGenGraph interactive nodes={FIXTURE} edges={EDGES} selectedKey="s1/reach" onSelect={vi.fn()} />,
    )
    expect(await axe(container)).toHaveNoViolations()
  })
})

describe('WorldGenGraph — fillHost (MYT-89 audit v3: the reveal pane fills its half)', () => {
  it('fillHost: the root fills the host and the pane flexes instead of the viewport clamp', () => {
    stubViewport(false)
    stubGetContext(null)
    const { container } = render(
      <WorldGenGraph interactive fillHost nodes={FIXTURE} edges={EDGES} onSelect={vi.fn()} />,
    )
    const pane = container.querySelector('canvas')?.parentElement
    expect(pane?.className).toMatch(/flex-1/)
    expect(pane?.className).not.toMatch(/clamp/)
    const band = pane?.parentElement
    expect(band?.className).toMatch(/flex-col/)
    expect(band?.parentElement?.className).toMatch(/h-full/)
    // The desktop band keeps its breathing-room inset (only NARROW drops it).
    expect(band?.className).toMatch(/p-\[var\(--space-4\)\]/)
  })

  it('default (no fillHost): the viewport clamp stays (the shipped layout)', () => {
    stubViewport(false)
    stubGetContext(null)
    const { container } = render(
      <WorldGenGraph interactive nodes={FIXTURE} edges={EDGES} onSelect={vi.fn()} />,
    )
    const pane = container.querySelector('canvas')?.parentElement
    expect(pane?.className).toMatch(/clamp/)
    expect(pane?.parentElement?.parentElement?.className).not.toMatch(/h-full/)
  })
})

describe('WorldGenGraph — pannable (MYT-89 audit v3: the camera gate)', () => {
  // The camera engages GEOMETRICALLY (the seat: the pane can't seat every label);
  // `pannable={false}` zeroes the seat so the world never outgrows the pane —
  // the reveal's desktop half must fill, not pan. Observable through the DOM:
  // `trackWorldDims` stamps `data-camera-engaged` on the canvas exactly with
  // engagement (jsdom's CSSStyleDeclaration drops the touch-action flip, so the
  // attribute is the one observable both jsdom and the browser drag-proof share).
  // A measured pane (mocked rect) + the realistic 46-entity fixture triggers the
  // seat: 46 × areaPerLabel (15000) far exceeds a 600×600 pane's 1:1 space.
  function mockPaneRect(width: number, height: number): void {
    const rect: DOMRect = {
      x: 0, y: 0, top: 0, left: 0, right: width, bottom: height,
      width, height,
      toJSON: () => ({}),
    }
    vi.spyOn(HTMLCanvasElement.prototype, 'getBoundingClientRect').mockReturnValue(rect)
  }

  it('default: the camera engages when the world outgrows the pane (touch-action: none)', () => {
    stubViewport(false)
    stubGetContext(null)
    mockPaneRect(600, 600)
    const { container } = render(
      <WorldGenGraph
        interactive
        nodes={[...MAX_DENSITY_NODES]}
        edges={[...MAX_DENSITY_EDGES]}
        onSelect={vi.fn()}
      />,
    )
    const canvas = container.querySelector('canvas[data-camera-engaged]')
    expect(canvas?.getAttribute('data-camera-engaged')).toBe('true')
  })

  it('pannable={false}: the camera NEVER engages at the same density (the world fills the pane)', () => {
    stubViewport(false)
    stubGetContext(null)
    mockPaneRect(600, 600)
    const { container } = render(
      <WorldGenGraph
        interactive
        pannable={false}
        nodes={[...MAX_DENSITY_NODES]}
        edges={[...MAX_DENSITY_EDGES]}
        onSelect={vi.fn()}
      />,
    )
    const canvas = container.querySelector('canvas[data-camera-engaged]')
    expect(canvas?.getAttribute('data-camera-engaged')).toBe('false')
  })
})

// A minimal status payload (the layout tests only care WHERE the card renders,
// not what it shows — the card's own tests own that).
const STATUS = { stages: [] }

describe('WorldGenGraph — narrow-viewport layout (MYT-89 audit v2: full-bleed + footer)', () => {
  // On a phone-class viewport (< 640px — the DS's one narrow regime, the same
  // boundary the reveal's entity list stacks at) the generation graph goes
  // FULL-BLEED: the 16px band is dropped and the status card leaves the canvas
  // for a compact footer BELOW the pane (no in-canvas overlay → no sim keep-out).
  // Desktop keeps the shipped layout exactly. The flip is form-factor-driven
  // (a media condition) — NEVER camera-engagement-driven.

  it('narrow + status: the card is a FOOTER below the pane, not an in-canvas overlay', () => {
    stubViewport(true)
    stubGetContext(null)
    const { container } = render(
      <WorldGenGraph nodes={FIXTURE} edges={EDGES} onSelect={vi.fn()} status={STATUS} />,
    )
    const footer = container.querySelector('[data-variant="footer"]')
    expect(footer).not.toBeNull()
    expect(container.querySelector('[data-variant="overlay"]')).toBeNull()
    // The footer lives OUTSIDE the pane box (the canvases' shared parent) — the
    // status is page chrome now, never occluding the world.
    const pane = container.querySelector('canvas')?.parentElement
    expect(pane?.contains(footer)).toBe(false)
  })

  it('narrow: the band is gone — the pane goes edge-to-edge (reaches the reveal too)', () => {
    stubViewport(true)
    stubGetContext(null)
    const { container } = render(<WorldGenGraph nodes={FIXTURE} edges={EDGES} onSelect={vi.fn()} />)
    const band = container.querySelector('canvas')?.parentElement?.parentElement
    expect(band?.className).not.toMatch(/p-\[var\(--space-4\)\]/)
  })

  it('narrow + status: the pane FLEXES to fill the stage instead of the viewport clamp', () => {
    stubViewport(true)
    stubGetContext(null)
    const { container } = render(
      <WorldGenGraph nodes={FIXTURE} edges={EDGES} onSelect={vi.fn()} status={STATUS} />,
    )
    const pane = container.querySelector('canvas')?.parentElement
    expect(pane?.className).toMatch(/flex-1/)
    expect(pane?.className).not.toMatch(/clamp/)
  })

  it('narrow WITHOUT status (the reveal): no footer, and the clamp height stays', () => {
    stubViewport(true)
    stubGetContext(null)
    const { container } = render(<WorldGenGraph nodes={FIXTURE} edges={EDGES} onSelect={vi.fn()} />)
    expect(container.querySelector('[data-variant="footer"]')).toBeNull()
    const pane = container.querySelector('canvas')?.parentElement
    expect(pane?.className).toMatch(/clamp/)
  })

  it('desktop + status: the shipped layout exactly — overlay in the pane, band on, no footer', () => {
    stubViewport(false)
    stubGetContext(null)
    const { container } = render(
      <WorldGenGraph nodes={FIXTURE} edges={EDGES} onSelect={vi.fn()} status={STATUS} />,
    )
    const overlay = container.querySelector('[data-variant="overlay"]')
    expect(overlay).not.toBeNull()
    const pane = container.querySelector('canvas')?.parentElement
    expect(pane?.contains(overlay)).toBe(true)
    expect(container.querySelector('[data-variant="footer"]')).toBeNull()
    const band = pane?.parentElement
    expect(band?.className).toMatch(/p-\[var\(--space-4\)\]/)
    expect(pane?.className).toMatch(/clamp/)
  })
})

describe('WorldGenGraph — motion contract', () => {
  it('reducedMotion renders WITHOUT starting a requestAnimationFrame loop', () => {
    stubGetContext(fakeCtx())
    const raf = vi.spyOn(window, 'requestAnimationFrame').mockReturnValue(1)
    render(<WorldGenGraph nodes={FIXTURE} edges={EDGES} onSelect={vi.fn()} reducedMotion />)
    // Static settle-to-convergence redraw only — no rAF churn (graph OR fog).
    expect(raf).not.toHaveBeenCalled()
  })

  it('starts (and on unmount cancels) a rAF loop when motion is allowed', () => {
    stubGetContext(fakeCtx())
    const raf = vi.spyOn(window, 'requestAnimationFrame').mockReturnValue(1)
    const caf = vi.spyOn(window, 'cancelAnimationFrame').mockImplementation(() => undefined)
    const { unmount } = render(<WorldGenGraph nodes={FIXTURE} edges={EDGES} onSelect={vi.fn()} />)
    expect(raf).toHaveBeenCalled()
    unmount()
    expect(caf).toHaveBeenCalled()
  })
})

// A recording context that logs every `fillText` text and returns a plausible
// `measureText` width — enough for one motion frame of the graph + fog loops to run
// under jsdom without throwing, so the drawn labels are observable.
function labelRecordingCtx(texts: string[]): CanvasRenderingContext2D {
  return new Proxy(
    {},
    {
      get: (_t, prop) => {
        if (prop === 'measureText') return (s: string) => ({ width: s.length * 7 })
        if (prop === 'fillText')
          return (text: string) => {
            texts.push(text)
          }
        return () => undefined
      },
      set: () => true,
    },
  ) as unknown as CanvasRenderingContext2D
}

describe('WorldGenGraph — generation labels + drag (MYT-89 audit #3 / #5)', () => {
  it('draws the node NAMES during generation (labels decoupled from interactive — #3)', () => {
    const texts: string[] = []
    stubGetContext(labelRecordingCtx(texts))
    // Capture the rAF callbacks WITHOUT running them synchronously, then drive exactly one
    // frame of each registered loop (graph + fog). Only the graph fillTexts entity names.
    const frames: FrameRequestCallback[] = []
    vi.spyOn(window, 'requestAnimationFrame').mockImplementation((cb) => frames.push(cb))
    render(<WorldGenGraph nodes={FIXTURE} edges={EDGES} onSelect={vi.fn()} />) // interactive defaults false (gen)
    frames.slice().forEach((cb) => {
      cb(16)
    })
    for (const n of FIXTURE) expect(texts).toContain(n.name)
    // The kind is conveyed by the glyph SHAPE, never drawn as a text tag.
    expect(texts).not.toContain('location')
  })

  it('attaches Canvas pointer handlers DURING generation (drag decoupled from #5)', () => {
    // A fine pointer is required for Canvas drag; jsdom has no matchMedia, so stub it
    // (wide regime — the shipped desktop layout; `pointer: fine` matches).
    stubViewport(false)
    stubGetContext(fakeCtx())
    vi.spyOn(window, 'requestAnimationFrame').mockReturnValue(1)
    const addSpy = vi.spyOn(HTMLCanvasElement.prototype, 'addEventListener')
    render(<WorldGenGraph nodes={FIXTURE} edges={EDGES} onSelect={vi.fn()} />) // gen (interactive false)
    const attachedDrag = addSpy.mock.calls.some(([type]) => type === 'pointerdown')
    expect(attachedDrag).toBe(true) // the pre-fix effect gated this off during generation
  })
})
