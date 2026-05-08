// ESLint rule: no-stripe-subscription-price-mutation
//
// Closes the price-change-via-subscription-item-mutation backdoor:
//   stripe.subscriptions.update(id, { items: [{ price: 'price_X' }] })
//
// The restricted API key permits Subscriptions: write (needed for
// cancel_at_period_end and admin fraud cancellation), so this is one of
// the few mutation paths still possible from the SDK. Mythrun's tier-
// switching flow goes through Customer Portal exclusively (per spec §6);
// app code does NOT initiate item-price mutations. This rule enforces.
//
// Conservative match: any `stripe.subscriptions.update` call whose first
// argument-after-id is an object with an `items` array, where any element
// is an object containing a `price` property. Quantity-only item updates
// (no `price` key) are allowed.

module.exports = {
  meta: {
    type: 'problem',
    docs: {
      description:
        'Ban subscription item-price mutations. Tier-switching goes through Customer Portal, not app code.',
    },
    schema: [],
    messages: {
      banned:
        'stripe.subscriptions.update with items[].price is forbidden — tier-switching goes through Customer Portal exclusively (per MYT-41 spec §6). Other update fields (cancel_at_period_end, metadata, pause_collection, items[].quantity) are fine.',
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
          callee.object.property.name !== 'subscriptions' ||
          callee.property.type !== 'Identifier' ||
          callee.property.name !== 'update'
        ) {
          return
        }
        // stripe.subscriptions.update(id, body) — body is arg[1]
        const body = node.arguments[1]
        if (!body || body.type !== 'ObjectExpression') return
        for (const prop of body.properties) {
          if (
            prop.type === 'Property' &&
            prop.key.type === 'Identifier' &&
            prop.key.name === 'items' &&
            prop.value.type === 'ArrayExpression'
          ) {
            for (const elem of prop.value.elements) {
              if (!elem || elem.type !== 'ObjectExpression') continue
              for (const itemProp of elem.properties) {
                if (
                  itemProp.type === 'Property' &&
                  itemProp.key.type === 'Identifier' &&
                  itemProp.key.name === 'price'
                ) {
                  context.report({ node, messageId: 'banned' })
                  return
                }
              }
            }
          }
        }
      },
    }
  },
}
