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

/** The terrain-quad alpha over the page ground. 0.8 lands the painted tile at
 *  ~3.5:1 (light, paper-600 over paper-100) and ~4.6:1 (dark, paper-400 over
 *  paper-900) — see the measured test. */
export const TERRAIN_ALPHA = 0.8

/** The terrain ink — the `--worldgen-terrain` semantic token (flips with the
 *  theme, same technique as the graph's `resolveInk`). Falls back to the
 *  reference fog colour on a bare canvas (jsdom — where no 2D context paints
 *  anyway). */
export function resolveTerrainInk(canvas: HTMLCanvasElement): string {
  const ink = getComputedStyle(canvas).getPropertyValue('--worldgen-terrain').trim()
  return ink.length > 0 ? ink : FOG_PARAMS.fogColor
}
