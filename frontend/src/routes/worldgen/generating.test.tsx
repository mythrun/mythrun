import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { I18nextProvider } from 'react-i18next'
import type { StageTiming } from '@mythrun/client-core'
import { MIN_EXPECTED_ENTITIES } from '@mythrun/client-core/worldgen'
import { WATCHED_ENTITY_STAGES, WORLD_GEN_STAGES, type WorldGenStage } from '@mythrun/contract/events'
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
  readonly campaignId?: string
  readonly lastErrorClass?: 'connectivity' | 'rate-limit'
}

function renderGenerating({
  nodes = [],
  stages = [],
  stageTimings = null,
  resumedMidGen = false,
  campaignId,
  lastErrorClass,
}: RenderOpts = {}): void {
  render(
    <I18nextProvider i18n={i18n}>
      <GeneratingView
        nodes={nodes}
        edges={[]}
        stages={stages}
        stageTimings={stageTimings}
        resumedMidGen={resumedMidGen}
        {...(campaignId !== undefined ? { campaignId } : {})}
        {...(lastErrorClass !== undefined ? { lastErrorClass } : {})}
      />
    </I18nextProvider>,
  )
}

/** Like renderGenerating, but hands back a typed re-render for the tests that
 *  advance the live stream mid-mount (the monotonic-clamp walk). */
function renderGeneratingRerenderable(opts: RenderOpts = {}): {
  rerenderWith: (next: RenderOpts) => void
} {
  const tree = (o: RenderOpts): React.JSX.Element => (
    <I18nextProvider i18n={i18n}>
      <GeneratingView
        nodes={o.nodes ?? []}
        edges={[]}
        stages={o.stages ?? []}
        stageTimings={o.stageTimings ?? null}
        resumedMidGen={o.resumedMidGen ?? false}
        {...(o.lastErrorClass !== undefined ? { lastErrorClass: o.lastErrorClass } : {})}
      />
    </I18nextProvider>
  )
  const { rerender } = render(tree(opts))
  return {
    rerenderWith: (next: RenderOpts): void => {
      rerender(tree(next))
    },
  }
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
    // The accreting mark carries the busy meaning, with the i18n'd SR label.
    expect(screen.getByRole('status', { name: i18n.t('worldGen.loadingLabel') })).toBeDefined()
    // The graph never mounts during the prep act.
    expect(graphSpy).not.toHaveBeenCalled()
  })

  it('drives the mark from REAL events — one completed prep stage fills, zero idles nearly blank (myth-i2pdo; ux-run3 myth-c96rf)', () => {
    mockMatchMedia(false)
    renderGenerating({ stages: [stage('concept_intake', 'running')] })
    expect(screen.getByTestId('worldgen-loading-mark').getAttribute('data-beat-mode')).toBe('idle')
    cleanup()
    mockMatchMedia(false)
    renderGenerating({
      stages: [stage('concept_intake', 'completed'), stage('world_color', 'running')],
    })
    const mark = screen.getByTestId('worldgen-loading-mark')
    expect(mark.getAttribute('data-beat-mode')).toBe('fill')
    expect(Number(mark.getAttribute('data-beat-level'))).toBeGreaterThan(0)
  })

  it('grants permission to leave — the quiet closing line (myth-i2pdo)', () => {
    mockMatchMedia(false)
    renderGenerating()
    expect(screen.getByTestId('worldgen-loading-leave').textContent).toBe(
      i18n.t('worldGen.safeToLeave'),
    )
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
      const text = screen.getByTestId('whisper-ledger-current').textContent
      expect(allFlavors.has(text)).toBe(true)
      seen.add(text)
    }
    readFlavor()
    // 19 more ticks walk the REST of the permutation: every line shows exactly
    // once before any repeats — 20 distinct lines seen, whatever the shuffle drew.
    // One interval per tick (WorldGenLoading's DEFAULT_INTERVAL_MS is ~10s — the
    // staging-audit slow-cycle dwell).
    for (let tick = 0; tick < 19; tick++) {
      act(() => {
        vi.advanceTimersByTime(10_000)
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

  it('supplies a friendly i18n label for EVERY canonical world-gen stage — watched-entity stages carry their scope', () => {
    mockMatchMedia(false)
    renderWatching()
    const labels = lastGraphProps().status?.stageLabels
    // The production map is built by iterating WORLD_GEN_STAGES, so every canonical
    // stage carries a real label — the card + SR announcer never fall back to the
    // defensive title. The four WATCHED-ENTITY stages (the card's bars) get their
    // position composed in ("Stage N of 4 · …", ux-run2 myth-uz1bn) so stage scope
    // is never conflated with overall time; prep + tail stages stay plain. This
    // expected map is Record<WorldGenStage>, so a future taxonomy addition fails
    // THIS compile in lockstep with the production map's own compile guard
    // (STAGE_LABEL_KEY).
    const positioned = (current: number, key: string): string =>
      i18n.t('worldGen.stagePosition', {
        current,
        total: WATCHED_ENTITY_STAGES.length,
        stage: key,
      })
    const expected: Record<WorldGenStage, string> = {
      concept_intake: i18n.t('worldGen.stage.concept_intake'),
      world_color: i18n.t('worldGen.stage.world_color'),
      vocabulary_intake: i18n.t('worldGen.stage.vocabulary_intake'),
      world_and_factions: positioned(1, i18n.t('worldGen.stage.world_and_factions')),
      locations_and_npcs: positioned(2, i18n.t('worldGen.stage.locations_and_npcs')),
      entity_relationships: positioned(3, i18n.t('worldGen.stage.entity_relationships')),
      world_introduction: positioned(4, i18n.t('worldGen.stage.world_introduction')),
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

  // ux-run3 myth-aftau: the live map is unmountable (every "Wait quietly" toggle
  // takes it down), so the layout has to live outside the component. The route is
  // where the world's identity enters — without this key the cache is never engaged
  // and every re-entry re-rolls the constellation.
  it('hands the graph the campaign as its LAYOUT CACHE KEY (myth-aftau)', () => {
    mockMatchMedia(false)
    renderWatching({ campaignId: 'campaign-42' })
    expect(lastGraphProps().layoutCacheKey).toBe('campaign-42')
  })

  it('omits the layout key entirely when no campaign is supplied (never an explicit undefined)', () => {
    mockMatchMedia(false)
    renderWatching()
    expect('layoutCacheKey' in lastGraphProps()).toBe(false)
  })

  // ux-run3 myth-fi1v1: the live map draws its shape vocabulary for minutes before the
  // reveal ever explains it. The key speaks the SAME wiki group headings the reveal
  // does — one map, no second copy — and documents no hollow state (during generation
  // an unlabeled mark is a name still arriving, not a settled one).
  it('gives the live map a marker KEY in the wiki\'s own words (myth-fi1v1)', () => {
    mockMatchMedia(false)
    renderWatching()
    expect(lastGraphProps().legend).toEqual({
      faction: i18n.t('worldReveal.group.faction'),
      location: i18n.t('worldReveal.group.location'),
      npc: i18n.t('worldReveal.group.npc'),
      item: i18n.t('worldReveal.group.item'),
    })
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

describe('GeneratingView — the coarse remaining-wait line (MYT-102 timer revamp)', () => {
  // A fixed clock: fake timers pin Date.now(), so startedAt offsets are exact.
  const T0 = new Date('2026-07-07T12:00:00.000Z')
  const ago = (ms: number): string => new Date(T0.getTime() - ms).toISOString()
  // Coarse label helpers: "N min remaining" / "under a minute remaining".
  const mins = (n: number): string =>
    i18n.t('worldGen.countdown', { time: i18n.t('shared.wait.minutes', { count: n }) })
  const underMinute = i18n.t('worldGen.countdown', { time: i18n.t('shared.wait.underMinute') })

  it('shows a COARSE remaining-wait line on the loading screen (minute-granular, never a ticking M:SS)', () => {
    mockMatchMedia(false)
    vi.useFakeTimers()
    vi.setSystemTime(T0)
    // concept_intake fresh into its 60s average + world_color's whole 60s ahead →
    // 120s remain → "2 min remaining".
    const stages = [stage('concept_intake', 'running', T0.toISOString())]
    const stageTimings: StageTiming[] = [
      { stage: 'concept_intake', avgMs: 60_000 },
      { stage: 'world_color', avgMs: 60_000 },
    ]
    renderGenerating({ stages, stageTimings })
    const countdown = screen.getByTestId('worldgen-loading-countdown')
    expect(countdown.textContent).toBe(mins(2))
    // Coarse: NEVER a ticking `M:SS`, and it does not churn every second — a few
    // seconds later it still reads the same coarse bucket.
    expect(countdown.textContent).not.toMatch(/\d:\d\d/)
    act(() => {
      vi.advanceTimersByTime(3000)
    })
    expect(countdown.textContent).toBe(mins(2))
  })

  it('feeds the coarse line to the status card (act two)', () => {
    mockMatchMedia(false)
    vi.useFakeTimers()
    vi.setSystemTime(T0)
    // locations_and_npcs 20s into its 120s average → 100s left → "2 min remaining".
    const stages = [
      ...ENTITY_UNDERWAY.slice(0, 3),
      stage('world_and_factions', 'completed'),
      stage('locations_and_npcs', 'running', ago(20_000)),
    ]
    const stageTimings: StageTiming[] = [{ stage: 'locations_and_npcs', avgMs: 120_000 }]
    renderWatching({ stages, stageTimings })
    expect(lastGraphProps().status?.countdownLabel).toBe(mins(2))
    expect(lastGraphProps().status?.countdownLabel).not.toMatch(/\d:\d\d/)
  })

  it('DEGRADES IN LANGUAGE the instant the estimate exhausts — never a dead floor (act two)', () => {
    mockMatchMedia(false)
    vi.useFakeTimers()
    vi.setSystemTime(T0)
    // Every watched stage done except the final one, which is RUNNING and has
    // overrun its average (90s elapsed vs 30s) → the estimate clamps to 0. The old
    // countdown sat at "0:00 remaining"; run 2 then sat on a frozen coarse floor
    // for ~90s. Now the stalled reassurance STANDS IN for the number (ux-run2
    // myth-uz1bn: frozen numbers degrade in language rather than sit).
    const exhausted = [
      ...ENTITY_UNDERWAY.slice(0, 3),
      stage('world_and_factions', 'completed'),
      stage('locations_and_npcs', 'completed'),
      stage('entity_relationships', 'running', ago(90_000)),
    ]
    const stageTimings: StageTiming[] = [{ stage: 'entity_relationships', avgMs: 30_000 }]
    renderWatching({ stages: exhausted, stageTimings })
    expect(lastGraphProps().status).toBeDefined()
    expect(lastGraphProps().status?.countdownLabel).toBeUndefined()
    expect(lastGraphProps().status?.stalledLabel).toBe(i18n.t('shared.wait.stalled'))
  })

  it('shows the stalled line on the LOADING screen too when the aggregate exhausts (one budget, one behavior)', () => {
    mockMatchMedia(false)
    vi.useFakeTimers()
    vi.setSystemTime(T0)
    // The whole timed slice is done except vocabulary_intake, running and overrun
    // (60s elapsed vs 20s) → estimate 0 → the countdown is replaced by the stalled
    // reassurance; the loading screen (flavor cycle) still renders around it.
    const exhausted = [
      stage('concept_intake', 'completed'),
      stage('world_color', 'completed'),
      stage('vocabulary_intake', 'running', ago(60_000)),
    ]
    const stageTimings: StageTiming[] = [
      { stage: 'concept_intake', avgMs: 30_000 },
      { stage: 'world_color', avgMs: 30_000 },
      { stage: 'vocabulary_intake', avgMs: 20_000 },
    ]
    renderGenerating({ stages: exhausted, stageTimings })
    expect(screen.queryByTestId('worldgen-loading-countdown')).toBeNull()
    expect(screen.getByTestId('worldgen-loading-stalled').textContent).toBe(
      i18n.t('shared.wait.stalled'),
    )
    expect(screen.getByTestId('worldgen-loading')).toBeDefined()
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

  it('act ONE shows the AGGREGATE budget — the whole visible wait, not the prep slice (ux-run2 myth-uz1bn)', () => {
    // The run-1 "two targets" design (myth-tudy1) made act one count only to
    // graph arrival, so the act swap reset "Under a minute" up to "8 min" —
    // run 2's blocker. Both acts now read ONE budget: concept_intake 0s into its
    // 60s avg + world_color 40s + vocabulary_intake 20s + world_and_factions
    // (an ENTITY stage) 600s = 720s → "about 12 min", even on act one.
    mockMatchMedia(false)
    vi.useFakeTimers()
    vi.setSystemTime(T0)
    const stages = [stage('concept_intake', 'running', T0.toISOString())]
    const stageTimings: StageTiming[] = [
      { stage: 'concept_intake', avgMs: 60_000 },
      { stage: 'world_color', avgMs: 40_000 },
      { stage: 'vocabulary_intake', avgMs: 20_000 },
      { stage: 'world_and_factions', avgMs: 600_000 },
    ]
    renderGenerating({ stages, stageTimings })
    expect(screen.getByTestId('worldgen-loading-countdown').textContent).toBe(mins(12))
  })

  it('act TWO counts down to the REVEAL — the watched slice', () => {
    // entity_relationships is a WATCHED stage, so its 30s ahead counts (coarse:
    // "under a minute"); the silent tail never counts.
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
    expect(lastGraphProps().status?.countdownLabel).toBe(underMinute)
  })

  it('the countdown SURVIVES the calm-wait → live-map transition unchanged (one budget across acts)', () => {
    // The player-called blocker: "2 min" → "Under a minute" on the calm screen,
    // then "8 min remaining" the moment the map opened. Same stream, same
    // timings, same tick — the number the card shows after the watch press must
    // BE the number the loading screen showed before it.
    mockMatchMedia(false)
    vi.useFakeTimers()
    vi.setSystemTime(T0)
    const stages = [
      ...ENTITY_UNDERWAY.slice(0, 3),
      stage('world_and_factions', 'running', ago(30_000)),
    ]
    const stageTimings: StageTiming[] = [
      { stage: 'world_and_factions', avgMs: 60_000 },
      { stage: 'locations_and_npcs', avgMs: 60_000 },
    ]
    renderGenerating({ stages, stageTimings })
    const shownBefore = screen.getByTestId('worldgen-loading-countdown').textContent
    expect(shownBefore).toBe(mins(2)) // 30s left in the running stage + 60s ahead
    watch()
    expect(lastGraphProps().status?.countdownLabel).toBe(shownBefore)
  })

  it('DAMPS re-estimates — a sudden multi-minute drop steps down ONE minute per whisper dwell, never a nervous jump (ux-run3 myth-b965d)', () => {
    // Run 3: the estimate shed 2 minutes in 45 seconds. A stage completing far
    // under its average legitimately collapses the raw estimate at once — but
    // the SHOWN number now walks down a minute at a time, at most once per
    // ~10s whisper dwell, so it reads as observed, not guessed. (Exhaustion
    // still bypasses the damper — the stalled line is honesty, not display.)
    mockMatchMedia(false)
    vi.useFakeTimers()
    vi.setSystemTime(T0)
    const stageTimings: StageTiming[] = [
      { stage: 'world_and_factions', avgMs: 480_000 },
      { stage: 'locations_and_npcs', avgMs: 300_000 },
    ]
    // Phase 1 carries only wf's timing (480s ahead → "about 8 min"); phase 2
    // swaps in the full timing set so the raw estimate collapses to ~300s.
    const view = renderGeneratingRerenderable({
      stages: [
        ...ENTITY_UNDERWAY.slice(0, 3),
        stage('world_and_factions', 'running', T0.toISOString()),
      ],
      stageTimings: [{ stage: 'world_and_factions', avgMs: 480_000 }],
    })
    // Adopt the first usable estimate fully: 480s → "about 8 min".
    const countdown = (): string | null => screen.getByTestId('worldgen-loading-countdown').textContent
    expect(countdown()).toBe(mins(8))
    // One second in, the stage completes WAY under its average and the next one
    // starts: raw collapses to ~300s ("about 5 min") in a single tick.
    act(() => {
      vi.advanceTimersByTime(1000)
    })
    view.rerenderWith({
      stages: [
        ...ENTITY_UNDERWAY.slice(0, 3),
        stage('world_and_factions', 'completed'),
        stage('locations_and_npcs', 'running', new Date(T0.getTime() + 1000).toISOString()),
      ],
      stageTimings,
    })
    // Within the hold window the shown number does not move.
    expect(countdown()).toBe(mins(8))
    act(() => {
      vi.advanceTimersByTime(4000)
    })
    expect(countdown()).toBe(mins(8))
    // Each elapsed dwell releases exactly one minute: 8 → 7 → 6.
    act(() => {
      vi.advanceTimersByTime(6000) // t = +11s
    })
    expect(countdown()).toBe(mins(7))
    act(() => {
      vi.advanceTimersByTime(10_000) // t = +21s
    })
    expect(countdown()).toBe(mins(6))
    act(() => {
      vi.advanceTimersByTime(10_000) // t = +31s
    })
    expect(countdown()).toBe(mins(5))
  })

  it('NEVER moves the countdown up — a rising raw estimate holds at the last shown value (monotonic clamp)', () => {
    // A real up-jump source: a watched stage fails and re-enters `running`, so
    // its whole average re-joins the sum. The raw estimate climbs from ~30s to
    // ~5 min; the shown label must hold at "under a minute", not climb.
    mockMatchMedia(false)
    vi.useFakeTimers()
    vi.setSystemTime(T0)
    const nearDone = [
      ...ENTITY_UNDERWAY.slice(0, 3),
      stage('world_and_factions', 'completed'),
      stage('locations_and_npcs', 'completed'),
      stage('entity_relationships', 'running', ago(90_000)),
    ]
    const stageTimings: StageTiming[] = [
      { stage: 'entity_relationships', avgMs: 120_000 },
      { stage: 'world_introduction', avgMs: 0 },
    ]
    const view = renderGeneratingRerenderable({ stages: nearDone, stageTimings })
    expect(screen.getByTestId('worldgen-loading-countdown').textContent).toBe(underMinute)
    // The running stage "restarts": startedAt resets to now → its full 120s
    // average is ahead again + locations_and_npcs regresses to running with a
    // fresh 180s average. Raw estimate ≈ 5 min; the display must not climb.
    view.rerenderWith({
      stages: [
        ...ENTITY_UNDERWAY.slice(0, 3),
        stage('world_and_factions', 'completed'),
        stage('locations_and_npcs', 'running', T0.toISOString()),
        stage('entity_relationships', 'pending'),
      ],
      stageTimings: [
        { stage: 'locations_and_npcs', avgMs: 180_000 },
        { stage: 'entity_relationships', avgMs: 120_000 },
      ],
    })
    expect(screen.getByTestId('worldgen-loading-countdown').textContent).toBe(underMinute)
  })
})

describe('GeneratingView — the parked hold (llm-outage-resilience §3.4)', () => {
  const T0 = new Date('2026-07-07T12:00:00.000Z')
  const ago = (ms: number): string => new Date(T0.getTime() - ms).toISOString()
  const mins = (n: number): string =>
    i18n.t('worldGen.countdown', { time: i18n.t('shared.wait.minutes', { count: n }) })
  const hold = (): string => i18n.t('worldGen.degradedHold')

  // A stream shape whose estimate WOULD show a countdown ("2 min") — the park
  // must suppress exactly that.
  const RUNNING_STAGES = (): readonly StageProgress[] => [
    ...ENTITY_UNDERWAY.slice(0, 3),
    stage('world_and_factions', 'running', ago(30_000)),
  ]
  const TIMINGS: StageTiming[] = [
    { stage: 'world_and_factions', avgMs: 60_000 },
    { stage: 'locations_and_npcs', avgMs: 60_000 },
  ]

  it('act one: the hold copy owns the wait narrative — no countdown, never the stalled line', () => {
    mockMatchMedia(false)
    vi.useFakeTimers()
    vi.setSystemTime(T0)
    renderGenerating({
      stages: RUNNING_STAGES(),
      stageTimings: TIMINGS,
      lastErrorClass: 'connectivity',
    })
    // The ETA countdown is suppressed even though a live estimate exists…
    expect(screen.queryByTestId('worldgen-loading-countdown')).toBeNull()
    // …and the wait-language slot carries the HOLD copy, not "Still working"
    // ("Still working" and "the making was interrupted" never share a screen).
    expect(screen.getByTestId('worldgen-loading-stalled').textContent).toBe(hold())
    expect(screen.getByTestId('worldgen-loading-stalled').textContent).not.toBe(
      i18n.t('shared.wait.stalled'),
    )
  })

  it('act one: the hold replaces the STALLED reassurance too (exhausted estimate)', () => {
    mockMatchMedia(false)
    vi.useFakeTimers()
    vi.setSystemTime(T0)
    // Overrun running stage → the un-parked view would show shared.wait.stalled.
    renderGenerating({
      stages: [
        stage('concept_intake', 'completed'),
        stage('world_color', 'completed'),
        stage('vocabulary_intake', 'running', ago(60_000)),
      ],
      stageTimings: [{ stage: 'vocabulary_intake', avgMs: 20_000 }],
      lastErrorClass: 'rate-limit',
    })
    expect(screen.getByTestId('worldgen-loading-stalled').textContent).toBe(hold())
  })

  it('act two: feeds the status card the hold line and NO countdown while parked', () => {
    mockMatchMedia(false)
    vi.useFakeTimers()
    vi.setSystemTime(T0)
    renderWatching({
      stages: RUNNING_STAGES(),
      stageTimings: TIMINGS,
      lastErrorClass: 'connectivity',
    })
    expect(lastGraphProps().status?.countdownLabel).toBeUndefined()
    expect(lastGraphProps().status?.stalledLabel).toBe(hold())
  })

  it('resets the ETA damper/clamp refs when the park clears — a FRESH estimate is adopted even upward', () => {
    // Pre-park the monotonic clamp pinned "2 min". A resumed generation may
    // honestly need MORE than the pre-park floor (the outage cost real time);
    // without the ref reset the clamp would hold the stale 2-minute floor and
    // the damper would leak the pre-park cadence. The park clears → the view
    // re-adopts the fresh raw estimate fully (7 min), proving both refs reset.
    mockMatchMedia(false)
    vi.useFakeTimers()
    vi.setSystemTime(T0)
    const view = renderGeneratingRerenderable({
      stages: RUNNING_STAGES(),
      stageTimings: TIMINGS,
    })
    expect(screen.getByTestId('worldgen-loading-countdown').textContent).toBe(mins(2))

    // The park arrives (a contained connectivity failure).
    view.rerenderWith({
      stages: RUNNING_STAGES(),
      stageTimings: TIMINGS,
      lastErrorClass: 'connectivity',
    })
    expect(screen.queryByTestId('worldgen-loading-countdown')).toBeNull()
    expect(screen.getByTestId('worldgen-loading-stalled').textContent).toBe(hold())

    // The park clears; the resumed pipeline's fresh estimate is HIGHER (7 min).
    view.rerenderWith({
      stages: [
        ...ENTITY_UNDERWAY.slice(0, 3),
        stage('world_and_factions', 'completed'),
        stage('locations_and_npcs', 'running', T0.toISOString()),
      ],
      stageTimings: [
        { stage: 'locations_and_npcs', avgMs: 300_000 },
        { stage: 'entity_relationships', avgMs: 120_000 },
      ],
    })
    expect(screen.getByTestId('worldgen-loading-countdown').textContent).toBe(mins(7))
    expect(screen.queryByTestId('worldgen-loading-stalled')).toBeNull()
  })
})

describe('GeneratingView — the way back from the live map (ux-run2 myth-t11az)', () => {
  it('wires the status card a return link that lands back on the calm loading screen', () => {
    mockMatchMedia(false)
    renderWatching()
    const { status } = lastGraphProps()
    expect(status?.returnLabel).toBe(i18n.t('worldGen.waitQuietly'))
    act(() => {
      status?.onReturn?.()
    })
    expect(screen.getByTestId('worldgen-loading')).toBeDefined()
    // The watch button is still offered — the door swings both ways.
    expect(screen.getByRole('button', { name: i18n.t('worldGen.watch') })).toBeDefined()
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
