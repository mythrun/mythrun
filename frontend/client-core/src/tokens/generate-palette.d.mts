/**
 * Type companion for `generate-palette.mjs`. The generator is plain `.mjs`
 * (untyped); @mythrun/ui's tsconfig — unlike the web app's — sets neither
 * `allowJs` nor `resolveJsonModule`, so a `.ts` test importing the generator
 * via the package's `./tokens` export would otherwise resolve to implicit `any`
 * (TS7016). This declares the generator's public surface so every TS consumer
 * (web, ui, client-core) types it identically. Sibling to `culori.d.ts`, which
 * does the same for the one culori function the token tests use. Keep in sync
 * with the generator's actual exports.
 */
declare const STEPS: readonly number[]
declare const EMBER_HERO: string
declare const SEMANTIC_ANCHORS: Record<
  'success' | 'warning' | 'danger' | 'info',
  { hex: string; anchorStep: number }
>

/** One ramp: the ten brand steps (50…900) → a `#rrggbb` hex. */
interface Ramp {
  50: string
  100: string
  200: string
  300: string
  400: string
  500: string
  600: string
  700: string
  800: string
  900: string
}

/** The six brand ramps, deterministically generated from the hero anchors. */
interface Palette {
  paper: Ramp
  ember: Ramp
  success: Ramp
  warning: Ramp
  danger: Ramp
  info: Ramp
}

declare function generatePalette(): Palette

export { STEPS, EMBER_HERO, SEMANTIC_ANCHORS, generatePalette }
