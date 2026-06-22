import { RuleTester } from 'eslint'
import { describe, it } from 'vitest'
import tseslint from 'typescript-eslint'
import { noAdHocColor } from './no-ad-hoc-color.js'

// Wire ESLint's RuleTester to Vitest's runner so each case is a real test AND
// the rule module is instrumented for coverage. Component source is TSX (JSX
// `className`, `style={{}}`, `cva({...})` configs), so the RuleTester needs the
// typescript-eslint parser with JSX enabled — espree alone can't parse it.
//
// This is the rule's COVERAGE source (the visitor runs directly here). The
// sibling `no-ad-hoc-color.wiring.test.ts` drives the rule through ESLint's full
// config loader to prove registration fires; that path corrupts the v8 coverage
// map for the rule file (the vitest-v8 double-load gotcha), so it is
// RUN-excluded from `test:coverage`. Keep the exhaustive branch cases HERE.
RuleTester.describe = describe
RuleTester.it = it
RuleTester.itOnly = it.only

const ruleTester = new RuleTester({
  languageOptions: {
    parser: tseslint.parser,
    ecmaVersion: 2024,
    sourceType: 'module',
    parserOptions: { ecmaFeatures: { jsx: true } },
  },
})

ruleTester.run('no-ad-hoc-color', noAdHocColor, {
  valid: [
    // Token utility classes in a JSX className — the supported happy path.
    { code: 'export const A = () => <div className="bg-ember-600 text-ink border-border-strong" />' },
    // Token utilities inside a cva() config (the shadcn/CVA pattern this rule
    // must scan beyond JSX attributes).
    {
      code:
        "export const v = cva('bg-bg', { variants: { tone: { x: 'bg-ember-600 text-ink' } } })",
    },
    // Token utilities inside a cn() call.
    { code: "export const c = cn('bg-surface', 'text-ink')" },
    // A non-color arbitrary value must NOT be flagged (w-[32px], h-[2rem]).
    { code: 'export const A = () => <div className="w-[32px] h-[2rem]" />' },
    // A direct var(--color-...) value IS a token — never a raw color. (An
    // ARBITRARY-UTILITY wrapper `text-[var(--x)]` is a DIFFERENT thing and is
    // flagged below: an arbitrary bracket is an escape hatch regardless of what
    // it wraps; the supported form is a token utility like `text-ink`.)
    { code: "export const A = () => <div style={{ color: 'var(--color-ink)' }} />" },
    // A plain non-color string literal must not trip the hex/function scan
    // (e.g. an arbitrary identifier, a path, prose). `#abc` only matches as a
    // hex color at a word boundary; `section#hero` is an id selector, not a hex.
    { code: "export const id = 'section#hero-banner'" },
    // A template literal with only token classes + an interpolation.
    {
      code:
        'export const A = ({ active }: { active: boolean }) => <div className={`bg-bg ${active ? "text-ink" : "text-ink-secondary"}`} />',
    },
    // Inline style with a NON-color property — a numeric/dimension string is
    // not a color and must not be flagged.
    { code: "export const A = () => <div style={{ width: '32px' }} />" },
    // A 1- or 2-char hex-looking fragment is NOT a valid color length and must
    // not fire (hex colors are 3/4/6/8 digits).
    { code: "export const x = 'value #ab is not a color'" },
    // --- inline-style edge cases (exercise the JSXAttribute visitor's arms
    //     without producing a violation) ---
    // A style-object property whose value is an IDENTIFIER (not a string
    // literal): stylePropStringValue returns undefined → skipped.
    { code: 'export const A = ({ c }: { c: string }) => <div style={{ color: c }} />' },
    // A style-object SPREAD element (not a Property) → skipped, not crashed.
    {
      code:
        'export const A = ({ base }: { base: object }) => <div style={{ ...base, width: 8 }} />',
    },
    // A style attribute bound to a variable (the container expression is NOT an
    // ObjectExpression) → the object-property scan is skipped.
    { code: 'export const A = ({ s }: { s: object }) => <div style={s} />' },
    // A `style` attribute written as a plain string (value is a string Literal,
    // not a JSXExpressionContainer) → skipped by the container guard. (Lints to
    // an `arbitraryColor`-free string, so no color violation either.)
    { code: 'export const A = () => <div style="margin: 0" />' },
    // A NON-`style` JSX attribute is ignored by the inline-style visitor.
    { code: 'export const A = () => <div data-x="bg-ember-600" />' },
    // A numeric literal anywhere exercises the Literal visitor's non-string
    // early return.
    { code: 'export const n = 42' },
  ],
  invalid: [
    // 1. Raw hex in a JSX className attribute.
    {
      code: 'export const A = () => <div className="bg-[#abc]" />',
      errors: [{ messageId: 'arbitraryColor' }],
    },
    // 1b. 6-digit hex inside an arbitrary-value bg utility. `arbitraryColor`
    //     wins (it names the precise Tailwind escape) and the redundant
    //     raw-hex report is suppressed.
    {
      code: 'export const A = () => <div className="bg-[#aabbcc]" />',
      errors: [{ messageId: 'arbitraryColor' }],
    },
    // 2. THE HEADLINE: a hex literal inside a cva() config (not a JSX attr).
    {
      code: "export const v = cva({ variants: { tone: { x: 'text-[#fff]' } } })",
      errors: [{ messageId: 'arbitraryColor' }],
    },
    // 2b. A bare raw hex literal (a variable, not even a class) inside source.
    {
      code: "export const BRAND = '#ff5500'",
      errors: [{ messageId: 'rawColor' }],
    },
    // 3. rgb()/rgba()/hsl()/oklch() function-call colors as raw literals.
    {
      code: "export const v = cva({ variants: { tone: { x: 'rgb(0,0,0)' } } })",
      errors: [{ messageId: 'rawColor' }],
    },
    { code: "export const C = 'rgba(0, 0, 0, 0.5)'", errors: [{ messageId: 'rawColor' }] },
    { code: "export const C = 'hsl(210, 50%, 50%)'", errors: [{ messageId: 'rawColor' }] },
    { code: "export const C = 'oklch(0.7 0.1 200)'", errors: [{ messageId: 'rawColor' }] },
    // 4. Arbitrary-value color utility with an rgb() inside the brackets —
    //    `arbitraryColor` wins, the redundant raw-function report is suppressed.
    {
      code: 'export const A = () => <div className="text-[rgb(0,0,0)]" />',
      errors: [{ messageId: 'arbitraryColor' }],
    },
    // 4b. Arbitrary-value color utility referencing a NON-token var(--x): a
    //     `text-[var(--brand)]` arbitrary util is still an ad-hoc escape even if
    //     the value happens to be a var — flagged as an arbitrary color utility.
    {
      code: 'export const A = () => <div className="border-[var(--whatever)]" />',
      errors: [{ messageId: 'arbitraryColor' }],
    },
    // 5. Inline-style hex color string in a JSX style object.
    {
      code: "export const A = () => <div style={{ color: '#abc' }} />",
      errors: [{ messageId: 'inlineStyleColor' }],
    },
    // 5b. Inline-style rgb() color string.
    {
      code: "export const A = () => <div style={{ backgroundColor: 'rgb(1,2,3)' }} />",
      errors: [{ messageId: 'inlineStyleColor' }],
    },
    // 6. Template-literal quasi carrying a raw arbitrary color utility.
    {
      code:
        'export const A = ({ on }: { on: boolean }) => <div className={`bg-[#abc] ${on ? "text-ink" : ""}`} />',
      errors: [{ messageId: 'arbitraryColor' }],
    },
    // 7. A `cn()` argument carrying a raw color.
    {
      code: "export const c = cn('text-ink', 'bg-[#abc]')",
      errors: [{ messageId: 'arbitraryColor' }],
    },
  ],
})
