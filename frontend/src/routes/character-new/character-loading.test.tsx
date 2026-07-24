import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, render, screen } from '@testing-library/react'
import { I18nextProvider } from 'react-i18next'
import type { StageProgress } from '@mythrun/contract/events'
import { ApiClientProvider, type ApiContext, type StageTiming } from '@mythrun/client-core'
import type { LoadingBeat } from '@mythrun/client-core/contract'
import { useCharacterCreationStream, useCreationProgressPoll } from '@mythrun/client-core/character'
import { i18n } from '../../i18n/config.ts'
import { CharacterLoadingSurface } from './character-loading.tsx'

// CharacterLoadingSurface (MYT-90 D5 + the MYT-102 waiting upgrade) — the
// processing-state screen D8 mounts while the viewer's character concept is
// being generated. It composes the DS <CharacterLoadingBeat> over the
// client-core useCharacterCreationStream, and calls `onDone` the instant the
// viewer's own completion arrives so D8 re-routes to the reveal. MYT-102 adds
// the waiting register: a one-time stage-timings fetch + a 1-second tick turn
// the hook's folded `stages` into the beat's COARSE countdown (OMITTED on
// cold-start — no fake numbers), and the "still working" line replaces the
// countdown the instant the estimate exhausts — or, with no history, after a
// flat 2-minute window — so the wait never sits at a dead 0:00. The stream hook
// is MOCKED off its barrel (its folding is covered by
// use-character-creation-stream.test.ts); the countdown math is the REAL
// remainingCreationWaitMs → waitDisplay — the tests drive it through injected
// timings + mocked stages + fake timers. i18n: the countdown/stall copy keys are
// controller-owned — these tests assert presence via testids (and the coarse
// format), never resolved strings.

vi.mock('@mythrun/client-core/character', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@mythrun/client-core/character')>()
  return { ...actual, useCharacterCreationStream: vi.fn(), useCreationProgressPoll: vi.fn() }
})
const mockStream = vi.mocked(useCharacterCreationStream)
// myth-qkjdq: the durable SSE-independent poll. Both the stream AND the poll can
// signal terminal; the surface swaps on either. Mocked so these tests drive each
// path deterministically without a real GET/timer.
const mockPoll = vi.mocked(useCreationProgressPoll)

// jsdom has no matchMedia; install a query-aware one so the surface's
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

const CID = 'c1'
const UID = 'u1'

// The surface reads its ApiContext (for the timings fetch) — a test provider;
// the default real fetch never fires here (fetchTimings is injected or the
// mocked hook short-circuits everything network-shaped).
const testCtx: ApiContext = {
  baseUrl: 'http://api.test',
  getAuthHeaders: () => Promise.resolve({}),
}

const MID_BEATS: LoadingBeat[] = [
  { id: 'name', label: 'a name surfaces', state: 'done' },
  { id: 'class', label: 'a class takes shape', state: 'done' },
  { id: 'scores', label: 'ability scores settle', state: 'active' },
  { id: 'kit', label: 'equipment is gathered', state: 'pending' },
]
const DONE_BEATS: LoadingBeat[] = MID_BEATS.map((b) => ({ ...b, state: 'done' }))

/** The viewer's folded per-player stage rows (what the hook exposes). */
const stageRow = (
  stage: string,
  status: StageProgress['status'],
  startedAt: string | null = null,
): StageProgress => ({ stage, status, userId: UID, costUsd: 0, startedAt, completedAt: null })

/** A timing row for every creation stage at a uniform `avgMs`. */
const creationTimings = (avgMs: number): StageTiming[] => [
  { stage: 'location_selection', avgMs },
  { stage: 'character_concept', avgMs },
  { stage: 'character_sheet', avgMs },
]

interface RenderOpts {
  readonly beats?: LoadingBeat[]
  readonly done?: boolean
  readonly stages?: readonly StageProgress[]
  readonly onDone?: () => void
  readonly fetchTimings?: () => Promise<readonly StageTiming[]>
  /** The durable poll's terminal signal (myth-qkjdq) — defaults to still-waiting. */
  readonly poll?: { done: boolean; failed: boolean }
}

function surface(onDone: () => void, fetchTimings?: RenderOpts['fetchTimings']): React.JSX.Element {
  return (
    <I18nextProvider i18n={i18n}>
      <ApiClientProvider value={testCtx}>
        <CharacterLoadingSurface
          campaignId={CID}
          userId={UID}
          onDone={onDone}
          {...(fetchTimings !== undefined ? { fetchTimings } : {})}
        />
      </ApiClientProvider>
    </I18nextProvider>
  )
}

function renderSurface({
  beats = MID_BEATS,
  done = false,
  stages = [],
  onDone = vi.fn(),
  fetchTimings,
  poll = { done: false, failed: false },
}: RenderOpts = {}) {
  mockStream.mockReturnValue({ beats, done, stages })
  mockPoll.mockReturnValue(poll)
  return render(surface(onDone, fetchTimings))
}

/** Flush the microtask queue (the timings fetch resolves off it). */
const flush = async (): Promise<void> => {
  await act(async () => {
    await Promise.resolve()
  })
}

beforeEach(() => {
  // Default the durable poll to still-waiting so a direct-render test (one that
  // sets mockStream itself, not via renderSurface) gets a valid poll value.
  mockPoll.mockReturnValue({ done: false, failed: false })
})

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
  vi.useRealTimers()
  if (typeof window !== 'undefined') Reflect.deleteProperty(window, 'matchMedia')
})

describe('CharacterLoadingSurface', () => {
  it('drives the stream with the campaign + viewer ids', () => {
    renderSurface()
    // deps is unset here → the surface forwards `undefined` (the hook then
    // defaults to the real SSE client + progress probe). D8 mounts it this way.
    expect(mockStream).toHaveBeenCalledWith(CID, UID, undefined)
  })

  it("renders the loading beat from the hook's beats", () => {
    renderSurface({ beats: MID_BEATS })
    expect(screen.getByTestId('character-loading-beat')).toBeDefined()
    const rows = screen.getAllByTestId('character-loading-beat-row')
    expect(rows.map((r) => r.getAttribute('data-beat-id'))).toEqual(['name', 'class', 'scores', 'kit'])
    expect(rows.map((r) => r.getAttribute('data-state'))).toEqual([
      'done',
      'done',
      'active',
      'pending',
    ])
  })

  it('renders the i18n screen title as a heading', () => {
    renderSurface()
    expect(
      screen.getByRole('heading', { name: i18n.t('characterCreate.loading.title') }),
    ).toBeDefined()
  })

  it('does not call onDone while the character is still processing (done false)', () => {
    const onDone = vi.fn()
    renderSurface({ done: false, onDone })
    expect(onDone).not.toHaveBeenCalled()
  })

  it('calls onDone once when the stream already reports done', () => {
    const onDone = vi.fn()
    renderSurface({ done: true, onDone })
    expect(onDone).toHaveBeenCalledTimes(1)
  })

  it('calls onDone exactly once when done flips true, and never again on later re-renders', () => {
    const onDone = vi.fn()
    mockStream.mockReturnValue({ beats: MID_BEATS, done: false, stages: [] })
    const { rerender } = render(surface(onDone))
    expect(onDone).not.toHaveBeenCalled()

    // The viewer's completion arrives — the swap fires once.
    mockStream.mockReturnValue({ beats: DONE_BEATS, done: true, stages: [] })
    rerender(surface(onDone))
    expect(onDone).toHaveBeenCalledTimes(1)

    // Still done on a further re-render — the latch holds; it must not fire again.
    rerender(surface(onDone))
    expect(onDone).toHaveBeenCalledTimes(1)
  })

  it('advances via the DURABLE poll when the stream never reports done (dead SSE)', () => {
    // The SSE-driven stream stays at `done:false` forever (a CloudFront-buffered
    // stream never delivers the completion). The poll's durable `done` still
    // advances the screen — the myth-qkjdq fix.
    const onDone = vi.fn()
    renderSurface({ done: false, poll: { done: true, failed: false }, onDone })
    expect(onDone).toHaveBeenCalledTimes(1)
  })

  it('advances on a poll-reported FAILURE (so D8 can route to the concept-failure surface)', () => {
    const onDone = vi.fn()
    renderSurface({ done: false, poll: { done: false, failed: true }, onDone })
    expect(onDone).toHaveBeenCalledTimes(1)
  })

  it('does not advance while both the stream and the poll are still waiting', () => {
    const onDone = vi.fn()
    renderSurface({ done: false, poll: { done: false, failed: false }, onDone })
    expect(onDone).not.toHaveBeenCalled()
  })

  it('passes reducedMotion=true to the beat when the user prefers reduced motion', () => {
    mockMatchMedia(true)
    renderSurface()
    expect(screen.getByTestId('character-loading-beat').getAttribute('data-reduced-motion')).toBe(
      'true',
    )
  })

  it('passes reducedMotion=false by default (no preference set)', () => {
    mockMatchMedia(false)
    renderSurface()
    expect(screen.getByTestId('character-loading-beat').getAttribute('data-reduced-motion')).toBe(
      'false',
    )
  })
})

describe('CharacterLoadingSurface — the countdown (MYT-102)', () => {
  it('shows a COARSE countdown once the timings history arrives and a wait remains', async () => {
    renderSurface({
      stages: [
        stageRow('location_selection', 'completed'),
        stageRow('character_concept', 'completed'),
        stageRow('character_sheet', 'running', new Date().toISOString()),
      ],
      fetchTimings: () => Promise.resolve(creationTimings(60_000)),
    })
    await flush()
    const countdown = screen.getByTestId('character-loading-beat-countdown')
    // Coarse, minute-granular — NEVER a ticking `M:SS` (the false-precision bug).
    expect(countdown.textContent).not.toMatch(/\d:\d\d/)
  })

  it('omits the countdown on cold-start (no usable history) — no fake numbers', async () => {
    renderSurface({ fetchTimings: () => Promise.resolve([]) })
    await flush()
    expect(screen.queryByTestId('character-loading-beat-countdown')).toBeNull()
  })

  it('omits the countdown calmly when the timings fetch fails', async () => {
    renderSurface({ fetchTimings: () => Promise.reject(new Error('network')) })
    await flush()
    expect(screen.queryByTestId('character-loading-beat-countdown')).toBeNull()
    expect(screen.getByTestId('character-loading-beat')).toBeDefined()
  })
})

describe('CharacterLoadingSurface — the stalled line (MYT-102 timer revamp)', () => {
  it('replaces the countdown with the stalled line the instant the estimate exhausts (never a dead 0:00)', async () => {
    vi.useFakeTimers()
    // The final stage is running and OVERRUNS its 10s average: once elapsed passes
    // 10s the estimate clamps to 0 — the exact dead-zero the old countdown sat on.
    renderSurface({
      stages: [
        stageRow('location_selection', 'completed'),
        stageRow('character_concept', 'completed'),
        stageRow('character_sheet', 'running', new Date().toISOString()),
      ],
      fetchTimings: () => Promise.resolve(creationTimings(10_000)),
    })
    await flush()
    // Still a positive estimate → a coarse countdown, no stalled line yet.
    expect(screen.getByTestId('character-loading-beat-countdown')).toBeDefined()
    expect(screen.queryByTestId('character-loading-beat-stalled')).toBeNull()

    // Push past the 10s average — the estimate exhausts.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(12_000)
    })
    // The stalled line takes over; NO dead countdown lingers beside it.
    expect(screen.getByTestId('character-loading-beat-stalled')).toBeDefined()
    expect(screen.queryByTestId('character-loading-beat-countdown')).toBeNull()
  })

  it('appears after the flat 2-minute window with no history and no terminal event', async () => {
    vi.useFakeTimers()
    renderSurface({ fetchTimings: () => Promise.resolve([]) })
    await flush()
    expect(screen.queryByTestId('character-loading-beat-stalled')).toBeNull()

    await act(async () => {
      await vi.advanceTimersByTimeAsync(90_000)
    })
    expect(screen.queryByTestId('character-loading-beat-stalled')).toBeNull()

    await act(async () => {
      await vi.advanceTimersByTimeAsync(31_000)
    })
    expect(screen.getByTestId('character-loading-beat-stalled')).toBeDefined()
    // No fake countdown ever showed on the no-history path.
    expect(screen.queryByTestId('character-loading-beat-countdown')).toBeNull()
  })

  it('appears via the wall-clock backstop when a wedged stage keeps the estimate positive (3× the initial estimate)', async () => {
    vi.useFakeTimers()
    // Nothing ever starts (stages stay empty) → the estimate holds at the full
    // 3 × 10s = 30s forever (no running stage subtracts elapsed), so exhaustion
    // never fires. The wall-clock backstop (3 × 30s = 90s) catches the wedge.
    renderSurface({ fetchTimings: () => Promise.resolve(creationTimings(10_000)) })
    await flush()

    await act(async () => {
      await vi.advanceTimersByTimeAsync(89_000)
    })
    expect(screen.queryByTestId('character-loading-beat-stalled')).toBeNull()

    await act(async () => {
      await vi.advanceTimersByTimeAsync(2_000)
    })
    expect(screen.getByTestId('character-loading-beat-stalled')).toBeDefined()
    expect(screen.queryByTestId('character-loading-beat-countdown')).toBeNull()
  })

  it('never appears once the stream reports done', async () => {
    vi.useFakeTimers()
    renderSurface({ done: true, fetchTimings: () => Promise.resolve([]) })
    await flush()
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10 * 60_000)
    })
    expect(screen.queryByTestId('character-loading-beat-stalled')).toBeNull()
  })
})
