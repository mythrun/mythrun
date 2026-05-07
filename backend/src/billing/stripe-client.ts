// Module-level cached client. Tests that need a different env must mock
// the Stripe SDK at the import boundary (vitest's vi.mock), not reach into
// this cache. The cache is process-scoped; rotation requires a process
// restart (ECS rolling deploy after Secrets Manager update).

import Stripe from 'stripe'
import type { Env } from '../config/env.js'

// Pin to the latest Stripe API release line as of MYT-41 design (2026-05).
// Bumping this is a deliberate spec patch — it changes webhook payload
// shapes and field names, and the SDK type-narrows apiVersion to the
// literal union of valid versions, so a wrong string fails tsc.
//
// Cadence: review Stripe's API changelog every 6 months as routine
// maintenance; bump only when there's a feature we need or a breaking
// change with a sunset date.
export const STRIPE_API_VERSION = '2026-04-22.dahlia' as const

let cached: Stripe | null = null

export function getStripeClient(env: Env): Stripe {
  cached ??= new Stripe(env.stripeSecretKey, {
    apiVersion: STRIPE_API_VERSION,
    typescript: true,
  })
  return cached
}
