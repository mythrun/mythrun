/**
 * Minimal ambient types for the `culori` color library. The package ships no
 * bundled `.d.ts` and we don't pull in `@types/culori` for the one function the
 * token tests use — `wcagContrast(a, b)` returns the WCAG 2.x contrast ratio
 * (1..21) between two CSS color strings. The generate-palette.mjs generator uses
 * more of culori's surface, but it's plain `.mjs` (untyped); this declaration
 * only needs to cover what the typechecked `.ts` test imports.
 */
declare module 'culori' {
  export function wcagContrast(a: string, b: string): number
}
