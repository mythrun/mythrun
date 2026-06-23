import { forwardRef, useEffect, useRef, useState } from 'react'
import type { SpinnerProps } from '@mythrun/client-core/contract'
import { cn } from '../../lib/cn.ts'
import { GRID, GAP, SPEED_MS, buildCells, isOn } from './develop.ts'

// An indeterminate busy indicator rendered as the brand's LOCKED "diagonal dither
// wave": a 12×12 square of HARD binary cells (opacity 0 or 1, never between) —
// currentColor pixels over a TRANSPARENT ground — where a continuous wave flows
// the lit dither up the diagonal on a loop, with two notched corners (top-left +
// bottom-right) cut out (always transparent, like every off-cell).
//
// WHY requestAnimationFrame, not a CSS keyframe: the wave LEVEL is a continuous
// sin() of each cell's DIAGONAL position (see develop.ts `levelAt`), and each
// cell's ON/OFF is a hard threshold against that level. A CSS keyframe can't
// express "level = f(diagonal, time)" per cell, so a rAF loop computes `isOn` per
// cell per frame and writes `style.opacity` directly (no per-frame setState).
//
// REDUCED MOTION: the base.css CSS reset does NOT stop a rAF loop, so we read
// `matchMedia('(prefers-reduced-motion: reduce)')` and, when reduced, never start
// the loop — we paint a STATIC frame at the baseline density (≈40% lit), a legible
// dithered square (notch still cut), never a blank box. We also subscribe to the
// media query so a runtime toggle starts/stops the wave.
//
// COLOR is token-only (R3 / no-ad-hoc-color) AND context-aware: the GROUND is
// transparent (the grid draws no fill, so the off-cells, the notch, and the box
// all show whatever is behind the spinner — not a drawn paper tile). The lit cells
// are `bg-current` (background = currentColor), so the pixel color is driven by the
// grid's text color. `tone` picks that text color:
//   - `accent` (default) → `text-accent` on the grid → the pixels are the brand
//     ember (theme-aware). The standalone look (on a panel/surface).
//   - `inherit` → NO color class → the pixels take the SURROUNDING text color, for
//     use inside a colored control (a Button: paper on the ember primary fill, ink
//     on secondary/ghost) — so an ember-on-ember vanish is impossible.
// HARD opacity (0/1), 0px radius. No raw hex.
//
// a11y: `role="status"` (a polite live region) + an `aria-label` SR name. The
// whole dither grid is `aria-hidden` (pure decoration); the status name carries
// the meaning (motion is never the sole signal). `label` is an i18n key the
// consumer supplies; the default `'Loading'` keeps a bare <Spinner /> from being
// silent to AT.

// Cell size in WHOLE pixels per spinner size. A 12×12 dither renders crisp ONLY
// when the box is an exact multiple of 12, so each cell lands on whole-pixel
// boundaries — otherwise the browser sub-pixel anti-aliases the cells into mush
// (e.g. 16px ÷ 12 = 1.33px cells). So sizes are 12·cellPx: xs/sm/md/lg =
// 1/2/3/4px cells → 12/24/36/48px squares. width === height (the grid is square).
// `xs` is the smallest crisp size — 1px cells → exactly 12px (twelve whole 1px
// cells) — sized for the IN-BUTTON loading slot, where it sits proportionate to a
// 12/14px label rather than towering over it. The wave/notch/reduced-motion/a11y
// behaviour is identical at every cellPx; only the box scales.
const CELL_PX: Record<NonNullable<SpinnerProps['size']>, number> = { xs: 1, sm: 2, md: 3, lg: 4 }

// The static cell geometry (computed once — pure + deterministic; the grain never
// reshuffles across renders). The component renders these in order, so DOM child
// index i ↔ CELLS[i] for the rAF loop.
const CELLS = buildCells()

const REDUCED_MOTION_QUERY = '(prefers-reduced-motion: reduce)'

// Read the current reduced-motion preference (web-only package, so `window` and
// `matchMedia` exist; guarded for any non-window environment).
function prefersReducedMotion(): boolean {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return false
  return window.matchMedia(REDUCED_MOTION_QUERY).matches
}

export const Spinner = forwardRef<HTMLSpanElement, SpinnerProps>(function Spinner(props, ref) {
  const { size = 'md', label = 'Loading', tone = 'accent' } = props
  const gridRef = useRef<HTMLSpanElement>(null)
  // Whether motion is reduced — initialized from the media query, kept in sync.
  const [reduced, setReduced] = useState(prefersReducedMotion)

  // Subscribe to runtime changes of the reduced-motion preference so the wave
  // starts/stops if the user toggles it.
  useEffect(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return
    const mql = window.matchMedia(REDUCED_MOTION_QUERY)
    const onChange = (): void => {
      setReduced(mql.matches)
    }
    mql.addEventListener('change', onChange)
    return () => {
      mql.removeEventListener('change', onChange)
    }
  }, [])

  // The animation loop. When motion is reduced we DON'T start it — the static
  // frame painted at render (and re-asserted below) is the resting state. When
  // motion is allowed, a rAF loop writes each cell's HARD-binary opacity per
  // frame from the wave math; it is cancelled on unmount / when `reduced` flips.
  useEffect(() => {
    const grid = gridRef.current
    if (grid === null) return
    const cellNodes = Array.from(grid.children) as HTMLElement[]

    // Paint the static frame: each cell lit iff its baseline staticLit (the
    // reduced-motion ≈40% dither). This is also the correct resting paint when we
    // are NOT going to animate.
    const paintStatic = (): void => {
      cellNodes.forEach((node, i) => {
        node.style.opacity = CELLS[i]?.staticLit ? '1' : '0'
      })
    }

    if (reduced) {
      paintStatic()
      return
    }

    let raf = 0
    let start: number | null = null
    const tick = (now: number): void => {
      start ??= now
      const T = (now - start) / SPEED_MS
      cellNodes.forEach((node, i) => {
        const c = CELLS[i]
        node.style.opacity = c !== undefined && isOn(c.x, c.y, T) ? '1' : '0'
      })
      raf = window.requestAnimationFrame(tick)
    }
    raf = window.requestAnimationFrame(tick)
    return () => {
      window.cancelAnimationFrame(raf)
    }
  }, [reduced])

  return (
    <span
      ref={ref}
      role="status"
      aria-label={label}
      className="inline-flex"
      data-testid={props['data-testid']}
    >
      {/* The decorative dither grid: a 12×12 currentColor-on-transparent square. The
          role + accessible name above carry the busy meaning, so the texture is
          aria-hidden. `grid` lays the cells out as a GRID × GRID square that fills
          the icon-token footprint; GAP=0 so the dither reads as one field. The
          ground draws NO fill (transparent); `text-accent` (default tone) makes the
          `bg-current` pixels resolve to the brand ember, while `tone="inherit"`
          omits it so the pixels take the surrounding control's text color. */}
      <span
        ref={gridRef}
        aria-hidden="true"
        data-spinner-grid=""
        className={cn('grid', tone === 'accent' && 'text-accent')}
        style={{
          width: `${String(GRID * CELL_PX[size])}px`,
          height: `${String(GRID * CELL_PX[size])}px`,
          gridTemplateColumns: `repeat(${String(GRID)}, ${String(CELL_PX[size])}px)`,
          gridTemplateRows: `repeat(${String(GRID)}, ${String(CELL_PX[size])}px)`,
          gap: `${String(GAP)}px`,
        }}
      >
        {CELLS.map((c) => (
          <span
            key={`${String(c.x)}:${String(c.y)}`}
            data-spinner-cell=""
            data-spinner-notched={c.notched ? 'true' : 'false'}
            className={cn('bg-current')}
            // HARD-binary opacity, driven by the rAF loop (or the static frame
            // under reduced motion). The initial inline value is the static frame
            // so first paint / SSR is the legible ≈40% dither, never blank.
            style={{ opacity: c.staticLit ? 1 : 0 }}
          />
        ))}
      </span>
    </span>
  )
})
