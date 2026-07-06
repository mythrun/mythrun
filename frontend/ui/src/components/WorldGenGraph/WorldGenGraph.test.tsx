import { afterEach, describe, expect, it, vi } from 'vitest'
import { render } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { axe } from 'jest-axe'
import type { GraphEdge, GraphNode } from '@mythrun/client-core/contract'
import { WorldGenGraph } from './WorldGenGraph.tsx'

// WorldGenGraph pairs a decorative Canvas (aria-hidden — jsdom can't render it) with
// an ACCESSIBLE entity list, which is the whole testable + a11y surface. These tests
// exercise the list (one item per node, activation → onSelect, selection marking),
// the Canvas's aria-hidden, and the reduced-motion contract (no rAF churn). Pixel
// output is out of scope: getContext is null under jsdom (we stub it either way).

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
const EDGES: GraphEdge[] = [{ synthKey: 'e1', from: 's2/maeris', to: 's3/guild', relationship: 'leads' }]

// The chrome labels are consumer-supplied (i18n) props — the DS owns no copy. Every
// render passes them; tests that assert on them use these exact values.
const LABELS = { listLabel: 'Entities in your forming world', emptyLabel: 'The world is still taking shape' }

/** A permissive fake 2D context: every method is a no-op, every property write is
 *  absorbed. Lets the reduced-motion / motion tests run the draw path (which jsdom's
 *  null context otherwise skips) so we can assert the rAF behaviour around it. */
function fakeCtx(): CanvasRenderingContext2D {
  return new Proxy(
    {},
    {
      get: () => () => undefined,
      set: () => true,
    },
  ) as unknown as CanvasRenderingContext2D
}

/** Stub HTMLCanvasElement.getContext for one test (restored by afterEach). */
function stubGetContext(value: CanvasRenderingContext2D | null): void {
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(value)
}

afterEach(() => {
  vi.restoreAllMocks()
})

describe('WorldGenGraph — accessible entity list', () => {
  it('renders one activatable item per node, showing name + kind', () => {
    stubGetContext(null)
    const { getByRole, getByText } = render(
      <WorldGenGraph nodes={FIXTURE} edges={EDGES} onSelect={vi.fn()} {...LABELS} />,
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
    const { getAllByRole } = render(<WorldGenGraph nodes={FIXTURE} edges={EDGES} onSelect={vi.fn()} {...LABELS} />)
    expect(getAllByRole('button')).toHaveLength(FIXTURE.length)
  })

  it('calls onSelect(displayId) when an item is activated (click)', async () => {
    stubGetContext(null)
    const onSelect = vi.fn()
    const user = userEvent.setup()
    const { getByRole } = render(<WorldGenGraph nodes={FIXTURE} edges={EDGES} onSelect={onSelect} {...LABELS} />)
    await user.click(getByRole('button', { name: /Maeris Vale/ }))
    expect(onSelect).toHaveBeenCalledExactlyOnceWith('s2/maeris')
  })

  it('calls onSelect(displayId) on keyboard activation (Enter)', async () => {
    stubGetContext(null)
    const onSelect = vi.fn()
    const user = userEvent.setup()
    const { getByRole } = render(<WorldGenGraph nodes={FIXTURE} edges={EDGES} onSelect={onSelect} {...LABELS} />)
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
      <WorldGenGraph nodes={[finalized]} edges={[]} onSelect={onSelect} {...LABELS} />,
    )
    await user.click(getByRole('button', { name: /Tallow Guild/ }))
    expect(onSelect).toHaveBeenCalledExactlyOnceWith('ent-fac-1')

    // selectedKey is the displayId → aria-current; the synthKey must NOT match.
    rerender(<WorldGenGraph nodes={[finalized]} edges={[]} selectedKey="ent-fac-1" onSelect={onSelect} {...LABELS} />)
    expect(getByRole('button', { name: /Tallow Guild/ })).toHaveAttribute('aria-current', 'true')
    rerender(
      <WorldGenGraph
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
      <WorldGenGraph nodes={FIXTURE} edges={EDGES} selectedKey="s2/maeris" onSelect={vi.fn()} {...LABELS} />,
    )
    expect(getByRole('button', { name: /Maeris Vale/ })).toHaveAttribute('aria-current', 'true')
    expect(getByRole('button', { name: /Ashfen Reach/ })).not.toHaveAttribute('aria-current')
  })

  it('has no a11y violations', async () => {
    stubGetContext(null)
    const { container } = render(
      <WorldGenGraph nodes={FIXTURE} edges={EDGES} selectedKey="s1/reach" onSelect={vi.fn()} {...LABELS} />,
    )
    expect(await axe(container)).toHaveNoViolations()
  })

  it('labels the list with the consumer-supplied listLabel (DS owns no copy)', () => {
    stubGetContext(null)
    const { getByRole } = render(<WorldGenGraph nodes={FIXTURE} edges={EDGES} onSelect={vi.fn()} {...LABELS} />)
    expect(getByRole('list')).toHaveAccessibleName(LABELS.listLabel)
  })

  it('shows the consumer-supplied emptyLabel when no entity has arrived', () => {
    stubGetContext(null)
    const { getByText } = render(<WorldGenGraph nodes={[]} edges={[]} onSelect={vi.fn()} {...LABELS} />)
    expect(getByText(LABELS.emptyLabel)).toBeInTheDocument()
  })
})

describe('WorldGenGraph — Canvas', () => {
  it('marks the decorative Canvas aria-hidden', () => {
    stubGetContext(null)
    const { container } = render(<WorldGenGraph nodes={FIXTURE} edges={EDGES} onSelect={vi.fn()} {...LABELS} />)
    const canvas = container.querySelector('canvas')
    expect(canvas).not.toBeNull()
    expect(canvas).toHaveAttribute('aria-hidden', 'true')
  })
})

describe('WorldGenGraph — motion contract', () => {
  it('reducedMotion renders WITHOUT starting a requestAnimationFrame loop', () => {
    stubGetContext(fakeCtx())
    const raf = vi.spyOn(window, 'requestAnimationFrame').mockReturnValue(1)
    render(<WorldGenGraph nodes={FIXTURE} edges={EDGES} onSelect={vi.fn()} reducedMotion {...LABELS} />)
    // Static settle-to-convergence redraw only — no rAF churn.
    expect(raf).not.toHaveBeenCalled()
  })

  it('starts (and on unmount cancels) a rAF loop when motion is allowed', () => {
    stubGetContext(fakeCtx())
    const raf = vi.spyOn(window, 'requestAnimationFrame').mockReturnValue(1)
    const caf = vi.spyOn(window, 'cancelAnimationFrame').mockImplementation(() => undefined)
    const { unmount } = render(<WorldGenGraph nodes={FIXTURE} edges={EDGES} onSelect={vi.fn()} {...LABELS} />)
    expect(raf).toHaveBeenCalled()
    unmount()
    expect(caf).toHaveBeenCalled()
  })
})
