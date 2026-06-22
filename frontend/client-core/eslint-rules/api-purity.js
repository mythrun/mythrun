/**
 * ESLint rule: api-purity (R2 of the frontend portability architecture)
 *
 * mythrunUI's PUBLIC prop surface must stay platform-neutral so a future
 * true-native implementation can satisfy the same component contract. The
 * surface lives in two places, both linted by this rule:
 *   - the contract types in `@mythrun/client-core/src/contract/**` (e.g. ButtonProps)
 *   - any component prop-WIDENING in `@mythrun/ui/src/components/**`
 *     (a component typed `(props: ButtonProps & { className?: string })` smuggles
 *      a DOM prop past the contract — the "excess prop" direction)
 *
 * Scope: only EXPORTED `*Props` interfaces / type-aliases are the public surface.
 * Non-exported helper types are exempt — that is the "internal Radix wiring"
 * carve-out (a component may locally compose `interface Internal { className }`
 * for its DOM plumbing as long as it never reaches the public *Props contract).
 *
 * Flags (pure AST — no parserServices / type-checker):
 *   1. domMember        — a member named `className`, `style`, or matching a DOM
 *                         mouse/pointer/drag event handler (/^on(Mouse|Pointer|Drag)[A-Z]/).
 *   2. cssPropertiesType — a member whose type annotation references CSSProperties
 *                          or React.CSSProperties (a TSTypeReference named CSSProperties).
 *   3. domExtends       — an exported *Props that extends / intersects a
 *                         DOM-attribute base (HTMLAttributes, HTMLProps,
 *                         ComponentProps, ComponentPropsWithoutRef, DOMAttributes,
 *                         or any *HTMLAttributes).
 */

const DOM_EVENT_HANDLER = /^on(Mouse|Pointer|Drag)[A-Z]/
const BANNED_MEMBER_NAMES = new Set(['className', 'style'])

// DOM-attribute base types a public *Props must never inherit. `*HTMLAttributes`
// (ButtonHTMLAttributes, AnchorHTMLAttributes, ...) is matched by suffix.
const DOM_BASE_NAMES = new Set([
  'HTMLAttributes',
  'HTMLProps',
  'ComponentProps',
  'ComponentPropsWithoutRef',
  'DOMAttributes',
])

const isDomBaseName = (name) =>
  typeof name === 'string' && (DOM_BASE_NAMES.has(name) || name.endsWith('HTMLAttributes'))

const isExported = (node) => node.parent?.type === 'ExportNamedDeclaration'

const isPropsName = (node) => typeof node.id?.name === 'string' && node.id.name.endsWith('Props')

// A member's static name: an `Identifier` key (className) or a string `Literal`
// key ('data-testid'). Returns undefined for keys with no readable static name
// (e.g. a numeric literal key) — those carry no prop-name semantics for us.
// (Computed keys are filtered by the caller before reaching here.)
const memberName = (key) => {
  if (key.type === 'Identifier') return key.name
  if (key.type === 'Literal' && typeof key.value === 'string') return key.value
  return undefined
}

// A `TSTypeReference`'s referenced name is its `typeName`: an `Identifier`
// (`CSSProperties`) or a `TSQualifiedName` (`React.CSSProperties`), whose
// trailing `right` Identifier carries the name. Any other shape yields
// undefined via the optional chain (no separate dead default to cover).
const typeReferenceName = (typeRef) => {
  const tn = typeRef.typeName
  if (tn.type === 'Identifier') return tn.name
  return tn.right?.name
}

/** @type {import('eslint').Rule.RuleModule} */
export const apiPurity = {
  meta: {
    type: 'problem',
    docs: {
      description:
        "Keep mythrunUI's public *Props surface platform-neutral: no DOM-only props (className/style/CSSProperties/DOM events/HTMLAttributes). (R2)",
    },
    schema: [],
    messages: {
      domMember:
        "mythrunUI prop '{{name}}' leaks the DOM; the public *Props contract must stay platform-neutral (R2). Use a semantic prop (e.g. onPress, not onMouseEnter) and let the platform UI map it.",
      cssPropertiesType:
        "mythrunUI prop '{{name}}' is typed CSSProperties, a DOM-only type; the public *Props contract must stay platform-neutral (R2). Expose semantic style tokens instead.",
      domExtends:
        "mythrunUI prop type '{{name}}' extends the DOM-attribute base '{{base}}'; the public *Props contract must stay platform-neutral and never inherit HTML attributes (R2).",
    },
  },
  create(context) {
    // Report any member that leaks the DOM by name or by CSSProperties type.
    const checkMembers = (members) => {
      for (const member of members) {
        // Only declared (non-computed) prop signatures carry a public name.
        // Index signatures (`[k: string]`) and computed keys (`[SYM]`) are not
        // the named prop surface — skip them rather than mis-read the key.
        if (member.type !== 'TSPropertySignature' || member.computed || !member.key) continue
        const name = memberName(member.key)
        if (name === undefined) continue
        if (BANNED_MEMBER_NAMES.has(name) || DOM_EVENT_HANDLER.test(name)) {
          context.report({ node: member, messageId: 'domMember', data: { name } })
        }
        const ann = member.typeAnnotation?.typeAnnotation
        if (ann?.type === 'TSTypeReference' && typeReferenceName(ann) === 'CSSProperties') {
          context.report({ node: member, messageId: 'cssPropertiesType', data: { name } })
        }
      }
    }

    // Report a DOM-attribute base referenced by a TSTypeReference (intersection
    // member or interface-heritage expression resolves to a name we test here).
    const checkBaseName = (baseName, propsName, node) => {
      if (isDomBaseName(baseName)) {
        context.report({
          node,
          messageId: 'domExtends',
          data: { name: propsName, base: baseName },
        })
      }
    }

    return {
      TSInterfaceDeclaration(node) {
        if (!isExported(node) || !isPropsName(node)) return
        checkMembers(node.body.body)
        // typescript-eslint always provides `extends` as an array ([] when the
        // interface has no heritage clause), so no nullish guard is needed.
        for (const heritage of node.extends) {
          // TSInterfaceHeritage.expression is the base type Identifier.
          const expr = heritage.expression
          if (expr.type === 'Identifier') checkBaseName(expr.name, node.id.name, heritage)
        }
      },
      TSTypeAliasDeclaration(node) {
        if (!isExported(node) || !isPropsName(node)) return
        const ann = node.typeAnnotation
        if (ann.type === 'TSTypeLiteral') {
          checkMembers(ann.members)
        } else if (ann.type === 'TSIntersectionType') {
          for (const part of ann.types) {
            if (part.type === 'TSTypeLiteral') {
              checkMembers(part.members)
            } else if (part.type === 'TSTypeReference') {
              checkBaseName(typeReferenceName(part), node.id.name, part)
            }
          }
        }
      },
    }
  },
}
