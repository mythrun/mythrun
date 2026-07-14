import { describe, it, expect, vi, afterEach } from 'vitest'
import { createRef } from 'react'
import { act, render } from '@testing-library/react'
import { axe } from 'jest-axe'
import { DieSpin } from './DieSpin.tsx'

// DieSpin (MYT-93, spec §5) — the flat 2D OUTLINED d20 the RollCard spins. Its
// motion is a STEPPED rotation (8 discrete 45° steps ≈ one ~1s revolution, driven
// by a setInterval step counter — NEVER a smooth CSS transition, the motion analog
// of the brand's stepped Bayer dither); on the last step it calls `onSpinComplete`.
// `result` stamps the numeral in the die centre in `--font-ui` once landed;
// `reducedMotion` lands instantly (no spin, immediate `onSpinComplete`). The die is
// aria-hidden decoration; the landed result announces via a polite live region
// (motion is never the only signal). These tests pin: the idle glyph, the stamped
// numeral + live region, the STEPPED interval (≥2 distinct rotations + one
// completion), the reduced-motion instant land (no churn / no rotation), the
// aria-hidden die, the no-circle register, and the unmount cleanup.

// The stepped budget the component pins (8 steps × 125ms ≈ 1s). Kept here so the
// timing walk below is self-describing.
const SPIN_STEPS = 8
const STEP_MS = 125

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
})

describe('DieSpin', () => {
  it('idle (not spinning, no result) renders the die glyph and NO numeral', () => {
    const { container, queryByTestId } = render(
      <DieSpin spinning={false} result={null} reducedMotion={false} onSpinComplete={vi.fn()} />,
    )
    expect(container.querySelector('svg')).toBeInTheDocument()
    expect(queryByTestId('die-spin-result')).toBeNull()
  })

  it('stamps the landed numeral in a font-ui node and announces it via a polite live region', () => {
    const { getByTestId, getByRole } = render(
      <DieSpin
        spinning={false}
        result={20}
        reducedMotion={false}
        onSpinComplete={vi.fn()}
        resultLabel="[ph: you rolled a 20]"
      />,
    )
    const numeral = getByTestId('die-spin-result')
    expect(numeral).toHaveTextContent('20')
    expect(numeral).toHaveClass('font-ui')
    const live = getByRole('status')
    expect(live).toHaveTextContent('[ph: you rolled a 20]')
    expect(live).toHaveAttribute('aria-live', 'polite')
  })

  it('stamps the numeral with an EMPTY live region when no resultLabel is supplied', () => {
    const { getByTestId, getByRole } = render(
      <DieSpin spinning={false} result={7} reducedMotion={false} onSpinComplete={vi.fn()} />,
    )
    expect(getByTestId('die-spin-result')).toHaveTextContent('7')
    expect(getByRole('status')).toHaveTextContent('')
  })

  it('runs the STEPPED rotation (≥2 distinct rotate transforms) and completes once', () => {
    vi.useFakeTimers()
    const onSpinComplete = vi.fn()
    const { container, queryByTestId } = render(
      <DieSpin spinning result={17} reducedMotion={false} onSpinComplete={onSpinComplete} />,
    )
    // While spinning the numeral is withheld even though a result is present.
    expect(queryByTestId('die-spin-result')).toBeNull()

    const svg = container.querySelector('svg')
    if (svg === null) throw new Error('die glyph missing')
    const transforms = new Set<string>([svg.style.transform])
    for (let i = 0; i < SPIN_STEPS; i++) {
      act(() => {
        vi.advanceTimersByTime(STEP_MS)
      })
      transforms.add(svg.style.transform)
    }
    // Stepped, not static — the die visits multiple discrete angles.
    expect(transforms.size).toBeGreaterThanOrEqual(2)
    // Exactly one completion at the last step.
    expect(onSpinComplete).toHaveBeenCalledTimes(1)
  })

  it('under reducedMotion lands INSTANTLY — immediate completion, no churn, no rotation', () => {
    vi.useFakeTimers()
    const onSpinComplete = vi.fn()
    const { container } = render(
      <DieSpin spinning result={12} reducedMotion onSpinComplete={onSpinComplete} />,
    )
    expect(onSpinComplete).toHaveBeenCalledTimes(1)
    const svg = container.querySelector('svg')
    if (svg === null) throw new Error('die glyph missing')
    expect(svg.style.transform).toBe('rotate(0deg)')
    // No stepped interval churns afterward — the completion is a one-shot.
    act(() => {
      vi.advanceTimersByTime(5000)
    })
    expect(onSpinComplete).toHaveBeenCalledTimes(1)
    expect(svg.style.transform).toBe('rotate(0deg)')
  })

  it('does NOT complete while idle (spinning:false fires nothing)', () => {
    const onSpinComplete = vi.fn()
    render(<DieSpin spinning={false} result={null} reducedMotion={false} onSpinComplete={onSpinComplete} />)
    expect(onSpinComplete).not.toHaveBeenCalled()
  })

  it('marks the die glyph aria-hidden (decoration; the live region carries meaning)', () => {
    const { container } = render(
      <DieSpin spinning={false} result={9} reducedMotion={false} onSpinComplete={vi.fn()} />,
    )
    expect(container.querySelector('svg')).toHaveAttribute('aria-hidden', 'true')
  })

  it('uses no circle / rounded-full (square 1-bit register)', () => {
    const { container } = render(
      <DieSpin spinning={false} result={15} reducedMotion={false} onSpinComplete={vi.fn()} />,
    )
    expect(container.querySelector('circle')).toBeNull()
    expect(container.innerHTML).not.toMatch(/rounded-full/)
  })

  it('clears the stepped interval on unmount (no post-unmount churn)', () => {
    vi.useFakeTimers()
    const clearInterval = vi.spyOn(window, 'clearInterval')
    const { unmount } = render(
      <DieSpin spinning result={null} reducedMotion={false} onSpinComplete={vi.fn()} />,
    )
    act(() => {
      vi.advanceTimersByTime(STEP_MS)
    })
    unmount()
    expect(clearInterval).toHaveBeenCalled()
  })

  it('forwards its ref to the wrapping element', () => {
    const ref = createRef<HTMLDivElement>()
    render(<DieSpin ref={ref} spinning={false} result={null} reducedMotion={false} onSpinComplete={vi.fn()} />)
    expect(ref.current).toBeInstanceOf(HTMLDivElement)
  })

  it('has no axe violations idle and landed', async () => {
    const idle = render(
      <DieSpin spinning={false} result={null} reducedMotion={false} onSpinComplete={vi.fn()} />,
    )
    expect(await axe(idle.container)).toHaveNoViolations()
    idle.unmount()
    const landed = render(
      <DieSpin
        spinning={false}
        result={20}
        reducedMotion={false}
        onSpinComplete={vi.fn()}
        resultLabel="[ph: you rolled a 20]"
      />,
    )
    expect(await axe(landed.container)).toHaveNoViolations()
  })
})
