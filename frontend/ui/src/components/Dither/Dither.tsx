import { forwardRef } from 'react'
import type { DitherProps, DitherPairing } from '@mythrun/client-core/contract'
import { cn } from '../../lib/cn.ts'
import { BAND_CELLS, CELL_PX, buildBand } from './bayer.ts'

// Dither — the brand's ONLY sanctioned gradient. NEVER a smooth CSS/SVG gradient:
// a stepped two-color transition rendered as a 4×4 ordered Bayer dither, exactly
// per the LOCKED brand formula. Source:
//   ../../Design/mythrun-design/brand/guidelines.md → "The dither formula (locked)"
//   ../../Design/mythrun-design/brand/decisions.md  → "Why dithering …"
// Reference pin: Return of the Obra Dinn. The math lives in `bayer.ts` (pure +
// unit-tested); this component paints the cell grid as SVG <rect>s and frames the
// band with the two solid color blocks.
//
// Color is TOKEN-driven (R3 / no-ad-hoc-color): the sanctioned `pairing` maps to
// two `var(--color-…)` token references — never a raw hex. Only the three brand
// pairings exist (ground is always a paper step; ember-ground + semantic colors
// are forbidden, so they're not expressible).
//
// a11y: the texture layer is decorative → `aria-hidden`. Any `children` render
// OVER it (a higher stacking context) and stay in the a11y tree — the brand uses
// the dither behind a wordmark / CTA on splash, footer, error screens.

// Sanctioned token pairings (ground → accent). `var(--color-…)` references, so
// both no-ad-hoc-color (TSX) and stylelint (if this were CSS) pass — the color is
// DEFINED in the token layer, consumed here as a var.
const PAIRINGS: Record<DitherPairing, { ground: string; accent: string }> = {
  'light-ember': { ground: 'var(--color-paper-100)', accent: 'var(--color-ember-600)' },
  'light-ink': { ground: 'var(--color-paper-100)', accent: 'var(--color-paper-900)' },
  'dark-cream': { ground: 'var(--color-paper-900)', accent: 'var(--color-paper-100)' },
}

// Cross-axis cell count for the SVG grid. The SVG stretches to fill the container
// (`preserveAspectRatio="none"`), so this is the texture's intrinsic resolution
// across the band — enough cells to read as grain, not a single column.
const CROSS_CELLS = 24
// Solid framing blocks: a few cells of pure ground before the band and pure
// accent after it (the brand frames the 20-cell band with two solid blocks).
const FRAME_CELLS = 4

export const Dither = forwardRef<HTMLDivElement, DitherProps>(function Dither(
  { pairing = 'light-ember', direction = 'vertical', scale = 'preview', children, 'data-testid': dataTestId },
  ref,
) {
  const { ground, accent } = PAIRINGS[pairing]
  const cellPx = CELL_PX[scale]
  const cells = buildBand(CROSS_CELLS)

  // Transition-axis length in cells: ground frame + dithered band + accent frame.
  const axisCells = FRAME_CELLS + BAND_CELLS + FRAME_CELLS
  // For vertical the transition runs down (y); for horizontal it runs across (x).
  const vertical = direction === 'vertical'
  const widthCells = vertical ? CROSS_CELLS : axisCells
  const heightCells = vertical ? axisCells : CROSS_CELLS

  // Intrinsic minimum size (px) = the cell grid at 1:1. The `absolute` SVG layer
  // gives the root no height of its own, so this is what makes the texture render
  // standalone (no `children`). A sized host can still stretch the band past it.
  const minInlinePx = `${String(widthCells * cellPx)}px`
  const minBlockPx = `${String(heightCells * cellPx)}px`

  return (
    <div
      ref={ref}
      {...(dataTestId !== undefined ? { 'data-testid': dataTestId } : {})}
      data-dither-direction={direction}
      data-cell-px={cellPx}
      // Fill the host container (so a sized wrapper drives the texture), but carry
      // a real intrinsic minimum so the band is VISIBLE standalone: the SVG layer
      // is `absolute` and contributes NO height, so without this the root would
      // collapse to 0px whenever there are no in-flow `children`. The min size is
      // the band's own cell extent — exactly enough to read the full ground→accent
      // transition at 1:1 — and the host can always grow past it.
      style={{ minBlockSize: minBlockPx, minInlineSize: minInlinePx }}
      className="relative isolate block h-full w-full overflow-hidden"
    >
      <svg
        data-dither-texture
        aria-hidden="true"
        className="absolute inset-0 -z-10 h-full w-full"
        viewBox={`0 0 ${String(widthCells * cellPx)} ${String(heightCells * cellPx)}`}
        preserveAspectRatio="none"
        shapeRendering="crispEdges"
      >
        {/* Solid ground fills the whole field; the accent frame + dither cells
            paint over it, so the result is ground→accent with NO interpolation. */}
        <rect x={0} y={0} width="100%" height="100%" fill={ground} />
        {/* The solid ACCENT framing block at the far end of the transition axis. */}
        <rect
          fill={accent}
          x={vertical ? 0 : (FRAME_CELLS + BAND_CELLS) * cellPx}
          y={vertical ? (FRAME_CELLS + BAND_CELLS) * cellPx : 0}
          width={vertical ? widthCells * cellPx : FRAME_CELLS * cellPx}
          height={vertical ? FRAME_CELLS * cellPx : heightCells * cellPx}
        />
        {/* The 20-cell dithered band — every accent cell painted individually. The
            band sits after the ground frame on the transition axis; `cell.y` is
            the step (0..BAND_CELLS), `cell.x` the cross position. Horizontal
            transposes the two axes. */}
        {cells
          .filter((c) => c.accent)
          .map((c) => {
            const step = FRAME_CELLS + c.y // band offset past the ground frame
            const col = c.x
            const px = vertical ? col : step
            const py = vertical ? step : col
            return (
              <rect
                key={`${String(c.x)}:${String(c.y)}`}
                x={px * cellPx}
                y={py * cellPx}
                width={cellPx}
                height={cellPx}
                fill={accent}
              />
            )
          })}
      </svg>
      {/* Content layers OVER the texture (the default stacking context > -z-10). */}
      {children !== undefined ? <div className={cn('relative')}>{children}</div> : null}
    </div>
  )
})
