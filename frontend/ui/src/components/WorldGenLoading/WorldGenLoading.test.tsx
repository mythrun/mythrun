import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { createRef } from 'react'
import { act, fireEvent, render } from '@testing-library/react'
import { axe } from 'jest-axe'
import { WorldGenLoading } from './WorldGenLoading.tsx'

// WorldGenLoading is act ONE of the two-act generating flow (MYT-89): the generic
// pre-entity loading screen shown while the prep stages run — the DS Spinner (the
// brand dither wave) + a FLAVOR line that cycles short playful loading messages
// every few seconds (Claude-Code-"thinking" style). The cycle is RANDOM (MYT-89
// waiting-feedback): a shuffled permutation walked to exhaustion, re-shuffled
// with NO immediate repeat across the boundary — the RNG is injectable
// (`random`, default Math.random — the FogSim pattern) so these tests pin
// deterministic cycles. Below the flavor line an optional per-second COUNTDOWN
// (`countdownLabel`, consumer-ticked) keeps the wait legible; it is aria-hidden
// (a per-second live region would be noise — the Spinner's role="status"
// carries the busy meaning). When entities start streaming the consumer flips
// `watchReady` and the screen grows the "watch your world be born" WATCH
// button; pressing it fires `onWatch`. These tests pin: the Spinner presence +
// label, the shuffled rotation + the reshuffle-boundary no-repeat (fake
// timers), the reduced-motion freeze (no timed swapping), the countdown line's
// render + aria-hidden, the watch button's gating + press wiring, and the
// a11y surface.

const FLAVORS = [
  '[ph: worldgen flavor 1]',
  '[ph: worldgen flavor 2]',
  '[ph: worldgen flavor 3]',
] as const

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

  it('renders the DS Spinner (the brand dither wave) with the supplied SR label', () => {
    const { getByRole } = render(
      <WorldGenLoading flavorLabels={FLAVORS} spinnerLabel="[ph: making your world]" />,
    )
    const status = getByRole('status')
    expect(status).toHaveAccessibleName('[ph: making your world]')
    // The paper-register indicator IS the Spinner's dither grid — no ad-hoc art.
    expect(status.querySelector('[data-spinner-grid]')).not.toBeNull()
  })

  it('opens on the shuffled order’s first line (not necessarily the listed first)', () => {
    // ZERO_RNG shuffles [1, 2, 0] — the screen opens on flavor 2. The order is
    // the SHUFFLE's, never the array's.
    const { getByText } = render(<WorldGenLoading flavorLabels={FLAVORS} random={ZERO_RNG} />)
    expect(getByText('[ph: worldgen flavor 2]')).toBeInTheDocument()
  })

  it('cycles the flavor line through the whole permutation every intervalMs', () => {
    vi.useFakeTimers()
    const { getByText, queryByText } = render(
      <WorldGenLoading flavorLabels={FLAVORS} intervalMs={2000} random={IDENTITY_RNG} />,
    )
    expect(getByText('[ph: worldgen flavor 1]')).toBeInTheDocument()
    act(() => {
      vi.advanceTimersByTime(2000)
    })
    expect(getByText('[ph: worldgen flavor 2]')).toBeInTheDocument()
    expect(queryByText('[ph: worldgen flavor 1]')).toBeNull()
    act(() => {
      vi.advanceTimersByTime(2000)
    })
    expect(getByText('[ph: worldgen flavor 3]')).toBeInTheDocument()
    // Exhausted → RE-SHUFFLE (identity again) and keep walking: back to 1.
    act(() => {
      vi.advanceTimersByTime(2000)
    })
    expect(getByText('[ph: worldgen flavor 1]')).toBeInTheDocument()
  })

  it('never repeats a line across the reshuffle boundary (the just-shown head swaps away)', () => {
    vi.useFakeTimers()
    // Crafted sequence: the first shuffle (2 draws at ~1) is the identity
    // [0,1,2] — the cycle ends on flavor 3. The reshuffle (draws 0 then 0.9)
    // yields [2,1,0] RAW — flavor 3 would repeat back-to-back — so the cycler
    // must swap the offending head to the tail: the next line is flavor 1.
    const rng = sequenceRng([0.999999, 0.999999, 0, 0.9])
    const { getByText } = render(
      <WorldGenLoading flavorLabels={FLAVORS} intervalMs={2000} random={rng} />,
    )
    expect(getByText('[ph: worldgen flavor 1]')).toBeInTheDocument()
    act(() => {
      vi.advanceTimersByTime(4000) // → flavor 2, then flavor 3 (permutation end)
    })
    expect(getByText('[ph: worldgen flavor 3]')).toBeInTheDocument()
    act(() => {
      vi.advanceTimersByTime(2000) // reshuffle boundary
    })
    // NOT flavor 3 again — the raw reshuffle led with it and the guard swapped it away.
    expect(getByText('[ph: worldgen flavor 1]')).toBeInTheDocument()
  })

  it('cycles with the default Math.random when no RNG is injected', () => {
    const { getByTestId } = render(<WorldGenLoading flavorLabels={FLAVORS} />)
    // Whatever the real shuffle drew, the line is one of the supplied labels.
    expect(FLAVORS).toContain(getByTestId('worldgen-loading-flavor').textContent)
  })

  it('defaults the rotation to ~3s when intervalMs is omitted', () => {
    vi.useFakeTimers()
    const { getByText } = render(<WorldGenLoading flavorLabels={FLAVORS} random={IDENTITY_RNG} />)
    act(() => {
      vi.advanceTimersByTime(2999)
    })
    expect(getByText('[ph: worldgen flavor 1]')).toBeInTheDocument()
    act(() => {
      vi.advanceTimersByTime(1)
    })
    expect(getByText('[ph: worldgen flavor 2]')).toBeInTheDocument()
  })

  it('under prefers-reduced-motion the cycler FREEZES on the opening line (no timed swap)', () => {
    mockMatchMedia(true)
    vi.useFakeTimers()
    const { getByText } = render(
      <WorldGenLoading flavorLabels={FLAVORS} intervalMs={2000} random={IDENTITY_RNG} />,
    )
    act(() => {
      vi.advanceTimersByTime(10_000)
    })
    expect(getByText('[ph: worldgen flavor 1]')).toBeInTheDocument()
  })

  it('renders no flavor line when the list is empty (the Spinner still shows)', () => {
    const { getByRole, container } = render(<WorldGenLoading flavorLabels={[]} />)
    expect(getByRole('status')).toBeInTheDocument()
    expect(container.querySelector('[data-testid="worldgen-loading-flavor"]')).toBeNull()
  })

  it('does NOT start an interval for a single flavor line (nothing to cycle)', () => {
    vi.useFakeTimers()
    const setInterval = vi.spyOn(window, 'setInterval')
    render(<WorldGenLoading flavorLabels={['[ph: worldgen flavor 1]']} />)
    expect(setInterval).not.toHaveBeenCalled()
  })

  it('clears the interval on unmount (no leak)', () => {
    vi.useFakeTimers()
    const clearInterval = vi.spyOn(window, 'clearInterval')
    const { unmount } = render(<WorldGenLoading flavorLabels={FLAVORS} />)
    unmount()
    expect(clearInterval).toHaveBeenCalled()
  })

  it('renders the countdown line, aria-hidden (the Spinner status carries AT meaning)', () => {
    const { getByTestId } = render(
      <WorldGenLoading flavorLabels={FLAVORS} countdownLabel="[ph: ~4:37 left]" />,
    )
    const countdown = getByTestId('worldgen-loading-countdown')
    expect(countdown).toHaveTextContent('[ph: ~4:37 left]')
    expect(countdown).toHaveAttribute('aria-hidden', 'true')
  })

  it('re-renders the countdown as the consumer ticks it (the per-second walk)', () => {
    const { getByTestId, rerender } = render(
      <WorldGenLoading flavorLabels={FLAVORS} countdownLabel="[ph: ~4:37 left]" />,
    )
    rerender(<WorldGenLoading flavorLabels={FLAVORS} countdownLabel="[ph: ~4:36 left]" />)
    expect(getByTestId('worldgen-loading-countdown')).toHaveTextContent('[ph: ~4:36 left]')
  })

  it('renders NO countdown line when countdownLabel is omitted (cold-start / no history)', () => {
    const { container } = render(<WorldGenLoading flavorLabels={FLAVORS} />)
    expect(container.querySelector('[data-testid="worldgen-loading-countdown"]')).toBeNull()
  })

  it('hides the watch button during the pure prep act (watchReady omitted/false)', () => {
    const { queryByRole, rerender } = render(<WorldGenLoading flavorLabels={FLAVORS} />)
    expect(queryByRole('button')).toBeNull()
    rerender(<WorldGenLoading flavorLabels={FLAVORS} watchReady={false} />)
    expect(queryByRole('button')).toBeNull()
  })

  it('shows the watch button once watchReady, and fires onWatch on press', () => {
    const onWatch = vi.fn()
    const { getByRole } = render(
      <WorldGenLoading
        flavorLabels={FLAVORS}
        watchReady
        watchLabel="[ph: watch your world be born]"
        onWatch={onWatch}
      />,
    )
    const button = getByRole('button', { name: '[ph: watch your world be born]' })
    fireEvent.click(button)
    expect(onWatch).toHaveBeenCalledTimes(1)
  })

  it('keeps cycling the flavor line while the watch button is showing (gen keeps running)', () => {
    vi.useFakeTimers()
    const { getByText } = render(
      <WorldGenLoading
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
    expect(getByText('[ph: worldgen flavor 2]')).toBeInTheDocument()
  })

  it('never uses banned motion (no spin/slide/bounce — the brand rule)', () => {
    const { container } = render(
      <WorldGenLoading flavorLabels={FLAVORS} countdownLabel="[ph: ~4:37 left]" watchReady />,
    )
    expect(container.innerHTML).not.toMatch(
      /animate-spin|animate-bounce|animate-ping|translate|rotate|scale-/,
    )
  })

  it('forwards its ref and passes through a data-testid', () => {
    const ref = createRef<HTMLDivElement>()
    const { getByTestId } = render(
      <WorldGenLoading ref={ref} flavorLabels={FLAVORS} data-testid="loading-screen" />,
    )
    expect(getByTestId('loading-screen')).toBeInTheDocument()
    expect(ref.current).toBeInstanceOf(HTMLDivElement)
  })

  it('has no axe violations (prep act + watch-ready act, countdown showing)', async () => {
    const prep = render(
      <WorldGenLoading
        flavorLabels={FLAVORS}
        spinnerLabel="[ph: making your world]"
        countdownLabel="[ph: ~4:37 left]"
      />,
    )
    expect(await axe(prep.container)).toHaveNoViolations()
    prep.unmount()
    const ready = render(
      <WorldGenLoading
        flavorLabels={FLAVORS}
        spinnerLabel="[ph: making your world]"
        countdownLabel="[ph: ~0:41 left]"
        watchReady
        watchLabel="[ph: watch your world be born]"
        onWatch={vi.fn()}
      />,
    )
    expect(await axe(ready.container)).toHaveNoViolations()
  })
})
