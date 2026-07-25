import { FOG_PARAMS } from '@mythrun/client-core/worldgen'

// The terrain-quad paint (ux-run2 myth-y7yki — the run-1 "map contrast" carryover).
// The reference prototype painted its fog quads #a89f8a at 0.5 alpha — tuned against
// a dev backdrop, but over the shipped light page ground the blended tile lands at
// ~1.4:1, far under the WCAG 1.4.11 3:1 floor for meaningful graphics: "the thing
// you want the user staring at for 8 minutes is the faintest element on screen."
// The production paint therefore diverges deliberately from the reference record
// (FOG_PARAMS stays the verbatim prototype copy): the ink comes from the theme-aware
// `--worldgen-terrain` semantic token and the alpha from TERRAIN_ALPHA below. The
// measured guarantee — blended tile ≥3:1 against the page ground in BOTH themes,
// while the near-full-ink markers/labels stay dominant — is pinned by
// `terrain-contrast.test.ts` against the real token values.

/** The terrain-quad alpha over the page ground — FULL ink since ux-run3 (myth-llqj7).
 *
 *  Run 2 set this to 0.8 against a stylesheet-computed 3.47:1, and run 3's rendered
 *  pixels came back at ~2.5:1. Both numbers were right about different units: 3.47:1
 *  is a SOLID quad, but the field is a DITHER — a screenshot (and the eye) integrates
 *  painted cells with the paper between them, and at the run-2 field's ~24% coverage
 *  that integral sat near 1.5:1. Coverage, not alpha, was the larger half of the gap
 *  (see `terrain-field.ts`, which gives the field land to be dense over); this is the
 *  other half. At 1.0 the painted cell is the token's own ink — 5.2:1 light, 6.5:1
 *  dark — so a landmass at its coverage floor integrates past 3:1 with margin, and
 *  the near-black markers still out-contrast it better than 2:1.
 *
 *  A partial alpha was also slightly out of register: the brand's fog is 1-bit, and
 *  the dither IS the gradient. A cell is now ink or it is paper. */
export const TERRAIN_ALPHA = 1

/** The terrain ink — the `--worldgen-terrain` semantic token (flips with the
 *  theme, same technique as the graph's `resolveInk`). Falls back to the
 *  reference fog colour on a bare canvas (jsdom — where no 2D context paints
 *  anyway). */
export function resolveTerrainInk(canvas: HTMLCanvasElement): string {
  const ink = getComputedStyle(canvas).getPropertyValue('--worldgen-terrain').trim()
  return ink.length > 0 ? ink : FOG_PARAMS.fogColor
}
