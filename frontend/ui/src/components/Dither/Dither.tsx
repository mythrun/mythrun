import { forwardRef, useId } from 'react'
import type { DitherProps } from '@mythrun/client-core/contract'
import { BAND_CELLS, CELL_PX, CROSS_CELLS, buildBand } from './bayer.ts'

// Dither — the brand's ONLY sanctioned gradient, and a pure TRANSITION device. NEVER a
// smooth CSS/SVG gradient: a stepped two-color crossfade rendered as a 4×4 ordered Bayer
// dither, per the LOCKED brand formula. Source:
//   ../../Design/mythrun-design/brand/guidelines.md → "The dither formula (locked)"
//     + "Footer. The canonical use."
// Reference pin: Return of the Obra Dinn. The math lives in `bayer.ts` (pure + unit-tested,
// UNCHANGED); this component paints the cell grid into an SVG `<pattern>`.
//
// CROPPED TO THE BAND. The brand uses the dither ONLY as the transition strip between two
// solid sections — the canonical case is the page→footer break: cream content above, this
// band, the dark reversed footer below. So the component renders ONLY the 20 dithered cells
// (where the grain actually is); the solid ground/accent blocks the math frames it with are
// NOT drawn — those solids are the adjacent sections' own colour. Nothing ever layers on the
// band (no children); content lives in the sections above/below, never on the texture (brand:
// "the lockup sits ABOVE the band, not inside it").
//
// SQUARE PIXELS AT ANY SIZE: inline SVG with NO viewBox (1 user unit = 1 CSS px, no internal
// scaling) holding a `<pattern patternUnits="userSpaceOnUse">` tiled at the natural cell-pixel
// size. The transition axis is the fixed band length; the CROSS axis tiles to fill the host,
// so a wider host gets MORE identical-width columns, never wider cells.
//
// Color is TOKEN-driven (R3 / no-ad-hoc-color): `from`/`to` are PALETTE TOKEN NAMES
// (the closed `PaletteColor` set) mapped to `var(--color-{name})` refs (never raw
// hex). `from` is the GROUND the band emerges from; `to` is the ACCENT it resolves
// into. The SVG is INLINE in the host document, so those vars resolve against the
// page's token layer. a11y: the band is decoration → `aria-hidden`.

export const Dither = forwardRef<HTMLDivElement, DitherProps>(function Dither(
  { from = 'paper-100', to = 'ember-600', direction = 'vertical', scale = 'preview', flip = false, 'data-testid': dataTestId },
  ref,
) {
  // Palette token names → CSS var references (the only sanctioned way to name color
  // here). `var(--color-{name})` resolves against the page token layer at render.
  const ground = `var(--color-${from})`
  const accent = `var(--color-${to})`
  const cellPx = CELL_PX[scale]
  const cells = buildBand(CROSS_CELLS)
  // A per-instance pattern id so multiple Dithers on one page don't collide on the
  // SVG `<pattern>` reference (the id is document-global within the SVG namespace).
  const patternId = `dither-${useId()}`

  // For vertical the crossfade runs down (block); horizontal transposes the axes.
  const vertical = direction === 'vertical'

  // CROPPED extent: the transition axis carries ONLY the 20 dithered cells (no solid
  // frames); the cross axis is the repeat period (one tile, then tiling to fill).
  const transitionPx = BAND_CELLS * cellPx
  const crossPx = CROSS_CELLS * cellPx
  const tileWidthPx = vertical ? crossPx : transitionPx
  const tileHeightPx = vertical ? transitionPx : crossPx

  return (
    <div
      ref={ref}
      {...(dataTestId !== undefined ? { 'data-testid': dataTestId } : {})}
      data-dither-direction={direction}
      data-cell-px={cellPx}
      // The transition axis is FIXED to the band length (a fixed-size crossfade strip);
      // the cross axis fills the host and TILES, with an intrinsic minimum (one tile) so
      // the band is visible standalone.
      style={
        vertical
          ? { blockSize: `${String(transitionPx)}px`, inlineSize: '100%', minInlineSize: `${String(crossPx)}px` }
          : { inlineSize: `${String(transitionPx)}px`, blockSize: '100%', minBlockSize: `${String(crossPx)}px` }
      }
      className="relative block overflow-hidden"
    >
      {/* No viewBox → 1 user unit = 1 CSS px, no internal scaling: the pattern tiles at
          its NATURAL pixel size and the cells stay perfectly square at any host size.
          `crispEdges` kills anti-aliasing on the cells. Decorative → aria-hidden. */}
      <svg
        data-dither-texture
        aria-hidden="true"
        className="absolute inset-0 h-full w-full"
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
            {/* GROUND fills the tile; the accent dither cells paint over it — the start
                of the band is mostly ground (sparse accent), the end mostly accent. NO
                solid frame block: the framing solids are the adjacent sections' colour. */}
            <rect x={0} y={0} width={tileWidthPx} height={tileHeightPx} fill={ground} />
            {/* The 20-cell dithered band — every accent cell painted individually as a
                cellPx square. `cell.y` is the transition step (0…BAND_CELLS-1, no frame
                offset), `cell.x` the cross position; horizontal transposes the two axes. */}
            {cells
              .filter((c) => c.accent)
              .map((c) => {
                // `flip` reverses the transition step so the band runs accent→ground
                // along the axis (the genesis CROWN: dense at the top edge, fading
                // DOWN). Mirroring the row index of each accent cell flips the whole
                // ground→accent ramp without touching the (unit-tested) Bayer math.
                const step = flip ? BAND_CELLS - 1 - c.y : c.y
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
        {/* The band fills the field: the transition axis is the tile's natural band
            length; the CROSS axis is 100% so the pattern tiles to fill. No solid
            backdrop — the component IS the band, nothing more. */}
        <rect
          x={0}
          y={0}
          width={vertical ? '100%' : tileWidthPx}
          height={vertical ? tileHeightPx : '100%'}
          fill={`url(#${patternId})`}
        />
      </svg>
    </div>
  )
})
