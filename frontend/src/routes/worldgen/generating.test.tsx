import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { I18nextProvider } from 'react-i18next'
import type { StageTiming } from '@mythrun/client-core'
import { MIN_EXPECTED_ENTITIES } from '@mythrun/client-core/worldgen'
import { WORLD_GEN_STAGES, type WorldGenStage } from '@mythrun/contract/events'
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
//   `interactive={false}`, the status card is fed the stream's `stages[]` + a
//   full stage-label map (every canonical stage carries a friendly label — built
//   by iterating WORLD_GEN_STAGES, so the card/announcer never fall back; the card
//   still only bars the watched entity stages) + a data-driven ETA label (audit ③)
//   and NO cost (audit
//   ⑥), and the fog DRAIN is keyed off the ENTITY COUNT against the DB-derived
//   floor (MYT-89 spawn-drain): full fog at the graph entry, fully drained by
//   MIN_EXPECTED_ENTITIES arrivals.
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

const stage = (
  id: string,
  status: StageProgress['status'],
  startedAt: string | null = null,
): StageProgress => ({
  stage: id,
  status,
  userId: null,
  costUsd: 0,
  startedAt,
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
  readonly resumedMidGen?: boolean
}

function renderGenerating({
  nodes = [],
  stages = [],
  stageTimings = null,
  resumedMidGen = false,
}: RenderOpts = {}): void {
  render(
    <I18nextProvider i18n={i18n}>
      <GeneratingView
        nodes={nodes}
        edges={[]}
        stages={stages}
        stageTimings={stageTimings}
        resumedMidGen={resumedMidGen}
      />
    </I18nextProvider>,
  )
}

/** Press the watch button — the only path from act one to the graph. */
function watch(): void {
  fireEvent.click(screen.getByRole('button', { name: i18n.t('worldGen.watch') }))
}

/** Render with entities underway and enter the graph — the act-two entry the
 *  graph-prop assertions run against. */
function renderWatching(opts: RenderOpts = {}): void {
  renderGenerating({ stages: ENTITY_UNDERWAY, ...opts })
  watch()
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

  it('cycles ALL TWENTY flavor lines every ~3s, each exactly once per pass (a shuffled permutation)', () => {
    mockMatchMedia(false)
    vi.useFakeTimers()
    // The twenty catalog lines the view must thread through. Literal keys — the
    // typed catalog rejects dynamic ones.
    const allFlavors = new Set([
      i18n.t('worldGen.flavor1'),
      i18n.t('worldGen.flavor2'),
      i18n.t('worldGen.flavor3'),
      i18n.t('worldGen.flavor4'),
      i18n.t('worldGen.flavor5'),
      i18n.t('worldGen.flavor6'),
      i18n.t('worldGen.flavor7'),
      i18n.t('worldGen.flavor8'),
      i18n.t('worldGen.flavor9'),
      i18n.t('worldGen.flavor10'),
      i18n.t('worldGen.flavor11'),
      i18n.t('worldGen.flavor12'),
      i18n.t('worldGen.flavor13'),
      i18n.t('worldGen.flavor14'),
      i18n.t('worldGen.flavor15'),
      i18n.t('worldGen.flavor16'),
      i18n.t('worldGen.flavor17'),
      i18n.t('worldGen.flavor18'),
      i18n.t('worldGen.flavor19'),
      i18n.t('worldGen.flavor20'),
    ])
    expect(allFlavors.size).toBe(20)
    renderGenerating({ stages: [stage('concept_intake', 'running')] })
    const seen = new Set<string>()
    const readFlavor = (): void => {
      const text = screen.getByTestId('worldgen-loading-flavor').textContent
      expect(allFlavors.has(text)).toBe(true)
      seen.add(text)
    }
    readFlavor()
    // 19 more ticks walk the REST of the permutation: every line shows exactly
    // once before any repeats — 20 distinct lines seen, whatever the shuffle drew.
    for (let tick = 0; tick < 19; tick++) {
      act(() => {
        vi.advanceTimersByTime(3000)
      })
      readFlavor()
    }
    expect(seen.size).toBe(20)
    // 20 full re-renders of the loading view spend REAL time (fake timers only
    // skip the waits): CI's slower CPU overruns vitest's 5s default — the
    // home.test CoverDither precedent. Generous ceiling, not a slow test.
  }, 20_000)

  it('offers NO watch button during the pure prep act', () => {
    mockMatchMedia(false)
    renderGenerating({ stages: [stage('concept_intake', 'running')] })
    expect(screen.queryByRole('button')).toBeNull()
  })
})

describe('GeneratingView — the beat: entities start → the watch button', () => {
  it('offers the watch button when the first ENTITY stage is underway', () => {
    mockMatchMedia(false)
    renderGenerating({ stages: ENTITY_UNDERWAY })
    expect(
      screen.getByRole('button', { name: i18n.t('worldGen.watch') }),
    ).toBeDefined()
    // Still act one — the graph only shows on the press.
    expect(graphSpy).not.toHaveBeenCalled()
  })

  it('offers the watch button when the first NODE arrives (even before the stage snapshot)', () => {
    mockMatchMedia(false)
    renderGenerating({
      nodes: [node('The Salt Baron')],
      stages: [stage('vocabulary_intake', 'running')],
    })
    expect(
      screen.getByRole('button', { name: i18n.t('worldGen.watch') }),
    ).toBeDefined()
  })

  it('pressing the button transitions to the graph view (act two)', () => {
    mockMatchMedia(false)
    renderGenerating({ stages: ENTITY_UNDERWAY })
    watch()
    expect(graphSpy).toHaveBeenCalled()
    expect(screen.queryByTestId('worldgen-loading')).toBeNull()
  })
})

describe('GeneratingView — reduced-motion wiring (act two)', () => {
  it('passes reducedMotion={true} to WorldGenGraph when the user prefers reduced motion', () => {
    mockMatchMedia(true)
    renderWatching()
    expect(graphSpy).toHaveBeenLastCalledWith(expect.objectContaining({ reducedMotion: true }))
  })

  it('passes reducedMotion={false} by default (no preference set)', () => {
    mockMatchMedia(false)
    renderWatching()
    expect(graphSpy).toHaveBeenLastCalledWith(expect.objectContaining({ reducedMotion: false }))
  })

  it('passes reducedMotion={false} when matchMedia is unavailable (SSR-safe default)', () => {
    if (typeof window !== 'undefined') Reflect.deleteProperty(window, 'matchMedia')
    renderWatching()
    expect(graphSpy).toHaveBeenLastCalledWith(expect.objectContaining({ reducedMotion: false }))
  })
})

describe('GeneratingView — act two rides the FullBleedStage (MYT-89 audit v2)', () => {
  // The OTHER half of the inset coupling: app-frame.test.tsx pins the AppFrame
  // content box at `p-[var(--space-6)]`; this pins the act-two stage's bleed to
  // the SAME token. If the route's `inset={6}` drifts (or the stage stops
  // bleeding), the graph silently stops being edge-to-edge on phones without
  // any other test noticing — this is that tripwire. FullBleedStage is REAL
  // here (only WorldGenGraph is spied).

  it('narrow viewport: the stage bleeds exactly the frame inset (--space-6)', () => {
    // mockMatchMedia reports matches:false for every non-reduced-motion query —
    // including the wide-viewport `(min-width: 640px)` read — so this renders
    // the NARROW regime, where the stage's bleed branch is live.
    mockMatchMedia(false)
    renderWatching()
    expect(screen.getByTestId('worldgen-generating').className).toContain('-m-[var(--space-6)]')
  })

  it('no matchMedia (wide/SSR default): the stage is a plain block — no bleed', () => {
    if (typeof window !== 'undefined') Reflect.deleteProperty(window, 'matchMedia')
    renderWatching()
    expect(screen.getByTestId('worldgen-generating').className).not.toContain('-m-')
  })
})

describe('GeneratingView — gated generation (§3.4)', () => {
  it('renders the graph GATED — interactive={false}, no C5 bridge', () => {
    mockMatchMedia(false)
    renderWatching()
    // The C5 `interactive` bridge is removed: generation is inert (no entity
    // list, no selection). The reveal keeps `interactive`; the gen view does not.
    expect(lastGraphProps().interactive).toBe(false)
  })
})

describe('GeneratingView — status card wiring (§3.3)', () => {
  it('feeds the status card the stream stages, and NO cost (audit ⑥)', () => {
    mockMatchMedia(false)
    renderWatching()
    const { status } = lastGraphProps()
    expect(status?.stages).toEqual(ENTITY_UNDERWAY)
    // Cost is never passed to the user card — the player never sees API spend.
    expect((status as Record<string, unknown> | undefined)?.costUsd).toBeUndefined()
  })

  it('supplies a friendly i18n label for EVERY canonical world-gen stage', () => {
    mockMatchMedia(false)
    renderWatching()
    const labels = lastGraphProps().status?.stageLabels
    // The production map is built by iterating WORLD_GEN_STAGES, so every canonical
    // stage carries a real label — the card + SR announcer never fall back to the
    // defensive title. This expected map is Record<WorldGenStage>, so a future
    // taxonomy addition fails THIS compile in lockstep with the production map's
    // own compile guard (STAGE_LABEL_KEY).
    const expected: Record<WorldGenStage, string> = {
      concept_intake: i18n.t('worldGen.stage.concept_intake'),
      world_color: i18n.t('worldGen.stage.world_color'),
      vocabulary_intake: i18n.t('worldGen.stage.vocabulary_intake'),
      world_and_factions: i18n.t('worldGen.stage.world_and_factions'),
      locations_and_npcs: i18n.t('worldGen.stage.locations_and_npcs'),
      entity_relationships: i18n.t('worldGen.stage.entity_relationships'),
      world_introduction: i18n.t('worldGen.stage.world_introduction'),
      entity_consolidation: i18n.t('worldGen.stage.entity_consolidation'),
      starting_situation: i18n.t('worldGen.stage.starting_situation'),
      random_tables: i18n.t('worldGen.stage.random_tables'),
      coherence_pass: i18n.t('worldGen.stage.coherence_pass'),
      embed_world: i18n.t('worldGen.stage.embed_world'),
    }
    for (const s of WORLD_GEN_STAGES) {
      expect(labels?.[s]).toBe(expected[s])
    }
  })

  it('supplies i18n framing labels (title/done/progress) for the card', () => {
    mockMatchMedia(false)
    renderWatching()
    const { status } = lastGraphProps()
    expect(status?.titleLabel).toBe(i18n.t('worldGen.statusTitle'))
    expect(status?.doneLabel).toBe(i18n.t('worldGen.statusDone'))
    expect(status?.progressLabel).toBe(i18n.t('worldGen.statusProgress'))
  })
})

describe('GeneratingView — the per-second countdown (MYT-89 waiting-feedback)', () => {
  // A fixed clock: fake timers pin Date.now(), so startedAt offsets are exact.
  const T0 = new Date('2026-07-07T12:00:00.000Z')
  const ago = (ms: number): string => new Date(T0.getTime() - ms).toISOString()

  it('shows a ticking ~M:SS countdown ON THE LOADING SCREEN (act one has the expectation too)', () => {
    mockMatchMedia(false)
    vi.useFakeTimers()
    vi.setSystemTime(T0)
    // concept_intake is 30s into its 60s average (30s left) + world_color's
    // whole 35s ahead → 65s remain → "~1:05 left".
    const stages = [stage('concept_intake', 'running', ago(30_000))]
    const stageTimings: StageTiming[] = [
      { stage: 'concept_intake', avgMs: 60_000 },
      { stage: 'world_color', avgMs: 35_000 },
    ]
    renderGenerating({ stages, stageTimings })
    const countdown = screen.getByTestId('worldgen-loading-countdown')
    expect(countdown.textContent).toBe(i18n.t('worldGen.countdown', { time: '1:05' }))
    // One real second later the number has walked down one second.
    act(() => {
      vi.advanceTimersByTime(1000)
    })
    expect(countdown.textContent).toBe(i18n.t('worldGen.countdown', { time: '1:04' }))
    // …and keeps walking (the "feels like progress" beat).
    act(() => {
      vi.advanceTimersByTime(4000)
    })
    expect(countdown.textContent).toBe(i18n.t('worldGen.countdown', { time: '1:00' }))
  })

  it('feeds the TICKING countdown to the status card (replacing the coarse minute ETA)', () => {
    mockMatchMedia(false)
    vi.useFakeTimers()
    vi.setSystemTime(T0)
    // locations_and_npcs is 20s into its 120s average → 100s left → "~1:40 left".
    const stages = [
      ...ENTITY_UNDERWAY.slice(0, 3),
      stage('world_and_factions', 'completed'),
      stage('locations_and_npcs', 'running', ago(20_000)),
    ]
    const stageTimings: StageTiming[] = [{ stage: 'locations_and_npcs', avgMs: 120_000 }]
    renderWatching({ stages, stageTimings })
    expect(lastGraphProps().status?.countdownLabel).toBe(
      i18n.t('worldGen.countdown', { time: '1:40' }),
    )
    act(() => {
      vi.advanceTimersByTime(1000)
    })
    expect(lastGraphProps().status?.countdownLabel).toBe(
      i18n.t('worldGen.countdown', { time: '1:39' }),
    )
  })

  it('HOLDS at the remaining-future floor while a stage overruns, then RESUMES on completion', () => {
    mockMatchMedia(false)
    vi.useFakeTimers()
    vi.setSystemTime(T0)
    // locations_and_npcs has overrun its 60s average (90s elapsed): its own
    // contribution clamps to 0, so the count HOLDS at the boundary stage's 30s.
    const overrunning = [
      ...ENTITY_UNDERWAY.slice(0, 3),
      stage('world_and_factions', 'completed'),
      stage('locations_and_npcs', 'running', ago(90_000)),
    ]
    const stageTimings: StageTiming[] = [
      { stage: 'locations_and_npcs', avgMs: 60_000 },
      { stage: 'entity_relationships', avgMs: 30_000 },
    ]
    const view = render(
      <I18nextProvider i18n={i18n}>
        <GeneratingView
          nodes={[]}
          edges={[]}
          stages={overrunning}
          stageTimings={stageTimings}
          resumedMidGen={false}
        />
      </I18nextProvider>,
    )
    watch()
    expect(lastGraphProps().status?.countdownLabel).toBe(
      i18n.t('worldGen.countdown', { time: '0:30' }),
    )
    // Seconds pass; the overrun deepens; the count holds — never negative.
    act(() => {
      vi.advanceTimersByTime(5000)
    })
    expect(lastGraphProps().status?.countdownLabel).toBe(
      i18n.t('worldGen.countdown', { time: '0:30' }),
    )
    // The stage completes (the next stream event): the boundary stage starts and
    // the count RESUMES walking from its average.
    const resumed = [
      ...ENTITY_UNDERWAY.slice(0, 3),
      stage('world_and_factions', 'completed'),
      stage('locations_and_npcs', 'completed'),
      stage('entity_relationships', 'running', new Date(T0.getTime() + 5000).toISOString()),
    ]
    view.rerender(
      <I18nextProvider i18n={i18n}>
        <GeneratingView
          nodes={[]}
          edges={[]}
          stages={resumed}
          stageTimings={stageTimings}
          resumedMidGen={false}
        />
      </I18nextProvider>,
    )
    expect(lastGraphProps().status?.countdownLabel).toBe(
      i18n.t('worldGen.countdown', { time: '0:30' }),
    )
    act(() => {
      vi.advanceTimersByTime(2000)
    })
    expect(lastGraphProps().status?.countdownLabel).toBe(
      i18n.t('worldGen.countdown', { time: '0:28' }),
    )
  })

  it('feeds NO countdown on cold-start (empty timings) — both surfaces show no estimate', () => {
    mockMatchMedia(false)
    renderGenerating({ stageTimings: [] })
    expect(screen.queryByTestId('worldgen-loading-countdown')).toBeNull()
    cleanup()
    renderWatching({ stageTimings: [] })
    expect(lastGraphProps().status?.countdownLabel).toBeUndefined()
  })

  it('feeds NO countdown before the timings resolve (null)', () => {
    mockMatchMedia(false)
    renderWatching({ stageTimings: null })
    expect(lastGraphProps().status?.countdownLabel).toBeUndefined()
  })

  it('act ONE counts down to ARRIVING ON THE GRAPH — the prep slice, NOT the reveal (myth-tudy1)', () => {
    // The loading countdown must sum ONLY the prep stages (arrive-on-the-graph),
    // never the entity stages (arrive-at-the-reveal). concept_intake 0s into its
    // 60s avg + world_color 40s + vocabulary_intake 20s = 120s = "2:00". The huge
    // world_and_factions timing is an ENTITY stage — it must be ignored here (the
    // old reveal-target math would have swept it in and read ~10 min).
    mockMatchMedia(false)
    vi.useFakeTimers()
    vi.setSystemTime(T0)
    const stages = [stage('concept_intake', 'running', T0.toISOString())]
    const stageTimings: StageTiming[] = [
      { stage: 'concept_intake', avgMs: 60_000 },
      { stage: 'world_color', avgMs: 40_000 },
      { stage: 'vocabulary_intake', avgMs: 20_000 },
      { stage: 'world_and_factions', avgMs: 600_000 }, // entity stage — excluded on act one
    ]
    renderGenerating({ stages, stageTimings })
    expect(screen.getByTestId('worldgen-loading-countdown').textContent).toBe(
      i18n.t('worldGen.countdown', { time: '2:00' }),
    )
  })

  it('act TWO still counts down to the REVEAL — the watched slice is unchanged', () => {
    // The status card keeps its reveal-target countdown: entity_relationships is a
    // WATCHED stage, so its 30s ahead counts. (Distinct from act one's prep slice.)
    mockMatchMedia(false)
    vi.useFakeTimers()
    vi.setSystemTime(T0)
    const stages = [
      ...ENTITY_UNDERWAY.slice(0, 3),
      stage('world_and_factions', 'completed'),
      stage('locations_and_npcs', 'completed'),
      stage('entity_relationships', 'running', T0.toISOString()),
    ]
    const stageTimings: StageTiming[] = [{ stage: 'entity_relationships', avgMs: 30_000 }]
    renderWatching({ stages, stageTimings })
    expect(lastGraphProps().status?.countdownLabel).toBe(
      i18n.t('worldGen.countdown', { time: '0:30' }),
    )
  })
})

describe('GeneratingView — re-entry act gate (mid-gen refresh lands on the graph)', () => {
  it('lands directly on the GRAPH act when resumedMidGen is true (no forced loading screen)', () => {
    // myth-gcsp1: a rejoin/refresh of an already-populated generating world seeds
    // the graph from the connect frame; the view must land on act two WITHOUT the
    // player pressing watch — the deliberate beat already happened on their first
    // visit. The graph renders; the loading screen never shows.
    mockMatchMedia(false)
    renderGenerating({
      resumedMidGen: true,
      nodes: [node('The Salt Baron'), node('The Drowned Ward')],
      stages: ENTITY_UNDERWAY,
    })
    expect(graphSpy).toHaveBeenCalled()
    expect(screen.queryByTestId('worldgen-loading')).toBeNull()
    // No watch button — the graph is already shown.
    expect(screen.queryByRole('button', { name: i18n.t('worldGen.watch') })).toBeNull()
  })

  it('keeps the deliberate loading beat on a FIRST visit (resumedMidGen false)', () => {
    // A genuine first visit connects during prep (resumedMidGen false): the loading
    // screen shows and the watch button is the ONLY path to the graph.
    mockMatchMedia(false)
    renderGenerating({ resumedMidGen: false, stages: ENTITY_UNDERWAY })
    expect(screen.getByTestId('worldgen-loading')).toBeDefined()
    expect(graphSpy).not.toHaveBeenCalled()
    // The watch button is offered (entities underway) — but the beat is deliberate.
    expect(screen.getByRole('button', { name: i18n.t('worldGen.watch') })).toBeDefined()
  })
})

describe('GeneratingView — fog drain keyed off the ENTITY COUNT (MYT-89 spawn-drain)', () => {
  it('holds FULL fog at the graph entry (no entity arrived yet)', () => {
    mockMatchMedia(false)
    renderWatching() // prep complete, world_and_factions running, zero nodes
    const props = lastGraphProps()
    // shown 0 over the ENTITY FLOOR — spawn scale 1: full fog at the birth of the
    // world; stage progress no longer drives the clear at all.
    expect(props.shownEntities).toBe(0)
    expect(props.totalEntities).toBe(MIN_EXPECTED_ENTITIES)
  })

  it('feeds the ARRIVED NODE COUNT as the drain numerator mid-gen', () => {
    mockMatchMedia(false)
    renderWatching({ nodes: [node('The Salt Baron'), node('The Drowned Ward'), node('Bell-Wardens')] })
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
    renderWatching({ stages })
    // Every stage complete yet zero nodes: the old stage-keyed fade would report
    // fully-gone here — the drain stays keyed to entities alone.
    const props = lastGraphProps()
    expect(props.shownEntities).toBe(0)
    expect(props.totalEntities).toBe(MIN_EXPECTED_ENTITIES)
  })

  it('reaches the floor as the graph fills — nothing spawns from here (fog drains to gone)', () => {
    mockMatchMedia(false)
    const nodes = Array.from({ length: MIN_EXPECTED_ENTITIES }, (_, i) => node(`Entity ${String(i)}`))
    renderWatching({ nodes })
    const props = lastGraphProps()
    expect(props.shownEntities).toBe(MIN_EXPECTED_ENTITIES)
    expect(props.totalEntities).toBe(MIN_EXPECTED_ENTITIES)
  })
})
