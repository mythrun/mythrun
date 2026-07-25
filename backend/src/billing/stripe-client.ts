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
//
// BEFORE YOU BUMP THIS (myth-e3ary — this is revenue-critical):
//
// This pin must equal the api_version of every enabled Stripe webhook
// endpoint. Bumping it here alone silently breaks the money path: the
// dispatcher fail-closes on any event whose api_version != this value
// (backend/src/billing/webhook.ts), so every delivery is acked 200 with no
// handler run and paid customers are charged and never credited.
//
// You cannot fix that after the fact by re-fetching the event. A Stripe
// Event is IMMUTABLE — it is rendered once, at the delivering endpoint's
// api_version, and `GET /v1/events/:id` returns those exact bytes whatever
// Stripe-Version the request carries. Verified against the live account:
// the retrieved payload is byte-identical across a 2024-06-20 →
// 2026-04-22.dahlia request-version span, while the same header
// demonstrably re-renders a Subscription (current_period_* moves between
// the subscription and its items). Stripe's own docs: "The contents of
// `data` never change, so this value remains static regardless of the API
// version currently in use." Re-rendering objects works; re-rendering
// events does not. Don't reach for stripe.events.retrieve() here — it is a
// dead end that looks like a fix.
//
// And an endpoint's api_version is CREATE-ONLY (the update call accepts
// only url / enabled_events / description / disabled / metadata), so
// realigning an endpoint generally means creating a replacement, moving its
// new signing secret into Secrets Manager, and retiring the old one.
//
// So a bump is a coordinated change, not a one-line edit: new endpoint at
// the new version + signing-secret rotation + this constant, deployed
// together. probeStripeContract asserts the two agree at boot and refuses
// to start on a mismatch, which is what stops a half-done bump from
// reaching production.
export const STRIPE_API_VERSION = '2026-04-22.dahlia' as const

let cached: Stripe | null = null

export function getStripeClient(env: Env): Stripe {
  cached ??= new Stripe(env.stripeSecretKey, {
    apiVersion: STRIPE_API_VERSION,
    typescript: true,
  })
  return cached
}
