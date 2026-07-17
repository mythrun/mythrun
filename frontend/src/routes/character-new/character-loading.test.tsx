import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, render, screen } from '@testing-library/react'
import { I18nextProvider } from 'react-i18next'
import type { StageProgress } from '@mythrun/contract/events'
import { ApiClientProvider, type ApiContext, type StageTiming } from '@mythrun/client-core'
import type { LoadingBeat } from '@mythrun/client-core/contract'
import { useCharacterCreationStream } from '@mythrun/client-core/character'
import { i18n } from '../../i18n/config.ts'
import { CharacterLoadingSurface } from './character-loading.tsx'

// CharacterLoadingSurface (MYT-90 D5 + the MYT-102 waiting upgrade) — the
// processing-state screen D8 mounts while the viewer's character concept is
// being generated. It composes the DS <CharacterLoadingBeat> over the
// client-core useCharacterCreationStream, and calls `onDone` the instant the
// viewer's own completion arrives so D8 re-routes to the reveal. MYT-102 adds
// the waiting register: a one-time stage-timings fetch + a 1-second tick turn
// the hook's folded `stages` into the beat's ticking countdown (OMITTED on
// cold-start — no fake numbers), and a calm stall notice appears when the wait
// has exhausted 3× the initial estimate (or 5 minutes with no history). The
// stream hook is MOCKED off its barrel (its folding is covered by
// use-character-creation-stream.test.ts); the countdown math is the REAL
// remainingCreationWaitMs — the tests drive it through injected timings +
// mocked stages + fake timers. i18n: the countdown/stall copy keys are
// controller-owned — these tests assert element presence via testids, never
// resolved strings.

vi.mock('@mythrun/client-core/character', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@mythrun/client-core/character')>()
  return { ...actual, useCharacterCreationStream: vi.fn() }
})
const mockStream = vi.mocked(useCharacterCreationStream)

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
}: RenderOpts = {}) {
  mockStream.mockReturnValue({ beats, done, stages })
  return render(surface(onDone, fetchTimings))
}

/** Flush the microtask queue (the timings fetch resolves off it). */
const flush = async (): Promise<void> => {
  await act(async () => {
    await Promise.resolve()
  })
}

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
  it('shows the countdown once the timings history arrives and a wait remains', async () => {
    renderSurface({
      stages: [
        stageRow('location_selection', 'completed'),
        stageRow('character_concept', 'completed'),
        stageRow('character_sheet', 'running', new Date().toISOString()),
      ],
      fetchTimings: () => Promise.resolve(creationTimings(60_000)),
    })
    await flush()
    // Presence only — the label's copy is an i18n key the controller owns.
    expect(screen.getByTestId('character-loading-beat-countdown')).toBeDefined()
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

describe('CharacterLoadingSurface — the stall notice (MYT-102)', () => {
  it('appears after 5 minutes with no history and no terminal event', async () => {
    vi.useFakeTimers()
    renderSurface({ fetchTimings: () => Promise.resolve([]) })
    await flush()
    expect(screen.queryByTestId('character-loading-stalled')).toBeNull()

    await act(async () => {
      await vi.advanceTimersByTimeAsync(4 * 60_000)
    })
    expect(screen.queryByTestId('character-loading-stalled')).toBeNull()

    await act(async () => {
      await vi.advanceTimersByTimeAsync(60_000)
    })
    expect(screen.getByTestId('character-loading-stalled')).toBeDefined()
  })

  it('appears once the wait exhausts 3× the initial estimate', async () => {
    vi.useFakeTimers()
    // Nothing started yet → the initial estimate is the full 3 × 10s = 30s;
    // the stall threshold is 3 × that = 90s.
    renderSurface({ fetchTimings: () => Promise.resolve(creationTimings(10_000)) })
    await flush()

    await act(async () => {
      await vi.advanceTimersByTimeAsync(89_000)
    })
    expect(screen.queryByTestId('character-loading-stalled')).toBeNull()

    await act(async () => {
      await vi.advanceTimersByTimeAsync(2_000)
    })
    expect(screen.getByTestId('character-loading-stalled')).toBeDefined()
    // The countdown holds at its honest floor alongside the notice.
    expect(screen.getByTestId('character-loading-beat-countdown')).toBeDefined()
  })

  it('never appears once the stream reports done', async () => {
    vi.useFakeTimers()
    renderSurface({ done: true, fetchTimings: () => Promise.resolve([]) })
    await flush()
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10 * 60_000)
    })
    expect(screen.queryByTestId('character-loading-stalled')).toBeNull()
  })
})
