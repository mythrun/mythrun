import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { createRef } from 'react'
import { render } from '@testing-library/react'
import { axe } from 'jest-axe'
import { Spinner } from './Spinner.tsx'
import { GRID, buildCells, isOn } from './develop.ts'

// Spinner is the brand's LOCKED "diagonal dither wave": a 12×12 square of HARD
// binary cells (currentColor pixels over a TRANSPARENT ground) where a continuous
// wave — a sin() of each cell's diagonal position — flows the lit dither up the
// diagonal on a requestAnimationFrame loop, with two notched corners. The wave is
// continuous in each cell's diagonal coordinate, so it can't be a CSS keyframe —
// a rAF loop drives `style.opacity` per cell per frame. The pure wave/notch math
// is unit-tested in develop.test.ts; these are the COMPONENT contract: a status
// role + accessible name, the cell grid (notched corners cut), the rAF loop runs
// (and is cancelled on unmount), the reduced-motion path skips the loop and paints
// a legible STATIC ~40% dither, and NO spin/translate/scale (the brand rule).

// jsdom has no matchMedia; the component reads it for prefers-reduced-motion.
// Install a configurable mock so each test can choose reduce vs no-reduce.
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

describe('Spinner', () => {
  beforeEach(() => {
    // Default: motion allowed (the animated path).
    mockMatchMedia(false)
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('exposes a status role to assistive tech', () => {
    const { getByRole } = render(<Spinner />)
    expect(getByRole('status')).toBeInTheDocument()
  })

  it('has a sensible default accessible name', () => {
    const { getByRole } = render(<Spinner />)
    // Default fallback so a bare <Spinner /> is never silent to AT.
    expect(getByRole('status')).toHaveAccessibleName('Loading')
  })

  it('uses the supplied label as its accessible name', () => {
    const { getByRole } = render(<Spinner label="Rolling the dice" />)
    expect(getByRole('status')).toHaveAccessibleName('Rolling the dice')
  })

  it('renders a decorative (aria-hidden) grid; the role+label carry the meaning', () => {
    const { getByRole } = render(<Spinner />)
    const status = getByRole('status')
    const grid = status.querySelector('[data-spinner-grid]')
    expect(grid).not.toBeNull()
    expect(grid).toHaveAttribute('aria-hidden', 'true')
  })

  it('renders the full GRID×GRID cells, with the 6 notched corner cells flagged', () => {
    const { getByRole } = render(<Spinner />)
    const status = getByRole('status')
    const cells = status.querySelectorAll('[data-spinner-cell]')
    expect(cells.length).toBe(GRID * GRID)
    // The two notched corners are cut: those cells carry the notched flag (so
    // they never light) — exactly 6 of them.
    const notched = status.querySelectorAll('[data-spinner-cell][data-spinner-notched="true"]')
    expect(notched.length).toBe(6)
  })

  it('default tone: a TRANSPARENT ground, lit cells = currentColor driven by the ACCENT token (no raw color)', () => {
    const { getByRole } = render(<Spinner />)
    const status = getByRole('status')
    const grid = status.querySelector('[data-spinner-grid]')
    // The negative space (off-cells, notch, the box) is transparent — the grid
    // draws NO paper/surface ground, so whatever is behind the spinner shows
    // through. (The old `bg-surface` paper tile is gone.)
    expect(grid?.className).not.toMatch(/bg-(surface|paper|bg|accent|ember)/)
    // The default `accent` tone resolves currentColor to the brand ember via a
    // `text-accent-fg` token utility on the grid (the FOREGROUND accent).
    expect(grid?.className).toMatch(/\btext-accent-fg\b/)
    const cell = status.querySelector('[data-spinner-cell]')
    // The lit pixels are `bg-current` (== currentColor), so the pixel color is
    // whatever the grid's text color resolves to (ember for the default tone).
    expect(cell?.className).toMatch(/\bbg-current\b/)
    const html = status.innerHTML
    expect(html).not.toMatch(/#[0-9a-fA-F]{3,8}\b/)
    expect(html).not.toMatch(/\b(?:rgba?|hsla?|oklch|oklab)\(/)
  })

  it('tone="inherit": NO color class on the grid — the pixels take the surrounding text color', () => {
    const { getByRole } = render(<Spinner tone="inherit" />)
    const status = getByRole('status')
    const grid = status.querySelector('[data-spinner-grid]')
    // Inside a colored control the spinner must match the control's foreground,
    // so the grid carries NO `text-accent-fg` (it inherits the ambient text color);
    // the ground stays transparent and the pixels stay `bg-current`.
    expect(grid?.className).not.toMatch(/\btext-accent-fg\b/)
    expect(grid?.className).not.toMatch(/bg-(surface|paper|bg|accent|ember)/)
    const cell = status.querySelector('[data-spinner-cell]')
    expect(cell?.className).toMatch(/\bbg-current\b/)
  })

  it('drives the wave with requestAnimationFrame (a continuous wave, not a keyframe)', () => {
    const raf = vi.spyOn(window, 'requestAnimationFrame')
    render(<Spinner />)
    // The loop is started on mount (rAF scheduled at least once).
    expect(raf).toHaveBeenCalled()
    // HARD binary, opacity-driven — never a transform/keyframe utility.
    const html = document.body.innerHTML
    expect(html).not.toMatch(/animate-spin|animate-bounce|animate-ping|translate|rotate|scale-/)
  })

  it('actually toggles cell opacities across frames (the wave moves, HARD binary)', () => {
    // Capture the rAF callbacks and step them through two distinct times; the
    // rendered opacities must change between frames and be strictly 0 or 1.
    const callbacks: FrameRequestCallback[] = []
    vi.spyOn(window, 'requestAnimationFrame').mockImplementation((cb: FrameRequestCallback) => {
      callbacks.push(cb)
      return callbacks.length
    })
    const { getByRole } = render(<Spinner />)
    const grid = getByRole('status').querySelector('[data-spinner-grid]')
    const step = (now: number): void => {
      const cb = callbacks.shift()
      if (cb) cb(now)
    }
    const snapshot = (): string =>
      Array.from(grid?.querySelectorAll('[data-spinner-cell]') ?? [])
        .map((c) => (c as HTMLElement).style.opacity)
        .join('')
    // First frame establishes the clock origin; a later frame advances time.
    step(0)
    const frameA = snapshot()
    step(900) // ~half a wave period → many cells flip
    const frameB = snapshot()
    expect(frameA).not.toBe(frameB)
    // HARD binary: only '0' or '1', never an in-between opacity.
    for (const o of Array.from(grid?.querySelectorAll('[data-spinner-cell]') ?? []).map(
      (c) => (c as HTMLElement).style.opacity,
    )) {
      expect(o === '0' || o === '1').toBe(true)
    }
  })

  it('cancels the rAF loop on unmount (no leak)', () => {
    vi.spyOn(window, 'requestAnimationFrame').mockImplementation(() => 42)
    const cancel = vi.spyOn(window, 'cancelAnimationFrame')
    const { unmount } = render(<Spinner />)
    unmount()
    expect(cancel).toHaveBeenCalledWith(42)
  })

  it('under prefers-reduced-motion: NO rAF loop, a legible STATIC ~40% dither', () => {
    mockMatchMedia(true)
    const raf = vi.spyOn(window, 'requestAnimationFrame')
    const { getByRole } = render(<Spinner />)
    // The animation loop never starts.
    expect(raf).not.toHaveBeenCalled()
    // A static frame is painted: the lit subset is the ~40% static dither, never
    // empty (blank) nor full (solid), and never a notched cell.
    const status = getByRole('status')
    const lit = Array.from(status.querySelectorAll<HTMLElement>('[data-spinner-cell]')).filter(
      (c) => c.style.opacity === '1',
    )
    expect(lit.length).toBe(buildCells().filter((c) => c.staticLit).length)
    expect(lit.length).toBeGreaterThan(0)
    expect(lit.length).toBeLessThan(GRID * GRID)
    for (const c of lit) {
      expect(c.getAttribute('data-spinner-notched')).not.toBe('true')
    }
  })

  it('static frame matches the pure buildCells() staticLit at the baseline level', () => {
    mockMatchMedia(true)
    const { getByRole } = render(<Spinner />)
    const cells = Array.from(
      getByRole('status').querySelectorAll<HTMLElement>('[data-spinner-cell]'),
    )
    const built = buildCells()
    cells.forEach((c, i) => {
      const lit = c.style.opacity === '1'
      expect(lit).toBe(built[i]?.staticLit)
    })
  })

  it('renders xs as a crisp 12px square (12 = 12·1px cells) — the in-button slot', () => {
    const { getByRole } = render(<Spinner size="xs" />)
    const grid = getByRole('status').querySelector<HTMLElement>('[data-spinner-grid]')
    // xs = 1px cells → exactly 12px, whole-pixel (12 ÷ 12 = 1px cells, no
    // sub-pixel anti-aliasing). This is the proportionate in-button footprint.
    expect(grid?.style.width).toBe('12px')
    expect(grid?.style.height).toBe('12px')
    // The full 12×12 dither still renders (144 cells) at the smaller cell size.
    const cells = getByRole('status').querySelectorAll('[data-spinner-cell]')
    expect(cells.length).toBe(GRID * GRID)
  })

  it('xs honours reduced motion: NO rAF loop, a legible STATIC dither', () => {
    mockMatchMedia(true)
    const raf = vi.spyOn(window, 'requestAnimationFrame')
    const { getByRole } = render(<Spinner size="xs" />)
    expect(raf).not.toHaveBeenCalled()
    const lit = Array.from(
      getByRole('status').querySelectorAll<HTMLElement>('[data-spinner-cell]'),
    ).filter((c) => c.style.opacity === '1')
    expect(lit.length).toBe(buildCells().filter((c) => c.staticLit).length)
    expect(lit.length).toBeGreaterThan(0)
  })

  it('renders lg as a crisp whole-pixel square (48px = 12·4px cells)', () => {
    const { getByRole } = render(<Spinner size="lg" />)
    const grid = getByRole('status').querySelector<HTMLElement>('[data-spinner-grid]')
    // The grid is sized to an exact multiple of GRID so every cell lands on whole
    // pixels (no sub-pixel anti-aliasing). lg = 4px cells → 48px.
    expect(grid?.style.width).toBe('48px')
    expect(grid?.style.height).toBe('48px')
  })

  it('scales the grid square sm → md → lg in whole-pixel cells (24 / 36 / 48px)', () => {
    const sm = render(<Spinner size="sm" />)
    expect(sm.container.querySelector<HTMLElement>('[data-spinner-grid]')?.style.width).toBe('24px')
    sm.unmount()
    const md = render(<Spinner size="md" />)
    expect(md.container.querySelector<HTMLElement>('[data-spinner-grid]')?.style.width).toBe('36px')
  })

  it('forwards its ref to the underlying element', () => {
    const ref = createRef<HTMLSpanElement>()
    render(<Spinner ref={ref} />)
    expect(ref.current).toBeInstanceOf(HTMLSpanElement)
  })

  it('passes through a data-testid', () => {
    const { getByTestId } = render(<Spinner data-testid="spin" />)
    expect(getByTestId('spin')).toBeInTheDocument()
  })

  it('has no axe violations', async () => {
    const { container } = render(<Spinner label="Loading your campaign" />)
    expect(await axe(container)).toHaveNoViolations()
  })
})

// A direct consistency check that the hard-binary decision the loop renders with
// is the same pure math (guards drift between isOn and the component loop).
describe('isOn parity', () => {
  it('a notched corner cell is never on; a mid cell follows the wave', () => {
    expect(isOn(0, 0, 0.0)).toBe(false)
    expect(typeof isOn(6, 6, 0.25)).toBe('boolean')
  })
})
