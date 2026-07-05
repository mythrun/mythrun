import { useEffect, useState } from 'react'
import type { Meta, StoryObj } from '@storybook/react-vite'
import type { GraphEdge, GraphNode } from '@mythrun/client-core/contract'
import { WorldGenGraph } from './WorldGenGraph.tsx'

// WorldGenGraph — the live streaming graph shown during world generation (the
// world-gen loading experience). A decorative force-directed Canvas (square ink
// glyphs by kind, hand-drawn links, ambient ghost-bloom churn between arrivals)
// beside an ACCESSIBLE entity list. Entities stream in over ~10 minutes; the layout
// GROWS without ever resetting. These specimens drive it through a mini generation
// on a BURSTY schedule (per spec §6 — clustered arrivals, not a metronome).

const meta: Meta<typeof WorldGenGraph> = {
  title: 'Patterns/WorldGenGraph',
  component: WorldGenGraph,
  tags: ['autodocs'],
  parameters: { layout: 'fullscreen' },
}

// eslint-disable-next-line no-restricted-syntax -- Storybook CSF requires the meta object as the module's default export.
export default meta

type Story = StoryObj<typeof WorldGenGraph>

const node = (synthKey: string, kind: string, name: string): GraphNode => ({
  synthKey,
  kind,
  name,
  displayId: synthKey,
  state: 'live',
  lastEventIndex: 0,
})
const edge = (synthKey: string, from: string, to: string, relationship: string): GraphEdge => ({
  synthKey,
  from,
  to,
  relationship,
})

// A scripted mini generation. Each arrival carries the delay (ms) BEFORE it lands —
// deliberately bursty: a lull, then a cluster, mirroring how the prep pipeline emits
// (a stage goes quiet, then dumps several entities at once).
interface Arrival {
  afterMs: number
  node?: GraphNode
  edge?: GraphEdge
}

const ARRIVALS: Arrival[] = [
  { afterMs: 300, node: node('s1/world', 'world', 'Ashfen Reach') },
  { afterMs: 1600, node: node('s2/ward', 'location', 'The Drowned Ward') },
  { afterMs: 250, edge: edge('e1', 's2/ward', 's1/world', 'within') },
  { afterMs: 300, node: node('s3/guild', 'faction', 'The Tallow Guild') },
  { afterMs: 250, edge: edge('e2', 's3/guild', 's2/ward', 'controls') },
  { afterMs: 2400, node: node('s4/maeris', 'npc', 'Maeris Vale') },
  { afterMs: 300, edge: edge('e3', 's4/maeris', 's3/guild', 'leads') },
  { afterMs: 350, node: node('s4/corr', 'npc', 'Old Corr') },
  { afterMs: 2100, node: node('s5/ledger', 'item', 'The Salt Ledger') },
  { afterMs: 300, edge: edge('e4', 's5/ledger', 's3/guild', 'kept by') },
  { afterMs: 300, node: node('s6/wardens', 'faction', 'Reach Wardens') },
  { afterMs: 1800, node: node('s7/pc', 'pc', 'You') },
  { afterMs: 300, edge: edge('e5', 's7/pc', 's6/wardens', 'sworn to') },
]

/** Fold the arrivals up to `count` into the cumulative node/edge sets. */
function snapshotAt(count: number): { nodes: GraphNode[]; edges: GraphEdge[] } {
  const nodes: GraphNode[] = []
  const edges: GraphEdge[] = []
  for (const arrival of ARRIVALS.slice(0, count)) {
    if (arrival.node !== undefined) nodes.push(arrival.node)
    if (arrival.edge !== undefined) edges.push(arrival.edge)
  }
  return { nodes, edges }
}

function StreamingDemo({ reducedMotion }: { reducedMotion?: boolean }): React.JSX.Element {
  const [count, setCount] = useState(1)
  const [selectedKey, setSelectedKey] = useState<string>()

  useEffect(() => {
    if (count >= ARRIVALS.length) return
    const id = setTimeout(() => {
      setCount((c) => c + 1)
    }, ARRIVALS[count]?.afterMs ?? 800)
    return () => {
      clearTimeout(id)
    }
  }, [count])

  const { nodes, edges } = snapshotAt(count)
  return (
    <div className="min-h-dvh bg-bg p-[var(--space-6)]">
      <div className="h-[70vh]">
        <WorldGenGraph
          nodes={nodes}
          edges={edges}
          {...(selectedKey !== undefined ? { selectedKey } : {})}
          onSelect={setSelectedKey}
          listLabel="Entities in your forming world"
          emptyLabel="The world is still taking shape"
          {...(reducedMotion !== undefined ? { reducedMotion } : {})}
        />
      </div>
    </div>
  )
}

// The graph growing live, in motion — the churn fills the dead air between arrivals.
export const Generating: Story = {
  render: () => <StreamingDemo />,
}

// The same scripted generation with reduced motion: no rAF churn, no ghost blooms —
// the layout settles to convergence and redraws statically on each arrival.
export const ReducedMotion: Story = {
  name: 'Reduced motion',
  render: () => <StreamingDemo reducedMotion />,
}

// A fully-populated static snapshot — every entity + link at once, for a quick read
// of the glyph vocabulary (frame = world, diamond = faction, stack = npc/pc, small
// square = item, square = location) and the entity list.
export const Populated: Story = {
  render: () => {
    const { nodes, edges } = snapshotAt(ARRIVALS.length)
    return (
      <div className="min-h-dvh bg-bg p-[var(--space-6)]">
        <div className="h-[70vh]">
          <WorldGenGraph
            nodes={nodes}
            edges={edges}
            onSelect={() => undefined}
            listLabel="Entities in your forming world"
            emptyLabel="The world is still taking shape"
          />
        </div>
      </div>
    )
  },
}
