import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { I18nextProvider } from 'react-i18next'
import type { StageTiming } from '@mythrun/client-core'
import { MIN_EXPECTED_ENTITIES } from '@mythrun/client-core/worldgen'
import type { StageProgress, WorldGenGraphProps } from '@mythrun/ui'
import { i18n } from '../../i18n/config.ts'
import { GeneratingView } from './generating.tsx'

// GeneratingView is the SOLE production consumer of <WorldGenGraph> during
// generation, and since the two-act cut it is a TWO-ACT flow:
//
//   ACT ONE (prep): while only prep stages have run there is nothing to draw —
//   the view shows the generic WorldGenLoading screen (Spinner + cycling flavor
//   line), NOT the graph. When entities start (an ENTITY_STAGES stage underway
//   OR the first node), the "watch your world be born" button appears; pressing
//   it is the ONLY way to act two (a deliberate beat — never automatic).
//
//   ACT TWO (graph): the GATED, fog-forward experience (§3.3/§3.4): the graph is
//   `interactive={false}`, the status card is fed the stream's `stages[]` + an
//   ENTITY-only `[ph:]` stage-label map + a data-driven ETA label (audit ③) and
//   NO cost (audit ⑥), and the fog DRAIN is keyed off the ENTITY COUNT against
//   the DB-derived floor (MYT-89 spawn-drain): full fog at the reveal, fully
//   drained by MIN_EXPECTED_ENTITIES arrivals.
//
// WorldGenGraph is mocked to a props spy — its own rendering is covered by its
// unit test; here we assert the act gating + the props threaded through.
// WorldGenLoading is REAL (its internals are covered by its own DS unit test;
// here we drive the actual button).

const { graphSpy } = vi.hoisted(() => ({ graphSpy: vi.fn() }))

vi.mock('@mythrun/ui', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@mythrun/ui')>()
  return {
    ...actual,
    WorldGenGraph: (props: WorldGenGraphProps): null => {
      graphSpy(props)
      return null
    },
  }
})

// jsdom has no matchMedia; install a query-aware one so this view's
// prefers-reduced-motion read resolves to the value under test.
function mockMatchMedia(reduced: boolean): void {
  Object.defineProperty(window, 'matchMedia', {
    configurable: true,
    writable: true,
    value: (query: string) => ({
      matches: query.includes('reduced-motion') ? reduced : false,
      media: query,
      onchange: null,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      addListener: vi.fn(),
      removeListener: vi.fn(),
      dispatchEvent: vi.fn(),
    }),
  })
}

const stage = (id: string, status: StageProgress['status']): StageProgress => ({
  stage: id,
  status,
  userId: null,
  costUsd: 0,
  startedAt: null,
  completedAt: null,
})

/** A minimal finalized node — the "first entity arrived" signal. */
const node = (name: string): WorldGenGraphProps['nodes'][number] => ({
  synthKey: name,
  kind: 'npc',
  name,
  displayId: name,
  state: 'finalized',
  lastEventIndex: -1,
})

// The whole prep act completed + the first entity stage underway — the canonical
// "entities have started" stream shape.
const ENTITY_UNDERWAY: readonly StageProgress[] = [
  stage('concept_intake', 'completed'),
  stage('world_color', 'completed'),
  stage('vocabulary_intake', 'completed'),
  stage('world_and_factions', 'running'),
]

interface RenderOpts {
  readonly nodes?: WorldGenGraphProps['nodes']
  readonly stages?: readonly StageProgress[]
  readonly stageTimings?: readonly StageTiming[] | null
}

function renderGenerating({ nodes = [], stages = [], stageTimings = null }: RenderOpts = {}): void {
  render(
    <I18nextProvider i18n={i18n}>
      <GeneratingView nodes={nodes} edges={[]} stages={stages} stageTimings={stageTimings} />
    </I18nextProvider>,
  )
}

/** Press the reveal button — the only path from act one to the graph. */
function reveal(): void {
  fireEvent.click(screen.getByRole('button', { name: i18n.t('worldGen.reveal') }))
}

/** Render with entities underway and reveal — the act-two entry the graph-prop
 *  assertions run against. */
function renderRevealed(opts: RenderOpts = {}): void {
  renderGenerating({ stages: ENTITY_UNDERWAY, ...opts })
  reveal()
}

/** The most recent props the spied WorldGenGraph was rendered with. */
function lastGraphProps(): WorldGenGraphProps {
  return graphSpy.mock.calls.at(-1)?.[0] as WorldGenGraphProps
}

afterEach(() => {
  cleanup()
  vi.useRealTimers()
  vi.clearAllMocks()
  if (typeof window !== 'undefined') Reflect.deleteProperty(window, 'matchMedia')
})

describe('GeneratingView — act one: the prep loading screen', () => {
  it('shows the generic loading screen (NOT the graph) while only prep stages have run', () => {
    mockMatchMedia(false)
    renderGenerating({
      stages: [stage('concept_intake', 'completed'), stage('world_color', 'running')],
    })
    expect(screen.getByTestId('worldgen-loading')).toBeDefined()
    // The DS Spinner carries the busy meaning, with the i18n'd SR label.
    expect(screen.getByRole('status', { name: i18n.t('worldGen.loadingLabel') })).toBeDefined()
    // The graph never mounts during the prep act.
    expect(graphSpy).not.toHaveBeenCalled()
  })

  it('shows the loading screen before the first snapshot frame (empty stream)', () => {
    mockMatchMedia(false)
    renderGenerating()
    expect(screen.getByTestId('worldgen-loading')).toBeDefined()
    expect(graphSpy).not.toHaveBeenCalled()
  })

  it('cycles the `[ph:]` flavor lines every ~3s (Claude-Code-"thinking" style)', () => {
    mockMatchMedia(false)
    vi.useFakeTimers()
    renderGenerating({ stages: [stage('concept_intake', 'running')] })
    expect(screen.getByText(i18n.t('worldGen.flavor1'))).toBeDefined()
    act(() => {
      vi.advanceTimersByTime(3000)
    })
    expect(screen.getByText(i18n.t('worldGen.flavor2'))).toBeDefined()
    act(() => {
      vi.advanceTimersByTime(3000)
    })
    expect(screen.getByText(i18n.t('worldGen.flavor3'))).toBeDefined()
  })

  it('offers NO reveal button during the pure prep act', () => {
    mockMatchMedia(false)
    renderGenerating({ stages: [stage('concept_intake', 'running')] })
    expect(screen.queryByRole('button')).toBeNull()
  })
})

describe('GeneratingView — the beat: entities start → the reveal button', () => {
  it('offers the reveal button when the first ENTITY stage is underway', () => {
    mockMatchMedia(false)
    renderGenerating({ stages: ENTITY_UNDERWAY })
    expect(
      screen.getByRole('button', { name: i18n.t('worldGen.reveal') }),
    ).toBeDefined()
    // Still act one — the graph is only revealed by the press.
    expect(graphSpy).not.toHaveBeenCalled()
  })

  it('offers the reveal button when the first NODE arrives (even before the stage snapshot)', () => {
    mockMatchMedia(false)
    renderGenerating({
      nodes: [node('The Salt Baron')],
      stages: [stage('vocabulary_intake', 'running')],
    })
    expect(
      screen.getByRole('button', { name: i18n.t('worldGen.reveal') }),
    ).toBeDefined()
  })

  it('pressing the button transitions to the graph view (act two)', () => {
    mockMatchMedia(false)
    renderGenerating({ stages: ENTITY_UNDERWAY })
    reveal()
    expect(graphSpy).toHaveBeenCalled()
    expect(screen.queryByTestId('worldgen-loading')).toBeNull()
  })
})

describe('GeneratingView — reduced-motion wiring (act two)', () => {
  it('passes reducedMotion={true} to WorldGenGraph when the user prefers reduced motion', () => {
    mockMatchMedia(true)
    renderRevealed()
    expect(graphSpy).toHaveBeenLastCalledWith(expect.objectContaining({ reducedMotion: true }))
  })

  it('passes reducedMotion={false} by default (no preference set)', () => {
    mockMatchMedia(false)
    renderRevealed()
    expect(graphSpy).toHaveBeenLastCalledWith(expect.objectContaining({ reducedMotion: false }))
  })

  it('passes reducedMotion={false} when matchMedia is unavailable (SSR-safe default)', () => {
    if (typeof window !== 'undefined') Reflect.deleteProperty(window, 'matchMedia')
    renderRevealed()
    expect(graphSpy).toHaveBeenLastCalledWith(expect.objectContaining({ reducedMotion: false }))
  })
})

describe('GeneratingView — gated generation (§3.4)', () => {
  it('renders the graph GATED — interactive={false}, no C5 bridge', () => {
    mockMatchMedia(false)
    renderRevealed()
    // The C5 `interactive` bridge is removed: generation is inert (no entity
    // list, no selection). The reveal keeps `interactive`; the gen view does not.
    expect(lastGraphProps().interactive).toBe(false)
  })
})

describe('GeneratingView — status card wiring (§3.3)', () => {
  it('feeds the status card the stream stages, and NO cost (audit ⑥)', () => {
    mockMatchMedia(false)
    renderRevealed()
    const { status } = lastGraphProps()
    expect(status?.stages).toEqual(ENTITY_UNDERWAY)
    // Cost is never passed to the user card — the player never sees API spend.
    expect((status as Record<string, unknown> | undefined)?.costUsd).toBeUndefined()
  })

  it('supplies an ENTITY-only i18n stage-label map (the prep stretch lives in act one)', () => {
    mockMatchMedia(false)
    renderRevealed()
    const labels = lastGraphProps().status?.stageLabels
    // Entity stage ids resolve to their i18n'd friendly labels — incl.
    // entity_consolidation (stage 4b) so every entity taxonomy bar has a label…
    expect(labels?.world_and_factions).toBe(i18n.t('worldGen.stage.world_and_factions'))
    expect(labels?.entity_consolidation).toBe(i18n.t('worldGen.stage.entity_consolidation'))
    expect(labels?.embed_world).toBe(i18n.t('worldGen.stage.embed_world'))
    // …and the prep stages get NO entry — the card renders no bar for them.
    expect(labels?.concept_intake).toBeUndefined()
    expect(labels?.world_color).toBeUndefined()
    expect(labels?.vocabulary_intake).toBeUndefined()
  })

  it('supplies i18n framing labels (title/done/progress) for the card', () => {
    mockMatchMedia(false)
    renderRevealed()
    const { status } = lastGraphProps()
    expect(status?.titleLabel).toBe(i18n.t('worldGen.statusTitle'))
    expect(status?.doneLabel).toBe(i18n.t('worldGen.statusDone'))
    expect(status?.progressLabel).toBe(i18n.t('worldGen.statusProgress'))
  })
})

describe('GeneratingView — data-driven ETA (audit ③)', () => {
  it('computes a "time left" label from the timings + completed stages', () => {
    mockMatchMedia(false)
    // locations_and_npcs remains at 120_000ms; every other un-completed stage has
    // no timing → 0. Total remaining 120s → 2 minutes → the minutes ETA copy.
    const stages = [...ENTITY_UNDERWAY.slice(0, 3), stage('world_and_factions', 'completed'), stage('locations_and_npcs', 'running')]
    const stageTimings: StageTiming[] = [{ stage: 'locations_and_npcs', avgMs: 120_000 }]
    renderRevealed({ stages, stageTimings })
    expect(lastGraphProps().status?.etaLabel).toBe(i18n.t('worldGen.statusEta', { minutes: 2 }))
  })

  it('uses the seconds copy in the final under-a-minute stretch', () => {
    mockMatchMedia(false)
    const stages = [...ENTITY_UNDERWAY.slice(0, 3), stage('coherence_pass', 'running')]
    const stageTimings: StageTiming[] = [{ stage: 'coherence_pass', avgMs: 30_000 }]
    renderRevealed({ stages, stageTimings })
    expect(lastGraphProps().status?.etaLabel).toBe(
      i18n.t('worldGen.statusEtaShort', { seconds: 30 }),
    )
  })

  it('feeds NO etaLabel on cold-start (empty timings) — the card shows no estimate', () => {
    mockMatchMedia(false)
    renderRevealed({ stageTimings: [] })
    expect(lastGraphProps().status?.etaLabel).toBeUndefined()
  })

  it('feeds NO etaLabel before the timings resolve (null)', () => {
    mockMatchMedia(false)
    renderRevealed({ stageTimings: null })
    expect(lastGraphProps().status?.etaLabel).toBeUndefined()
  })
})

describe('GeneratingView — fog drain keyed off the ENTITY COUNT (MYT-89 spawn-drain)', () => {
  it('holds FULL fog at the reveal moment (no entity arrived yet)', () => {
    mockMatchMedia(false)
    renderRevealed() // prep complete, world_and_factions running, zero nodes
    const props = lastGraphProps()
    // shown 0 over the ENTITY FLOOR — spawn scale 1: full fog at the birth of the
    // world; stage progress no longer drives the clear at all.
    expect(props.shownEntities).toBe(0)
    expect(props.totalEntities).toBe(MIN_EXPECTED_ENTITIES)
  })

  it('feeds the ARRIVED NODE COUNT as the drain numerator mid-gen', () => {
    mockMatchMedia(false)
    renderRevealed({ nodes: [node('The Salt Baron'), node('The Drowned Ward'), node('Bell-Wardens')] })
    const props = lastGraphProps()
    expect(props.shownEntities).toBe(3)
    expect(props.totalEntities).toBe(MIN_EXPECTED_ENTITIES)
  })

  it('the denominator is the DB-derived entity floor — a constant, never the stage count', () => {
    mockMatchMedia(false)
    const stages = [
      ...ENTITY_UNDERWAY.slice(0, 3),
      stage('world_and_factions', 'completed'),
      stage('coherence_pass', 'completed'),
      stage('embed_world', 'completed'),
    ]
    renderRevealed({ stages })
    // Every stage complete yet zero nodes: the old stage-keyed fade would report
    // fully-gone here — the drain stays keyed to entities alone.
    const props = lastGraphProps()
    expect(props.shownEntities).toBe(0)
    expect(props.totalEntities).toBe(MIN_EXPECTED_ENTITIES)
  })

  it('reaches the floor as the graph fills — nothing spawns from here (fog drains to gone)', () => {
    mockMatchMedia(false)
    const nodes = Array.from({ length: MIN_EXPECTED_ENTITIES }, (_, i) => node(`Entity ${String(i)}`))
    renderRevealed({ nodes })
    const props = lastGraphProps()
    expect(props.shownEntities).toBe(MIN_EXPECTED_ENTITIES)
    expect(props.totalEntities).toBe(MIN_EXPECTED_ENTITIES)
  })
})
