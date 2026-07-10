import { useState } from 'react'
import type { Meta, StoryObj } from '@storybook/react-vite'
import { expect, userEvent, waitFor, within } from 'storybook/test'
import type { GraphEdge, GraphNode, RevealMoment } from '@mythrun/client-core/contract'
import { MIN_EXPECTED_ENTITIES } from '@mythrun/client-core/worldgen'
import { RevealTransition, RevealPanes, RevealFade, revealPhaseAtLeast } from './RevealTransition.tsx'
import { MAX_DENSITY_EDGES, MAX_DENSITY_NODES } from '../WorldGenGraph/max-density-fixture.ts'
import { WorldGenGraph } from '../WorldGenGraph/WorldGenGraph.tsx'
import { Drawer } from '../Drawer/Drawer.tsx'
import { FullBleedStage } from '../FullBleedStage/FullBleedStage.tsx'
import { Stack } from '../Stack/Stack.tsx'
import { Heading } from '../Heading/Heading.tsx'
import { Text } from '../Text/Text.tsx'
import { Divider } from '../Divider/Divider.tsx'
import { Button } from '../Button/Button.tsx'

// RevealTransition — the gen→reveal REWARD MOMENT (MYT-89 §3.8, D6): the beat
// where the cleared world settles, the title lands, and the wiki arrives.
// These stories are the TUNING BENCH: a synthetic completed
// graph plays the full moment on load, the replay button re-runs it, and the
// arrangements mirror the app's reveal recipe exactly (RevealPanes for the
// desktop 50/50 arrival; the edge-handle Drawer arriving at `resolve` on
// mobile), so the timings can be judged in isolation from the pipeline.
//
// The fog composes through its ONE clear mechanism (the spawn drain), and on
// the reveal it is BORN DRAINED for every world size: the numerator is floored
// at the denominator (the app's `revealFogShown` recipe — the §3.8 fog-gone
// invariant). A live gust of a sub-floor world's residual was tried and cut on
// the sequence capture: the remounted sim's cold low-pass fades the haze back
// IN, and the wind needs ~20s to carry it off.

/** The reveal fog numerator — always fully arrived (the app's `revealFogShown`). */
function fogShown(nodeCount: number): number {
  return Math.max(nodeCount, MIN_EXPECTED_ENTITIES)
}

/** A sub-floor world (28 of the 46 fixture entities) — the sparser layout the
 *  drain floor exists for; its reveal fog is born drained like every other. */
const SUB_FLOOR_NODES: readonly GraphNode[] = MAX_DENSITY_NODES.slice(0, 28)
const SUB_FLOOR_IDS = new Set(SUB_FLOOR_NODES.map((n) => n.synthKey))
const SUB_FLOOR_EDGES: readonly GraphEdge[] = MAX_DENSITY_EDGES.filter(
  (e) => SUB_FLOOR_IDS.has(e.from) && SUB_FLOOR_IDS.has(e.to),
)

/** The wiki stand-in — enough paper to read as the arriving pane (real pages
 *  are WorldWiki's; the moment only needs its silhouette). */
function FauxWiki(): React.JSX.Element {
  return (
    <Stack gap={3}>
      <Text role="ui-caption">reveal.wiki.search</Text>
      <Divider />
      <Heading level={2} role="heading">reveal.wiki.factions</Heading>
      <Stack gap={1}>
        <Text>The Tallow Guild</Text>
        <Text>Reach Wardens</Text>
        <Text>Bell-Wardens</Text>
      </Stack>
      <Heading level={2} role="heading">reveal.wiki.places</Heading>
      <Stack gap={1}>
        <Text>The Drowned Ward</Text>
        <Text>The Bell-Loft</Text>
        <Text>The Forgetting Road</Text>
      </Stack>
    </Stack>
  )
}

interface ArrangementProps {
  moment: RevealMoment
  nodes: readonly GraphNode[]
  edges: readonly GraphEdge[]
  reducedMotion: boolean
}

/** The desktop reveal recipe: title fades at `settle`; RevealPanes re-seats
 *  the full-width graph to the left half while the wiki slides in at
 *  `resolve`; the prompt arrives with the layout. The graph FILLS its half
 *  (fillHost — the row owns the vertical space), never pans on desktop
 *  (pannable false), and runs the FORCEFUL settle regime (audit v4) — the
 *  app's reveal regime props, mirrored exactly. */
function DesktopArrangement({ moment, nodes, edges, reducedMotion }: ArrangementProps): React.JSX.Element {
  return (
    <Stack gap={4}>
      <RevealFade moment={moment} visibleFrom="settle">
        <Heading level={1} role="title">reveal.title</Heading>
      </RevealFade>
      <RevealPanes
        moment={moment}
        stage={
          <WorldGenGraph
            interactive
            pannable={false}
            fillHost
            forcefulSettle
            nodes={[...nodes]}
            edges={[...edges]}
            onSelect={() => undefined}
            reducedMotion={reducedMotion}
            shownEntities={fogShown(nodes.length)}
            totalEntities={MIN_EXPECTED_ENTITIES}
          />
        }
        panel={<FauxWiki />}
      />
      <RevealFade moment={moment} visibleFrom="resolve">
        <Text role="prose-body" as="p">reveal.explore-prompt</Text>
      </RevealFade>
    </Stack>
  )
}

/** The mobile reveal recipe: the graph owns the glass in every phase (the
 *  gen→reveal geometric continuity); the drawer — handle pinned at the right
 *  edge — arrives at `resolve`. */
function MobileArrangement({ moment, nodes, edges, reducedMotion }: ArrangementProps): React.JSX.Element {
  const [open, setOpen] = useState(false)
  return (
    <Stack>
      <FullBleedStage inset={6}>
        <WorldGenGraph
          interactive
          fillHost
          forcefulSettle
          nodes={[...nodes]}
          edges={[...edges]}
          onSelect={() => undefined}
          reducedMotion={reducedMotion}
          shownEntities={fogShown(nodes.length)}
          totalEntities={MIN_EXPECTED_ENTITIES}
        />
      </FullBleedStage>
      {revealPhaseAtLeast(moment.phase, 'resolve') && (
        <Drawer
          title="reveal.title"
          description="reveal.explore-prompt"
          openLabel="reveal.wiki.open"
          closeLabel="reveal.wiki.close"
          open={open}
          onOpenChange={setOpen}
        >
          <FauxWiki />
        </Drawer>
      )}
    </Stack>
  )
}

interface MomentDemoProps {
  narrow?: boolean
  reducedMotion?: boolean
  nodes?: readonly GraphNode[]
  edges?: readonly GraphEdge[]
}

/** The bench: the moment plays on mount; replay remounts it (fresh latch). The
 *  replay press's own pointer-down lands on the OUTGOING moment (skip is part
 *  of the contract); the remount then plays clean. */
function MomentDemo({
  narrow = false,
  reducedMotion = false,
  nodes = MAX_DENSITY_NODES,
  edges = MAX_DENSITY_EDGES,
}: MomentDemoProps): React.JSX.Element {
  const [run, setRun] = useState(0)
  const Arrangement = narrow ? MobileArrangement : DesktopArrangement
  return (
    <div className="min-h-dvh bg-bg p-[var(--space-6)]">
      <div className="mb-[var(--space-4)]">
        <Button
          variant="secondary"
          onPress={() => {
            setRun((r) => r + 1)
          }}
        >
          reveal.replay
        </Button>
      </div>
      <RevealTransition key={run} play reducedMotion={reducedMotion} data-testid="moment">
        {(moment) => (
          <Arrangement moment={moment} nodes={nodes} edges={edges} reducedMotion={reducedMotion} />
        )}
      </RevealTransition>
    </div>
  )
}

const meta: Meta<typeof MomentDemo> = {
  title: 'Patterns/RevealTransition',
  component: MomentDemo,
  parameters: { layout: 'fullscreen' },
}

// eslint-disable-next-line no-restricted-syntax -- Storybook CSF requires the meta object as the module's default export.
export default meta

type Story = StoryObj<typeof MomentDemo>

// The common case: a world past the entity floor (46 nodes) — the fog drained
// during generation, so the moment is the quiet beat + title + layout arrival.
// The play() drives the SKIP contract in real Chromium: a mid-moment pointer
// press lands the layout in its final state (phase done, title visible).
export const Default: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    const moment = canvasElement.querySelector('[data-testid="moment"]')
    await expect(moment).not.toBeNull()
    // Skip mid-moment: any pointer-down lands in the final state.
    await userEvent.click(canvas.getByRole('heading', { name: 'reveal.title' }))
    await waitFor(() => expect(moment?.getAttribute('data-reveal-phase')).toBe('done'))
  },
}

// A sub-floor world (28 < 32) — the sparser layout at the same beat. Its fog
// is born drained like every other reveal (see the module note on why a live
// residual gust was cut).
export const SubFloorWorld: Story = {
  args: { nodes: SUB_FLOOR_NODES, edges: SUB_FLOOR_EDGES },
}

// The mobile recipe at phone width: the graph owns the glass throughout (the
// generating act's exact geometry — the swap doesn't jolt the pane); the wiki
// drawer's edge handle arrives with `resolve`.
export const Mobile: Story = {
  args: { narrow: true, nodes: SUB_FLOOR_NODES, edges: SUB_FLOOR_EDGES },
  globals: { viewport: { value: 'mobile1', isRotated: false } },
}

// The §3.8 reduced path: no walk — fog cleared and layout final from the first
// frame, one ~300ms surface fade to mark the completion.
export const ReducedMotion: Story = {
  args: { reducedMotion: true },
}
