import { describe, expect, it } from 'vitest'
import { LAND_COVERAGE, terrainHeight, terrainLand, terrainLandAt } from './terrain-field.ts'

// The landmass field (ux-run3 myth-rlbku). Run 3: "the tiles are a diagonal spray of
// confetti — no coastline, no landmass silhouette, no sense of place", plus a dead
// lower ~40% of the canvas in every captured frame. Both are properties of a field,
// not of a pixel, so this suite measures the field's SHAPE:
//
//   - COHERENCE: land cells cluster into masses (a confetti field's neighbours are
//     land at roughly the land fraction; a landmass's neighbours are almost all land);
//   - COMPOSITION: land reaches the lower band, so the emptiness there reads as sea
//     rather than as a 16:9 crop;
//   - SEA: real negative space survives — a field that is land everywhere is not a map;
//   - SHORE: a graded waterline exists, so the coast is drawn as grain rather than as
//     a ruled edge;
//   - DETERMINISM: one seed is one world for the life of the session (myth-aftau's
//     terrain half — re-entry must replay the identical ground).

const W = 900
const H = 470
const ASPECT = H / W
const STEP = 6 // CELL_PX — sample the field at the resolution the paint uses

/** Sample the land field over the pane as a boolean land mask at cell resolution. */
function landMask(seed: number): { mask: boolean[][]; cols: number; rows: number } {
  const cols = Math.floor(W / STEP)
  const rows = Math.floor(H / STEP)
  const mask: boolean[][] = []
  for (let r = 0; r < rows; r++) {
    const row: boolean[] = []
    for (let c = 0; c < cols; c++) {
      row.push(terrainLand(((c + 0.5) * STEP) / W, ((r + 0.5) * STEP) / W, seed, ASPECT) > 0)
    }
    mask.push(row)
  }
  return { mask, cols, rows }
}

function landFraction(seed: number): number {
  const { mask, cols, rows } = landMask(seed)
  let land = 0
  for (const row of mask) for (const cell of row) if (cell) land++
  return land / (cols * rows)
}

/** The mean fraction of a land cell's 4-neighbours that are also land. For a coherent
 *  landmass this is close to 1; for a field of independent coin flips at land fraction
 *  p it is p. This single number separates "continent" from "confetti". */
function neighbourCohesion(seed: number): number {
  const { mask, cols, rows } = landMask(seed)
  let samples = 0
  let neighbours = 0
  for (let r = 1; r < rows - 1; r++) {
    for (let c = 1; c < cols - 1; c++) {
      if (mask[r]?.[c] !== true) continue
      samples += 4
      for (const [dr, dc] of [[-1, 0], [1, 0], [0, -1], [0, 1]] as const) {
        if (mask[r + dr]?.[c + dc] === true) neighbours++
      }
    }
  }
  return samples === 0 ? 0 : neighbours / samples
}

const SEEDS = [1, 0x5eed, 0xc0ffee, 424242, 7]

describe('terrain field — landmass coherence (ux-run3 myth-rlbku)', () => {
  it.each(SEEDS)('seed %i: land coheres into masses, not confetti', (seed) => {
    const cohesion = neighbourCohesion(seed)
    const fraction = landFraction(seed)
    // The confetti baseline IS the land fraction. A landmass must beat it decisively;
    // 0.9 means a land cell's neighbours are land nine times in ten — an interior, with
    // the shortfall coming from the coastline.
    expect(cohesion).toBeGreaterThan(0.9)
    expect(cohesion).toBeGreaterThan(fraction * 1.5)
  })

  it.each(SEEDS)('seed %i: land and SEA both hold real area — a map, not a fill', (seed) => {
    const fraction = landFraction(seed)
    expect(fraction).toBeGreaterThan(0.15)
    expect(fraction).toBeLessThan(0.7)
  })

  it.each(SEEDS)('seed %i: the LOWER band carries land — no dead 16:9 crop', (seed) => {
    const { mask, cols, rows } = landMask(seed)
    const from = Math.floor(rows * 0.6)
    let land = 0
    for (let r = from; r < rows; r++) for (let c = 0; c < cols; c++) if (mask[r]?.[c] === true) land++
    expect(land / ((rows - from) * cols)).toBeGreaterThan(0.1)
  })

  it('has a graded SHORE — coverage between bare sea and solid land exists', () => {
    let shore = 0
    for (let r = 0; r < 120; r++) {
      for (let c = 0; c < 200; c++) {
        const v = terrainLand((c * 4.5) / W, (r * 4) / W, 0x5eed, ASPECT)
        if (v > 0 && v < LAND_COVERAGE) shore++
      }
    }
    expect(shore).toBeGreaterThan(0)
  })

  it('is DETERMINISTIC per seed — one world, one coastline (myth-aftau)', () => {
    const a = terrainLandAt(0x5eed, W, H)
    const b = terrainLandAt(0x5eed, W, H)
    for (let i = 0; i < 200; i++) {
      const x = (i * 37) % W
      const y = (i * 53) % H
      expect(a(x, y)).toBe(b(x, y))
    }
  })

  it('different seeds are different worlds', () => {
    const a = terrainLandAt(1, W, H)
    const b = terrainLandAt(2, W, H)
    let differ = 0
    for (let i = 0; i < 400; i++) {
      const x = (i * 37) % W
      const y = (i * 53) % H
      if (a(x, y) !== b(x, y)) differ++
    }
    expect(differ).toBeGreaterThan(80)
  })

  it('samples the noise on SQUARE lattice cells — no horizontal smear on a wide pane', () => {
    // The sampler passes `py / W` (not `py / H`), so a lobe is as tall as it is wide.
    // Walking the same distance in px along each axis must cross comparable amounts of
    // field structure; a stretched lattice would make the vertical walk change far
    // faster than the horizontal one.
    const variation = (dx: number, dy: number): number => {
      let sum = 0
      for (let i = 1; i < 150; i++) {
        const a = terrainHeight((i * dx) / W, (i * dy) / W, 0x5eed, ASPECT)
        const b = terrainHeight(((i - 1) * dx) / W, ((i - 1) * dy) / W, 0x5eed, ASPECT)
        sum += Math.abs(a - b)
      }
      return sum
    }
    const horizontal = variation(3, 0)
    const vertical = variation(0, 3)
    expect(vertical).toBeGreaterThan(horizontal * 0.5)
    expect(vertical).toBeLessThan(horizontal * 2)
  })
})
