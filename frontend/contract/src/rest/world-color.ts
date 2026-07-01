// The WORLD COVER colour set — the closed palette a world's dither cover may be
// tinted with (the genesis / home-hub cover art). Lives in the zod-only,
// react-free `@mythrun/contract` so the BACKEND can validate a per-world cover
// pair (and the colour stage can enforce the rung rule) without pulling in
// `@mythrun/client-core` (which depends on react).
//
// The set is the full per-hue ramp grid: 13 RAMPS × 10 STEPS = 130 tokens, each
// a standard design token `--color-{ramp}-{step}` (e.g. `--color-verdigris-200`).
// The 13 ramps are the neutral `paper` ground, the `ember` brand accent, and the
// 11 remaining brand pigments. The semantic ramps (success/warning/danger/info)
// are EXCLUDED — a cover is decorative, never a UI-state signal.
//
// COLOUR MODEL (MYT-87 2026-07-01 rework): a Sonnet call one-shots TWO tokens at
// least 6 rungs apart on the 10-rung ladder; the ≥6-rung rule guarantees ~3.0+
// WCAG contrast (a full enumeration proved 5 rungs or fewer can dip to ~2.5),
// so the two dither ends always read as distinct. This REPLACES the old curated
// 20-member set + luminance-table + contrast-floor model — with per-hue ramps
// now real tokens, the model can pick two genuinely complementary chromatic
// colours that also read (e.g. a light coral × a dark teal).
//
// A client-core drift guard cross-checks every member here against the real
// design tokens (`frontend/ui/src/styles/tokens.manifest.json`), so this set can
// never name a `--color-*` token that doesn't exist.
import { z } from 'zod'

/**
 * The 13 ramps a world cover may draw from, in canonical order: the `paper`
 * neutral ground, the `ember` brand accent, then the 11 remaining brand
 * pigments. EXCLUDES the semantic ramps (success/warning/danger/info).
 */
export const WORLD_COLOR_RAMPS = [
  'paper', 'ember', 'sienna', 'ochre', 'moss', 'pine', 'verdigris',
  'lapis', 'iris', 'heather', 'rose', 'umber', 'slate',
] as const
export type WorldColorRamp = (typeof WORLD_COLOR_RAMPS)[number]

/**
 * The 10-rung OKLCH luminance ladder every ramp is emitted on (50 = lightest,
 * 900 = darkest). The `rungsApart` distance is measured over THIS index order,
 * not the numeric labels.
 */
export const WORLD_COLOR_STEPS = [50, 100, 200, 300, 400, 500, 600, 700, 800, 900] as const
export type WorldColorStep = (typeof WORLD_COLOR_STEPS)[number]

/** A single cover colour — a `{ramp}-{step}` design-token name (e.g. `verdigris-200`). */
export type WorldColor = `${WorldColorRamp}-${WorldColorStep}`

/**
 * The full cover-colour set: every `{ramp}-{step}` (13 × 10 = 130 tokens). Built
 * programmatically from the ramps × steps grid so it can never drift from the
 * emitted design tokens.
 */
export const WORLD_COLORS: readonly WorldColor[] = WORLD_COLOR_RAMPS.flatMap((ramp) =>
  // eslint-disable-next-line @typescript-eslint/restrict-template-expressions -- the token name deliberately embeds the numeric ladder rung; the `: WorldColor` annotation keeps the union precise.
  WORLD_COLOR_STEPS.map((step): WorldColor => `${ramp}-${step}`),
)

export const WorldColorSchema = z.enum(WORLD_COLORS)

/**
 * A world cover's two dither ends — `from` (the lighter, sparse ground) and `to`
 * (the deeper, dense accent). Both are `WorldColor`s; an excluded/unknown colour
 * fails the parse. The backend validates a persisted cover pair against this and
 * the colour stage constrains the LLM's output to it.
 */
export const WorldColorPairSchema = z.object({
  from: WorldColorSchema,
  to: WorldColorSchema,
})
export type WorldColorPair = z.infer<typeof WorldColorPairSchema>

/**
 * The CSS custom-property reference a world colour resolves to. Every member is
 * a standard ramp token, so the mapping is uniform: `verdigris-200` →
 * `var(--color-verdigris-200)`. The consumer (the CoverDither) drops the result
 * straight into a `fill` / custom-property value.
 */
export function worldColorCssVar(name: WorldColor): string {
  return `var(--color-${name})`
}

/** The trailing ladder step of a world colour (`verdigris-200` → `200`). */
export function worldColorStep(name: WorldColor): number {
  return Number(name.slice(name.lastIndexOf('-') + 1))
}

/** The hue (ramp) of a world colour (`verdigris-200` → `verdigris`). */
export function worldColorHue(name: WorldColor): WorldColorRamp {
  const hue = name.slice(0, name.lastIndexOf('-'))
  const match = WORLD_COLOR_RAMPS.find((ramp) => ramp === hue)
  /* c8 ignore next -- unreachable: a WorldColor is always `${ramp}-${step}`, so
   * a ramp always matches; the throw is a type-narrow, never hit for a real
   * WorldColor. */
  if (match === undefined) throw new Error(`world colour has no known hue: ${name}`)
  return match
}

/**
 * The absolute distance between two colours on the 10-rung ladder — the contrast
 * proxy the colour model enforces. `rungsApart('verdigris-200', 'moss-800') === 6`;
 * `rungsApart('lapis-400', 'lapis-500') === 1`. A pair `≥ 6` rungs apart clears
 * ~3.0:1 WCAG in the worst hue combo (enumeration-proven), so the two dither ends
 * always read as distinct.
 */
export function rungsApart(a: WorldColor, b: WorldColor): number {
  const stepA = worldColorStep(a)
  const stepB = worldColorStep(b)
  const indexA = WORLD_COLOR_STEPS.findIndex((step) => step === stepA)
  const indexB = WORLD_COLOR_STEPS.findIndex((step) => step === stepB)
  return Math.abs(indexA - indexB)
}

/**
 * Re-ink a light-mode cover pair for dark mode: the lighter end (the lower step)
 * drops to its hue's smouldering mid-tone (`-400`), and the darker end deepens to
 * near-black (`-900`), so the cover reads as a dark object with the colour
 * glowing — cohering with the dark card. Each end keeps its HUE; only the steps
 * snap. Consumed by the CoverDither's dark-pair CSS custom properties.
 */
export function reInkPair({ from, to }: WorldColorPair): WorldColorPair {
  const fromHue = worldColorHue(from)
  const toHue = worldColorHue(to)
  if (worldColorStep(from) <= worldColorStep(to)) {
    return { from: `${fromHue}-400`, to: `${toHue}-900` }
  }
  return { from: `${fromHue}-900`, to: `${toHue}-400` }
}
