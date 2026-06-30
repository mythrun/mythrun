// The curated WORLD COVER color set — the closed palette a world's dither cover
// may be tinted with (the genesis/home-hub cover art). Lives in the zod-only,
// react-free `@mythrun/contract` so the BACKEND can validate a per-world cover
// pair without pulling in `@mythrun/client-core` (which depends on react).
//
// The set spans TWO CSS-var namespaces, both sourced from the design tokens:
//
//   1. The 12 avatar pigments (the "scribe's pigments") — a hand-curated brand
//      set, emitted by @mythrun/ui as `--color-avatar-{name}`.
//   2. Selected steps of the `paper` (neutral ground) and `ember` (brand accent)
//      ramps — emitted as `--color-{name}`.
//
// The semantic ramps (success/warning/danger/info) are EXCLUDED: a cover is
// decorative, never a UI-state signal. A client-core drift-guard test
// cross-checks every member here against the actual design tokens (the
// `AVATAR_COLORS` keys + the generated paper/ember ramp steps), so this set can
// never name a token that doesn't exist.
import { z } from 'zod'

/**
 * The 12 avatar pigments, in their canonical order. Each resolves to the avatar
 * CSS-var namespace: `--color-avatar-{name}`. Mirror of `AVATAR_COLORS` in
 * `@mythrun/client-core` `tokens/scales.ts` (the drift guard asserts they agree).
 */
export const WORLD_COLOR_PIGMENTS = [
  'ember', 'sienna', 'ochre', 'moss', 'pine', 'verdigris',
  'lapis', 'iris', 'heather', 'rose', 'umber', 'slate',
] as const

/**
 * The selected paper/ember ramp steps. Each resolves to the base palette CSS-var
 * namespace: `--color-{name}` (e.g. `--color-paper-100`). A curated spread — the
 * pale paper grounds + a couple of dark steps for each ramp — not the full 10.
 */
export const WORLD_COLOR_RAMP_STEPS = [
  'paper-50', 'paper-100', 'paper-200', 'paper-900',
  'ember-100', 'ember-200', 'ember-700', 'ember-900',
] as const

/** The curated world-color name set (pigments first, then ramp steps). */
export const WORLD_COLORS = [
  ...WORLD_COLOR_PIGMENTS,
  ...WORLD_COLOR_RAMP_STEPS,
] as const

export const WorldColorSchema = z.enum(WORLD_COLORS)
export type WorldColor = z.infer<typeof WorldColorSchema>

/**
 * A world cover's two dither ends — `from` (the sparse ground) and `to` (the
 * dense accent). Both are curated `WorldColor`s; an excluded/unknown color fails
 * the parse. The backend validates a persisted cover pair against this.
 */
export const WorldColorPairSchema = z.object({
  from: WorldColorSchema,
  to: WorldColorSchema,
})
export type WorldColorPair = z.infer<typeof WorldColorPairSchema>

// The pigment names, as a string Set, so namespace lookup needs no assertion: a
// `WorldColor` (string) is a valid `.has()` argument against a `Set<string>`.
const PIGMENT_NAMES: ReadonlySet<string> = new Set(WORLD_COLOR_PIGMENTS)

/**
 * The CSS custom-property a world color resolves to. Pigments live in the avatar
 * namespace (`--color-avatar-{name}`); ramp steps in the base palette namespace
 * (`--color-{name}`). The consumer (the CoverDither component) reads this to pick
 * the right var — the single place the two-namespace convention is encoded.
 */
export function worldColorCssVar(name: WorldColor): string {
  return PIGMENT_NAMES.has(name) ? `--color-avatar-${name}` : `--color-${name}`
}
