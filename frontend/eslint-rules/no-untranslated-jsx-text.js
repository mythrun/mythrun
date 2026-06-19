/**
 * ESLint rule: no-untranslated-jsx-text
 *
 * The authoritative, complete JSX-child-text rail: no bare user-facing text in
 * JSX children — use t() or <Trans>. Closes the template-literal-child hole the
 * eslint-plugin-i18next rail skips (should-validate-template:false), and covers
 * every component shape (no all-caps-const scope-skip blind spot).
 *
 * Reports (in a JSXElement/JSXFragment child position, with no <Trans> ancestor):
 *   - a non-whitespace JSXText node
 *   - a string Literal inside a child JSXExpressionContainer
 *   - a TemplateLiteral inside a child JSXExpressionContainer that has static text
 * Allows: whitespace-only text, numeric/expression children (`{count}`,
 *   `{t('k')}`), interpolation-only templates (`{`${x}`}`), and any descendant
 *   of <Trans>. Attribute literals belong to the eslint-plugin-i18next rail.
 *
 * @type {import('eslint').Rule.RuleModule}
 */
export const noUntranslatedJsxText = {
  meta: {
    type: 'problem',
    docs: {
      description: 'Disallow bare user-facing text in JSX children; use t() or <Trans>.',
    },
    schema: [],
    messages: {
      bareText:
        'Bare JSX text is un-keyed user-facing copy. Use t(\'key\') or <Trans>. (True one-off: `// eslint-disable-next-line mythrun-ui/no-untranslated-jsx-text -- <reason>`.)',
    },
  },
  create(context) {
    const isTransEl = (el) =>
      el.type === 'JSXElement' && el.openingElement.name.name === 'Trans'

    const hasTransAncestor = (node) => {
      for (let p = node.parent; p; p = p.parent) {
        if (isTransEl(p)) return true
      }
      return false
    }

    const isChildContainer = (node) =>
      node.parent.type === 'JSXElement' || node.parent.type === 'JSXFragment'

    // `cooked` is always a string here: it is null only for invalid escape
    // sequences, which the parser permits solely in TAGGED templates (a
    // TaggedTemplateExpression — a different node type that never reaches this
    // helper). An untagged child template with a bad escape is a parse error.
    const hasStaticText = (tpl) =>
      tpl.quasis.some((q) => q.value.cooked.trim() !== '')

    return {
      JSXText(node) {
        if (node.value.trim() === '') return
        if (hasTransAncestor(node)) return
        context.report({ node, messageId: 'bareText' })
      },
      JSXExpressionContainer(node) {
        if (!isChildContainer(node)) return
        if (hasTransAncestor(node)) return
        const expr = node.expression
        if (expr.type === 'Literal' && typeof expr.value === 'string') {
          context.report({ node, messageId: 'bareText' })
        } else if (expr.type === 'TemplateLiteral' && hasStaticText(expr)) {
          context.report({ node, messageId: 'bareText' })
        }
      },
    }
  },
}
