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

import type { FastifyPluginAsync } from 'fastify'
import fastifyPlugin from 'fastify-plugin'
import { REGISTERED_DECORATOR } from './constants.js'
import type { AuthUser } from './types.js'

const BYPASS_USER: AuthUser = {
  sub: 'bypass:dev-1',
  cognitoUsername: 'bypass_dev_1',
  scopes: Object.freeze(['bypass']),
}

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

  // Layer 4: loud, structured warning at registration.
  app.log.warn(
    { event: 'auth.bypass_mode_active' },
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

    request.user = BYPASS_USER
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
