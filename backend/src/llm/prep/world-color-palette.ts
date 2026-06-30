// The backend mirror of the curated world-cover palette + a WCAG luminance/
// contrast table over it. The world-gen colour stage uses this to contrast-
// guard the (from, to) WorldColor pair an LLM proposes for a world's dither
// cover — rejecting illegible, near-equiluminant pairs.
//
// The hexes are HAND-AUTHORED: the backend can't import the frontend palette
// (@mythrun/client-core pulls in react; the @mythrun/ui token manifest is a
// build asset). A drift-guard test (world-color-palette.test.ts) reads both
// frontend sources and asserts every member here still matches, so the copy
// can't silently rot.
import type { WorldColor } from '@mythrun/contract'

/**
 * Every curated `WorldColor` → its hex, sourced from the frontend design tokens:
 *
 *   - the 12 pigments mirror `AVATAR_COLORS` in @mythrun/client-core
 *     `tokens/scales.ts`;
 *   - the 8 ramp steps mirror the `--color-*` entries in @mythrun/ui
 *     `styles/tokens.manifest.json`.
 *
 * Typed `Record<WorldColor, string>` so adding a `WorldColor` member without a
 * hex here is a compile error. Case is authored verbatim from each source (the
 * drift guard compares case-insensitively).
 */
export const WORLD_COLOR_HEX: Record<WorldColor, string> = {
  // 12 avatar pigments — scales.ts AVATAR_COLORS
  ember: '#8A5A3C',
  sienna: '#A05A45',
  ochre: '#82682E',
  moss: '#62703C',
  pine: '#41714D',
  verdigris: '#3D6B60',
  lapis: '#46647E',
  iris: '#5E5A86',
  heather: '#6E4C62',
  rose: '#9E4F64',
  umber: '#5A4636',
  slate: '#586470',
  // 8 paper/ember ramp steps — tokens.manifest.json
  'paper-50': '#F8F4EA',
  'paper-100': '#EFE9DC',
  'paper-200': '#E1D9C6',
  'paper-900': '#231B12',
  'ember-100': '#e2c5a7',
  'ember-200': '#cca178',
  'ember-700': '#5e3a25',
  'ember-900': '#311d12',
}

/** sRGB 8-bit channel → linear-light (the WCAG 0.03928/12.92 piecewise + 2.4 gamma). */
function srgbToLinear(channel: number): number {
  const c = channel / 255
  return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4)
}

/**
 * WCAG 2.x relative luminance of an `#RRGGBB` hex: sRGB → linear, then the
 * Rec.709 weights. Byte-for-byte equal to culori's at these inputs (the formula
 * is copied verbatim from @mythrun/ui `semantic-contrast.test.ts`).
 */
export function relativeLuminance(hex: string): number {
  const m = hex.replace('#', '')
  const r = parseInt(m.slice(0, 2), 16)
  const g = parseInt(m.slice(2, 4), 16)
  const b = parseInt(m.slice(4, 6), 16)
  return 0.2126 * srgbToLinear(r) + 0.7152 * srgbToLinear(g) + 0.0722 * srgbToLinear(b)
}

/** WCAG contrast ratio `(L_light + 0.05) / (L_dark + 0.05)` between two curated colours. */
export function contrastRatio(a: WorldColor, b: WorldColor): number {
  const la = relativeLuminance(WORLD_COLOR_HEX[a])
  const lb = relativeLuminance(WORLD_COLOR_HEX[b])
  const lighter = Math.max(la, lb)
  const darker = Math.min(la, lb)
  return (lighter + 0.05) / (darker + 0.05)
}

/**
 * The minimum contrast a world-cover (from, to) pair must clear for the two
 * dither ends to read as visually distinct. Set empirically: the curated
 * pigments all cluster in mid-low luminance (every one is ≥4.5:1 on the light
 * paper-50 ground by design), so the lightest-pigment ↔ darkest-pigment pair
 * tops out at ~1.7:1 — while every pale-paper ↔ pigment pair clears ~3.8:1. 3.0
 * (the WCAG 2.x non-text / graphical-object minimum — the register for "two
 * decorative fills must read as different") sits cleanly in that gap: it rejects
 * every equiluminant pigment pair (the review's sienna↔ochre case, ~1.0:1) and
 * accepts every paper↔pigment cover.
 */
export const CONTRAST_FLOOR = 3
