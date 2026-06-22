/**
 * ESLint rule: no-ad-hoc-color (R3 of the frontend portability architecture)
 *
 * `@mythrun/ui` components style with Tailwind v4 TOKEN classes (`bg-ember-600`,
 * `text-ink`, `border-border-strong`) sourced from the design tokens. They must
 * NEVER carry a raw color value. R3 keeps color out of component code so the
 * single token layer stays the one place color is defined (theme-aware, portable
 * to a future native UI).
 *
 * Why this is NOT a `JSXAttribute`-only rule: in the shadcn/CVA pattern the
 * color classes live as string literals INSIDE `cva({...})` / `cn(...)` call
 * arguments (and plain variables), not only in JSX `className`. A matcher keyed
 * on `JSXAttribute` would silently miss every cva config — the exact gap this
 * rule closes. So we scan EVERY string `Literal` and `TemplateLiteral` quasi in
 * `src/components/**`, plus inline `style={{}}` object color values.
 *
 * Flags (pure AST / string scan — no parserServices):
 *   1. rawColor          — a raw hex color (`#abc`/`#aabbcc`/8-digit) or a
 *                          color FUNCTION call (rgb/rgba/hsl/hsla/oklch/oklab)
 *                          anywhere in a string.
 *   2. arbitraryColor    — a Tailwind arbitrary-value COLOR utility, e.g.
 *                          `bg-[#abc]`, `text-[rgb(...)]`, `border-[var(--x)]`.
 *                          Non-color arbitrary values (`w-[32px]`) are allowed.
 *   3. inlineStyleColor  — a JSX `style={{ color: '#abc' }}` property whose
 *                          value is a raw hex/rgb/hsl string literal.
 *
 * `var(--color-...)` (and any `var(--…)`) references are TOKENS, never raw — a
 * bare `var(...)` value is allowed everywhere. (An ARBITRARY-utility wrapper
 * `text-[var(--x)]` is still flagged by #2 as an ad-hoc escape; the supported
 * form is a token utility, not an arbitrary bracket.)
 *
 * Escape hatch: a normal `// eslint-disable-next-line ... -- reason` (the repo
 * requires a description on disables).
 */

// A raw hex color: 3/4/6/8 hex digits after `#`, anchored on a `#` and ending
// at a word boundary so `#ab` (too short) and `section#hero` (non-hex tail) do
// NOT match. Authored to the spec's exact length set.
const HEX_COLOR = /#([0-9a-fA-F]{3,4}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})\b/

// A CSS color FUNCTION call. `var()` is deliberately absent — var() is a token.
const COLOR_FUNCTION = /\b(?:rgba?|hsla?|oklch|oklab)\(/

// A Tailwind ARBITRARY-VALUE color utility: a color-bearing prefix followed by
// `-[` and a value that opens with a color sigil (`#`, a color function, or a
// CSS var — an arbitrary `var()` wrapper is still an ad-hoc escape vs a token
// utility). A non-color arbitrary value (`w-[32px]`) never matches.
const ARBITRARY_COLOR_UTILITY =
  /\b(?:bg|text|border|ring|outline|fill|stroke|from|via|to|decoration|shadow|accent|caret|divide)-\[(?:#|rgba?\(|hsla?\(|oklch\(|oklab\(|var\(--)/

// A string value is a raw color if it carries a hex color or a color function.
const hasRawColor = (value) => HEX_COLOR.test(value) || COLOR_FUNCTION.test(value)

/** @type {import('eslint').Rule.RuleModule} */
export const noAdHocColor = {
  meta: {
    type: 'problem',
    docs: {
      description:
        'Component colors must come from design tokens (bg-ember-600 / text-ink), never raw hex/rgb/hsl values or arbitrary-value color utilities. (R3)',
    },
    schema: [],
    messages: {
      rawColor:
        "Raw color '{{value}}' — use a design token utility (bg-ember-600 / text-ink) instead (R3).",
      arbitraryColor:
        "Arbitrary-value color utility '{{value}}' — use a design token utility (bg-ember-600 / text-ink) instead (R3).",
      inlineStyleColor:
        "Inline-style color '{{value}}' — use a design token utility (bg-ember-600 / text-ink) instead of a raw inline color (R3).",
    },
  },
  create(context) {
    // Report the color violation a raw string value carries. The two messages
    // are mutually exclusive and `arbitraryColor` wins: an arbitrary-color
    // utility (`bg-[#abc]`, `text-[rgb(...)]`) embeds a raw color by
    // construction, so reporting BOTH would double-flag the same class. The
    // `arbitraryColor` message names the precise problem (the Tailwind escape),
    // so the bare-`rawColor` scan only fires for raw colors NOT already wrapped
    // in an arbitrary utility (a `#ff5500` variable, a standalone `rgb(...)`).
    const checkStringValue = (value, node) => {
      if (ARBITRARY_COLOR_UTILITY.test(value)) {
        context.report({ node, messageId: 'arbitraryColor', data: { value } })
      } else if (hasRawColor(value)) {
        context.report({ node, messageId: 'rawColor', data: { value } })
      }
    }

    // The static string text of a JSX style-object property VALUE, if it is a
    // plain string literal; otherwise undefined (computed/non-string values
    // carry no inline-color text for us to inspect).
    const stylePropStringValue = (valueNode) => {
      if (valueNode.type === 'Literal' && typeof valueNode.value === 'string') return valueNode.value
      return undefined
    }

    // True when a string Literal is the VALUE of a property inside a JSX
    // `style={{ ... }}` object. Such literals are handled by the JSXAttribute
    // visitor (the dedicated `inlineStyleColor` message); skipping them in the
    // generic Literal scan avoids double-reporting the same color.
    const isInlineStyleValue = (node) => {
      const prop = node.parent
      if (prop?.type !== 'Property' || prop.value !== node) return false
      const obj = prop.parent
      const container = obj?.parent
      const attr = container?.parent
      return (
        obj?.type === 'ObjectExpression' &&
        container?.type === 'JSXExpressionContainer' &&
        attr?.type === 'JSXAttribute' &&
        attr.name?.name === 'style'
      )
    }

    return {
      // Every string literal anywhere in the file (className attr, cva/cn arg,
      // a bare variable). Literals that are `style={{}}` property values are
      // skipped here — the JSXAttribute visitor reports those with the dedicated
      // `inlineStyleColor` message, so scanning them here too would double-flag.
      Literal(node) {
        if (typeof node.value !== 'string') return
        if (isInlineStyleValue(node)) return
        checkStringValue(node.value, node)
      },
      // Template-literal quasis (cooked text) — the static segments of
      // `className={`bg-bg ${x}`}`. Interpolations are separate expressions and
      // are visited on their own (as Literals/Identifiers).
      TemplateElement(node) {
        const cooked = node.value.cooked
        if (typeof cooked === 'string') checkStringValue(cooked, node)
      },
      // Inline-style color: `style={{ color: '#abc' }}`. We scan the object's
      // properties for a string value that is a raw color and emit the dedicated
      // message. `var(--color-…)` values are tokens → not flagged.
      JSXAttribute(node) {
        if (node.name.name !== 'style') return
        // `node.value` is null for a boolean attribute (`<div style />`) and a
        // string Literal for `style="…"`; only a `{ … }` container holds an
        // object expression. Optional chain handles the null case.
        const expr = node.value
        if (expr?.type !== 'JSXExpressionContainer') return
        const obj = expr.expression
        if (obj.type !== 'ObjectExpression') return
        for (const prop of obj.properties) {
          if (prop.type !== 'Property') continue
          const value = stylePropStringValue(prop.value)
          if (value === undefined) continue
          if (hasRawColor(value)) {
            context.report({ node: prop, messageId: 'inlineStyleColor', data: { value } })
          }
        }
      },
    }
  },
}
