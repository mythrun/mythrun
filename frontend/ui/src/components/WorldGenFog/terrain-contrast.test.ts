import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { CELL_PX, FOG_PARAMS, WIND_BASE } from '@mythrun/client-core/worldgen'
import { paintFog, type FogPaintTarget } from './fog-draw.ts'
import { TERRAIN_ALPHA } from './terrain-ink.ts'
import { LAND_COVERAGE, terrainLand, terrainLandAt } from './terrain-field.ts'

// The RENDERED-PIXEL terrain-contrast check (ux-run3 myth-llqj7; supersedes the run-2
// stylesheet-computed version).
//
// Run 2 shipped a check that composited `--worldgen-terrain` over `--bg` in arithmetic
// and asserted 3.47:1. Run 3's screen measurements came back at ~2.5:1 for mid-tone
// tiles and ~1.9:1 for the palest, and BOTH numbers were right about different units:
// the computed one measured a SOLID painted quad, but the terrain is a DITHER — the
// eye (and a screenshot) integrates painted cells together with the paper between
// them, and at the run-2 field's ~24% coverage that integral sat near 1.5:1. A test
// that reasons about stylesheet values can never see that gap, because the gap only
// exists in pixels.
//
// So this test RENDERS. It runs the real `paintFog` into an RGBA buffer with Canvas-2D
// `source-over` semantics, over the real page ground, with the real terrain field —
// then samples the result. The ink and the ground still come from the shipped
// stylesheets (a palette change must still fail here), but every ratio below is
// measured off pixels that `paintFog` actually put down, so "computed" and "real" are
// now the same number by construction.
//
// What it pins:
//   - a SOLID cell clears 3:1 (the WCAG 1.4.11 unit — one graphical object);
//   - the FIELD over solid land clears 3:1 as an area integral (the run-3 defect);
//   - markers stay DOMINANT over the ground in both themes (the praised hierarchy:
//     near-black ■/◆ pop, quiet ground).

const STYLES = join(dirname(fileURLToPath(import.meta.url)), '../../styles')
const SEMANTIC = readFileSync(join(STYLES, 'semantic.css'), 'utf8')
const PALETTE = readFileSync(join(STYLES, 'colors.generated.css'), 'utf8')

/** The palette hex for a `--color-*` var name. */
function paletteHex(colorVar: string): string {
  const m = new RegExp(`${colorVar}:\\s*(#[0-9a-fA-F]{6})`).exec(PALETTE)
  if (m?.[1] === undefined) throw new Error(`palette var not found: ${colorVar}`)
  return m[1]
}

/** Resolve a semantic token (e.g. `--worldgen-terrain`) inside one theme block of
 *  semantic.css to its palette hex. `block` narrows the search to the text after the
 *  block's opening selector. */
function semanticHex(blockStart: string, token: string): string {
  const start = SEMANTIC.indexOf(blockStart)
  if (start < 0) throw new Error(`theme block not found: ${blockStart}`)
  const scope = SEMANTIC.slice(start)
  const m = new RegExp(`${token}:\\s*var\\((--color-[a-z0-9-]+)\\)`).exec(scope)
  if (m?.[1] === undefined) throw new Error(`token not found in ${blockStart}: ${token}`)
  return paletteHex(m[1])
}

type Rgb = readonly [number, number, number]

function hexToRgb(hex: string): Rgb {
  return [
    parseInt(hex.slice(1, 3), 16),
    parseInt(hex.slice(3, 5), 16),
    parseInt(hex.slice(5, 7), 16),
  ]
}

/** WCAG relative luminance. */
function luminance([r, g, b]: Rgb): number {
  const lin = (c: number): number => {
    const s = c / 255
    return s <= 0.04045 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4)
  }
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b)
}

function contrast(a: Rgb, b: Rgb): number {
  const [l1, l2] = [luminance(a), luminance(b)].sort((x, y) => y - x)
  if (l1 === undefined || l2 === undefined) throw new Error('bad luminance')
  return (l1 + 0.05) / (l2 + 0.05)
}

/** An RGBA raster that implements the exact `FogPaintTarget` surface `paintFog` writes
 *  through, compositing each `fillRect` the way Canvas 2D `source-over` does: the live
 *  `globalAlpha` blended over what is already there, in gamma (sRGB) space, on integer
 *  cell bounds (so there is no antialiasing to model — the paint only ever draws
 *  axis-aligned `CELL_PX` quads at integer multiples of `CELL_PX`). Pre-filled with the
 *  page ground, which is what a real canvas sits on. */
function raster(width: number, height: number, bg: Rgb, ink: Rgb) {
  const px = new Float64Array(width * height * 3)
  for (let i = 0; i < width * height; i++) {
    for (let c = 0; c < 3; c++) px[i * 3 + c] = bg[c] ?? 0
  }
  let alpha = 1
  const target: FogPaintTarget = {
    get globalAlpha() {
      return alpha
    },
    set globalAlpha(v: number) {
      alpha = v
    },
    fillStyle: '',
    fillRect(x, y, w, h) {
      for (let yy = y; yy < y + h; yy++) {
        for (let xx = x; xx < x + w; xx++) {
          if (xx < 0 || yy < 0 || xx >= width || yy >= height) continue
          const i = (yy * width + xx) * 3
          for (let c = 0; c < 3; c++) {
            px[i + c] = alpha * (ink[c] ?? 0) + (1 - alpha) * (px[i + c] ?? 0)
          }
        }
      }
    },
  }
  const at = (x: number, y: number): Rgb => {
    const i = (y * width + x) * 3
    return [px[i] ?? 0, px[i + 1] ?? 0, px[i + 2] ?? 0]
  }
  /** The AREA-INTEGRATED tone of a rectangle — what the eye reads at arm's length and
   *  what a screenshot sample of a region reports. */
  const mean = (x0: number, y0: number, w: number, h: number): Rgb => {
    const sum = [0, 0, 0]
    for (let y = y0; y < y0 + h; y++) {
      for (let x = x0; x < x0 + w; x++) {
        const i = (y * width + x) * 3
        for (let c = 0; c < 3; c++) sum[c] = (sum[c] ?? 0) + (px[i + c] ?? 0)
      }
    }
    const n = w * h
    return [(sum[0] ?? 0) / n, (sum[1] ?? 0) / n, (sum[2] ?? 0) / n]
  }
  return { target, at, mean }
}

/** The pane the measurement renders — the reference virtual space, the size the fog's
 *  look was tuned at. */
const W = 900
const H = 470
const SEED = 0x5eed

/** A DRAINED density grid: the state the terrain must carry alone (the fog has blown
 *  off, the world is placed). Land is the only thing painting here, which is exactly
 *  the case run 3 measured. */
function drainedDensity(gw: number, gh: number): Float32Array {
  return new Float32Array(gw * gh)
}

/** Render the ground for one theme and return the samplers. */
function renderTheme(blockStart: string) {
  const bg = hexToRgb(semanticHex(blockStart, '--bg'))
  const ink = hexToRgb(semanticHex(blockStart, '--worldgen-terrain'))
  const marker = hexToRgb(semanticHex(blockStart, '--ink'))
  const gw = Math.ceil(W / CELL_PX)
  const gh = Math.ceil(H / CELL_PX)
  const { target, at, mean } = raster(W, H, bg, ink)
  paintFog(target, drainedDensity(gw, gh), gw, gh, {
    wx: WIND_BASE[0] * FOG_PARAMS.wind,
    wy: WIND_BASE[1] * FOG_PARAMS.wind,
    t: 0,
    density: FOG_PARAMS.density,
    // The theme's own `--worldgen-terrain`, parsed out of the shipped stylesheet —
    // the same string the fog hook resolves at runtime. (The raster binds the ink at
    // construction, so this rides through as the record of what was painted.)
    fogColor: semanticHex(blockStart, '--worldgen-terrain'),
    fogAlpha: TERRAIN_ALPHA,
    land: terrainLandAt(SEED, W, H),
  })
  return { bg, ink, marker, at, mean }
}

/** Every `size`×`size` block whose whole footprint is INTERIOR land (the land field at
 *  its coverage plateau). Coastal blocks are deliberately excluded: a shoreline is a
 *  boundary between two materials, not a material with a contrast floor of its own. */
function interiorBlocks(size: number): { x: number; y: number }[] {
  const out: { x: number; y: number }[] = []
  const aspect = H / W
  const solid = (x: number, y: number): boolean => terrainLand(x / W, y / W, SEED, aspect) >= LAND_COVERAGE
  for (let y = 0; y + size <= H; y += size) {
    for (let x = 0; x + size <= W; x += size) {
      if (solid(x, y) && solid(x + size - 1, y) && solid(x, y + size - 1) && solid(x + size - 1, y + size - 1)) {
        out.push({ x, y })
      }
    }
  }
  return out
}

/** The block edge (px) the field is integrated over — ~4 dither cells across, the
 *  scale at which a viewer reads "ground", not "one square". */
const BLOCK = CELL_PX * 4

const LIGHT_BLOCK = ':root,'
const DARK_BLOCK = '.dark,'
const THEMES: readonly [string, string][] = [
  ['light', LIGHT_BLOCK],
  ['dark', DARK_BLOCK],
]

describe('world-gen terrain contrast — measured off RENDERED pixels (ux-run3 myth-llqj7)', () => {
  it.each(THEMES)('%s: a SOLID painted cell clears the 3:1 non-text floor', (_name, block) => {
    const { bg, at } = renderTheme(block)
    const blocks = interiorBlocks(BLOCK)
    expect(blocks.length).toBeGreaterThan(0)
    // A painted pixel inside interior land: scan the first solid block for one that
    // differs from the ground (the dither leaves ~a fifth of the cells as paper).
    const home = blocks[0]
    if (home === undefined) throw new Error('no interior land')
    let solid: Rgb | undefined
    for (let y = home.y; y < home.y + BLOCK && solid === undefined; y++) {
      for (let x = home.x; x < home.x + BLOCK; x++) {
        const p = at(x, y)
        if (p[0] !== bg[0] || p[1] !== bg[1] || p[2] !== bg[2]) {
          solid = p
          break
        }
      }
    }
    expect(solid).toBeDefined()
    expect(contrast(solid ?? bg, bg)).toBeGreaterThanOrEqual(3)
  })

  it.each(THEMES)(
    '%s: the FIELD over solid land clears 3:1 as an area integral — the run-3 defect',
    (_name, block) => {
      const { bg, mean } = renderTheme(block)
      const blocks = interiorBlocks(BLOCK)
      expect(blocks.length).toBeGreaterThan(20) // enough land to be a landmass
      const ratios = blocks.map(({ x, y }) => contrast(mean(x, y, BLOCK, BLOCK), bg))
      // EVERY interior block, not the median: run 3's complaint was that the field
      // "fades to nothing at the edges", so the weakest patch is the one under test.
      expect(Math.min(...ratios)).toBeGreaterThanOrEqual(3)
    },
  )

  it.each(THEMES)('%s: markers stay DOMINANT over the integrated ground', (_name, block) => {
    const { bg, marker, mean } = renderTheme(block)
    const blocks = interiorBlocks(BLOCK)
    const ratios = blocks.map(({ x, y }) => contrast(mean(x, y, BLOCK, BLOCK), bg))
    // The heaviest ground the field ever reaches must still sit clearly under the
    // near-black marker ink — the ground is quiet, the markers pop.
    expect(contrast(marker, bg)).toBeGreaterThan(Math.max(...ratios) * 1.5)
  })
})
