const { RuleTester } = require('eslint')
const rule = require('../no-stripe-price-mutations.cjs')

const tester = new RuleTester({
  languageOptions: { ecmaVersion: 2024, sourceType: 'module' },
})

tester.run('no-stripe-price-mutations', rule, {
  valid: [
    'stripe.prices.list({})',
    'stripe.prices.retrieve("price_x")',
    'stripe.products.retrieve("prod_x")',
    'stripe.subscriptions.update(id, { cancel_at_period_end: true })',
    'stripe.subscriptions.update(id, { metadata: {} })',
    'stripe.subscriptions.update(id, { pause_collection: {} })',
    'stripe.subscriptions.cancel(id)',
    'stripe.checkout.sessions.create({})',
    'stripe.billingPortal.sessions.create({})',
    'stripe.webhooks.constructEvent(body, sig, secret)',
    'stripe.customers.create({})',
    'stripe.customers.retrieve("cus_x")',
    'stripe.customers.update("cus_x", {})',
  ],
  invalid: [
    { code: 'stripe.prices.create({})', errors: [{ messageId: 'banned' }] },
    { code: 'stripe.prices.update("price_x", {})', errors: [{ messageId: 'banned' }] },
    {
      code: 'stripe.prices.update("price_x", { active: false })',
      errors: [{ messageId: 'banned' }],
    },
    { code: 'stripe.products.create({})', errors: [{ messageId: 'banned' }] },
    { code: 'stripe.products.update("prod_x", {})', errors: [{ messageId: 'banned' }] },
    { code: 'stripe.products.del("prod_x")', errors: [{ messageId: 'banned' }] },
    { code: 'stripe.coupons.create({})', errors: [{ messageId: 'banned' }] },
    { code: 'stripe.coupons.update("coupon_x", {})', errors: [{ messageId: 'banned' }] },
    { code: 'stripe.coupons.del("coupon_x")', errors: [{ messageId: 'banned' }] },
    { code: 'stripe.promotionCodes.create({})', errors: [{ messageId: 'banned' }] },
    { code: 'stripe.promotionCodes.update("promo_x", {})', errors: [{ messageId: 'banned' }] },
  ],
})

console.log('no-stripe-price-mutations: all RuleTester cases passed')
