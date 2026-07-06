import { useEffect, useState } from 'react'
import type { Meta, StoryObj } from '@storybook/react-vite'
import type { GraphEdge, GraphNode, StageProgress, WorldGenStatusCardProps } from '@mythrun/client-core/contract'
import { WorldGenGraph } from './WorldGenGraph.tsx'

// WorldGenGraph — the live streaming graph shown during world generation. The GENERATION
// graph (default, gated) stacks a decorative fog layer behind mono-ink shape glyphs with
// a render-only buoy bob, plus a top-left status card; NO entity list, NO selection (the
// fog IS the ambient animation). The REVEAL variant opts in with `interactive` — the
// accessible + selectable entity list beside the settled graph. Entities stream in over
// ~10 minutes; the layout GROWS without ever resetting. These specimens drive a mini
// generation on a BURSTY schedule (§6 — clustered arrivals, not a metronome).

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
  arrivalIndex: 0,
  sourceStage: 'weave',
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

const NODE_TOTAL = ARRIVALS.filter((a) => a.node !== undefined).length

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

// A synthetic status card that advances with the generation — the top-left overlay that
// keeps the pre-entity stretch legible. `[ph:]` labels (the DS owns no copy).
const STAGE_IDS = [
  'concept_intake',
  'world_color',
  'vocabulary_intake',
  'entity_relationships',
  'entity_details',
  'fact_generation',
  'coherence_pass',
] as const
const STAGE_LABELS: Record<string, string> = {
  concept_intake: '[ph: shaping the concept]',
  world_color: '[ph: colouring the world]',
  vocabulary_intake: '[ph: naming things]',
  entity_relationships: '[ph: drawing connections]',
  entity_details: '[ph: filling in detail]',
  fact_generation: '[ph: writing the world]',
  coherence_pass: '[ph: tidying up]',
}

function statusFor(count: number): WorldGenStatusCardProps {
  // Map generation progress (0..ARRIVALS.length) onto the seven stages.
  const done = Math.min(STAGE_IDS.length, Math.round((count / ARRIVALS.length) * STAGE_IDS.length))
  const stages: StageProgress[] = STAGE_IDS.map((id, i) => ({
    stage: id,
    status: i < done ? 'completed' : i === done ? 'running' : 'pending',
    userId: null,
    costUsd: 0,
    startedAt: null,
    completedAt: null,
  }))
  return {
    stages,
    costUsd: Number((count * 0.006).toFixed(3)),
    stageLabels: STAGE_LABELS,
    titleLabel: '[ph: weaving your world]',
    doneLabel: '[ph: your world is ready]',
    progressLabel: '[ph: world generation progress]',
  }
}

function StreamingDemo({ reducedMotion }: { reducedMotion?: boolean }): React.JSX.Element {
  const [count, setCount] = useState(1)

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
      <div className="mx-auto w-full max-w-[900px]">
        <WorldGenGraph
          nodes={nodes}
          edges={edges}
          onSelect={() => undefined}
          status={statusFor(count)}
          totalEntities={NODE_TOTAL}
          listLabel="Entities in your forming world"
          emptyLabel="The world is still taking shape"
          {...(reducedMotion !== undefined ? { reducedMotion } : {})}
        />
      </div>
    </div>
  )
}

// The generation graph growing live: the fog fills the space, parts around the streaming
// glyphs, and fades as the graph fills — the status card tracks progress top-left. No
// list, no selection (the gated generation experience, §3.4).
export const Generating: Story = {
  render: () => <StreamingDemo />,
}

// The same scripted generation with reduced motion: no rAF churn, no bob — the graph and
// the fog settle to convergence and redraw statically on each arrival (the fade-with-
// entities progress signal is preserved).
export const ReducedMotion: Story = {
  name: 'Reduced motion',
  render: () => <StreamingDemo reducedMotion />,
}

/** The REVEAL variant: `interactive` turns on the accessible + selectable entity list
 *  beside the settled graph (with on-glyph name labels). The fog is faded to nothing
 *  (shown === total). */
function RevealDemo(): React.JSX.Element {
  const [selectedKey, setSelectedKey] = useState<string>()
  const { nodes, edges } = snapshotAt(ARRIVALS.length)
  return (
    <div className="min-h-dvh bg-bg p-[var(--space-6)]">
      <WorldGenGraph
        interactive
        nodes={nodes}
        edges={edges}
        shownEntities={NODE_TOTAL}
        totalEntities={NODE_TOTAL}
        {...(selectedKey !== undefined ? { selectedKey } : {})}
        onSelect={setSelectedKey}
        listLabel="Entities in your world"
        emptyLabel="The world is still taking shape"
      />
    </div>
  )
}

// A fully-populated, INTERACTIVE snapshot — the reveal shape: the settled graph beside
// the selectable entity list, every glyph in the vocabulary (frame = world, diamond =
// faction, stack = npc/pc, small square = item, square = location).
export const Populated: Story = {
  render: () => <RevealDemo />,
}
