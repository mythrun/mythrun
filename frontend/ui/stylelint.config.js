// Stylelint config for @mythrun/ui — the CSS-side of R3 (portability):
// COMPONENT CSS must be token-only, never a raw color value.
//
// Scope is the `lint:css` script glob: ONLY component CSS under src/components.
// The token layer under src/styles (theme.css, semantic.css, and the GENERATED
// colors.generated.css palette) legitimately holds raw hex/oklch values — it is
// where color is DEFINED — so it is deliberately NOT linted by this config.
// Components consume those tokens via var(--color-…) / Tailwind token utilities;
// a raw color in a component stylesheet is the R3 violation we ban.
//
// Today @mythrun/ui has no component CSS yet (components style with Tailwind
// token classes, linted by the `no-ad-hoc-color` ESLint rule). The glob
// therefore matches nothing for now; `lint:css` passes via --allow-empty-input.
// The rail is in place so the FIRST component stylesheet is token-only from
// day one.
//
// (Line comments — not a /* */ block — on purpose: a `**` + `/` glob fragment
// inside a block comment would terminate it early and break the parse.)

/** @type {import('stylelint').Config} */
export default {
  extends: ['stylelint-config-standard'],
  rules: {
    // Raw hex colors are banned outright in component CSS — use a token var.
    'color-no-hex': true,
    // rgb()/rgba()/hsl()/hsla() raw color functions are likewise banned for any
    // color / background-color / border-color / *-color declaration: the value
    // must be a token (var(--color-…)), not a literal color. (oklch/oklab live
    // in the generated palette only, which this config does not lint.)
    'declaration-property-value-disallowed-list': {
      '/color$/': ['/rgba?\\(/', '/hsla?\\(/'],
    },
  },
}
