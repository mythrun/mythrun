const { RuleTester } = require('eslint')
const rule = require('../no-stripe-subscription-price-mutation.cjs')

const tester = new RuleTester({
  languageOptions: { ecmaVersion: 2024, sourceType: 'module' },
})

tester.run('no-stripe-subscription-price-mutation', rule, {
  valid: [
    'stripe.subscriptions.update(id, { cancel_at_period_end: true })',
    'stripe.subscriptions.update(id, { metadata: {} })',
    'stripe.subscriptions.update(id, { pause_collection: {} })',
    'stripe.subscriptions.update(id, { items: [{ quantity: 2 }] })',
    'stripe.subscriptions.cancel(id)',
    'stripe.subscriptions.retrieve(id)',
    'stripe.checkout.sessions.create({ line_items: [{ price: "price_x" }] })',
  ],
  invalid: [
    {
      code: 'stripe.subscriptions.update(id, { items: [{ id: "si_x", price: "price_NEW" }] })',
      errors: [{ messageId: 'banned' }],
    },
    {
      code: 'stripe.subscriptions.update(id, { items: [{ price: someVar }] })',
      errors: [{ messageId: 'banned' }],
    },
    {
      code: 'stripe.subscriptions.update(id, { items: [{ price: lookupKeyToPrice() }] })',
      errors: [{ messageId: 'banned' }],
    },
  ],
})

console.log('no-stripe-subscription-price-mutation: all RuleTester cases passed')
