import { RuleTester } from 'eslint'
import { describe, it } from 'vitest'
import tseslint from 'typescript-eslint'
import { apiPurity } from './api-purity.js'

// Wire ESLint's RuleTester to Vitest's runner so each case is a real test
// AND the rule module is instrumented for coverage. The contract surface is
// TypeScript (`interface XProps {}`, `type` aliases), so the RuleTester needs
// the typescript-eslint parser — espree (the default) can't parse `interface`.
//
// This is the rule's COVERAGE source (the visitor runs directly here). The
// sibling `api-purity.wiring.test.ts` drives the rule through ESLint's full
// config loader to prove registration fires; that path corrupts the v8
// coverage map for the rule file (the vitest-v8 double-load gotcha), so it is
// RUN-excluded from `test:coverage`. Keep the exhaustive branch cases HERE.
RuleTester.describe = describe
RuleTester.it = it
RuleTester.itOnly = it.only

const ruleTester = new RuleTester({
  languageOptions: {
    parser: tseslint.parser,
    ecmaVersion: 2024,
    sourceType: 'module',
  },
})

ruleTester.run('api-purity', apiPurity, {
  valid: [
    // The platform-neutral happy path: variant union, a semantic press handler,
    // ReactNode children, and the allowed data-testid escape hatch (a Literal
    // member key — exercises the Literal branch of memberName()).
    {
      code:
        "export interface ZProps { variant?: 'a' | 'b'; onPress?: () => void; children?: ReactNode; 'data-testid'?: string }",
    },
    // A NON-exported helper type is the "internal Radix wiring" exemption — it
    // may carry DOM props (className/style) because it never reaches the public
    // contract surface.
    { code: 'interface Internal { className?: string; style?: CSSProperties }' },
    // A non-exported type alias is likewise exempt.
    { code: 'type InternalAlias = { className?: string }' },
    // An exported NON-Props type is out of scope (only `*Props` is the surface).
    { code: 'export interface ButtonState { className?: string }' },
    // onClick / onSelect are NOT DOM-only handlers under our regex (only
    // Mouse/Pointer/Drag event handlers leak the DOM); semantic names allowed.
    { code: 'export interface MenuProps { onSelect?: () => void; onClick?: () => void }' },
    // Extending another platform-neutral *Props type is fine — only DOM-attribute
    // bases (HTMLAttributes & friends) are banned.
    { code: 'export interface CardProps extends BaseProps { variant?: string }' },
    // An exported type-alias *Props built from a platform-neutral intersection
    // (exercises the TSTypeReference non-DOM-base + TSTypeLiteral member arms).
    { code: 'export type TabsProps = BaseProps & { value?: string }' },
    // An index signature has no named prop — skipped, not crashed.
    { code: 'export interface KProps { [k: string]: unknown }' },
    // A computed key (`[SYM]`) is not the named prop surface — the rule skips
    // it via member.computed rather than mis-reading the symbol identifier as a
    // literal prop name (so a symbol coincidentally named `className` is fine).
    { code: 'export interface CProps { [classNameSym]?: string }' },
    // A numeric-literal key reaches memberName's undefined fall-through (no
    // readable static name) and is skipped — exercises that arm.
    { code: 'export interface NProps { 42?: string }' },
    // A bare object-literal type alias *Props with only platform-neutral props
    // (exercises the TSTypeLiteral arm of the TSTypeAliasDeclaration path).
    { code: 'export type QProps = { variant?: string; onPress?: () => void }' },
  ],
  invalid: [
    // 1. className member — the canonical DOM leak.
    {
      code: 'export interface XProps { className?: string }',
      errors: [{ messageId: 'domMember' }],
    },
    // 2. `style` is BOTH a banned member name AND typed CSSProperties here, so
    //    both arms fire on the same member. Asserting both pins the dual report.
    {
      code: 'export interface XProps { style?: CSSProperties }',
      errors: [{ messageId: 'domMember' }, { messageId: 'cssPropertiesType' }],
    },
    // 2b. A NON-`style`-named member typed React.CSSProperties — isolates the
    //     type-annotation arm AND the TSQualifiedName branch of typeReferenceName.
    {
      code: 'export interface XProps { wrapperStyles?: React.CSSProperties }',
      errors: [{ messageId: 'cssPropertiesType' }],
    },
    // 3. DOM event handlers by name (Mouse / Pointer / Drag).
    {
      code: 'export interface XProps { onMouseEnter?: () => void }',
      errors: [{ messageId: 'domMember' }],
    },
    {
      code: 'export interface XProps { onPointerDown?: () => void }',
      errors: [{ messageId: 'domMember' }],
    },
    {
      code: 'export interface XProps { onDragStart?: () => void }',
      errors: [{ messageId: 'domMember' }],
    },
    // 4. extends a DOM-attribute base type (interface heritage).
    {
      code: 'export interface YProps extends HTMLAttributes<HTMLDivElement> {}',
      errors: [{ messageId: 'domExtends' }],
    },
    // 4a. the `*HTMLAttributes` suffix match (ButtonHTMLAttributes).
    {
      code: 'export interface YProps extends ButtonHTMLAttributes<HTMLButtonElement> {}',
      errors: [{ messageId: 'domExtends' }],
    },
    {
      code: 'export interface YProps extends ComponentPropsWithoutRef<"div"> {}',
      errors: [{ messageId: 'domExtends' }],
    },
    // 4b. extends via type-alias intersection (the TSIntersectionType +
    //     TSTypeReference DOM-base arm).
    {
      code: 'export type WProps = HTMLProps<HTMLDivElement> & { variant?: string }',
      errors: [{ messageId: 'domExtends' }],
    },
    // 5. a bare object-literal type alias *Props that leaks className
    //    (exercises the TSTypeLiteral arm of the type-alias path, line 129).
    {
      code: 'export type RProps = { className?: string }',
      errors: [{ messageId: 'domMember' }],
    },
  ],
})
