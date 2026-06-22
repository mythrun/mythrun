/**
 * The spacing-scale step, shared by every layout primitive's spacing prop
 * (`gap`, `padding`, `minColumnWidth`). 1..9 index the `--space-1..9` tokens
 * (4/8/12/16/24/32/40/48/64px — see `@mythrun/client-core/tokens/scales` SPACING).
 *
 * A SEMANTIC, token-typed value: the app names a scale step, never a raw pixel
 * value, so the web impl and a future native impl resolve the SAME token. This
 * is the platform-neutral style vocabulary §6 calls for — it passes api-purity
 * by construction (no DOM type leaks).
 */
export type SpaceToken = 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9
