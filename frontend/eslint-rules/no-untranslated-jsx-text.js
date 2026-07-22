/**
 * ESLint rule: no-untranslated-jsx-text
 *
 * The authoritative, complete JSX-child-text rail: no bare user-facing text in
 * JSX children — use t() or <Trans>. Closes the template-literal-child hole the
 * eslint-plugin-i18next rail skips (should-validate-template:false), and covers
 * every component shape (no all-caps-const scope-skip blind spot).
 *
 * Reports (in a JSXElement/JSXFragment child position, with no <Trans> and no
 * aria-hidden ancestor):
 *   - a non-whitespace JSXText node
 *   - a string Literal inside a child JSXExpressionContainer
 *   - a TemplateLiteral inside a child JSXExpressionContainer that has static text
 * Allows: whitespace-only text (JSXText or a `{' '}` spacing literal),
 *   numeric/expression children (`{count}`,
 *   `{t('k')}`, `{props.label}`), interpolation-only templates (`{`${x}`}`), any
 *   descendant of <Trans>, and any descendant of an `aria-hidden` element
 *   (presentational glyphs — separators/chevrons/arrows — that assistive tech
 *   never reads and copy never translates). Attribute literals belong to the
 *   eslint-plugin-i18next rail.
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

    // An element is aria-hidden when it carries `aria-hidden` set to a STATIC
    // true: `aria-hidden="true"`, `aria-hidden={true}`, or the bare `aria-hidden`
    // (React coerces a valueless boolean attribute to true). A string `"false"`,
    // `{false}`, or a dynamic expression is NOT treated as hidden — fail closed
    // and flag the text. Spread attributes carry no static name and are skipped.
    const isAriaHiddenTrue = (openingElement) => {
      const attr = openingElement.attributes.find(
        (a) => a.type === 'JSXAttribute' && a.name.name === 'aria-hidden',
      )
      if (!attr) return false
      const v = attr.value
      if (v === null) return true
      if (v.type === 'Literal' && v.value === 'true') return true
      return (
        v.type === 'JSXExpressionContainer' &&
        v.expression.type === 'Literal' &&
        v.expression.value === true
      )
    }

    // Text is exempt when an ancestor either OWNS its translation (<Trans>) or is
    // aria-hidden (presentational — assistive tech never reads it, so copy never
    // translates it: decorative separators/chevrons/arrows). aria-hidden on the
    // element DIRECTLY wrapping the text (the common `<span aria-hidden>‹</span>`)
    // and on any ancestor both exempt, via the walk below.
    const isExemptAncestor = (el) =>
      el.type === 'JSXElement' && (isTransEl(el) || isAriaHiddenTrue(el.openingElement))

    const hasExemptAncestor = (node) => {
      for (let p = node.parent; p; p = p.parent) {
        if (isExemptAncestor(p)) return true
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
        if (hasExemptAncestor(node)) return
        context.report({ node, messageId: 'bareText' })
      },
      JSXExpressionContainer(node) {
        if (!isChildContainer(node)) return
        if (hasExemptAncestor(node)) return
        const expr = node.expression
        // A whitespace-only string literal is the `{' '}` JSX spacing idiom, not
        // copy — skip it, mirroring the JSXText whitespace skip above (templates
        // are already covered: hasStaticText trims). Keeps the two child-text
        // branches consistent about what "whitespace-only" means.
        if (expr.type === 'Literal' && typeof expr.value === 'string' && expr.value.trim() !== '') {
          context.report({ node, messageId: 'bareText' })
        } else if (expr.type === 'TemplateLiteral' && hasStaticText(expr)) {
          context.report({ node, messageId: 'bareText' })
        }
      },
    }
  },
}
