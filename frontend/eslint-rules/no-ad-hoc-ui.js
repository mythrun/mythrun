/**
 * ESLint rule: no-ad-hoc-ui
 *
 * Feature code composes @mythrun/ui components (and fragments) only. Raw DOM
 * markup, inline styles, and raw Tailwind classes are ad-hoc UI. This rule is
 * OFF in the library zone (frontend/ui/**), where those legitimately live.
 *
 * Detection (pure AST shape — no type info):
 *  - intrinsic lowercase JSX elements (<div>, <button>, ...)   → rawElement
 *  - `style` attribute                                          → styleAttr
 *  - `className` attribute                                      → classNameAttr
 * Allowed: fragments (no opening identifier), component elements
 * (capitalized identifier or member expression).
 *
 * @type {import('eslint').Rule.RuleModule}
 */
export const noAdHocUi = {
  meta: {
    type: 'problem',
    docs: {
      description:
        'Disallow ad-hoc UI (raw DOM elements, inline styles, className) in feature code; compose @mythrun/ui.',
    },
    schema: [],
    messages: {
      rawElement:
        'Raw DOM element <{{name}}> is ad-hoc UI. Compose a @mythrun/ui component instead. (True one-off: `// eslint-disable-next-line mythrun-ui/no-ad-hoc-ui -- <reason>`.)',
      styleAttr: 'Inline `style` is ad-hoc UI. Use @mythrun/ui component props instead.',
      classNameAttr:
        '`className` (raw Tailwind) is banned in feature code. Use @mythrun/ui component props instead.',
    },
  },
  create(context) {
    return {
      JSXOpeningElement(node) {
        if (node.name.type === 'JSXIdentifier' && /^[a-z]/.test(node.name.name)) {
          context.report({ node, messageId: 'rawElement', data: { name: node.name.name } })
        }
      },
      JSXAttribute(node) {
        if (node.name.type !== 'JSXIdentifier') return
        if (node.name.name === 'style') {
          context.report({ node, messageId: 'styleAttr' })
        } else if (node.name.name === 'className') {
          context.report({ node, messageId: 'classNameAttr' })
        }
      },
    }
  },
}
