import { describe, it, expect, vi, afterEach } from 'vitest'
import { createRef } from 'react'
import { act, render } from '@testing-library/react'
import { axe } from 'jest-axe'
import { DieSpin, DIE_SPIN_DWELLS, DIE_IMPACT_MS, DIE_IMPACT_SCALE } from './DieSpin.tsx'

// DieSpin (MYT-93, spec §5) — the flat 2D OUTLINED facet-band d20 the RollCard spins.
// Its motion is a STEPPED rotation (eight discrete 45° jumps ≈ one revolution back to
// upright, driven by a setTimeout schedule — NEVER a smooth CSS transition, the motion
// analog of the brand's stepped Bayer dither). Easing lives in the DWELL: the holds
// ramp (DIE_SPIN_DWELLS) so the die decelerates into the landing, and the final step
// lands upright fused with ONE recoil frame (a scale pop, DIE_IMPACT_SCALE, held
// DIE_IMPACT_MS) before snapping to rest. `onSpinComplete` fires exactly ONCE, at that
// final rest. `result` stamps the numeral in the die centre in `--font-ui` once landed;
// `reducedMotion` lands instantly (no spin, immediate `onSpinComplete`). The die is
// aria-hidden decoration; the landed result announces via a polite live region (motion
// is never the only signal). These tests pin: the idle glyph, the stamped numeral +
// live region, the DECELERATING stepped schedule (distinct rotations + the recoil scale
// + a single completion at rest), the reduced-motion instant land, the aria-hidden die,
// the no-circle register, and the unmount cleanup.

// The full dwell walk: the seven decelerating spin holds, then the recoil hold. Each
// entry is the time to advance to REACH the next frame — mirrors the component's
// schedule so the timing walk below is self-describing.
const DWELLS = [...DIE_SPIN_DWELLS, DIE_IMPACT_MS]

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
        resultLabel="you rolled a 20"
      />,
    )
    const numeral = getByTestId('die-spin-result')
    expect(numeral).toHaveTextContent('20')
    expect(numeral).toHaveClass('font-ui')
    const live = getByRole('status')
    expect(live).toHaveTextContent('you rolled a 20')
    expect(live).toHaveAttribute('aria-live', 'polite')
  })

  it('stamps the numeral with an EMPTY live region when no resultLabel is supplied', () => {
    const { getByTestId, getByRole } = render(
      <DieSpin spinning={false} result={7} reducedMotion={false} onSpinComplete={vi.fn()} />,
    )
    expect(getByTestId('die-spin-result')).toHaveTextContent('7')
    expect(getByRole('status')).toHaveTextContent('')
  })

  it('runs the DECELERATING stepped rotation (distinct angles + a recoil scale) and completes once at rest', () => {
    vi.useFakeTimers()
    const onSpinComplete = vi.fn()
    const { container, queryByTestId } = render(
      <DieSpin spinning result={17} reducedMotion={false} onSpinComplete={onSpinComplete} />,
    )
    // While spinning the numeral is withheld even though a result is present.
    expect(queryByTestId('die-spin-result')).toBeNull()

    const svg = container.querySelector('svg')
    if (svg === null) throw new Error('die glyph missing')

    // The first frame shows synchronously on mount; no completion yet.
    const transforms = new Set<string>([svg.style.transform])
    expect(onSpinComplete).not.toHaveBeenCalled()

    // Walk every dwell, collecting the transform after each discrete jump.
    for (const dwell of DWELLS) {
      act(() => {
        vi.advanceTimersByTime(dwell)
      })
      transforms.add(svg.style.transform)
    }

    const seen = [...transforms]
    // Stepped, not static — the die visits many discrete angles across the revolution.
    const distinctRotations = new Set(seen.map((t) => /rotate\([^)]*\)/.exec(t)?.[0]))
    expect(distinctRotations.size).toBeGreaterThanOrEqual(2)
    // The single recoil frame pops the scale exactly once during the walk…
    expect(seen.some((t) => t.includes(`scale(${String(DIE_IMPACT_SCALE)})`))).toBe(true)
    // …then the die snaps to rest: upright, scale restored.
    expect(svg.style.transform).toBe('rotate(360deg) scale(1)')
    // Exactly one completion, at that final rest.
    expect(onSpinComplete).toHaveBeenCalledTimes(1)
  })

  it('fires completion only at the FINAL rest — not on any earlier step', () => {
    vi.useFakeTimers()
    const onSpinComplete = vi.fn()
    render(<DieSpin spinning result={5} reducedMotion={false} onSpinComplete={onSpinComplete} />)
    // Advance every dwell EXCEPT the last (the recoil hold): still mid-flight.
    for (const dwell of DWELLS.slice(0, -1)) {
      act(() => {
        vi.advanceTimersByTime(dwell)
      })
      expect(onSpinComplete).not.toHaveBeenCalled()
    }
    // The recoil hold (the final dwell) elapses → rest → the one and only completion.
    act(() => {
      vi.advanceTimersByTime(DIE_IMPACT_MS)
    })
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
    // No stepped schedule churns afterward — the completion is a one-shot.
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

  it('clears the stepped schedule on unmount (no post-unmount churn)', () => {
    vi.useFakeTimers()
    const clearTimeout = vi.spyOn(window, 'clearTimeout')
    const { unmount } = render(
      <DieSpin spinning result={null} reducedMotion={false} onSpinComplete={vi.fn()} />,
    )
    act(() => {
      vi.advanceTimersByTime(DIE_SPIN_DWELLS[0])
    })
    unmount()
    expect(clearTimeout).toHaveBeenCalled()
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
        resultLabel="you rolled a 20"
      />,
    )
    expect(await axe(landed.container)).toHaveNoViolations()
  })
})
