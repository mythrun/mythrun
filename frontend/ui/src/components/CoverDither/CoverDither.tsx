import { forwardRef } from 'react'
import type { CSSProperties } from 'react'
import type { CoverDitherProps } from '@mythrun/client-core/contract'
import { reInkPair, worldColorCssVar, worldColorStep, type WorldColor } from '@mythrun/contract/rest'
import { cn } from '../../lib/cn.ts'
import { buildField } from '../Dither/bayer.ts'

// CoverDither — the card-scale dither COVER that carries a world's two-colour
// identity (the genesis / home-hub cover art). It is NOT a `Dither`: `Dither` is a
// fixed-geometry transition STRIP (the brand's page→footer band — 20 dithered cells
// framed by two solid adjacent sections). CoverDither is a FULL-FIELD Bayer gradient
// that fills its host edge-to-edge — a true top→bottom sweep between the two
// world-colours, the whole cover art of a campaign card. The locked Bayer math
// (`bayer.ts`, pure + unit-tested) is REUSED unchanged; only the field geometry
// differs (`buildField`, a full grid, vs `buildBand`, a fixed strip).
//
// RENDERED AS SVG (not canvas) so the cover is THEME-RESPONSIVE via CSS with zero
// re-render: the Bayer PATTERN — which cell is ground vs accent — is fixed, and the
// two colour VALUES ride custom properties the `.dark` selector flips. A
// `viewBox`/`preserveAspectRatio="none"` grid stretches the fixed COLS×ROWS field to
// fill the host in both axes (the gradient must span exactly top→bottom, so the field
// stretches — it cannot tile); `crispEdges` keeps the grain chunky.
//
// COLOUR is a `from`/`to` pair, each a `WorldColor` (`{ramp}-{step}` token, R3, never
// raw hex). The ends are ordered by ladder STEP, not argument order: the lower step is
// the sparse GROUND (top), the higher step the dense ACCENT (bottom). `worldColorCssVar`
// resolves each to its uniform `var(--color-{ramp}-{step})`. a11y: the cover is pure
// decoration → `aria-hidden`; nothing composes on it (no children).

/** The still-generating placeholder pair — a muted `paper` ground→accent shown when a
 *  world has no colour pick yet (`from`/`to` absent). Run through the SAME
 *  ground/accent/re-ink pipeline as a real pair, so it darkens coherently in dark mode
 *  instead of glaring bright on the dark card. */
const GHOST_FROM: WorldColor = 'paper-100'
const GHOST_TO: WorldColor = 'paper-200'

/** Intrinsic shape per `size`. `band` is the wide card-cover banner: it fills its host
 *  WIDTH and stands up its own 5:3 cover-band height (the card is built around it).
 *  `swatch` is a SELF-SIZED fixed square (a `--space-8` / 48px tile, `shrink-0` so it
 *  holds its size as a flex-row thumbnail) — the leading world-identity chip in a
 *  compact list row, where the host can't set a width. */
const SIZE_CLASS = {
  band: 'w-full aspect-[5/3]',
  swatch: 'w-[var(--space-8)] shrink-0 aspect-square',
} as const

/** Full-field grid per size: `cols`×`rows` ≈ the size's aspect so the square-drawn
 *  cells render ~square at the natural size, and the count sets the GRAIN (host px ÷
 *  cells). The band is a ~230px card cover (≈5px cells); the swatch a 48px square
 *  (≈4px cells) — each kept coarse enough that the dither reads AS grain, not noise. */
const GRID = {
  band: { cols: 45, rows: 27 },
  swatch: { cols: 12, rows: 12 },
} as const

/** The four raw colour values a cover rides — the light pair and the re-inked dark
 *  pair — as inline custom properties. A `.dark`-scoped class picks which pair
 *  `--cover-ground` / `--cover-accent` resolve to, so the theme flips with no JS. */
type CoverVars = CSSProperties & Record<`--cover-${string}`, string>

export const CoverDither = forwardRef<HTMLDivElement, CoverDitherProps>(function CoverDither(
  { from, to, size = 'band', bordered = false, 'data-testid': dataTestId },
  ref,
) {
  // No colour pick yet → the muted paper ghost (both ends absent by contract).
  const isGhost = from === undefined || to === undefined
  const rawFrom = from ?? GHOST_FROM
  const rawTo = to ?? GHOST_TO

  // Order by ladder step: the lower step is the light GROUND (top, sparse), the higher
  // step the deep ACCENT (bottom, dense) — the direction the field sweeps. Independent
  // of the from/to argument order.
  const groundColor = worldColorStep(rawFrom) <= worldColorStep(rawTo) ? rawFrom : rawTo
  const accentColor = groundColor === rawFrom ? rawTo : rawFrom

  // Dark mode re-inks the SAME pattern: ground → its hue's smouldering -400, accent →
  // near-black -900 (hues preserved). reInkPair keys off step, so passing {ground,
  // accent} (ground ≤ accent) yields {darkGround, darkAccent} in the same positions.
  const darkPair = reInkPair({ from: groundColor, to: accentColor })

  // The light + dark colour values as custom properties; the `.dark`-scoped classes
  // below select which pair `--cover-ground` / `--cover-accent` point at.
  const style: CoverVars = {
    '--cover-ground-lt': worldColorCssVar(groundColor),
    '--cover-accent-lt': worldColorCssVar(accentColor),
    '--cover-ground-dk': worldColorCssVar(darkPair.from),
    '--cover-accent-dk': worldColorCssVar(darkPair.to),
  }

  const { cols, rows } = GRID[size]
  // Only the accent cells are drawn (the ground is one background rect beneath them),
  // halving the rect count. The pattern is fixed; the two fills flip with the theme.
  const accentCells = buildField(cols, rows).filter((c) => c.accent)

  return (
    <div
      ref={ref}
      {...(dataTestId !== undefined ? { 'data-testid': dataTestId } : {})}
      data-cover-size={size}
      {...(isGhost ? { 'data-cover-ghost': 'true' } : {})}
      style={style}
      className={cn(
        'relative block overflow-hidden',
        SIZE_CLASS[size],
        // Standalone covers (the mobile swatch) take a slightly-thick theme-adaptive
        // edge so a pale/low-contrast pair stays a distinct tile against the page.
        bordered && 'border-2 border-border-strong',
        // Light pair by default; the `.dark` scope re-inks to the dark pair. The
        // pattern never changes — only these two values do.
        '[--cover-ground:var(--cover-ground-lt)] [--cover-accent:var(--cover-accent-lt)]',
        'dark:[--cover-ground:var(--cover-ground-dk)] dark:[--cover-accent:var(--cover-accent-dk)]',
      )}
    >
      {/* No square-pixel viewBox here (unlike Dither's tiling pattern): the gradient
          must span exactly top→bottom, so the fixed COLS×ROWS field STRETCHES to fill
          via preserveAspectRatio="none". `crispEdges` keeps the cells hard-edged.
          Decorative → aria-hidden. */}
      <svg
        data-cover-texture
        aria-hidden="true"
        className="absolute inset-0 h-full w-full"
        viewBox={`0 0 ${String(cols)} ${String(rows)}`}
        preserveAspectRatio="none"
        shapeRendering="crispEdges"
      >
        {/* GROUND fills the whole field; the accent cells paint over it — sparse at the
            top, dense at the bottom (the two-colour dither sweep). Fill via CSS (not the
            `fill` attribute) so the custom-property value resolves and flips with theme. */}
        <rect
          data-cover-ground
          x={0}
          y={0}
          width={cols}
          height={rows}
          className="[fill:var(--cover-ground)]"
        />
        <g data-cover-accent className="[fill:var(--cover-accent)]">
          {accentCells.map((c) => (
            <rect key={`${String(c.x)}:${String(c.y)}`} x={c.x} y={c.y} width={1} height={1} />
          ))}
        </g>
      </svg>
    </div>
  )
})
