import { forwardRef, useId } from 'react'
import type { DitherProps, DitherPairing } from '@mythrun/client-core/contract'
import { cn } from '../../lib/cn.ts'
import { AXIS_CELLS, BAND_CELLS, CELL_PX, CROSS_CELLS, FRAME_CELLS, buildBand } from './bayer.ts'

// Dither — the brand's ONLY sanctioned gradient. NEVER a smooth CSS/SVG gradient:
// a stepped two-color transition rendered as a 4×4 ordered Bayer dither, exactly
// per the LOCKED brand formula. Source:
//   ../../Design/mythrun-design/brand/guidelines.md → "The dither formula (locked)"
//   ../../Design/mythrun-design/brand/decisions.md  → "Why dithering …"
// Reference pin: Return of the Obra Dinn. The math lives in `bayer.ts` (pure +
// unit-tested); this component paints the cell grid into an SVG `<pattern>`.
//
// SQUARE PIXELS AT ANY SIZE (the headline contract). The texture is an inline SVG
// with **no viewBox** — so 1 user unit = 1 CSS pixel, with NO internal scaling —
// holding a `<pattern patternUnits="userSpaceOnUse">` whose tile is the band at
// its NATURAL cell-pixel size. The pattern TILES (repeats) to fill a larger host;
// it is never stretched. So the cells stay perfectly square whatever the container
// dimensions: a wider box gets MORE identical-width columns (the repeat runs on
// the axis PERPENDICULAR to the dither), never wider cells. This replaces the old
// `viewBox` + `preserveAspectRatio="none"` SVG, which stretched the square cells
// into rectangles (warping) whenever the host outgrew the fixed viewBox.
//
// Color is TOKEN-driven (R3 / no-ad-hoc-color): the sanctioned `pairing` maps to
// two `var(--color-…)` token references — never a raw hex. Because the SVG is
// INLINE in the host document (not a data-URI background-image), those `var(--…)`
// refs resolve against the page's token layer — a data-URI SVG would be an
// isolated document and could NOT see the host custom properties. Only the three
// brand pairings exist (ground is always a paper step; ember-ground + semantic
// colors are forbidden, so they're not expressible).
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

export const Dither = forwardRef<HTMLDivElement, DitherProps>(function Dither(
  { pairing = 'light-ember', direction = 'vertical', scale = 'preview', children, 'data-testid': dataTestId },
  ref,
) {
  const { ground, accent } = PAIRINGS[pairing]
  const cellPx = CELL_PX[scale]
  const cells = buildBand(CROSS_CELLS)
  // A per-instance pattern id so multiple Dithers on one page don't collide on the
  // SVG `<pattern>` reference (the id is document-global within the SVG namespace).
  const patternId = `dither-${useId()}`

  // For vertical the transition runs down (block); horizontal transposes the axes.
  const vertical = direction === 'vertical'

  // ONE tile's natural pixel extent. The transition axis carries the full band
  // (ground frame + dither + accent frame); the cross axis is the repeat period.
  const tileTransitionPx = AXIS_CELLS * cellPx
  const tileCrossPx = CROSS_CELLS * cellPx
  const tileWidthPx = vertical ? tileCrossPx : tileTransitionPx
  const tileHeightPx = vertical ? tileTransitionPx : tileCrossPx

  // Intrinsic minimum size (px) = one tile at 1:1. The `absolute` SVG layer gives
  // the root no height of its own, so this is what makes the texture render
  // standalone (no `children`). A sized host can still grow past it — the texture
  // then TILES to fill (square cells hold), never stretches.
  const minInlinePx = `${String(tileWidthPx)}px`
  const minBlockPx = `${String(tileHeightPx)}px`

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
      // one tile's own cell extent — exactly enough to read the full ground→accent
      // transition at 1:1 — and the host can always grow past it (the tile repeats).
      style={{ minBlockSize: minBlockPx, minInlineSize: minInlinePx }}
      className="relative isolate block h-full w-full overflow-hidden"
    >
      {/* No viewBox → 1 user unit = 1 CSS px, no internal scaling: the pattern
          tiles at its NATURAL pixel size and the cells stay perfectly square at
          any container size. `crispEdges` kills anti-aliasing on the cells. */}
      <svg
        data-dither-texture
        aria-hidden="true"
        className="absolute inset-0 -z-10 h-full w-full"
        shapeRendering="crispEdges"
      >
        <defs>
          <pattern
            id={patternId}
            data-dither-pattern
            patternUnits="userSpaceOnUse"
            width={tileWidthPx}
            height={tileHeightPx}
          >
            {/* Solid GROUND fills the tile; the accent frame + dither cells paint
                over it, so the result is ground→accent with NO interpolation. */}
            <rect x={0} y={0} width={tileWidthPx} height={tileHeightPx} fill={ground} />
            {/* The solid ACCENT framing block at the far end of the transition axis. */}
            <rect
              fill={accent}
              x={vertical ? 0 : (FRAME_CELLS + BAND_CELLS) * cellPx}
              y={vertical ? (FRAME_CELLS + BAND_CELLS) * cellPx : 0}
              width={vertical ? tileWidthPx : FRAME_CELLS * cellPx}
              height={vertical ? FRAME_CELLS * cellPx : tileHeightPx}
            />
            {/* The 20-cell dithered band — every accent cell painted individually as
                a cellPx square. `cell.y` is the transition step, `cell.x` the cross
                position; horizontal transposes the two axes. */}
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
          </pattern>
        </defs>
        {/* Solid ACCENT backdrop fills the whole field — past the band's natural
            extent (a host taller/wider than one tile) it is what shows (the
            transition has already resolved to full accent). */}
        <rect x={0} y={0} width="100%" height="100%" fill={accent} />
        {/* The band, anchored at the START of the transition axis at its NATURAL
            length, tiling on the PERPENDICULAR (cross) axis to fill: a 100% extent
            on the cross axis repeats the pattern; the transition axis is pinned to
            the tile's natural length so the band never stretches. */}
        <rect
          x={0}
          y={0}
          width={vertical ? '100%' : tileWidthPx}
          height={vertical ? tileHeightPx : '100%'}
          fill={`url(#${patternId})`}
        />
      </svg>
      {/* Content layers OVER the texture (the default stacking context > -z-10). */}
      {children !== undefined ? <div className={cn('relative')}>{children}</div> : null}
    </div>
  )
})
