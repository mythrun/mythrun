import { useEffect, useState } from 'react'
import { WorldGenFogField, WorldGenGraph } from '@mythrun/ui'
import {
  FOG_PARAMS,
  MIN_EXPECTED_ENTITIES,
  VIRTUAL_HEIGHT,
  VIRTUAL_WIDTH,
} from '@mythrun/client-core/worldgen'
import type {
  FogFieldEntity,
  GraphEdge,
  GraphNode,
  StageProgress,
  WorldGenStatusCardProps,
} from '@mythrun/client-core/contract'
import type { AuditSection } from '../types.ts'

// ── WorldGenGraph streaming demo — replicated verbatim from
//    WorldGenGraph.stories.tsx (the `Generating` story's StreamingDemo). The graph
//    composes the fog layer, the mono-ink glyphs, the arrival trace, the status
//    card overlay, and the SR announcer, so this one exhibit covers the whole
//    world-gen loading experience.

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

function snapshotAt(arrivals: readonly Arrival[], count: number): { nodes: GraphNode[]; edges: GraphEdge[] } {
  const nodes: GraphNode[] = []
  const edges: GraphEdge[] = []
  for (const arrival of arrivals.slice(0, count)) {
    if (arrival.node !== undefined) nodes.push(arrival.node)
    if (arrival.edge !== undefined) edges.push(arrival.edge)
  }
  return { nodes, edges }
}

const STAGE_IDS = [
  'world_and_factions',
  'locations_and_npcs',
  'entity_relationships',
  'entity_consolidation',
  'starting_situation',
  'random_tables',
  'coherence_pass',
  'embed_world',
] as const
const STAGE_LABELS: Record<string, string> = {
  world_and_factions: '[ph: raising the powers]',
  locations_and_npcs: '[ph: peopling the world]',
  entity_relationships: '[ph: drawing connections]',
  entity_consolidation: '[ph: settling names]',
  starting_situation: '[ph: setting the scene]',
  random_tables: '[ph: stocking surprises]',
  coherence_pass: '[ph: tidying up]',
  embed_world: '[ph: committing to memory]',
}

function statusFor(count: number, totalArrivals: number): WorldGenStatusCardProps {
  const done = Math.min(STAGE_IDS.length, Math.round((count / totalArrivals) * STAGE_IDS.length))
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
    stageLabels: STAGE_LABELS,
    titleLabel: '[ph: weaving your world]',
    doneLabel: '[ph: your world is ready]',
    progressLabel: '[ph: world generation progress]',
  }
}

function StreamingDemo({ reducedMotion }: { reducedMotion: boolean }): React.JSX.Element {
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

  const { nodes, edges } = snapshotAt(ARRIVALS, count)
  return (
    <div className="h-full w-full bg-bg">
      <WorldGenGraph
        nodes={nodes}
        edges={edges}
        onSelect={() => undefined}
        status={statusFor(count, ARRIVALS.length)}
        totalEntities={NODE_TOTAL}
        fillHost
        reducedMotion={reducedMotion}
        generationA11y={{
          entityListLabel: '[ph: what has taken shape so far]',
          phaseLabel: '[ph: raising the powers]',
          entitiesLabel: `[ph: ${String(nodes.length)} have taken shape]`,
        }}
      />
    </div>
  )
}

// ── WorldGenGraph reveal — the settled, interactive graph (every glyph kind in the
//    vocabulary), fog drained to nothing. From the `Populated` story's RevealDemo.
function RevealDemo({ reducedMotion }: { reducedMotion: boolean }): React.JSX.Element {
  const [selectedKey, setSelectedKey] = useState<string>()
  const { nodes, edges } = snapshotAt(ARRIVALS, ARRIVALS.length)
  return (
    <div className="h-full w-full bg-bg">
      <WorldGenGraph
        interactive
        fillHost
        nodes={nodes}
        edges={edges}
        shownEntities={NODE_TOTAL}
        totalEntities={NODE_TOTAL}
        reducedMotion={reducedMotion}
        nodeListLabel="[ph: pick a place or figure from your world]"
        {...(selectedKey !== undefined ? { selectedKey } : {})}
        onSelect={setSelectedKey}
      />
    </div>
  )
}

// ── WorldGenFogField standalone — the decorative fog at its locked defaults (rolling,
//    wind-scrolled clouds parting around the entity labels). From the fog story's
//    `Locked`. The fog color is a FOG_PARAMS constant, so it renders the same in both
//    themes over the theme's paper ground.
const FOG_ENTS: FogFieldEntity[] = [
  { x: 0.3, y: 0.3, name: 'Stillwater', kind: 'LOCATION' },
  { x: 0.62, y: 0.38, name: 'Belltoe', kind: 'LOCATION' },
  { x: 0.44, y: 0.6, name: 'Bell-Wardens', kind: 'FACTION' },
  { x: 0.72, y: 0.7, name: 'Abbot Sennel', kind: 'NPC' },
  { x: 0.22, y: 0.78, name: 'The Understirring', kind: 'LOCATION' },
  { x: 0.82, y: 0.24, name: 'The Forgetting Road', kind: 'LOCATION' },
  { x: 0.52, y: 0.17, name: 'Lector Ivarn', kind: 'NPC' },
  { x: 0.13, y: 0.48, name: 'The Bell-Loft', kind: 'LOCATION' },
  { x: 0.6, y: 0.54, name: "Recollects' Circle", kind: 'FACTION' },
  { x: 0.37, y: 0.43, name: 'Master Peret Vell', kind: 'NPC' },
  { x: 0.8, y: 0.52, name: 'The Lower Galleries', kind: 'LOCATION' },
  { x: 0.47, y: 0.86, name: 'The Cracked Bowl', kind: 'LOCATION' },
].map((e) => ({ ...e, x: e.x * VIRTUAL_WIDTH, y: e.y * VIRTUAL_HEIGHT }))

function FogLocked({ reducedMotion }: { reducedMotion: boolean }): React.JSX.Element {
  return (
    <WorldGenFogField
      entities={FOG_ENTS.slice(0, FOG_PARAMS.entities)}
      shownEntities={FOG_PARAMS.entities}
      totalEntities={MIN_EXPECTED_ENTITIES}
      reducedMotion={reducedMotion}
    />
  )
}

export const worldgenSections: AuditSection[] = [
  {
    id: 'worldgen-graph',
    name: 'WorldGenGraph — live generation',
    path: 'frontend/ui/src/components/WorldGenGraph',
    where: 'World generation loading screen (create-world → /worlds/:id generating route)',
    note: 'Canvas force-directed graph + fog layer + arrival trace + status card, streamed on the story’s bursty ARRIVALS schedule. Reduced motion: no rAF/bob — settles + redraws statically per arrival.',
    height: 470,
    autoReplayMs: 18000,
    render: ({ reducedMotion, replayKey }) => (
      <div className="h-full w-full" style={{ height: 470 }}>
        <StreamingDemo key={replayKey} reducedMotion={reducedMotion} />
      </div>
    ),
  },
  {
    id: 'worldgen-fog',
    name: 'WorldGenFogField — fog layer (isolated)',
    path: 'frontend/ui/src/components/WorldGenFog',
    where: 'Behind the graph canvas in WorldGenGraph (same generation screen)',
    note: 'Fixed-timestep fluid sim painted as crisp ordered-Bayer fog quads, wind-scrolled. Loops continuously (wind). Reduced motion: snaps to a converged static frame, no rAF.',
    height: 360,
    render: ({ reducedMotion, replayKey }) => (
      <div className="relative h-full w-full bg-bg" style={{ height: 360 }}>
        <FogLocked key={replayKey} reducedMotion={reducedMotion} />
      </div>
    ),
  },
  {
    id: 'worldgen-reveal',
    name: 'WorldGenGraph — reveal (settled, interactive)',
    path: 'frontend/ui/src/components/WorldGenGraph',
    where: 'World reveal, post-generation (interactive settled graph; wiki is the browse surface)',
    note: 'The forceful cold-settle of the full entity set, then idle buoy bob; tap/click selects. Every glyph kind visible. Replay re-runs the settle.',
    height: 470,
    autoReplayMs: 22000,
    render: ({ reducedMotion, replayKey }) => (
      <div className="h-full w-full" style={{ height: 470 }}>
        <RevealDemo key={replayKey} reducedMotion={reducedMotion} />
      </div>
    ),
  },
]
