import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { TERRAIN_ALPHA } from './terrain-ink.ts'

// The MEASURED terrain-contrast check (ux-run2 myth-y7yki). The live-map's
// terrain field is the fog paint: `--worldgen-terrain` quads at TERRAIN_ALPHA
// composited over the page ground. Run 1 and run 2 both flagged the field as
// near-invisible (~1.2–1.4:1 measured off screenshots); the WCAG 1.4.11 floor
// for meaningful graphics is 3:1. This test computes the ACTUAL blended tile
// from the REAL token values (parsed out of the stylesheets, so a palette or
// alpha change can't silently regress it) and asserts the floor in BOTH themes
// — while the marker/label ink stays dominant above the terrain.

const STYLES = join(dirname(fileURLToPath(import.meta.url)), '../../styles')
const SEMANTIC = readFileSync(join(STYLES, 'semantic.css'), 'utf8')
const PALETTE = readFileSync(join(STYLES, 'colors.generated.css'), 'utf8')

/** The palette hex for a `--color-*` var name. */
function paletteHex(colorVar: string): string {
  const m = new RegExp(`${colorVar}:\\s*(#[0-9a-fA-F]{6})`).exec(PALETTE)
  if (m?.[1] === undefined) throw new Error(`palette var not found: ${colorVar}`)
  return m[1]
}

/** Resolve a semantic token (e.g. `--worldgen-terrain`) inside one theme block
 *  of semantic.css to its palette hex. `block` narrows the search to the text
 *  after the block's opening selector. */
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

/** Canvas source-over compositing happens in gamma (sRGB) space. */
function blend(fg: Rgb, bg: Rgb, alpha: number): Rgb {
  return [0, 1, 2].map((i) => {
    const f = fg[i]
    const b = bg[i]
    if (f === undefined || b === undefined) throw new Error('bad channel')
    return alpha * f + (1 - alpha) * b
  }) as unknown as Rgb
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

/** One theme's measured ratios: the blended terrain tile and the marker ink,
 *  both against that theme's page ground. */
function measure(blockStart: string): { tile: number; marker: number } {
  const bg = hexToRgb(semanticHex(blockStart, '--bg'))
  const terrain = hexToRgb(semanticHex(blockStart, '--worldgen-terrain'))
  const ink = hexToRgb(semanticHex(blockStart, '--ink'))
  return {
    tile: contrast(blend(terrain, bg, TERRAIN_ALPHA), bg),
    marker: contrast(ink, bg),
  }
}

const LIGHT_BLOCK = ':root,'
const DARK_BLOCK = '.dark,'

describe('world-gen terrain contrast (ux-run2 myth-y7yki)', () => {
  it('the LIGHT terrain tile clears the 3:1 non-text floor against the page ground', () => {
    expect(measure(LIGHT_BLOCK).tile).toBeGreaterThanOrEqual(3)
  })

  it('the DARK terrain tile clears the 3:1 non-text floor against the page ground', () => {
    expect(measure(DARK_BLOCK).tile).toBeGreaterThanOrEqual(3)
  })

  it('markers stay DOMINANT — the full ink out-contrasts the terrain field in both themes', () => {
    for (const block of [LIGHT_BLOCK, DARK_BLOCK]) {
      const { tile, marker } = measure(block)
      expect(marker).toBeGreaterThan(tile)
    }
  })
})
