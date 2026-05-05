// ESLint rule: no-stripe-price-mutations
//
// Bans Stripe SDK calls that would mutate the price/product/coupon
// catalog. Pattern-matches MemberExpression chains:
//
//   stripe.<namespace>.<method>(...)
//
// Banned namespaces + methods (rule fires on the call expression):
//   prices.create, prices.update
//   products.create, products.update, products.del
//   coupons.create, coupons.update, coupons.del
//   promotionCodes.create, promotionCodes.update
//
// Pattern-evasion paths the rule does NOT catch (documented):
//   stripe['products']['create'](...)         — bracket access
//   const c = stripe.products.create.bind(...); c(...) — alias
//   (stripe as any).products.create(...)      — type-system bypass
//
// The actual SDK-level enforcement is the restricted Stripe API key
// (no Prices: write / Products: write permission); this rule is a
// code-review tripwire on top.

const BANNED = {
  prices:         new Set(['create', 'update']),
  products:       new Set(['create', 'update', 'del']),
  coupons:        new Set(['create', 'update', 'del']),
  promotionCodes: new Set(['create', 'update']),
}

module.exports = {
  meta: {
    type: 'problem',
    docs: { description: 'Ban Stripe price/product/coupon mutation calls.' },
    schema: [],
    messages: {
      banned:
        "Stripe price/product/coupon mutations are forbidden — use Dashboard / CLI. The restricted API key blocks these at the network level; this rule catches them at code review.",
    },
  },
  create(context) {
    return {
      CallExpression(node) {
        const callee = node.callee
        if (
          callee.type !== 'MemberExpression' ||
          callee.object.type !== 'MemberExpression' ||
          callee.object.object.type !== 'Identifier' ||
          callee.object.object.name !== 'stripe' ||
          callee.object.property.type !== 'Identifier' ||
          callee.property.type !== 'Identifier'
        ) {
          return
        }
        const namespace = callee.object.property.name
        const method = callee.property.name
        const banned = BANNED[namespace]
        if (banned && banned.has(method)) {
          context.report({ node, messageId: 'banned' })
        }
      },
    }
  },
}
