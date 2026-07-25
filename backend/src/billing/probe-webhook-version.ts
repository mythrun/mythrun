// Boot-time assertion that every enabled Stripe webhook endpoint is pinned
// to the SDK's STRIPE_API_VERSION (myth-e3ary). Called from
// probeStripeContract; split out of probe.ts to keep that module under the
// 400-line ceiling.

import Stripe from 'stripe'
import type { Logger } from 'pino'
import { STRIPE_API_VERSION } from './stripe-client.js'

// Matches the budget the price / portal probes use. Boot checks get a short
// leash: a slow Stripe must not stretch container startup.
const WEBHOOK_PROBE_TIMEOUT_MS = 7000

export class BillingProbeWebhookVersionError extends Error {
  readonly code = 'BILLING_PROBE_WEBHOOK_VERSION'
  constructor(
    readonly mismatches: readonly string[],
    readonly bootId: string,
  ) {
    super(
      `Stripe billing probe failed (webhook endpoint api_version drift) [boot=${bootId}]:\n  ${mismatches.join('\n  ')}\n` +
        `Every enabled endpoint must be pinned to '${STRIPE_API_VERSION}'. Events are rendered once, at the endpoint's version, and cannot be re-rendered on retrieval — a drifted endpoint means dispatchEvent drops every delivery (200, no grant).`,
    )
    this.name = 'BillingProbeWebhookVersionError'
  }
}

/**
 * Assert every ENABLED v1 webhook endpoint is pinned to STRIPE_API_VERSION.
 *
 * Why this has to be a boot check and not a dispatch-time repair: a Stripe
 * Event is immutable. It is rendered once, at the delivering endpoint's
 * api_version, and `GET /v1/events/:id` returns those exact bytes no matter
 * what Stripe-Version the request carries (verified against the live
 * account — the payload is byte-identical across a 2024-06-20 →
 * 2026-04-22.dahlia request-version span, while the same header
 * demonstrably re-renders a Subscription). So if an endpoint's version
 * drifts from the SDK pin, `dispatchEvent` can only fail closed: every
 * delivery is acked with a 200 and no handler runs, which means paid
 * customers are silently never credited. Refusing to boot is what keeps
 * that configuration out of production — the boot-gate turns this throw
 * into a non-zero exit and ECS rolls the deploy back.
 *
 * Three deliberate non-failures, because each would take the service down
 * for something that is not evidence of drift:
 *
 *   - EMPTY LIST. `stripe listen` forwards without registering an endpoint
 *     (the whole local dev flow), and Stripe's v2 event destinations do not
 *     appear in this v1 list at all. Absence proves nothing.
 *   - PERMISSION DENIED. Production runs a restricted key; if it lacks the
 *     `webhook_endpoints: read` scope we degrade to a warn rather than
 *     crashloop on a missing scope. (This diverges from the prices/portal
 *     probes, where auth failure IS fatal — those gate checkout itself.)
 *     Grant that scope to arm this gate in production.
 *   - TRANSIENT STRIPE ERROR. Single-shot: a Stripe blip must not block a
 *     rollout on a check that is defense-in-depth.
 *
 * In all three cases the runtime `stripe_webhook_api_version_mismatch` log
 * and its CloudWatch alarm (myth-89am) remain the backstop.
 */
export async function probeWebhookEndpointVersion(
  stripe: Stripe,
  logger: Logger,
  bootId: string,
): Promise<void> {
  let result: Stripe.ApiList<Stripe.WebhookEndpoint>
  try {
    result = await stripe.webhookEndpoints.list(
      { limit: 100 },
      { timeout: WEBHOOK_PROBE_TIMEOUT_MS },
    )
  } catch (err) {
    // Split permission from everything else: the two have completely
    // different fixes (grant a scope vs wait for Stripe), and an operator
    // reading the warn should not have to infer which one they hit.
    const isPermission =
      err instanceof Stripe.errors.StripeAuthenticationError ||
      err instanceof Stripe.errors.StripePermissionError
    logger.warn(
      {
        event: 'billing.probe_webhook_version_unavailable',
        bootId,
        // Neither branch is a config verdict — we did not learn whether the
        // endpoints are pinned correctly, so the boot proceeds and the
        // runtime alarm carries the risk.
        classification: isPermission ? 'permission' : 'transient',
        remedy: isPermission
          ? 'grant the `webhook_endpoints: read` scope on STRIPE_SECRET_KEY to arm this gate'
          : 'transient Stripe/network failure; the gate re-arms on the next boot',
        err: err instanceof Error ? err.message : String(err),
      },
      'Stripe webhook endpoint api_version could not be verified; boot continues, relying on the runtime mismatch alarm',
    )
    return
  }

  // Disabled endpoints deliver nothing, so their version cannot drop revenue.
  const enabled = result.data.filter((e) => e.status === 'enabled')
  if (enabled.length === 0) {
    logger.info(
      { event: 'billing.probe_webhook_version_skipped', bootId, count: result.data.length },
      'No enabled v1 Stripe webhook endpoints registered; skipping api_version check',
    )
    return
  }

  const mismatches: string[] = []
  for (const endpoint of enabled) {
    if (endpoint.api_version === null) {
      // Unpinned: the endpoint follows the account default, so it can drift
      // under us with no deploy of ours. Not safe even when today's default
      // happens to match.
      mismatches.push(
        `webhook endpoint '${endpoint.id}' (${endpoint.url}) has no pinned api_version — it follows the Stripe account default and can drift without a deploy; pin it to '${STRIPE_API_VERSION}'`,
      )
    } else if (endpoint.api_version !== STRIPE_API_VERSION) {
      mismatches.push(
        `webhook endpoint '${endpoint.id}' (${endpoint.url}) is pinned to api_version '${endpoint.api_version}' but the SDK pin is '${STRIPE_API_VERSION}'`,
      )
    }
  }

  if (mismatches.length > 0) {
    logger.error(
      {
        event: 'billing.probe_webhook_version_failed',
        bootId,
        // CONFIG, not transient. Retrying this boot will produce the same
        // answer forever — the crashloop is the intended behaviour, and the
        // only thing that clears it is a change on the Stripe side. Stated
        // explicitly so nobody reads the restart loop as a flaky dependency
        // and tries to wait it out.
        classification: 'config',
        remedy:
          "pin the endpoint's api_version to STRIPE_API_VERSION; api_version is create-only on the Stripe API, so this generally means creating a replacement endpoint and rotating its signing secret",
        expected_api_version: STRIPE_API_VERSION,
        mismatchCount: mismatches.length,
        mismatches,
      },
      'Stripe webhook endpoint api_version drift — deliveries would be dropped uncredited; failing the boot deliberately',
    )
    throw new BillingProbeWebhookVersionError(mismatches, bootId)
  }

  logger.info(
    {
      event: 'billing.probe_webhook_version_passed',
      bootId,
      count: enabled.length,
      apiVersion: STRIPE_API_VERSION,
    },
    'Stripe webhook endpoint api_version verified',
  )
}
