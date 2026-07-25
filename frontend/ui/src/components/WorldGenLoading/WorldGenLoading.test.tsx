import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { createRef } from 'react'
import { act, fireEvent, render } from '@testing-library/react'
import { axe } from 'jest-axe'
import { WorldGenLoading } from './WorldGenLoading.tsx'

// WorldGenLoading is act ONE of the two-act generating flow (MYT-89; reworked
// for ux-run2 myth-i2pdo + myth-xe38q): the calm pre-graph loading screen — an
// ACCRETING ~96px dither mark (fill driven by real-event `accretion`; ambient
// breathe at zero — never an empty frame) over a FLAVOR whisper that cycles
// short playful lines, past lines settling beneath as a faint LEDGER. The cycle
// is RANDOM: a shuffled permutation walked to exhaustion, re-shuffled with NO
// immediate repeat across the boundary — the RNG is injectable (`random`,
// default Math.random — the FogSim pattern) so these tests pin deterministic
// cycles. Below, the coarse aggregate COUNTDOWN (aria-hidden churn; the mark's
// role="status" carries the busy meaning) or its stalled stand-in, and the
// quiet permission-to-leave line. When entities start streaming the consumer
// flips `watchReady` and the screen grows the "Watch it take shape" WATCH
// button; pressing it fires `onWatch`. These tests pin: the mark's modes +
// label, the shuffled rotation + the reshuffle-boundary no-repeat + the ledger
// accumulation (fake timers), the reduced-motion freeze, the countdown/stalled
// lines, the leave line, the watch button's gating + press wiring, and the
// a11y surface.

const FLAVORS = [
  'The gods decide what to name themselves.',
  'History fades into mythology.',
  'The spark of magic enters the world.',
] as const

// The resolved watch-button label the shell supplies (real MYT-100 copy). Required
// on every render (the DS owns no copy), rendered only when `watchReady`.
const WATCH = 'Watch it take shape'

// Fisher-Yates with r≈1 leaves every element in place → the IDENTITY
// permutation. The deterministic stand-in for "a shuffle happened" where the
// resulting order should read 1 → 2 → 3.
const IDENTITY_RNG = (): number => 0.999999

// Fisher-Yates with r=0 swaps every position with index 0 → for 3 labels the
// order is [1, 2, 0]: the cycle OPENS on flavor 2 — visibly NOT the listed
// order.
const ZERO_RNG = (): number => 0

/** An RNG that replays a fixed sequence (then holds its last value) — crafts
 *  the exact permutations the reshuffle-boundary test needs. */
function sequenceRng(values: readonly number[]): () => number {
  let i = 0
  return () => {
    const v = values[Math.min(i, values.length - 1)] ?? 0
    i += 1
    return v
  }
}

// jsdom has no matchMedia; the component reads it for prefers-reduced-motion.
function mockMatchMedia(reduced: boolean): void {
  Object.defineProperty(window, 'matchMedia', {
    writable: true,
    configurable: true,
    value: (query: string) => ({
      matches: reduced,
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

describe('WorldGenLoading', () => {
  beforeEach(() => {
    mockMatchMedia(false)
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  it('renders the dither MARK inside a labelled status region (the busy meaning for AT)', () => {
    const { getByRole } = render(
      <WorldGenLoading watchLabel={WATCH} flavorLabels={FLAVORS} spinnerLabel="Making your world" />,
    )
    const status = getByRole('status')
    expect(status).toHaveAccessibleName('Making your world')
    // The paper-register indicator IS the quantized dither figure — no ad-hoc art.
    expect(status.querySelector('[data-beat-mode]')).not.toBeNull()
  })

  it('BREATHES at zero accretion — alive from frame one, never an empty fill frame (myth-zyk6o rule)', () => {
    const { getByTestId } = render(<WorldGenLoading watchLabel={WATCH} flavorLabels={FLAVORS} />)
    const mark = getByTestId('worldgen-loading-mark')
    expect(mark).toHaveAttribute('data-beat-mode', 'breathe')
    expect(mark).not.toHaveAttribute('data-beat-level')
  })

  it('FILLS from real-event accretion once work has landed (myth-i2pdo: motion means work)', () => {
    const { getByTestId } = render(
      <WorldGenLoading watchLabel={WATCH} flavorLabels={FLAVORS} accretion={0.25} />,
    )
    const mark = getByTestId('worldgen-loading-mark')
    expect(mark).toHaveAttribute('data-beat-mode', 'fill')
    expect(mark).toHaveAttribute('data-beat-level', '0.25')
  })

  it('opens on the shuffled order’s first line (not necessarily the listed first)', () => {
    // ZERO_RNG shuffles [1, 2, 0] — the screen opens on flavor 2. The order is
    // the SHUFFLE's, never the array's.
    const { getByTestId } = render(<WorldGenLoading watchLabel={WATCH} flavorLabels={FLAVORS} random={ZERO_RNG} />)
    expect(getByTestId('whisper-ledger-current').textContent).toBe('History fades into mythology.')
  })

  it('cycles the flavor line through the whole permutation every intervalMs, settling shown lines into the LEDGER', () => {
    vi.useFakeTimers()
    const { getByTestId, getAllByTestId } = render(
      <WorldGenLoading watchLabel={WATCH} flavorLabels={FLAVORS} intervalMs={2000} random={IDENTITY_RNG} />,
    )
    const current = (): string | null => getByTestId('whisper-ledger-current').textContent
    expect(current()).toBe('The gods decide what to name themselves.')
    act(() => {
      vi.advanceTimersByTime(2000)
    })
    expect(current()).toBe('History fades into mythology.')
    // The just-shown line settled into the ledger (myth-i2pdo — the growing
    // list IS the progress indicator).
    expect(getAllByTestId('whisper-ledger-line').map((l) => l.textContent)).toEqual([
      'The gods decide what to name themselves.',
    ])
    act(() => {
      vi.advanceTimersByTime(2000)
    })
    expect(current()).toBe('The spark of magic enters the world.')
    // Newest first.
    expect(getAllByTestId('whisper-ledger-line').map((l) => l.textContent)).toEqual([
      'History fades into mythology.',
      'The gods decide what to name themselves.',
    ])
    // Exhausted → RE-SHUFFLE (identity again) and keep walking: back to 1.
    act(() => {
      vi.advanceTimersByTime(2000)
    })
    expect(current()).toBe('The gods decide what to name themselves.')
  })

  it('never repeats a line across the reshuffle boundary (the just-shown head swaps away)', () => {
    vi.useFakeTimers()
    // Crafted sequence: the first shuffle (2 draws at ~1) is the identity
    // [0,1,2] — the cycle ends on flavor 3. The reshuffle (draws 0 then 0.9)
    // yields [2,1,0] RAW — flavor 3 would repeat back-to-back — so the cycler
    // must swap the offending head to the tail: the next line is flavor 1.
    const rng = sequenceRng([0.999999, 0.999999, 0, 0.9])
    const { getByTestId } = render(
      <WorldGenLoading watchLabel={WATCH} flavorLabels={FLAVORS} intervalMs={2000} random={rng} />,
    )
    const current = (): string | null => getByTestId('whisper-ledger-current').textContent
    expect(current()).toBe('The gods decide what to name themselves.')
    act(() => {
      vi.advanceTimersByTime(4000) // → flavor 2, then flavor 3 (permutation end)
    })
    expect(current()).toBe('The spark of magic enters the world.')
    act(() => {
      vi.advanceTimersByTime(2000) // reshuffle boundary
    })
    // NOT flavor 3 again — the raw reshuffle led with it and the guard swapped it away.
    expect(current()).toBe('The gods decide what to name themselves.')
  })

  it('cycles with the default Math.random when no RNG is injected', () => {
    const { getByTestId } = render(<WorldGenLoading watchLabel={WATCH} flavorLabels={FLAVORS} />)
    // Whatever the real shuffle drew, the line is one of the supplied labels.
    expect(FLAVORS).toContain(getByTestId('whisper-ledger-current').textContent)
  })

  it('defaults the rotation to ~10s when intervalMs is omitted', () => {
    vi.useFakeTimers()
    const { getByTestId } = render(<WorldGenLoading watchLabel={WATCH} flavorLabels={FLAVORS} random={IDENTITY_RNG} />)
    const current = (): string | null => getByTestId('whisper-ledger-current').textContent
    act(() => {
      vi.advanceTimersByTime(9999)
    })
    expect(current()).toBe('The gods decide what to name themselves.')
    act(() => {
      vi.advanceTimersByTime(1)
    })
    expect(current()).toBe('History fades into mythology.')
  })

  it('under prefers-reduced-motion the cycler FREEZES on the opening line (no timed swap, empty ledger)', () => {
    mockMatchMedia(true)
    vi.useFakeTimers()
    const { getByTestId, queryByTestId } = render(
      <WorldGenLoading watchLabel={WATCH} flavorLabels={FLAVORS} intervalMs={2000} random={IDENTITY_RNG} />,
    )
    act(() => {
      vi.advanceTimersByTime(10_000)
    })
    expect(getByTestId('whisper-ledger-current').textContent).toBe('The gods decide what to name themselves.')
    expect(queryByTestId('whisper-ledger-history')).toBeNull()
  })

  it('renders no whisper column when the list is empty (the mark still shows)', () => {
    const { getByRole, container } = render(<WorldGenLoading watchLabel={WATCH} flavorLabels={[]} />)
    expect(getByRole('status')).toBeInTheDocument()
    expect(container.querySelector('[data-testid="whisper-ledger-current"]')).toBeNull()
  })

  it('renders the permission-to-leave line as real (non-hidden) closing content when supplied', () => {
    const { getByTestId } = render(
      <WorldGenLoading
        watchLabel={WATCH}
        flavorLabels={FLAVORS}
        leaveLabel="Safe to leave. The world keeps forming."
      />,
    )
    const leave = getByTestId('worldgen-loading-leave')
    expect(leave.textContent).toBe('Safe to leave. The world keeps forming.')
    expect(leave).not.toHaveAttribute('aria-hidden')
  })

  it('renders no leave line when the consumer omits it', () => {
    const { queryByTestId } = render(<WorldGenLoading watchLabel={WATCH} flavorLabels={FLAVORS} />)
    expect(queryByTestId('worldgen-loading-leave')).toBeNull()
  })

  it('does NOT start an interval for a single flavor line (nothing to cycle)', () => {
    vi.useFakeTimers()
    const setInterval = vi.spyOn(window, 'setInterval')
    render(<WorldGenLoading watchLabel={WATCH} flavorLabels={['The gods decide what to name themselves.']} />)
    expect(setInterval).not.toHaveBeenCalled()
  })

  it('clears the interval on unmount (no leak)', () => {
    vi.useFakeTimers()
    const clearInterval = vi.spyOn(window, 'clearInterval')
    const { unmount } = render(<WorldGenLoading watchLabel={WATCH} flavorLabels={FLAVORS} />)
    unmount()
    expect(clearInterval).toHaveBeenCalled()
  })

  it('renders the countdown line, aria-hidden (the Spinner status carries AT meaning)', () => {
    const { getByTestId } = render(
      <WorldGenLoading watchLabel={WATCH} flavorLabels={FLAVORS} countdownLabel="~4:37 left" />,
    )
    const countdown = getByTestId('worldgen-loading-countdown')
    expect(countdown).toHaveTextContent('~4:37 left')
    expect(countdown).toHaveAttribute('aria-hidden', 'true')
  })

  it('re-renders the countdown as the consumer ticks it (the per-second walk)', () => {
    const { getByTestId, rerender } = render(
      <WorldGenLoading watchLabel={WATCH} flavorLabels={FLAVORS} countdownLabel="~4:37 left" />,
    )
    rerender(<WorldGenLoading watchLabel={WATCH} flavorLabels={FLAVORS} countdownLabel="~4:36 left" />)
    expect(getByTestId('worldgen-loading-countdown')).toHaveTextContent('~4:36 left')
  })

  it('renders NO countdown line when countdownLabel is omitted (cold-start / no history)', () => {
    const { container } = render(<WorldGenLoading watchLabel={WATCH} flavorLabels={FLAVORS} />)
    expect(container.querySelector('[data-testid="worldgen-loading-countdown"]')).toBeNull()
  })

  it('renders the stalled stand-in when the estimate exhausts (ux-run2 myth-uz1bn: degrade in language, never sit)', () => {
    const { getByTestId, queryByTestId } = render(
      <WorldGenLoading watchLabel={WATCH} flavorLabels={FLAVORS} stalledLabel="Still working." />,
    )
    const stalled = getByTestId('worldgen-loading-stalled')
    expect(stalled).toHaveTextContent('Still working.')
    // Real reassurance content (a one-time state change) — NOT aria-hidden.
    expect(stalled).not.toHaveAttribute('aria-hidden')
    expect(queryByTestId('worldgen-loading-countdown')).toBeNull()
  })

  it('prefers the live countdown over the stalled line when both are supplied (defensive)', () => {
    const { getByTestId, queryByTestId } = render(
      <WorldGenLoading
        watchLabel={WATCH}
        flavorLabels={FLAVORS}
        countdownLabel="Ready in about 2 min"
        stalledLabel="Still working."
      />,
    )
    expect(getByTestId('worldgen-loading-countdown')).toBeInTheDocument()
    expect(queryByTestId('worldgen-loading-stalled')).toBeNull()
  })

  it('hides the watch button during the pure prep act (watchReady omitted/false)', () => {
    const { queryByRole, rerender } = render(<WorldGenLoading watchLabel={WATCH} flavorLabels={FLAVORS} />)
    expect(queryByRole('button')).toBeNull()
    rerender(<WorldGenLoading watchLabel={WATCH} flavorLabels={FLAVORS} watchReady={false} />)
    expect(queryByRole('button')).toBeNull()
  })

  it('shows the watch button once watchReady, and fires onWatch on press', () => {
    const onWatch = vi.fn()
    const { getByRole } = render(
      <WorldGenLoading watchLabel={WATCH}
        flavorLabels={FLAVORS}
        watchReady
        onWatch={onWatch}
      />,
    )
    const button = getByRole('button', { name: 'Watch it take shape' })
    fireEvent.click(button)
    expect(onWatch).toHaveBeenCalledTimes(1)
  })

  it('keeps cycling the flavor line while the watch button is showing (gen keeps running)', () => {
    vi.useFakeTimers()
    const { getByText } = render(
      <WorldGenLoading watchLabel={WATCH}
        flavorLabels={FLAVORS}
        intervalMs={2000}
        random={IDENTITY_RNG}
        watchReady
        onWatch={vi.fn()}
      />,
    )
    act(() => {
      vi.advanceTimersByTime(2000)
    })
    expect(getByText('History fades into mythology.')).toBeInTheDocument()
  })

  it('never uses banned motion (no spin/slide/bounce — the brand rule)', () => {
    const { container } = render(
      <WorldGenLoading watchLabel={WATCH} flavorLabels={FLAVORS} countdownLabel="~4:37 left" watchReady />,
    )
    expect(container.innerHTML).not.toMatch(
      /animate-spin|animate-bounce|animate-ping|translate|rotate|scale-/,
    )
  })

  it('forwards its ref and passes through a data-testid', () => {
    const ref = createRef<HTMLDivElement>()
    const { getByTestId } = render(
      <WorldGenLoading watchLabel={WATCH} ref={ref} flavorLabels={FLAVORS} data-testid="loading-screen" />,
    )
    expect(getByTestId('loading-screen')).toBeInTheDocument()
    expect(ref.current).toBeInstanceOf(HTMLDivElement)
  })

  it('has no axe violations (prep act + watch-ready act, countdown showing)', async () => {
    const prep = render(
      <WorldGenLoading watchLabel={WATCH}
        flavorLabels={FLAVORS}
        spinnerLabel="Making your world"
        countdownLabel="~4:37 left"
      />,
    )
    expect(await axe(prep.container)).toHaveNoViolations()
    prep.unmount()
    const ready = render(
      <WorldGenLoading watchLabel={WATCH}
        flavorLabels={FLAVORS}
        spinnerLabel="Making your world"
        countdownLabel="~0:41 left"
        watchReady
        onWatch={vi.fn()}
      />,
    )
    expect(await axe(ready.container)).toHaveNoViolations()
  })
})
