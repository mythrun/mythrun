import { forwardRef, useId } from 'react'
import type { CoverDitherProps } from '@mythrun/client-core/contract'
import { worldColorCssVar, type WorldColor } from '@mythrun/contract/rest'
import { cn } from '../../lib/cn.ts'
import { BAND_CELLS, CELL_PX, CROSS_CELLS, buildBand } from '../Dither/bayer.ts'

// CoverDither — the card-scale dither COVER that carries a world's two-colour identity
// (the genesis / home-hub cover art). It is NOT a `Dither`: `Dither` is a fixed-geometry
// transition STRIP (the brand's page→footer band — 20 dithered cells, cropped, framed by
// two solid adjacent sections, no children). CoverDither is a FULL-FIELD texture that
// fills its host edge-to-edge and TILES the locked 4×4-Bayer two-colour dither — the
// "tiled wall" of a campaign cover — sized to the card-band aspect or the mobile square.
// The locked Bayer math (`bayer.ts`, pure + unit-tested) is REUSED unchanged.
//
// FILLS THE HOST IN BOTH AXES. Where `Dither` pins its transition axis to the band's own
// length (a 160px strip) and only tiles the CROSS axis, CoverDither's fill rect is
// 100% × 100%, so the dither tiles to fill the whole cover in both directions — the
// transition axis fills the host too. The SVG has NO viewBox (1 user unit = 1 CSS px, no
// internal scaling) and a `<pattern patternUnits="userSpaceOnUse">` at the natural
// cell-pixel size, so the grain stays PERFECTLY SQUARE at any host size (`crispEdges`
// kills anti-aliasing); a wider/taller host gets MORE identical cells, never stretched ones.
//
// COLOUR is `from`→`to`, each a `WorldColor` (the curated cover set — R3, never raw hex).
// The set spans TWO css-var namespaces — the 12 avatar pigments (`--color-avatar-{name}`)
// and selected paper/ember ramp steps (`--color-{name}`). `worldColorCssVar` (the single
// place that convention is encoded) resolves the namespace; we wrap its var NAME in
// `var(...)`. `from` is the ground the dither emerges from; `to` the accent it resolves
// into. a11y: the cover is pure decoration → `aria-hidden`; nothing composes on it (no
// children).
//
// GRAIN: the cover uses the `preview` (8px) cell — a card cover / mobile swatch is a SMALL
// surface, so the chunkier 8px grain stays visible AS grain rather than reading as noise.
// The from→to ramp + cell math live in `bayer.ts`; this component is the cover's geometry.

/** Wrap the css-var NAME `worldColorCssVar` returns (e.g. `--color-avatar-sienna`) into a
 *  `var(...)` reference. Pigments resolve to the avatar namespace, ramp steps to the base
 *  palette namespace — the helper owns that switch so we never hand-roll it. */
function worldColorToVar(name: WorldColor): string {
  return `var(${worldColorCssVar(name)})`
}

/** Intrinsic shape per `size`: the wide card-cover banner vs the mobile square crop. Both
 *  fill their host WIDTH; the band derives a short height from a wide aspect, the swatch a
 *  square. The dither tiles to fill whatever box results. */
const SIZE_CLASS = {
  band: 'aspect-[16/5]',
  swatch: 'aspect-square',
} as const

// The cover grain: the chunkier `preview` cell so the dither stays visible at card scale.
const COVER_CELL_PX = CELL_PX.preview
// One tile = a full from→to dither ramp (the locked band), tiled to fill the cover.
const TILE_WIDTH_PX = CROSS_CELLS * COVER_CELL_PX
const TILE_HEIGHT_PX = BAND_CELLS * COVER_CELL_PX

export const CoverDither = forwardRef<HTMLDivElement, CoverDitherProps>(function CoverDither(
  { from, to, size = 'band', 'data-testid': dataTestId },
  ref,
) {
  // Curated cover colours → `var(--color*)` refs (pigment vs ramp namespace via the helper).
  const ground = worldColorToVar(from)
  const accent = worldColorToVar(to)
  // The from→to dither cell grid (locked Bayer math, reused unchanged): a tile of the ramp.
  const cells = buildBand(CROSS_CELLS)
  // A per-instance pattern id so the MANY covers on the dashboard wall don't collide on the
  // SVG `<pattern>` reference (the id is document-global within the SVG namespace).
  const patternId = `cover-dither-${useId()}`

  return (
    <div
      ref={ref}
      {...(dataTestId !== undefined ? { 'data-testid': dataTestId } : {})}
      data-cover-size={size}
      className={cn('relative block w-full overflow-hidden', SIZE_CLASS[size])}
    >
      {/* No viewBox → 1 user unit = 1 CSS px, no internal scaling: the pattern tiles at its
          NATURAL pixel size and the cells stay perfectly square at any host size.
          `crispEdges` kills anti-aliasing on the cells. Decorative → aria-hidden. */}
      <svg
        data-cover-texture
        aria-hidden="true"
        className="absolute inset-0 h-full w-full"
        shapeRendering="crispEdges"
      >
        <defs>
          <pattern
            id={patternId}
            data-cover-pattern
            patternUnits="userSpaceOnUse"
            width={TILE_WIDTH_PX}
            height={TILE_HEIGHT_PX}
          >
            {/* GROUND fills the tile; the accent dither cells paint over it — sparse accent
                at the ramp's start, dense at its end (the brand's two-colour dither). */}
            <rect x={0} y={0} width={TILE_WIDTH_PX} height={TILE_HEIGHT_PX} fill={ground} />
            {cells
              .filter((c) => c.accent)
              .map((c) => (
                <rect
                  key={`${String(c.x)}:${String(c.y)}`}
                  x={c.x * COVER_CELL_PX}
                  y={c.y * COVER_CELL_PX}
                  width={COVER_CELL_PX}
                  height={COVER_CELL_PX}
                  fill={accent}
                />
              ))}
          </pattern>
        </defs>
        {/* Fills the field in BOTH axes (the cover IS the whole texture): the pattern tiles
            to fill, so the dither runs edge-to-edge — the transition axis fills the host too. */}
        <rect data-cover-fill x={0} y={0} width="100%" height="100%" fill={`url(#${patternId})`} />
      </svg>
    </div>
  )
})
