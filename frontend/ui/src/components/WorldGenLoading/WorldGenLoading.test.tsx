import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { createRef } from 'react'
import { act, fireEvent, render } from '@testing-library/react'
import { axe } from 'jest-axe'
import { WorldGenLoading } from './WorldGenLoading.tsx'

// WorldGenLoading is act ONE of the two-act generating flow (MYT-89): the generic
// pre-entity loading screen shown while the prep stages run — the DS Spinner (the
// brand dither wave) + a FLAVOR line that cycles short playful loading messages
// every few seconds (Claude-Code-"thinking" style). When entities start streaming
// the consumer flips `revealReady` and the screen grows the "watch your world be
// born" REVEAL button; pressing it fires `onReveal` (the consumer swaps to the
// graph). These tests pin: the Spinner presence + label, the cycler's rotation +
// wrap-around (fake timers), the reduced-motion freeze (no timed swapping), the
// reveal button's gating + press wiring, and the a11y surface.

const FLAVORS = [
  '[ph: worldgen flavor 1]',
  '[ph: worldgen flavor 2]',
  '[ph: worldgen flavor 3]',
] as const

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

  it('shows the first flavor line initially', () => {
    const { getByText } = render(<WorldGenLoading flavorLabels={FLAVORS} />)
    expect(getByText('[ph: worldgen flavor 1]')).toBeInTheDocument()
  })

  it('cycles the flavor line every intervalMs, wrapping around the list', () => {
    vi.useFakeTimers()
    const { getByText, queryByText } = render(
      <WorldGenLoading flavorLabels={FLAVORS} intervalMs={2000} />,
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
    // Wrap-around: after the last line the cycle returns to the first.
    act(() => {
      vi.advanceTimersByTime(2000)
    })
    expect(getByText('[ph: worldgen flavor 1]')).toBeInTheDocument()
  })

  it('defaults the rotation to ~3s when intervalMs is omitted', () => {
    vi.useFakeTimers()
    const { getByText } = render(<WorldGenLoading flavorLabels={FLAVORS} />)
    act(() => {
      vi.advanceTimersByTime(2999)
    })
    expect(getByText('[ph: worldgen flavor 1]')).toBeInTheDocument()
    act(() => {
      vi.advanceTimersByTime(1)
    })
    expect(getByText('[ph: worldgen flavor 2]')).toBeInTheDocument()
  })

  it('under prefers-reduced-motion the cycler FREEZES on the first line (no timed swap)', () => {
    mockMatchMedia(true)
    vi.useFakeTimers()
    const { getByText } = render(<WorldGenLoading flavorLabels={FLAVORS} intervalMs={2000} />)
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

  it('hides the reveal button during the pure prep act (revealReady omitted/false)', () => {
    const { queryByRole, rerender } = render(<WorldGenLoading flavorLabels={FLAVORS} />)
    expect(queryByRole('button')).toBeNull()
    rerender(<WorldGenLoading flavorLabels={FLAVORS} revealReady={false} />)
    expect(queryByRole('button')).toBeNull()
  })

  it('shows the reveal button once revealReady, and fires onReveal on press', () => {
    const onReveal = vi.fn()
    const { getByRole } = render(
      <WorldGenLoading
        flavorLabels={FLAVORS}
        revealReady
        revealLabel="[ph: watch your world be born]"
        onReveal={onReveal}
      />,
    )
    const button = getByRole('button', { name: '[ph: watch your world be born]' })
    fireEvent.click(button)
    expect(onReveal).toHaveBeenCalledTimes(1)
  })

  it('keeps cycling the flavor line while the reveal button is showing (gen keeps running)', () => {
    vi.useFakeTimers()
    const { getByText } = render(
      <WorldGenLoading flavorLabels={FLAVORS} intervalMs={2000} revealReady onReveal={vi.fn()} />,
    )
    act(() => {
      vi.advanceTimersByTime(2000)
    })
    expect(getByText('[ph: worldgen flavor 2]')).toBeInTheDocument()
  })

  it('never uses banned motion (no spin/slide/bounce — the brand rule)', () => {
    const { container } = render(<WorldGenLoading flavorLabels={FLAVORS} revealReady />)
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

  it('has no axe violations (prep act + reveal-ready act)', async () => {
    const prep = render(
      <WorldGenLoading flavorLabels={FLAVORS} spinnerLabel="[ph: making your world]" />,
    )
    expect(await axe(prep.container)).toHaveNoViolations()
    prep.unmount()
    const ready = render(
      <WorldGenLoading
        flavorLabels={FLAVORS}
        spinnerLabel="[ph: making your world]"
        revealReady
        revealLabel="[ph: watch your world be born]"
        onReveal={vi.fn()}
      />,
    )
    expect(await axe(ready.container)).toHaveNoViolations()
  })
})
