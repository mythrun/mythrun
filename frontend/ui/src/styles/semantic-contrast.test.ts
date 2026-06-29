import { describe, it, expect } from 'vitest'
import { generatePalette } from '@mythrun/client-core/tokens'

// WCAG 2.x contrast, computed inline from the generated hex. The palette
// generator and semantic.css cite their ratios "measured with culori's
// wcagContrast" — but culori is a dep of @mythrun/client-core, NOT of
// @mythrun/ui, so a bare `import 'culori'` here is a phantom dependency that
// fails to resolve under this package's vite/vitest. A standing regression
// guard shouldn't be fragile to dependency hoisting, so we inline the formula:
// it's byte-for-byte equal to culori at these inputs (verified 4.7828 / 5.2987
// / 4.8825 vs the cited 4.78 / 5.30 / 4.88). sRGB → linear (the 0.03928/12.92
// piecewise + 2.4 gamma), Rec.709 luminance weights, then (L+0.05)/(L+0.05).
function srgbToLinear(channel: number): number {
  const c = channel / 255
  return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4)
}
function relativeLuminance(hex: string): number {
  const m = hex.replace('#', '')
  const r = parseInt(m.slice(0, 2), 16)
  const g = parseInt(m.slice(2, 4), 16)
  const b = parseInt(m.slice(4, 6), 16)
  return 0.2126 * srgbToLinear(r) + 0.7152 * srgbToLinear(g) + 0.0722 * srgbToLinear(b)
}
function wcagContrast(hexA: string, hexB: string): number {
  const a = relativeLuminance(hexA)
  const b = relativeLuminance(hexB)
  const lighter = Math.max(a, b)
  const darker = Math.min(a, b)
  return (lighter + 0.05) / (darker + 0.05)
}

const p = generatePalette()
const PAPER_50 = p.paper[50]    // light text on the accent fill
const PAPER_900 = p.paper[900]  // the dark page ground

// The ramp steps asserted below are COUPLED to the token→step mapping in
// frontend/ui/src/styles/semantic.css: dark `--accent` = ember-400 (line ~97),
// light `--accent` = ember-500 (~17), dark `--accent-fg` = ember-300 (~110). This
// guard pins those steps' contrast, not the live CSS-var resolution — if a token is
// REMAPPED to a different step in semantic.css, update the steps here to match.
describe('semantic accent contrast (regression guard for the MYT-86 dark CTA)', () => {
  it('dark --accent fill (ember-400) carries paper-50 label at AA', () => {
    expect(wcagContrast(p.ember[400], PAPER_50)).toBeGreaterThanOrEqual(4.5)
  })
  it('light --accent fill (ember-500) carries paper-50 label at AA', () => {
    expect(wcagContrast(p.ember[500], PAPER_50)).toBeGreaterThanOrEqual(4.5)
  })
  it('dark --accent-fg (ember-300) reads as text on the dark page at AA', () => {
    expect(wcagContrast(p.ember[300], PAPER_900)).toBeGreaterThanOrEqual(4.5)
  })
})
