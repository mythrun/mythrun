// backend/src/auth/jwt-plugin.ts
//
// Real Cognito JWT validation plugin. Hydrates JWKS at registration
// (with 0-1s jitter to spread thundering-herd, 10s timeout to bound
// the boot-failure case). Per-request: validates the access token,
// attaches claims-only request.user.
//
// Spec: docs/superpowers/specs/2026-04-30-myt-37-jwt-middleware-design.md §5.

import { CognitoJwtVerifier } from 'aws-jwt-verify'
import type { FastifyPluginAsync } from 'fastify'
import fastifyPlugin from 'fastify-plugin'
import { REGISTERED_DECORATOR } from './constants.js'
import type { AuthUser, JwtVerifier } from './types.js'

export interface JwtPluginOptions {
  userPoolId: string
  appClientId: string
}

const jwtPluginImpl: FastifyPluginAsync<JwtPluginOptions> = async (app, opts) => {
  if (app.hasDecorator(REGISTERED_DECORATOR)) {
    throw new Error('jwtPlugin: auth is already registered on this Fastify instance')
  }
  app.decorate(REGISTERED_DECORATOR, 'jwt' as const)

  const verifier = CognitoJwtVerifier.create({
    userPoolId: opts.userPoolId,
    clientId: opts.appClientId,
    tokenUse: 'access',
  })

  // Pre-fetch JWKS at registration so the FIRST protected request after
  // every cold start doesn't pay the JWKS fetch latency.
  // Jitter (0-1s) spreads simultaneous container-start fetches.
  // Promise.race timeout (10s) bounds the boot-failure case.
  // The .catch(() => {}) BEFORE Promise.race prevents unhandled-rejection
  // crashes if the timer wins and the underlying hydrate rejects late.
  await new Promise((resolve) => setTimeout(resolve, Math.random() * 1000))
  let hydrateTimer: NodeJS.Timeout | undefined
  const hydratePromise = verifier.hydrate()
  hydratePromise.catch(() => {
    // Swallow late rejection from the loser path; the boot has already
    // failed via Promise.race or the catch below logged + threw.
  })
  const timeoutPromise = new Promise<never>((_, reject) => {
    hydrateTimer = setTimeout(() => {
      reject(new Error('verifier.hydrate() timed out after 10s — Cognito JWKS unreachable'))
    }, 10_000)
  })
  try {
    await Promise.race([hydratePromise, timeoutPromise])
  } catch (err) {
    const issuer = `https://cognito-idp.${process.env.AWS_REGION ?? 'us-east-1'}.amazonaws.com/${opts.userPoolId}`
    app.log.error(
      {
        event: 'auth.jwks_hydrate_failed',
        issuer,
        errorClass: err instanceof Error ? err.constructor.name : 'Unknown',
      },
      'JWKS hydrate failed at boot',
    )
    throw err
  } finally {
    if (hydrateTimer) clearTimeout(hydrateTimer)
  }

  if (app.hasDecorator('jwtVerifier')) {
    throw new Error('jwtPlugin: app.jwtVerifier is already decorated — likely double-registration')
  }
  const jwtVerifier: JwtVerifier = {
    verify: (token) => verifier.verify(token),
  }
  app.decorate('jwtVerifier', jwtVerifier)

  app.addHook('onRequest', async (request, reply) => {
    // 404 fall-through: under setNotFoundHandler, `routeOptions.url` is
    // undefined. `routeOptions` itself is non-nullable per Fastify v5
    // types, so we only need the inner check.
    if (request.routeOptions.url === undefined) return

    const authMode = request.routeOptions.config.auth
    if (authMode === 'public') return

    const header = request.headers.authorization
    if (!header?.startsWith('Bearer ')) {
      return reply.code(401).send({ error: 'Missing Bearer token' })
    }
    const token = header.slice('Bearer '.length).trim()
    if (token.length === 0) {
      return reply.code(401).send({ error: 'Empty Bearer token' })
    }

    let payload
    try {
      payload = await verifier.verify(token)
    } catch (err) {
      request.log.warn(
        {
          event: 'auth.jwt_verify_failed',
          errorClass: err instanceof Error ? err.constructor.name : 'Unknown',
        },
        'JWT verification failed',
      )
      return reply.code(401).send({ error: 'Invalid token' })
    }

    if (typeof payload.sub !== 'string' || payload.sub.length === 0) {
      request.log.warn({ event: 'auth.jwt_missing_sub' }, 'JWT missing sub claim')
      return reply.code(401).send({ error: 'Invalid token' })
    }
    if (typeof payload.username !== 'string' || payload.username.length === 0) {
      request.log.warn({ event: 'auth.jwt_missing_username' }, 'JWT missing username claim')
      return reply.code(401).send({ error: 'Invalid token' })
    }

    const user: AuthUser = {
      sub: payload.sub,
      cognitoUsername: payload.username,
      scopes:
        typeof payload.scope === 'string' && payload.scope.length > 0
          ? Object.freeze(payload.scope.split(' '))
          : Object.freeze([]),
    }
    request.user = user
  })
}

// fastify-plugin wrapper: tells Fastify to skip the encapsulation wrapping
// so the hook + decorator apply at the parent app's scope (where /health,
// /health/ready, and all future protected routes live). Without this
// wrapper, the hook would only apply to the plugin's child scope and every
// route registered on the parent app would silently bypass auth.
export const jwtPlugin = fastifyPlugin(jwtPluginImpl, {
  fastify: '5.x',
  name: 'mythrun-auth-jwt',
})
