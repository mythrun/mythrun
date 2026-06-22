import { forwardRef } from 'react'
import type { SpinnerProps } from '@mythrun/client-core/contract'
import { cn } from '../../lib/cn.ts'
import { buildDevelopCells, SPINNER_GRID } from './develop.ts'
import './Spinner.css'

// An indeterminate busy indicator rendered as the brand's SIGNATURE "dither
// develop": a small square whose 4×4 Bayer dither (paper → ember) FILLS and
// RECEDES on a slow opacity loop — like ink developing on the page. Per the
// brand's motion rule (spec §4 — "only opacity/fades animate, nothing
// spins/slides/bounces") this is OPACITY-ONLY: each cell pulses opacity 0 → 1 →
// 0 (the `dither-develop` keyframe in Spinner.css) and a per-cell
// `animation-delay` keyed to the cell's Bayer THRESHOLD (low threshold first,
// computed in develop.ts) phases the cells so the lit pattern sweeps up and
// recedes in threshold order. Calm and patient (~3.7s/cycle), never a rotation.
//
// REDUCED MOTION: the global `prefers-reduced-motion` reset in `base.css` freezes
// CSS animations. So Spinner.css explicitly paints a LEGIBLE STATIC ~50% dither
// when motion is reduced — the cells flagged `data-spinner-lit` hold full
// opacity, the rest stay transparent — so the square is NEVER a blank box.
//
// COLOR is token-only (R3 / no-ad-hoc-color): the lit cells are the `accent`
// (ember) token (`bg-accent`, theme-aware ember in both themes) over the `surface`
// paper ground (`bg-surface`). No raw hex anywhere.
//
// a11y: `role="status"` (a polite live region) + an `aria-label` SR name. The
// whole dither grid is `aria-hidden` (pure decoration); the status name carries
// the meaning (motion is never the sole signal). `label` is an i18n key the
// consumer supplies; the default `'Loading'` keeps a bare <Spinner /> from being
// silent to AT.

// Per-size square dimensions, sized to the icon token scale (full literal token
// classes so Tailwind v4's source scanner generates them — same technique as
// `space.ts`). The grid is square, so width === height per size.
const GRID_SIZE_CLASS: Record<NonNullable<SpinnerProps['size']>, string> = {
  sm: 'w-[var(--icon-sm)] h-[var(--icon-sm)]',
  md: 'w-[var(--icon-md)] h-[var(--icon-md)]',
  lg: 'w-[var(--icon-lg)] h-[var(--icon-lg)]',
}

// The develop animation utility — the first-class `animate-dither-develop` theme
// utility (defined in theme.css's @theme: the `dither-develop` opacity keyframe,
// a calm 3.7s/cycle that MIRRORS develop.ts's DEVELOP_DURATION_MS, gentle in-out
// ease, looping). A STATIC literal class — an interpolated `animate-[…]` is not
// extractable by Tailwind's source scanner and would silently never emit.
const DEVELOP_ANIMATION_CLASS = 'animate-dither-develop'

// The static grid (computed once — pure + deterministic; the grain never
// reshuffles across renders).
const CELLS = buildDevelopCells()

export const Spinner = forwardRef<HTMLSpanElement, SpinnerProps>(function Spinner(props, ref) {
  const { size = 'md', label = 'Loading' } = props
  return (
    <span
      ref={ref}
      role="status"
      aria-label={label}
      className="inline-flex"
      data-testid={props['data-testid']}
    >
      {/* The decorative dither grid: an ember-on-surface square of cells. The
          role + accessible name above carry the busy meaning, so the texture is
          aria-hidden. `grid` lays the cells out as a SPINNER_GRID × SPINNER_GRID
          square that fills the icon-token footprint. */}
      <span
        aria-hidden="true"
        data-spinner-grid=""
        className={cn('grid bg-surface', GRID_SIZE_CLASS[size])}
        style={{ gridTemplateColumns: `repeat(${String(SPINNER_GRID)}, 1fr)` }}
      >
        {CELLS.map((c) => (
          <span
            key={`${String(c.x)}:${String(c.y)}`}
            data-spinner-cell=""
            data-spinner-lit={c.staticLit ? 'true' : 'false'}
            className={cn('bg-accent', DEVELOP_ANIMATION_CLASS)}
            // Per-cell develop delay = the Bayer-threshold order (numeric, not a
            // color → R3-clean). The cell's resting opacity (0) lives in
            // Spinner.css so the reduced-motion rule can reveal the static-lit
            // subset without an inline-specificity fight.
            style={{ animationDelay: `${String(c.delayMs)}ms` }}
          />
        ))}
      </span>
    </span>
  )
})
