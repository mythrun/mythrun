import { useEffect, useRef, useState } from 'react'
import {
  Divider,
  Heading,
  RevealFade,
  RevealPanes,
  RevealTransition,
  Stack,
  Text,
  WorldGenGraph,
} from '@mythrun/ui'
import { MIN_EXPECTED_ENTITIES } from '@mythrun/client-core/worldgen'
import type { GraphEdge, GraphNode, RevealMoment } from '@mythrun/client-core/contract'
import type { AuditSection } from '../types.ts'

// ── RevealTransition: the gen→reveal REWARD MOMENT (§3.8). A once-latched, skippable
//    timeline (hold → gust → settle → resolve → done) handed to consumers as a render-
//    prop RevealMoment. This replicates the story's DESKTOP arrangement: the title
//    fades in at `settle`; RevealPanes re-seats the full-width graph to the left half
//    while the wiki slides in at `resolve`; the explore prompt arrives with the layout.
//    The embedded graph runs the forceful cold-settle. Reduced motion: no walk — one
//    ~300ms surface fade, layout final from the first frame.

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

const REVEAL_NODES: GraphNode[] = [
  node('r/world', 'world', 'Ashfen Reach'),
  node('r/ward', 'location', 'The Drowned Ward'),
  node('r/loft', 'location', 'The Bell-Loft'),
  node('r/road', 'location', 'The Forgetting Road'),
  node('r/guild', 'faction', 'The Tallow Guild'),
  node('r/wardens', 'faction', 'Reach Wardens'),
  node('r/maeris', 'npc', 'Maeris Vale'),
  node('r/corr', 'npc', 'Old Corr'),
  node('r/ledger', 'item', 'The Salt Ledger'),
  node('r/pc', 'pc', 'You'),
]
const REVEAL_EDGES: GraphEdge[] = [
  edge('re1', 'r/ward', 'r/world', 'within'),
  edge('re2', 'r/guild', 'r/ward', 'controls'),
  edge('re3', 'r/maeris', 'r/guild', 'leads'),
  edge('re4', 'r/ledger', 'r/guild', 'kept by'),
  edge('re5', 'r/pc', 'r/wardens', 'sworn to'),
  edge('re6', 'r/road', 'r/world', 'within'),
]

/** The reveal fog numerator — always fully arrived (the app's revealFogShown recipe). */
function fogShown(nodeCount: number): number {
  return Math.max(nodeCount, MIN_EXPECTED_ENTITIES)
}

function FauxWiki(): React.JSX.Element {
  return (
    <Stack gap={3}>
      <Text role="ui-caption">[ph: search your world]</Text>
      <Divider />
      <Heading level={2} role="heading">
        [ph: factions]
      </Heading>
      <Stack gap={1}>
        <Text>The Tallow Guild</Text>
        <Text>Reach Wardens</Text>
      </Stack>
      <Heading level={2} role="heading">
        [ph: places]
      </Heading>
      <Stack gap={1}>
        <Text>The Drowned Ward</Text>
        <Text>The Bell-Loft</Text>
        <Text>The Forgetting Road</Text>
      </Stack>
    </Stack>
  )
}

function DesktopArrangement({ moment, reducedMotion }: { moment: RevealMoment; reducedMotion: boolean }): React.JSX.Element {
  return (
    <Stack gap={4}>
      <RevealFade moment={moment} visibleFrom="settle">
        <Heading level={1} role="title">
          [ph: your world is ready]
        </Heading>
      </RevealFade>
      <RevealPanes
          moment={moment}
          stage={
            <WorldGenGraph
              interactive
              pannable={false}
              fillHost
              forcefulSettle
              nodes={REVEAL_NODES}
              edges={REVEAL_EDGES}
              onSelect={() => undefined}
              reducedMotion={reducedMotion}
              shownEntities={fogShown(REVEAL_NODES.length)}
              totalEntities={MIN_EXPECTED_ENTITIES}
            />
          }
          panel={<FauxWiki />}
        />
      <RevealFade moment={moment} visibleFrom="resolve">
        <Text role="prose-body" as="p">
          [ph: explore the wiki, or begin your first session]
        </Text>
      </RevealFade>
    </Stack>
  )
}

/** RevealPanes hard-codes its own `100dvh`-based height (it's a full-screen route
 *  moment and bans consumer sizing overrides), so we uniformly SCALE the whole
 *  reveal to fit the audit box — the real component, shown at a smaller zoom, with
 *  the entire choreography (title → panes re-seat → wiki → prompt) in view. Fits by
 *  HEIGHT and widens the logical content so the scaled result still fills the box. */
function AutoFit({ boxHeight, children }: { boxHeight: number; children: React.ReactNode }): React.JSX.Element {
  const outer = useRef<HTMLDivElement>(null)
  const inner = useRef<HTMLDivElement>(null)
  const [{ scale, width }, setFit] = useState<{ scale: number; width: number }>({ scale: 1, width: 0 })
  useEffect(() => {
    const measure = (): void => {
      const o = outer.current
      const i = inner.current
      if (o === null || i === null) return
      const ih = i.scrollHeight
      const s = ih > 0 ? Math.min(o.clientHeight / ih, 1) : 1
      setFit({ scale: s, width: s > 0 ? o.clientWidth / s : o.clientWidth })
    }
    measure()
    const ro = new ResizeObserver(measure)
    if (outer.current !== null) ro.observe(outer.current)
    if (inner.current !== null) ro.observe(inner.current)
    return () => {
      ro.disconnect()
    }
  }, [])
  return (
    <div ref={outer} style={{ height: boxHeight, width: '100%', overflow: 'hidden', position: 'relative' }}>
      <div
        ref={inner}
        style={{ transform: `scale(${String(scale)})`, transformOrigin: 'top left', width: width > 0 ? width : '100%' }}
      >
        {children}
      </div>
    </div>
  )
}

function RevealLoop({ reducedMotion, boxHeight }: { reducedMotion: boolean; boxHeight: number }): React.JSX.Element {
  return (
    <AutoFit boxHeight={boxHeight}>
      <div className="flex w-full flex-col bg-bg p-[var(--space-5)]">
        <RevealTransition play reducedMotion={reducedMotion}>
          {(moment) => <DesktopArrangement moment={moment} reducedMotion={reducedMotion} />}
        </RevealTransition>
      </div>
    </AutoFit>
  )
}

export const revealSections: AuditSection[] = [
  {
    id: 'reveal-transition',
    name: 'RevealTransition — gen → reveal moment',
    path: 'frontend/ui/src/components/RevealTransition',
    where: 'The beat when generation completes and the world reveal arrives',
    note: 'Desktop recipe: title fades in at `settle`; RevealPanes re-seats the full-width graph to the left half while the wiki slides in at `resolve`; the prompt arrives with the layout. Auto-replays. Reduced motion: no walk — one ~300ms fade, layout final immediately.',
    height: 520,
    autoReplayMs: 9000,
    render: ({ reducedMotion, replayKey }) => (
      <RevealLoop key={replayKey} reducedMotion={reducedMotion} boxHeight={520} />
    ),
  },
]
