import { afterEach, describe, expect, it, vi } from 'vitest'
import { render } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { axe } from 'jest-axe'
import type { GraphEdge, GraphNode } from '@mythrun/client-core/contract'
import { WorldGenGraph } from './WorldGenGraph.tsx'

// WorldGenGraph has TWO phases (§3.4). The DEFAULT is the GENERATION graph — a fog layer
// behind mono-ink glyphs, GATED: no entity list, no selection (the fog is the ambient
// animation; the list/selection belong to the reveal). The REVEAL opts in with
// `interactive`, which turns on the ACCESSIBLE entity list — the whole testable + a11y +
// selection surface (jsdom can't paint the canvases; we stub getContext either way).

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

// The chrome labels are consumer-supplied (i18n) props — the DS owns no copy. Every
// interactive render passes them; tests that assert on them use these exact values.
const LABELS = { listLabel: 'Entities in your forming world', emptyLabel: 'The world is still taking shape' }

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

describe('WorldGenGraph — reveal (interactive) entity list', () => {
  it('renders one activatable item per node, showing name + kind', () => {
    stubGetContext(null)
    const { getByRole, getByText } = render(
      <WorldGenGraph interactive nodes={FIXTURE} edges={EDGES} onSelect={vi.fn()} {...LABELS} />,
    )
    for (const n of FIXTURE) {
      const item = getByRole('button', { name: new RegExp(n.name) })
      expect(item.tagName).toBe('BUTTON')
      expect(getByText(n.name)).toBeInTheDocument()
      expect(getByText(n.kind)).toBeInTheDocument()
    }
  })

  it('renders exactly one list item per node', () => {
    stubGetContext(null)
    const { getAllByRole } = render(
      <WorldGenGraph interactive nodes={FIXTURE} edges={EDGES} onSelect={vi.fn()} {...LABELS} />,
    )
    expect(getAllByRole('button')).toHaveLength(FIXTURE.length)
  })

  it('calls onSelect(displayId) when an item is activated (click)', async () => {
    stubGetContext(null)
    const onSelect = vi.fn()
    const user = userEvent.setup()
    const { getByRole } = render(
      <WorldGenGraph interactive nodes={FIXTURE} edges={EDGES} onSelect={onSelect} {...LABELS} />,
    )
    await user.click(getByRole('button', { name: /Maeris Vale/ }))
    expect(onSelect).toHaveBeenCalledExactlyOnceWith('s2/maeris')
  })

  it('calls onSelect(displayId) on keyboard activation (Enter)', async () => {
    stubGetContext(null)
    const onSelect = vi.fn()
    const user = userEvent.setup()
    const { getByRole } = render(
      <WorldGenGraph interactive nodes={FIXTURE} edges={EDGES} onSelect={onSelect} {...LABELS} />,
    )
    getByRole('button', { name: /Ashfen Reach/ }).focus()
    await user.keyboard('{Enter}')
    expect(onSelect).toHaveBeenCalledExactlyOnceWith('s1/reach')
  })

  it('selects by displayId (not synthKey) once a node is finalized (BUG 2.1)', async () => {
    // A finalized node whose synthKey ≠ displayId: selection is in displayId space
    // (the entity id), so onSelect emits displayId and aria-current keys on it.
    stubGetContext(null)
    const finalized: GraphNode = {
      synthKey: 'world_and_factions/factions/0',
      kind: 'faction',
      name: 'The Tallow Guild',
      displayId: 'ent-fac-1',
      state: 'finalized',
      lastEventIndex: 0,
    }
    const onSelect = vi.fn()
    const user = userEvent.setup()
    const { getByRole, rerender } = render(
      <WorldGenGraph interactive nodes={[finalized]} edges={[]} onSelect={onSelect} {...LABELS} />,
    )
    await user.click(getByRole('button', { name: /Tallow Guild/ }))
    expect(onSelect).toHaveBeenCalledExactlyOnceWith('ent-fac-1')

    // selectedKey is the displayId → aria-current; the synthKey must NOT match.
    rerender(
      <WorldGenGraph interactive nodes={[finalized]} edges={[]} selectedKey="ent-fac-1" onSelect={onSelect} {...LABELS} />,
    )
    expect(getByRole('button', { name: /Tallow Guild/ })).toHaveAttribute('aria-current', 'true')
    rerender(
      <WorldGenGraph
        interactive
        nodes={[finalized]}
        edges={[]}
        selectedKey="world_and_factions/factions/0"
        onSelect={onSelect}
        {...LABELS}
      />,
    )
    expect(getByRole('button', { name: /Tallow Guild/ })).not.toHaveAttribute('aria-current')
  })

  it('marks the selected item via aria-current', () => {
    stubGetContext(null)
    const { getByRole } = render(
      <WorldGenGraph interactive nodes={FIXTURE} edges={EDGES} selectedKey="s2/maeris" onSelect={vi.fn()} {...LABELS} />,
    )
    expect(getByRole('button', { name: /Maeris Vale/ })).toHaveAttribute('aria-current', 'true')
    expect(getByRole('button', { name: /Ashfen Reach/ })).not.toHaveAttribute('aria-current')
  })

  it('has no a11y violations', async () => {
    stubGetContext(null)
    const { container } = render(
      <WorldGenGraph interactive nodes={FIXTURE} edges={EDGES} selectedKey="s1/reach" onSelect={vi.fn()} {...LABELS} />,
    )
    expect(await axe(container)).toHaveNoViolations()
  })

  it('labels the list with the consumer-supplied listLabel (DS owns no copy)', () => {
    stubGetContext(null)
    const { getByRole } = render(
      <WorldGenGraph interactive nodes={FIXTURE} edges={EDGES} onSelect={vi.fn()} {...LABELS} />,
    )
    expect(getByRole('list')).toHaveAccessibleName(LABELS.listLabel)
  })

  it('shows the consumer-supplied emptyLabel when no entity has arrived', () => {
    stubGetContext(null)
    const { getByText } = render(
      <WorldGenGraph interactive nodes={[]} edges={[]} onSelect={vi.fn()} {...LABELS} />,
    )
    expect(getByText(LABELS.emptyLabel)).toBeInTheDocument()
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
