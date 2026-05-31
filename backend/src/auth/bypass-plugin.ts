// backend/src/auth/bypass-plugin.ts
//
// Development-only auth bypass plugin. Multi-layer defense prevents
// activation in any AWS-managed runtime even with coordinated misconfig:
//   Layer 2a: NODE_ENV must be 'development' or 'test' (allow-list, not block-list)
//   Layer 2b: HTTP probe to ECS task-metadata endpoint must FAIL (proves not on ECS)
//   Layer 3:  No Cognito config in plumbed opts OR raw process.env
//   Layer 4:  Loud structured-log warning at registration
//   Layer 5:  Terraform serving-module forces AUTH_MODE=real and NODE_ENV=production
//   Layer 6:  Tests verify every gate
//
// Spec: docs/superpowers/specs/2026-04-30-myt-37-jwt-middleware-design.md §4 + §6.

import os from 'node:os'
import type { FastifyPluginAsync } from 'fastify'
import fastifyPlugin from 'fastify-plugin'
import { REGISTERED_DECORATOR } from './constants.js'
import type { AuthUser } from './types.js'

// myth-yetw: derive the default bypass sub from os.hostname() so that
// multiple devs sharing a dev DB (or a staging DB) each register a distinct
// users row instead of all colliding on a single `bypass:dev-1` literal.
//
// CRITICAL: the `bypass:` prefix is preserved. It's keyed on by dev-credits,
// the rejection-storm per-sub counters, and the sibling users.cognito_sub
// `NOT LIKE 'bypass:%'` CHECK constraint work (myth-sea4). Only the suffix
// varies per machine.
const BYPASS_SUB_PREFIX = 'bypass:'
// Test/CI determinism override ONLY. When set, the bypass sub is this value
// verbatim, bypassing hostname derivation. The integration suite pins this
// to `bypass:dev-1` (in src/__tests__/setup-env.ts) so the many test files
// that hardcode that sub + mock getByCognitoSub on it keep passing across
// machines. Production and ordinary dev never set this → hostname-derived
// per-machine subs, as designed. Read at registration time, same as the
// hostname path.
const BYPASS_SUB_ENV = 'MYTHRUN_BYPASS_SUB'
// Bound the derived slug so a pathologically long hostname can't produce an
// unbounded sub. 64 chars of slug is plenty to keep machines distinct.
const MAX_SLUG_LEN = 64
// Stable fallback when a hostname sanitizes to empty (e.g. all-unsafe chars)
// so the sub is always valid and non-empty.
const EMPTY_HOSTNAME_FALLBACK = 'dev'

/** Sanitize a raw hostname into a safe, stable sub slug: lowercase, replace
 *  any run of non-[a-z0-9] characters with a single dash, trim leading and
 *  trailing dashes, bound length, and fall back to a stable token when the
 *  result is empty. Pure + deterministic — same hostname → same slug. */
const sanitizeHostname = (hostname: string): string => {
  const slug = hostname
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, MAX_SLUG_LEN)
    .replace(/-+$/g, '')
  return slug.length > 0 ? slug : EMPTY_HOSTNAME_FALLBACK
}

/** Build the default bypass user for this machine, `bypass:` prefix
 *  preserved. Called at plugin-registration time (not module load) so both
 *  the MYTHRUN_BYPASS_SUB override and the hostname are read when the app
 *  boots. The override (test/CI determinism only) wins; otherwise the sub is
 *  hostname-derived per machine. The static `bypass_dev_1` cognitoUsername
 *  stays fixed — only the identity-bearing `sub` varies. */
const buildBypassUser = (): AuthUser =>
  Object.freeze({
    sub: process.env[BYPASS_SUB_ENV] ?? `${BYPASS_SUB_PREFIX}${sanitizeHostname(os.hostname())}`,
    cognitoUsername: 'bypass_dev_1',
    scopes: Object.freeze(['bypass']),
  })

export interface BypassPluginOptions {
  /** Plumbed in from loadEnv. Layer 3 rejects if any are populated. */
  cognitoUserPoolId?: string
  cognitoAppClientId?: string
  cognitoIssuerUrl?: string
  cognitoHostedUiDomain?: string
}

const bypassPluginImpl: FastifyPluginAsync<BypassPluginOptions> = async (app, opts) => {
  if (app.hasDecorator(REGISTERED_DECORATOR)) {
    throw new Error('bypassPlugin: auth is already registered on this Fastify instance')
  }
  app.decorate(REGISTERED_DECORATOR, 'bypass' as const)

  // Layer 2a: NODE_ENV allow-list.
  const nodeEnv = process.env.NODE_ENV
  if (nodeEnv !== 'development' && nodeEnv !== 'test') {
    throw new Error(
      `auth bypass plugin: NODE_ENV must be 'development' or 'test' (got ${JSON.stringify(nodeEnv)})`,
    )
  }

  // Layer 2b: HTTP probe to ECS task-metadata endpoint. The link-local IP
  // 169.254.170.2 is served by the ECS agent; not addressable from local
  // dev. Probe success → we're on ECS → throw. Probe failure → we're not
  // on ECS → proceed.
  const controller = new AbortController()
  const probeTimer = setTimeout(() => {
    controller.abort()
  }, 1000)
  try {
    const response = await fetch('http://169.254.170.2/v2/metadata', {
      signal: controller.signal,
    })
    if (response.ok) {
      throw new Error(
        'auth bypass plugin: ECS task-metadata endpoint reachable — bypass forbidden in any ECS runtime',
      )
    }
    throw new Error(
      `auth bypass plugin: ECS task-metadata endpoint responded (status ${String(response.status)}) — bypass forbidden`,
    )
  } catch (err) {
    if (err instanceof Error && err.message.startsWith('auth bypass plugin:')) {
      throw err
    }
    // Probe failed (refused / timeout / DNS) — not on ECS, proceed.
  } finally {
    clearTimeout(probeTimer)
  }

  // Layer 3: No Cognito config in plumbed opts OR raw process.env.
  const populatedFromOpts = (
    [
      ['cognitoUserPoolId', opts.cognitoUserPoolId],
      ['cognitoAppClientId', opts.cognitoAppClientId],
      ['cognitoIssuerUrl', opts.cognitoIssuerUrl],
      ['cognitoHostedUiDomain', opts.cognitoHostedUiDomain],
    ] as const
  )
    .filter(([, v]) => Boolean(v))
    .map(([k]) => k)
  const COGNITO_KEYS = [
    'COGNITO_USER_POOL_ID',
    'COGNITO_APP_CLIENT_ID',
    'COGNITO_ISSUER_URL',
    'COGNITO_HOSTED_UI_DOMAIN',
  ] as const
  const populatedFromEnv = COGNITO_KEYS.filter((k) => Boolean(process.env[k]))
  if (populatedFromOpts.length > 0 || populatedFromEnv.length > 0) {
    const optsList = populatedFromOpts.length > 0 ? populatedFromOpts.join(', ') : 'none'
    const envList = populatedFromEnv.length > 0 ? populatedFromEnv.join(', ') : 'none'
    throw new Error(
      `auth bypass plugin: bypass forbidden — Cognito config present (opts: ${optsList}; env: ${envList})`,
    )
  }

  // Build the default bypass user once per registration (hostname read at
  // boot, not module load — see buildBypassUser). The hook closes over this.
  const bypassUser = buildBypassUser()

  // Layer 4: loud, structured warning at registration.
  app.log.warn(
    { event: 'auth.bypass_mode_active', sub: bypassUser.sub },
    'AUTH BYPASS MODE: all requests authenticated as dev user. NEVER run in staging/production.',
  )

  // The onRequest hook is `async` (no awaits today) so a thrown error
  // surfaces as a Promise rejection → Fastify's 500 path. The bypass tests
  // assert this for the per-request NODE_ENV-mutation gate.
  // eslint-disable-next-line @typescript-eslint/require-await
  app.addHook('onRequest', async (request) => {
    // 404 fall-through: under setNotFoundHandler, `routeOptions.url` is
    // undefined. `routeOptions` itself is non-nullable per Fastify v5
    // types, so we only need the inner check.
    if (request.routeOptions.url === undefined) return
    if (request.routeOptions.config.auth === 'public') return

    // Per-request re-check of Layers 2a + 3. Belt-and-suspenders against
    // some future code path mutating process.env at runtime. Layer 2b
    // (HTTP probe) is NOT re-checked per request — too expensive.
    const requestNodeEnv = process.env.NODE_ENV
    if (requestNodeEnv !== 'development' && requestNodeEnv !== 'test') {
      throw new Error(
        `auth bypass plugin: NODE_ENV must be 'development' or 'test' at request time (got ${JSON.stringify(requestNodeEnv)})`,
      )
    }
    const anyCognitoSet = [
      opts.cognitoUserPoolId,
      opts.cognitoAppClientId,
      opts.cognitoIssuerUrl,
      opts.cognitoHostedUiDomain,
      process.env.COGNITO_USER_POOL_ID,
      process.env.COGNITO_APP_CLIENT_ID,
      process.env.COGNITO_ISSUER_URL,
      process.env.COGNITO_HOSTED_UI_DOMAIN,
    ].some((v) => Boolean(v))
    if (anyCognitoSet) {
      throw new Error('auth bypass plugin: Cognito config observed at request time')
    }

    // Per-request sub override via the `x-mythrun-dev-sub` header. Tests
    // that exercise per-sub-keyed flows (rate-limit per-sub keying after
    // MYT-45, future ownership-matrix tests) need unique subs per test;
    // without the override, every bypass request collapses to the
    // hostname-derived default and per-sub counters / lookups bleed across
    // tests. Production never sees this header because bypass is gated by
    // Layers 2a/2b/3 — only fires in NODE_ENV=development|test off-ECS
    // with no Cognito config.
    const subHeader = request.headers['x-mythrun-dev-sub']
    const overrideSub = typeof subHeader === 'string' && subHeader.length > 0 ? subHeader : null
    if (overrideSub !== null) {
      request.user = Object.freeze({ ...bypassUser, sub: overrideSub })
    } else {
      request.user = bypassUser
    }
  })
}

// fastify-plugin wrapper: tells Fastify to skip the encapsulation wrapping
// so the hook + decorator apply at the parent app's scope (where /health,
// /health/ready, and all future protected routes live). Without this
// wrapper, the hook would only apply to the plugin's child scope and every
// route registered on the parent app would silently bypass auth.
export const bypassPlugin = fastifyPlugin(bypassPluginImpl, {
  fastify: '5.x',
  name: 'mythrun-auth-bypass',
})
