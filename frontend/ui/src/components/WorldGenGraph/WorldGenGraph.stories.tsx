import { useEffect, useRef, useState } from 'react'
import type { Meta, StoryObj } from '@storybook/react-vite'
import type {
  GraphEdge,
  GraphNode,
  StageProgress,
  WorldGenStatusCardProps,
} from '@mythrun/client-core/contract'
import {
  DENSITY_PARAM_RANGES,
  DENSITY_PARAMS,
  FORCE_PARAM_RANGES,
  FORCE_PARAMS,
  REVEAL_FORCE_PARAMS,
  type DensityParams,
  type ForceParams,
} from '@mythrun/client-core/worldgen'
import {
  MAX_DENSITY_ARRIVALS,
  MAX_DENSITY_EDGES,
  MAX_DENSITY_NODES,
  MAX_DENSITY_TOTAL,
  type FixtureArrival,
} from './max-density-fixture.ts'
import { FullBleedStage } from '../FullBleedStage/FullBleedStage.tsx'
import { drawNodes, type Point } from './canvas-draw.ts'
import { resolveInk, resolveLabelFont, resolvePaper, sizeCanvasForDpr } from './canvas-util.ts'
import { WorldGenGraph } from './WorldGenGraph.tsx'

// WorldGenGraph — the live streaming graph shown during world generation. The GENERATION
// graph (default, gated) stacks a decorative fog layer behind mono-ink shape glyphs with
// a render-only buoy bob, plus a top-left status card; NO selection (the fog IS the
// ambient animation). The REVEAL variant opts in with `interactive` — Canvas
// tap-to-select on the settled graph (no entity list on either surface, MYT-89 audit
// v3 — the wiki is the reveal's browse surface). Entities stream in over ~10 minutes;
// the layout GROWS without ever resetting. These specimens drive a mini generation on
// a BURSTY schedule (§6 — clustered arrivals, not a metronome).

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
// (a stage goes quiet, then dumps several entities at once). (The REALISTIC full-size
// script — 46 nodes / 72 edges, the measured shape of a real generation — lives in
// max-density-fixture.ts and shares this arrival shape.)
type Arrival = FixtureArrival

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
function snapshotAt(
  arrivals: readonly Arrival[],
  count: number,
): { nodes: GraphNode[]; edges: GraphEdge[] } {
  const nodes: GraphNode[] = []
  const edges: GraphEdge[] = []
  for (const arrival of arrivals.slice(0, count)) {
    if (arrival.node !== undefined) nodes.push(arrival.node)
    if (arrival.edge !== undefined) edges.push(arrival.edge)
  }
  return { nodes, edges }
}

// A synthetic status card that advances with the generation — the top-left overlay that
// keeps the pre-entity stretch legible. `[ph:]` labels (the DS owns no copy). The ids
// are the CANONICAL entity stages (the card renders one fixed bar per `WATCHED_ENTITY_STAGES`
// entry and ignores unknown ids — fictional ids left the bar stuck at 0%).
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
  // Map generation progress (0..totalArrivals) onto the seven stages.
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

function StreamingDemo({
  reducedMotion,
  paneClassName,
  arrivals = ARRIVALS,
  totalNodes = NODE_TOTAL,
}: {
  reducedMotion?: boolean
  /** Constrain the graph's container — the responsive specimens (below) wrap the graph
   *  in a narrow fixed-width column to stand in for a phone / tall pane. Default: full
   *  width, exactly how the generating route hosts it. */
  paneClassName?: string
  /** The arrival script (default: the small demo; the max-density specimens pass the
   *  realistic 46-node/72-edge fixture). */
  arrivals?: readonly Arrival[]
  totalNodes?: number
}): React.JSX.Element {
  const [count, setCount] = useState(1)

  useEffect(() => {
    if (count >= arrivals.length) return
    const id = setTimeout(() => {
      setCount((c) => c + 1)
    }, arrivals[count]?.afterMs ?? 800)
    return () => {
      clearTimeout(id)
    }
  }, [count, arrivals])

  const { nodes, edges } = snapshotAt(arrivals, count)
  return (
    <div className="min-h-dvh bg-bg p-[var(--space-6)]">
      <div className={paneClassName ?? 'w-full'}>
        <WorldGenGraph
          nodes={nodes}
          edges={edges}
          onSelect={() => undefined}
          status={statusFor(count, arrivals.length)}
          totalEntities={totalNodes}
          // E1 (Phase E): the SR-only generation model — a polite live region + a
          // hidden entities-so-far list (VisuallyHidden; nothing paints). Wired in the
          // story so the real-browser ARIA pass can inspect it.
          generationA11y={{
            entityListLabel: '[ph: what has taken shape so far]',
            phaseLabel: '[ph: raising the powers]',
            entitiesLabel: `[ph: ${String(nodes.length)} have taken shape]`,
          }}
          {...(reducedMotion !== undefined ? { reducedMotion } : {})}
        />
      </div>
    </div>
  )
}

// The generation graph growing live: the fog fills the space, parts around the streaming
// glyphs, and DRAINS as entities arrive (MYT-89 spawn-drain — fewer particles spawn in
// per arrival and the wind blows the rest off the pane; the demo's denominator is its
// own script length, production's is MIN_EXPECTED_ENTITIES) — the status card tracks
// progress top-left. No list, no selection (the gated generation experience, §3.4).
export const Generating: Story = {
  render: () => <StreamingDemo />,
}

// The same scripted generation with reduced motion: no rAF churn, no bob — the graph and
// the fog settle to convergence and redraw statically on each arrival (the drain-with-
// entities progress signal is preserved: each settle snaps to the scaled population).
export const ReducedMotion: Story = {
  name: 'Reduced motion',
  render: () => <StreamingDemo reducedMotion />,
}

// ── Arrival treatment (MYT-89 audit v2): trace, then stamp ─────────────────────────────
// An arriving node is DRAWN, not popped in: its silhouette traces itself in as a
// penstroke (the same hand as the edge draw-ins, from a per-node hashed start corner),
// then the solid ink + the name land together at completion. Two review surfaces: the
// live replay (watch arrivals against the fog + edges, re-run at will) and the frozen
// anatomy (every glyph kind at fixed trace progresses — screenshot-stable).

/** The live generation with a replay control: re-mounts the streaming demo so the
 *  arrival treatment can be watched repeatedly without reloading the story. `dense`
 *  streams the realistic 46-entity fixture instead of the small demo script. */
function ArrivalReplayDemo({ dense }: { dense?: boolean }): React.JSX.Element {
  const [run, setRun] = useState(1)
  return (
    <div className="relative">
      {dense === true ? (
        <StreamingDemo key={run} arrivals={MAX_DENSITY_ARRIVALS} totalNodes={MAX_DENSITY_TOTAL} />
      ) : (
        <StreamingDemo key={run} />
      )}
      <button
        type="button"
        className="absolute right-[var(--space-6)] top-[var(--space-6)] z-10 border border-border-strong bg-surface px-[var(--space-3)] py-[var(--space-2)] font-mono text-[12px] text-ink"
        onClick={() => {
          setRun((r) => r + 1)
        }}
      >
        [ph: replay]
      </button>
    </div>
  )
}

// THE arrival-review surface: the scripted mini generation with a top-right replay
// button — watch glyphs trace in among the drawing edges, as many times as needed.
export const ArrivalReplay: Story = {
  name: 'Arrival treatment (replay)',
  render: () => <ArrivalReplayDemo />,
}

// The same replay over the realistic 46-entity fixture — the busyness check: mid-gen
// arrival clusters must read as quiet pen marks, never as the graph churning.
export const ArrivalReplayDense: Story = {
  name: 'Arrival treatment, dense (replay)',
  render: () => <ArrivalReplayDemo dense />,
}

/** Frozen trace anatomy: every glyph kind (rows) at five arrival progresses
 *  (columns), drawn through the REAL draw path (`drawNodes` + a fixed progress per
 *  specimen) onto a bare canvas. The last column is the completed stamp — solid ink
 *  + the name landing together (the label gate made visible). Static and
 *  deterministic, so design review doesn't race a 320ms animation. */
function ArrivalAnatomyDemo(): React.JSX.Element {
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  useEffect(() => {
    const canvas = canvasRef.current
    const ctx = canvas?.getContext('2d') ?? null
    if (canvas === null || ctx === null) return
    const kinds = ['world', 'faction', 'npc', 'pc', 'item', 'location']
    const steps = [0.15, 0.35, 0.6, 0.85, 1]
    const nodes: GraphNode[] = []
    const positions = new Map<string, Point>()
    const progressOf = new Map<string, number>()
    kinds.forEach((kind, row) => {
      steps.forEach((p, col) => {
        const key = `anatomy/${kind}/${String(p)}`
        nodes.push(node(key, kind, kind))
        positions.set(key, { x: col * 120 - 240, y: row * 62 - 155 })
        progressOf.set(key, p)
      })
    })
    const dims = { width: 720, height: 400 }
    sizeCanvasForDpr(canvas, ctx, dims)
    ctx.translate(dims.width / 2, dims.height / 2)
    const ink = resolveInk(canvas)
    ctx.strokeStyle = ink
    ctx.fillStyle = ink
    drawNodes(
      ctx,
      nodes,
      positions,
      {
        selectedKey: undefined,
        hoverKey: null,
        focusKey: null,
        t: null,
        showLabels: true,
        labeled: undefined,
        labelFont: resolveLabelFont(canvas),
        paper: resolvePaper(canvas),
        virtual: dims,
      },
      (n) => progressOf.get(n.synthKey) ?? 1,
    )
  })
  return (
    <div className="min-h-dvh bg-bg p-[var(--space-6)]">
      <canvas ref={canvasRef} className="h-[400px] w-[720px] max-w-full" />
    </div>
  )
}

// The treatment's anatomy, frozen: rows = glyph kinds, columns = trace progress
// 0.15 → 1. Verify the trace is crisp 1px ink (no alpha, no scaling) and that the
// fill + name land ONLY in the final column.
export const ArrivalAnatomy: Story = {
  name: 'Arrival anatomy (frozen trace)',
  render: () => <ArrivalAnatomyDemo />,
}

// ── Responsive specimens (MYT-89 responsive fix) ──────────────────────────────────────
// The virtual space is PANE-ADAPTIVE: below the 900px reference width the graph renders
// 1:1 with CSS px (legible 14px labels at a ~375px phone), and the pane height tracks
// the viewport instead of an aspect lock — so a narrow pane is TALL (portrait graph) and
// a wide desktop pane fills the fold without overflowing it. These specimens pin the two
// non-desktop shapes; view them at any Storybook viewport (the pane height is dvh-based).

// A ~375px phone column: the graph must be legible (full-size labels) + fill the tall
// pane — the audit's "tiny letterboxed strip with 5px labels" is the regression state.
export const NarrowPane: Story = {
  name: 'Narrow pane (~375px)',
  render: () => <StreamingDemo paneClassName="w-[343px]" />,
}

// A tall/narrow split-window pane (~600px): mid-width, still under the reference width →
// still 1:1. Checks the aspect adaptation between phone and desktop.
export const TallNarrowPane: Story = {
  name: 'Tall narrow pane (~600px)',
  render: () => <StreamingDemo paneClassName="w-[600px]" />,
  // A fixed 600px pane specimen (aspect behavior pin) — wide-by-design at 375,
  // exempt from the overflow gate; MobileFullBleed covers the true 375 surface.
  parameters: { overflowGate: false },
}

// ── Max-density specimens (MYT-89 density redesign) ────────────────────────────────────
// A REAL generation lands ~46 entities / ~72 relationships (measured from the dev
// worlds) — these stream the realistic fixture at full density, compressed to ~35s. The
// density machinery under test: label tiering (anchors + the freshest arrivals wear
// names, everything else is glyph-only), the density-aware virtual-space growth (the
// world grows as it fills), straight lighter-ink edges, and tap/click name reveal.

// The realistic full generation on a desktop pane.
export const MaxDensity: Story = {
  name: 'Max density (realistic 46-entity gen)',
  render: () => <StreamingDemo arrivals={MAX_DENSITY_ARRIVALS} totalNodes={MAX_DENSITY_TOTAL} />,
}

// The same real load in a ~375px phone column — the form factor the T1b pannable
// camera exists for: the world stops shrinking to the glass, renders at full legible
// scale (every label seated), and the pane becomes a one-finger-drag camera over it,
// auto-following the newest arrival while the user's hand is idle.
export const MaxDensityNarrow: Story = {
  name: 'Max density, narrow pane (~375px)',
  render: () => (
    <StreamingDemo
      arrivals={MAX_DENSITY_ARRIVALS}
      totalNodes={MAX_DENSITY_TOTAL}
      paneClassName="w-[343px]"
    />
  ),
}

// Max density under REDUCED MOTION (view at a phone-sized viewport): no rAF loops, no
// auto-follow drift — the camera SNAPS to each new arrival's settled position (one
// discrete reposition per arrival), and a manual drag still pans (each move repaints
// the settled graph + fog statically, in lockstep).
export const MaxDensityReduced: Story = {
  name: 'Max density, reduced motion',
  render: () => (
    <StreamingDemo reducedMotion arrivals={MAX_DENSITY_ARRIVALS} totalNodes={MAX_DENSITY_TOTAL} />
  ),
}

// ── The mobile full-bleed anatomy (MYT-89 audit v2) ────────────────────────────────────
// The COMPLETE phone-screen composition the generating route builds: a mock app-frame
// header + `--space-6` padded content box, the FullBleedStage cancelling that inset, and
// the graph in its narrow layout — full-bleed pane (no band), the status as a compact
// FOOTER at the fold. VIEW AT < 640px (a 375px viewport is the audited shape); at a wide
// viewport this renders the shipped desktop layout inside the mock frame instead (the
// stage and the graph both flip on the same media condition).

/** The realistic max-density generation inside the mock frame + stage. `freezeAt`
 *  pins the arrival index instead of streaming — a reproducible design-review
 *  frame (early gen: thick fog, sparse graph; mid gen: dense, camera engaged). */
function MobileFrameDemo({ freezeAt }: { freezeAt?: number }): React.JSX.Element {
  const [count, setCount] = useState(freezeAt ?? 1)
  useEffect(() => {
    if (freezeAt !== undefined || count >= MAX_DENSITY_ARRIVALS.length) return
    const id = setTimeout(() => {
      setCount((c) => c + 1)
    }, MAX_DENSITY_ARRIVALS[count]?.afterMs ?? 800)
    return () => {
      clearTimeout(id)
    }
  }, [count, freezeAt])
  const { nodes, edges } = snapshotAt(MAX_DENSITY_ARRIVALS, count)
  return (
    <div className="min-h-dvh bg-bg">
      <div className="flex items-baseline justify-between border-b border-border-strong bg-surface p-[var(--space-4)] font-ui text-sm text-ink">
        <span>[ph: wordmark]</span>
        <span>[ph: chrome]</span>
      </div>
      <div className="bg-surface p-[var(--space-6)]">
        <FullBleedStage inset={6}>
          <WorldGenGraph
            nodes={nodes}
            edges={edges}
            onSelect={() => undefined}
            status={{
              ...statusFor(count, MAX_DENSITY_ARRIVALS.length),
              countdownLabel: '[ph: ~4:12 left]',
            }}
            totalEntities={MAX_DENSITY_TOTAL}
          />
        </FullBleedStage>
      </div>
    </div>
  )
}

// THE phone-screen specimen: header + full-bleed graph + status footer = one screen.
export const MobileFullBleed: Story = {
  name: 'Mobile full-bleed + footer (view at <640px)',
  render: () => <MobileFrameDemo />,
}

// Frozen review frames of the same anatomy — the two states the audit cares about,
// pinned so a design pass doesn't race the 35s stream. EARLY: a handful of entities,
// the fog thick, the camera disengaged (the world still fits the pane), the first
// stage running in the footer. MID: dense, the camera engaged (one-finger pan), the
// boundary stage running.
export const MobileFullBleedEarly: Story = {
  name: 'Mobile full-bleed, early gen (frozen)',
  render: () => <MobileFrameDemo freezeAt={6} />,
}
export const MobileFullBleedMid: Story = {
  name: 'Mobile full-bleed, mid gen (frozen)',
  render: () => <MobileFrameDemo freezeAt={35} />,
}

/** The REVEAL variant: `interactive` wires Canvas tap-to-select on the settled
 *  graph (no entity list — MYT-89 audit v3; the wiki is the reveal's browse
 *  surface). The fog is drained to nothing (shown === total → spawn scale 0 →
 *  the sim mounts empty). */
function RevealDemo(): React.JSX.Element {
  const [selectedKey, setSelectedKey] = useState<string>()
  const { nodes, edges } = snapshotAt(ARRIVALS, ARRIVALS.length)
  return (
    <div className="min-h-dvh bg-bg p-[var(--space-6)]">
      <WorldGenGraph
        interactive
        nodes={nodes}
        edges={edges}
        shownEntities={NODE_TOTAL}
        totalEntities={NODE_TOTAL}
        // E2 (Phase E): the SR/keyboard path into the aria-hidden reveal graph — a
        // roving hidden listbox (VisuallyHidden; nothing paints) whose selection drives
        // the same onSelect a canvas tap does. Wired so the browser ARIA pass can
        // inspect it.
        nodeListLabel="[ph: pick a place or figure from your world]"
        {...(selectedKey !== undefined ? { selectedKey } : {})}
        onSelect={setSelectedKey}
      />
    </div>
  )
}

// A fully-populated, INTERACTIVE snapshot — the reveal shape: the settled graph
// with tap-to-select live, every glyph in the vocabulary (frame = world, diamond =
// faction, stack = npc/pc, small square = item, square = location).
export const Populated: Story = {
  render: () => <RevealDemo />,
}

// ──────────────────────────────────────────────────────────────────────────
// Spread-tuning harness (MYT-89 audit #4) — the SAME UX as the fog tuner
// (WorldGenFogField.stories.tsx). A realistic ~24-node graph with the nine force
// params exposed as LIVE sliders (the locked spread seven + the two clustering
// knobs from the MYT-89 untangle); slide them and the layout re-seeds + re-spreads.
// The copy block hands the current values back so Miklos can lock them into
// `FORCE_PARAMS`. Fog is drained to nothing (shown === total → the sim mounts empty)
// so the spread reads clean.
// ──────────────────────────────────────────────────────────────────────────

/** A dev-tuning range control (placeholder labels per the brand i18n rule; the `help`
 *  line is plain English — this is a dev-only tuning harness, not user-facing copy).
 *  Mirrors the fog tuner's Slider; duplicated (not shared) — throwaway harness chrome. */
function Slider(props: {
  label: string
  help: string
  min: number
  max: number
  step: number
  value: number
  onChange: (v: number) => void
  readout: string
}): React.JSX.Element {
  return (
    <div className="flex flex-col gap-[var(--space-1)]">
      <label className="flex items-center gap-[var(--space-2)] font-mono text-[12px] text-ink">
        <span className="w-36">{props.label}</span>
        <input
          type="range"
          min={props.min}
          max={props.max}
          step={props.step}
          value={props.value}
          onChange={(e) => {
            props.onChange(Number(e.target.value))
          }}
          className="flex-1"
        />
        <span className="w-14 text-right text-ink-secondary">{props.readout}</span>
      </label>
      <p className="pl-36 text-[11px] leading-snug text-ink-secondary">{props.help}</p>
    </div>
  )
}

// The nine force knobs, in slider order — placeholder labels (the DS owns no copy).
// The two clustering knobs (MYT-89 untangle — `linkStrength`/`linkDistance`, the link
// pull + rest length that group connected entities) sit right after the two charge
// knobs, interleaved among the Miklos-locked spread seven rather than grouped at the end.
const FORCE_KEYS: readonly (keyof ForceParams)[] = [
  'chargeStrength',
  'chargeDistanceMax',
  'linkStrength',
  'linkDistance',
  'centerStrength',
  'boundaryStrength',
  'collisionPadding',
  'seedJitter',
  'margin',
]
const FORCE_LABELS: Record<keyof ForceParams, string> = {
  chargeStrength: '[ph: charge]',
  chargeDistanceMax: '[ph: charge range]',
  linkStrength: '[ph: link pull]',
  linkDistance: '[ph: link length]',
  centerStrength: '[ph: center]',
  boundaryStrength: '[ph: boundary]',
  collisionPadding: '[ph: box gap]',
  seedJitter: '[ph: seed jitter]',
  margin: '[ph: margin]',
  releaseAlpha: '[ph: release kick]',
  alphaDecay: '[ph: cool-down]',
  velocityDecay: '[ph: friction]',
}
// Plain-English help text under each knob so the tuning is legible WHILE sliding (this
// harness is dev-only — not user-facing product copy, so real prose, not `[ph:]` labels).
const FORCE_DESCRIPTIONS: Record<keyof ForceParams, string> = {
  chargeStrength: 'How hard nodes shove each other apart. More negative = wider spread.',
  chargeDistanceMax: 'How far that shove reaches. Higher = even spread; lower = local clumps.',
  linkStrength:
    'How hard a connection pulls its two entities together — the clustering dial. Higher = connected groups clump tighter (fewer tangled crossings); 0 = connections stop pulling and the layout ignores who relates to whom.',
  linkDistance:
    'The resting length of a connection. Lower = tighter, denser clumps; higher = looser, airier groups.',
  centerStrength:
    "Pulls the whole cluster toward the frame's middle (positions it, doesn't compress). 0 = let repulsion + margin decide.",
  boundaryStrength:
    'Gentle inward pull on every node. Higher = tighter/compact; lower = looser/wider.',
  collisionPadding:
    'The gap between label boxes — bigger = more air between entities. Each entity already reserves its full icon + text box; this just adds breathing room around it (icons + text never overlap regardless).',
  seedJitter: 'How scattered a node starts when it appears. Higher = emerges more spread out.',
  margin: 'How far nodes stay clear of the frame edge (the breathing-room band). Higher = bigger margin.',
  releaseAlpha:
    'How hard the world re-asserts when a dragged entity is let go. 0 = the drop parks the node where you left it (the generating act); high = the release re-energises the field and the node snaps back into its group.',
  alphaDecay:
    'How fast injected energy cools. Low = long anneal (better untangling, longer after-drift); high = decisive but can freeze a re-settle mid-untangle.',
  velocityDecay:
    'Per-tick friction on every node. Higher = the world stays seated through a release (less bystander drift); lower = livelier, floatier motion.',
}

// A realistic synthetic world (~24 named entities across the whole glyph vocabulary +
// a handful of relationships) — enough density that the spread is legible. displayId =
// synthKey (pre-finalize); fixture names mirror the streaming demo's register.
const TUNER_SPECS: readonly (readonly [string, string, string])[] = [
  ['s/world', 'world', 'Ashfen Reach'],
  ['s/ward', 'location', 'The Drowned Ward'],
  ['s/loft', 'location', 'The Bell-Loft'],
  ['s/road', 'location', 'The Forgetting Road'],
  ['s/galleries', 'location', 'The Lower Galleries'],
  ['s/bowl', 'location', 'The Cracked Bowl'],
  ['s/stir', 'location', 'The Understirring'],
  ['s/still', 'location', 'Stillwater'],
  ['s/guild', 'faction', 'The Tallow Guild'],
  ['s/wardens', 'faction', 'Reach Wardens'],
  ['s/recollects', 'faction', "Recollects' Circle"],
  ['s/bellwardens', 'faction', 'Bell-Wardens'],
  ['s/maeris', 'npc', 'Maeris Vale'],
  ['s/corr', 'npc', 'Old Corr'],
  ['s/sennel', 'npc', 'Abbot Sennel'],
  ['s/ivarn', 'npc', 'Lector Ivarn'],
  ['s/peret', 'npc', 'Master Peret Vell'],
  ['s/wren', 'npc', 'Wren the Quiet'],
  ['s/ledger', 'item', 'The Salt Ledger'],
  ['s/bell', 'item', 'The Sunken Bell'],
  ['s/key', 'item', "The Warden's Key"],
  ['s/map', 'item', 'The Tide Map'],
  ['s/pc', 'pc', 'You'],
  ['s/pc2', 'pc', 'Your Companion'],
]
const TUNER_NODES: GraphNode[] = TUNER_SPECS.map(([synthKey, kind, name]) =>
  node(synthKey, kind, name),
)
const TUNER_EDGES: GraphEdge[] = [
  edge('te1', 's/ward', 's/world', 'within'),
  edge('te2', 's/guild', 's/ward', 'controls'),
  edge('te3', 's/maeris', 's/guild', 'leads'),
  edge('te4', 's/ledger', 's/guild', 'kept by'),
  edge('te5', 's/pc', 's/wardens', 'sworn to'),
  edge('te6', 's/sennel', 's/recollects', 'leads'),
  edge('te7', 's/road', 's/world', 'within'),
]

/** The tuning harness: nine force sliders driving `WorldGenGraph.forceParams`, a live
 *  spread of the synthetic world, and a copy-paste block of the current values (drop
 *  straight into `FORCE_PARAMS`). Each slider change re-seeds the sim (fresh spread). */
function GraphSpreadTuner(): React.JSX.Element {
  const [params, setParams] = useState<ForceParams>({ ...FORCE_PARAMS })
  const snippet = FORCE_KEYS.map((k) => `  ${k}: ${String(params[k])},`).join('\n')
  return (
    <div className="min-h-dvh bg-bg p-[var(--space-6)]">
      <div className="mx-auto flex max-w-[900px] flex-col gap-[var(--space-3)]">
        <div className="flex flex-col gap-[var(--space-2)]">
          {FORCE_KEYS.map((k) => (
            <Slider
              key={k}
              label={FORCE_LABELS[k]}
              help={FORCE_DESCRIPTIONS[k]}
              min={FORCE_PARAM_RANGES[k].min}
              max={FORCE_PARAM_RANGES[k].max}
              step={FORCE_PARAM_RANGES[k].step}
              value={params[k]}
              onChange={(v) => {
                setParams((p) => ({ ...p, [k]: v }))
              }}
              readout={String(params[k])}
            />
          ))}
        </div>
        <div className="flex items-start gap-[var(--space-3)]">
          <pre className="flex-1 overflow-auto bg-surface p-[var(--space-3)] font-mono text-[12px] text-ink">{`{\n${snippet}\n}`}</pre>
          <button
            type="button"
            className="border border-border-strong px-[var(--space-3)] py-[var(--space-2)] font-mono text-[12px] text-ink"
            onClick={() => {
              void navigator.clipboard.writeText(`{\n${snippet}\n}`)
            }}
          >
            [ph: copy]
          </button>
          <button
            type="button"
            className="border border-border-strong px-[var(--space-3)] py-[var(--space-2)] font-mono text-[12px] text-ink"
            onClick={() => {
              setParams({ ...FORCE_PARAMS })
            }}
          >
            [ph: reset]
          </button>
        </div>
        <div className="w-full">
          <WorldGenGraph
            nodes={TUNER_NODES}
            edges={TUNER_EDGES}
            forceParams={params}
            shownEntities={TUNER_NODES.length}
            totalEntities={TUNER_NODES.length}
            onSelect={() => undefined}
          />
        </div>
      </div>
    </div>
  )
}

// THE spread-tuning surface — slide the nine force knobs and watch the ~24-node world
// re-seed + re-spread live; copy the settled values back into `FORCE_PARAMS` to lock them.
export const SpreadTuning: Story = {
  render: () => <GraphSpreadTuner />,
}

// ──────────────────────────────────────────────────────────────────────────
// Reveal-settle tuning harness (MYT-89 audit v4) — the FORCEFUL regime's
// dial-in surface. The realistic 46-entity world lands AT ONCE (the reveal's
// cold mount path), settles under the reveal profile, and is INTERACTIVE with
// the regime ON: drag any entity far across the world and LET GO — the release
// must snap it back into its group while the rest of the world holds its seat.
// All twelve force knobs are live, seeded from the merged reveal profile; the
// copy block emits ONLY the delta vs the locked FORCE_PARAMS — the exact
// Partial to lock into `REVEAL_FORCE_PARAMS`.
// ──────────────────────────────────────────────────────────────────────────

// The twelve knobs in dial-in order: the regime's own four first (the snap
// dials), then the shared spread/clustering seven the profile inherits.
const REVEAL_KEYS: readonly (keyof ForceParams)[] = [
  'releaseAlpha',
  'velocityDecay',
  'alphaDecay',
  'linkStrength',
  'linkDistance',
  'chargeStrength',
  'chargeDistanceMax',
  'centerStrength',
  'boundaryStrength',
  'collisionPadding',
  'seedJitter',
  'margin',
]

/** The reveal-regime harness: twelve sliders over the MERGED reveal profile, the
 *  dense world interactive with `forcefulSettle` on (drag → release → watch the
 *  snap), and a copy block of the CURRENT DELTA vs `FORCE_PARAMS` (drop straight
 *  into `REVEAL_FORCE_PARAMS`). A slider change re-seeds (fresh cold settle —
 *  exactly the reveal's mount path, so the settle quality is auditable too). */
function RevealSettleTuner(): React.JSX.Element {
  const [params, setParams] = useState<ForceParams>({ ...FORCE_PARAMS, ...REVEAL_FORCE_PARAMS })
  const [selectedKey, setSelectedKey] = useState<string>()
  const delta = REVEAL_KEYS.filter((k) => params[k] !== FORCE_PARAMS[k])
  const snippet = delta.map((k) => `  ${k}: ${String(params[k])},`).join('\n')
  return (
    <div className="min-h-dvh bg-bg p-[var(--space-6)]">
      <div className="mx-auto flex max-w-[1200px] flex-col gap-[var(--space-3)]">
        <div className="flex flex-col gap-[var(--space-2)]">
          {REVEAL_KEYS.map((k) => (
            <Slider
              key={k}
              label={FORCE_LABELS[k]}
              help={FORCE_DESCRIPTIONS[k]}
              min={FORCE_PARAM_RANGES[k].min}
              max={FORCE_PARAM_RANGES[k].max}
              step={FORCE_PARAM_RANGES[k].step}
              value={params[k]}
              onChange={(v) => {
                setParams((p) => ({ ...p, [k]: v }))
              }}
              readout={String(params[k])}
            />
          ))}
        </div>
        <div className="flex items-start gap-[var(--space-3)]">
          <pre className="flex-1 overflow-auto bg-surface p-[var(--space-3)] font-mono text-[12px] text-ink">{`{\n${snippet}\n}`}</pre>
          <button
            type="button"
            className="border border-border-strong px-[var(--space-3)] py-[var(--space-2)] font-mono text-[12px] text-ink"
            onClick={() => {
              void navigator.clipboard.writeText(`{\n${snippet}\n}`)
            }}
          >
            [ph: copy]
          </button>
          <button
            type="button"
            className="border border-border-strong px-[var(--space-3)] py-[var(--space-2)] font-mono text-[12px] text-ink"
            onClick={() => {
              setParams({ ...FORCE_PARAMS, ...REVEAL_FORCE_PARAMS })
            }}
          >
            [ph: reset]
          </button>
        </div>
        <div className="w-full">
          {/* The DESKTOP reveal's regime shape: pannable={false} → the seat is
              zeroed, world === pane, the WHOLE settled world is visible (judging
              the snap through an engaged camera window reads as churn that isn't
              there — and the desktop reveal never pans). */}
          <WorldGenGraph
            interactive
            forcefulSettle
            pannable={false}
            nodes={[...MAX_DENSITY_NODES]}
            edges={[...MAX_DENSITY_EDGES]}
            forceParams={params}
            shownEntities={MAX_DENSITY_NODES.length}
            totalEntities={MAX_DENSITY_NODES.length}
            {...(selectedKey !== undefined ? { selectedKey } : {})}
            onSelect={setSelectedKey}
          />
        </div>
      </div>
    </div>
  )
}

// THE reveal-settle surface — the forceful regime live on the dense settled
// world: drag an entity, release, judge the snap; copy the delta back into
// `REVEAL_FORCE_PARAMS` to lock it.
export const RevealSettleTuning: Story = {
  name: 'Reveal settle tuning (forceful + snap-back)',
  render: () => <RevealSettleTuner />,
  // The 12-slider tuning harness — a wide-by-design dev specimen like
  // SpreadTuning/the fog tuner, exempt from the 375px overflow gate.
  parameters: { overflowGate: false },
}

// ──────────────────────────────────────────────────────────────────────────
// Density-tuning harness (MYT-89 density redesign) — the SpreadTuning pattern
// for the FOUR density knobs (label area budget, label floor, growth start,
// growth rate), against the INSTANT realistic max-density fixture (46 nodes /
// 72 edges). Slide and watch the label tier + the virtual-space growth respond
// live; copy the values back into `DENSITY_PARAMS` to lock them. The locked
// spread params are untouched — these are NEW dials.
// ──────────────────────────────────────────────────────────────────────────

const DENSITY_KEYS: readonly (keyof DensityParams)[] = [
  'areaPerLabel',
  'minLabels',
  'growthStartCount',
  'growthPerNode',
]
const DENSITY_LABELS: Record<keyof DensityParams, string> = {
  areaPerLabel: '[ph: label area]',
  minLabels: '[ph: label floor]',
  growthStartCount: '[ph: growth start]',
  growthPerNode: '[ph: growth rate]',
}
const DENSITY_DESCRIPTIONS: Record<keyof DensityParams, string> = {
  areaPerLabel:
    'Virtual px² one shown label needs to breathe — the label budget is area ÷ this. Bigger = fewer, airier names (anchors — world/factions/you — always keep theirs).',
  minLabels: 'The label budget never drops below this, however tiny the pane.',
  growthStartCount:
    'Node count at which the virtual space starts growing. Below it the pane keeps the eye-approved desktop zoom.',
  growthPerNode:
    'Virtual px of extra width per node past the start. Higher = the world un-zooms toward 1:1 faster as it fills (labels never render below CSS-px size).',
}

/** The density harness: four sliders driving `densityParams` over the INSTANT
 *  max-density world, plus the copy block. A slider change re-tiers + re-grows live
 *  (no re-seed needed — the tier and the space are derived, not simulated). */
function GraphDensityTuner(): React.JSX.Element {
  const [params, setParams] = useState<DensityParams>({ ...DENSITY_PARAMS })
  const snippet = DENSITY_KEYS.map((k) => `  ${k}: ${String(params[k])},`).join('\n')
  return (
    <div className="min-h-dvh bg-bg p-[var(--space-6)]">
      <div className="mx-auto flex max-w-[1200px] flex-col gap-[var(--space-3)]">
        <div className="flex flex-col gap-[var(--space-2)]">
          {DENSITY_KEYS.map((k) => (
            <Slider
              key={k}
              label={DENSITY_LABELS[k]}
              help={DENSITY_DESCRIPTIONS[k]}
              min={DENSITY_PARAM_RANGES[k].min}
              max={DENSITY_PARAM_RANGES[k].max}
              step={DENSITY_PARAM_RANGES[k].step}
              value={params[k]}
              onChange={(v) => {
                setParams((p) => ({ ...p, [k]: v }))
              }}
              readout={String(params[k])}
            />
          ))}
        </div>
        <div className="flex items-start gap-[var(--space-3)]">
          <pre className="flex-1 overflow-auto bg-surface p-[var(--space-3)] font-mono text-[12px] text-ink">{`{\n${snippet}\n}`}</pre>
          <button
            type="button"
            className="border border-border-strong px-[var(--space-3)] py-[var(--space-2)] font-mono text-[12px] text-ink"
            onClick={() => {
              void navigator.clipboard.writeText(`{\n${snippet}\n}`)
            }}
          >
            [ph: copy]
          </button>
          <button
            type="button"
            className="border border-border-strong px-[var(--space-3)] py-[var(--space-2)] font-mono text-[12px] text-ink"
            onClick={() => {
              setParams({ ...DENSITY_PARAMS })
            }}
          >
            [ph: reset]
          </button>
        </div>
        <div className="w-full">
          <WorldGenGraph
            nodes={[...MAX_DENSITY_NODES]}
            edges={[...MAX_DENSITY_EDGES]}
            densityParams={params}
            shownEntities={MAX_DENSITY_NODES.length}
            totalEntities={MAX_DENSITY_NODES.length}
            onSelect={() => undefined}
          />
        </div>
      </div>
    </div>
  )
}

// THE density-tuning surface — the realistic 46-entity world at once, with the four
// density knobs live; copy the settled values back into `DENSITY_PARAMS` to lock them.
export const DensityTuning: Story = {
  render: () => <GraphDensityTuner />,
}
