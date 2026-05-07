// This file deliberately contains a banned pattern to exercise the
// no-stripe-price-mutations rule via the project's eslint.config.js.
// If lint passes on this file, the rule is shipped but not registered.
//
// .mjs (not .ts) so the type-aware ESLint parser doesn't need this file
// in tsconfig — the rule fires on the AST shape, regardless of language.

const stripe = { prices: { create: (input) => input } }
stripe.prices.create({})
