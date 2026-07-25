// The STATIC LANDMASS field (ux-run3 myth-rlbku + myth-llqj7). Until run 3 the only
// thing painting the map's ground was the fog: a wind-advected particle sim whose
// dither cells drifted diagonally across the pane. Two run-3 findings land on that
// one fact:
//
//   - COHERENCE (myth-rlbku). "The tiles are a diagonal spray of confetti — no
//     coastline, no landmass silhouette, no sense of place; it signals 'pixels
//     appearing' more than 'a world'." A weather field advects; land does not. And
//     the sim spawns from the wind edges, so the lower ~40% of the canvas sat dead
//     cream in every captured frame.
//   - CONTRAST (myth-llqj7). The stylesheet-computed check said 3.47:1 and the
//     rendered pixels said ~2.5:1, and BOTH were right about different things: 3.47:1
//     is a SOLID painted cell, but only ~24% of the pane's pixels are painted, so the
//     field the eye integrates measured ~1.5:1 median over its own painted region. No
//     ink change can rescue a 20%-coverage dither — the fix has to be COVERAGE, which
//     means the field needs somewhere it is genuinely dense.
//
// One structure answers both: land. This module is a static, seeded, value-noise
// height field with a sea level. Inside a landmass the coverage floor is high enough
// that the dither integrates past the 3:1 non-text floor (pinned by
// terrain-contrast.test.ts, measured off actually-rendered pixels); outside it the
// paper is left alone, so the emptiness reads as sea rather than as an unfinished
// render. The field spans the WHOLE virtual space, so the lower band gets coast too.
//
// It stays the same MATERIAL: the same square cells, the same `--worldgen-terrain`
// ink, the same single alpha, the same Bayer dither deciding which cells fill. Only
// the spatial ORGANISATION changes — islands instead of streaks — and the fog still
// rolls over the top of it and drains away as entities arrive. Land is the world;
// fog is the weather that lifts off it.
//
// Seeded per worldgen run (`mulberry32(terrainSeed)` — the same seed the layout cache
// holds for myth-aftau), so one world has one coastline for the life of the session:
// re-entry replays the identical ground instead of rolling a new continent under the
// same name.

/** Value-noise lattice resolution (cells per axis) at the BASE octave. Low enough that
 *  one lobe spans a good fraction of the pane — landmasses, not gravel. */
const LATTICE = 4

/** Octave count. Three is the usual island recipe: the base sets the continents, the
 *  two detail octaves rough the coastline up so it never reads as a smooth blob. */
const OCTAVES = 3

/** Per-octave lattice multiplier and amplitude. Amplitudes halve, so the base
 *  dominates the silhouette and the detail only perturbs the shore. */
const OCTAVE_LACUNARITY = 2
const OCTAVE_GAIN = 0.5

/** How far the edge falloff pulls the height down at the frame border (0 = none, 1 =
 *  to nothing). Gentle: it biases coastlines inward without shrinking the world to a
 *  blob in the middle of the pane. */
const EDGE_FALLOFF = 0.3

/** The fraction of the pane the landmass should occupy. The sea level is CALIBRATED to
 *  hit it (see `seaLevels`) rather than fixed: with only a handful of lobes across the
 *  pane, a fixed threshold against a raw noise field leaves the realised land fraction
 *  swinging wildly by seed — some worlds all continent, some all ocean. Calibrating
 *  gives every world the same land/sea balance and a different SHAPE, which is the
 *  variation that actually reads. A third leaves the negative space the brand's
 *  register wants and enough mass to read as a continent. */
const TARGET_LAND = 0.34

/** How much of the land is the graded SHORE band rather than solid interior — the
 *  grainy waterline that keeps the coast from ending on a ruled edge. */
const SHORE_SHARE = 0.4

/** Coverage inside solid land — the fraction of cells the Bayer threshold lets
 *  through. This is the number the contrast floor rides on: at this coverage the
 *  painted cells integrate to ~3.5:1 against the light page ground (and higher in
 *  dark), clearing the WCAG 1.4.11 3:1 floor with margin while individual cells stay
 *  the same crisp quads — see terrain-contrast.test.ts, which measures RENDERED pixels
 *  rather than stylesheet values. Deliberately NOT 1: an eighth of the cells left as
 *  paper is the tooth that keeps the ground reading as the brand's dithered material
 *  (and as the same material the calm-wait mark is made of), and keeps it a step
 *  quieter than the near-black markers on top. Below ~0.72 the field slides back under
 *  the floor. */
export const LAND_COVERAGE = 0.78

/** Coverage at the waterline — a thin scatter of cells so the coast grades into the
 *  paper instead of ending on a ruled edge. */
const SHORE_COVERAGE = 0.18

/** One deterministic lattice value in [0, 1) for integer lattice coords, derived from
 *  the seed by integer hashing. A hash (not a stored grid) so the field is infinite,
 *  allocation-free, and identical at every resolution the pane happens to be. */
function latticeValue(ix: number, iy: number, seed: number): number {
  let h = (Math.imul(ix, 0x27d4eb2d) ^ Math.imul(iy, 0x165667b1) ^ seed) >>> 0
  h = Math.imul(h ^ (h >>> 15), h | 1) >>> 0
  h ^= h + Math.imul(h ^ (h >>> 7), h | 61)
  return ((h ^ (h >>> 14)) >>> 0) / 4294967296
}

/** Smoothstep — the C1 interpolant that keeps the lattice from showing as diamonds. */
function smooth(t: number): number {
  return t * t * (3 - 2 * t)
}

/** Bilinear-interpolated value noise at (u, v) ∈ [0,1]² on a `cells`-per-axis lattice. */
function valueNoise(u: number, v: number, cells: number, seed: number): number {
  const x = u * cells
  const y = v * cells
  const ix = Math.floor(x)
  const iy = Math.floor(y)
  const fx = smooth(x - ix)
  const fy = smooth(y - iy)
  const v00 = latticeValue(ix, iy, seed)
  const v10 = latticeValue(ix + 1, iy, seed)
  const v01 = latticeValue(ix, iy + 1, seed)
  const v11 = latticeValue(ix + 1, iy + 1, seed)
  const top = v00 + (v10 - v00) * fx
  const bottom = v01 + (v11 - v01) * fx
  return top + (bottom - top) * fy
}

/** The normalised terrain HEIGHT at (u, v) — fractal value noise, then an EDGE falloff
 *  so landmasses tend to sit in the frame with water around them (an island, not a
 *  crop of an infinite continent). `u` is 0..1 across the pane; `v` runs 0..`aspect`
 *  (height/width) so the lattice cells stay SQUARE in pixel space — sampling both axes
 *  over 0..1 on a 900×470 pane stretched every lobe into a horizontal smear. Exported
 *  for the coherence test; the paint consumes `terrainLand` below. */
export function terrainHeight(u: number, v: number, seed: number, aspect: number): number {
  let amplitude = 1
  let sum = 0
  let norm = 0
  let cells = LATTICE
  for (let o = 0; o < OCTAVES; o++) {
    sum += amplitude * valueNoise(u, v, cells, seed + o * 0x9e3779b9)
    norm += amplitude
    amplitude *= OCTAVE_GAIN
    cells *= OCTAVE_LACUNARITY
  }
  // Edge falloff, measured per axis in the pane's OWN normalised coords so it eases
  // evenly on a wide pane: full height through the middle, dropping toward the frame
  // edge. Gentle (`EDGE_FALLOFF`) — enough to keep a coastline off the border most of
  // the time, not so much that the world shrinks to a blob in the middle.
  const edge = Math.max(Math.abs(u - 0.5) * 2, Math.abs(v / aspect - 0.5) * 2)
  return (sum / norm) * (1 - EDGE_FALLOFF * smooth(Math.min(1, edge)))
}

/** Samples per axis for the sea-level calibration — 40×40 ≈ 1600 height evaluations,
 *  a sub-millisecond one-off per (seed, aspect) that is then memoised. Fine enough
 *  that the realised land fraction lands within a couple of points of the target. */
const CALIBRATION_SAMPLES = 40

/** The calibrated `{ sea, shore }` height thresholds for a seed + pane aspect: the
 *  quantiles of the field's own height distribution that leave `TARGET_LAND` of the
 *  pane above water, with the top `SHORE_SHARE` of that band graded. Memoised — the
 *  field is static per world, so this runs once and every repaint reads the cache. */
const seaLevelCache = new Map<string, { sea: number; shore: number }>()

function seaLevels(seed: number, aspect: number): { sea: number; shore: number } {
  const key = `${String(seed)}|${aspect.toFixed(4)}`
  const cached = seaLevelCache.get(key)
  if (cached !== undefined) return cached
  const heights: number[] = []
  for (let r = 0; r < CALIBRATION_SAMPLES; r++) {
    for (let c = 0; c < CALIBRATION_SAMPLES; c++) {
      const u = (c + 0.5) / CALIBRATION_SAMPLES
      const v = ((r + 0.5) / CALIBRATION_SAMPLES) * aspect
      heights.push(terrainHeight(u, v, seed, aspect))
    }
  }
  heights.sort((a, b) => a - b)
  const at = (fromTop: number): number =>
    heights[Math.min(heights.length - 1, Math.max(0, Math.floor((1 - fromTop) * heights.length)))] ?? 0
  const levels = { sea: at(TARGET_LAND), shore: at(TARGET_LAND * (1 - SHORE_SHARE)) }
  seaLevelCache.set(key, levels)
  return levels
}

/** The land COVERAGE at (u, v): 0 at sea, ramping through the shore band to
 *  `LAND_COVERAGE` inland. This is a coverage, not an alpha — the paint feeds it to
 *  the SAME Bayer threshold every fog cell goes through, so land is drawn in the same
 *  1-bit material as the weather over it, never a soft wash. */
export function terrainLand(u: number, v: number, seed: number, aspect: number): number {
  const { sea, shore } = seaLevels(seed, aspect)
  const height = terrainHeight(u, v, seed, aspect)
  if (height <= sea) return 0
  if (height >= shore) return LAND_COVERAGE
  const t = (height - sea) / Math.max(1e-6, shore - sea)
  return SHORE_COVERAGE + (LAND_COVERAGE - SHORE_COVERAGE) * smooth(t)
}

/** Bind a seed + the virtual-space dims into the per-cell-centre sampler `paintFog`
 *  calls: virtual px in, land coverage out. Built once per repaint (the closure is
 *  the only allocation, and the sea-level calibration is memoised), so the paint loop
 *  stays a pure arithmetic walk. */
export function terrainLandAt(
  seed: number,
  width: number,
  height: number,
): (px: number, py: number) => number {
  const w = Math.max(1, width)
  const h = Math.max(1, height)
  const aspect = h / w
  return (px, py) => terrainLand(px / w, py / w, seed, aspect)
}
