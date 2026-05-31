// backend/src/auth/jwt-plugin.ts
//
// Real Cognito JWT validation plugin. Hydrates JWKS at registration
// (with 0-1s jitter to spread thundering-herd, 10s timeout to bound
// the boot-failure case). Per-request: validates the access token,
// attaches claims-only request.user.
//
// Spec: docs/superpowers/specs/2026-04-30-myt-37-jwt-middleware-design.md §5.
//       MYT-37 design §11 (JWKS periodic refresh) — myth-jlx9.

import { CognitoJwtVerifier } from 'aws-jwt-verify'
import { SimpleJwksCache } from 'aws-jwt-verify/jwk'
import type { Jwks, JwksParser, JwkWithKid, PenaltyBox } from 'aws-jwt-verify/jwk'
import type { Fetcher } from 'aws-jwt-verify/https'
import type { FastifyPluginAsync } from 'fastify'
import fastifyPlugin from 'fastify-plugin'
import { REGISTERED_DECORATOR } from './constants.js'
import type { AuthUser, JwtVerifier } from './types.js'

/** Maximum age of a cached JWKS set before the next lookup forces a re-fetch.
 *  Bounds the key-compromise window: aws-jwt-verify's default SimpleJwksCache
 *  only re-fetches the JWKS on a cache MISS (an unknown `kid`), so an
 *  AWS-revoked-but-still-cached key stays verifiable until the container
 *  restarts. With this TTL, any revoked key is dropped from the cache within
 *  6h (the JWKS is periodically re-fetched), without paying a network fetch
 *  on every verification. See MYT-37 design §11. */
export const JWKS_MAX_AGE_MS = 6 * 60 * 60 * 1000

/** SimpleJwksCache that expires cached JWKS sets after JWKS_MAX_AGE_MS.
 *
 *  aws-jwt-verify's verify() path resolves keys via the cache's async
 *  `getJwk`, whose fast path returns a cached key for a known `kid` WITHOUT
 *  ever re-fetching — so a revoked key remains verifiable indefinitely. The
 *  single fetch chokepoint is `getJwks` (which `getJwk`, `hydrate()`, and the
 *  fast-path-miss branch all funnel through), so we:
 *    1. Stamp the per-URI fetch time in `getJwks` (the only place a real
 *       network fetch happens).
 *    2. In `getJwk`, when the cached entry is older than the TTL, force a
 *       `getJwks` re-fetch FIRST. The parent's `getJwks` overwrites its own
 *       internal cache with the fresh set, so the subsequent `super.getJwk`
 *       fast path serves only post-refresh keys — a key AWS has since revoked
 *       is gone within at most JWKS_MAX_AGE_MS.
 *
 *  Subclassing SimpleJwksCache (rather than implementing JwksCache from
 *  scratch) is the library-documented extension point — see the
 *  `Rs256OnlyJwksCache` example in the aws-jwt-verify README ("Advanced:
 *  enforcing the algorithm"). The `now` injection point exists for
 *  deterministic TTL testing without fake timers (which would interfere with
 *  the plugin's 0-1s jitter setTimeout). */
export class TtlBoundedJwksCache extends SimpleJwksCache {
  private readonly maxAgeMs: number
  private readonly now: () => number
  private readonly lastFetchedAt = new Map<string, number>()

  constructor(props?: {
    penaltyBox?: PenaltyBox
    fetcher?: Fetcher
    jwksParser?: JwksParser
    maxAgeMs?: number
    now?: () => number
  }) {
    // Forward only the keys the caller actually set: under
    // exactOptionalPropertyTypes, passing `key: undefined` is a type error,
    // and we want the parent's own defaults (SimplePenaltyBox/SimpleFetcher)
    // to apply when omitted.
    super({
      ...(props?.penaltyBox !== undefined ? { penaltyBox: props.penaltyBox } : {}),
      ...(props?.fetcher !== undefined ? { fetcher: props.fetcher } : {}),
      ...(props?.jwksParser !== undefined ? { jwksParser: props.jwksParser } : {}),
    })
    this.maxAgeMs = props?.maxAgeMs ?? JWKS_MAX_AGE_MS
    this.now = props?.now ?? Date.now
  }

  override async getJwks(jwksUri: string): Promise<Jwks> {
    const jwks = await super.getJwks(jwksUri)
    // Stamp AFTER the fetch resolves so a failed fetch doesn't reset the
    // window (and a never-resolving fetch never marks the entry fresh).
    this.lastFetchedAt.set(jwksUri, this.now())
    return jwks
  }

  override async getJwk(jwksUri: string, decomposedJwt: Parameters<SimpleJwksCache['getJwk']>[1]): Promise<JwkWithKid> {
    const fetchedAt = this.lastFetchedAt.get(jwksUri)
    if (fetchedAt !== undefined && this.now() - fetchedAt > this.maxAgeMs) {
      // Entry is past its TTL — force a re-fetch BEFORE delegating, so the
      // parent fast path can't serve a (possibly revoked) cached key.
      await this.getJwks(jwksUri)
    }
    return super.getJwk(jwksUri, decomposedJwt)
  }
}

export interface JwtPluginOptions {
  userPoolId: string
  appClientId: string
}

const jwtPluginImpl: FastifyPluginAsync<JwtPluginOptions> = async (app, opts) => {
  if (app.hasDecorator(REGISTERED_DECORATOR)) {
    throw new Error('jwtPlugin: auth is already registered on this Fastify instance')
  }
  app.decorate(REGISTERED_DECORATOR, 'jwt' as const)

  // Pass a TTL-bounded JWKS cache as additionalProperties so the verifier
  // periodically re-fetches the JWKS set (every <=6h), dropping any key AWS
  // has revoked. The default SimpleJwksCache only re-fetches on a cache MISS,
  // which would keep a revoked-but-cached key verifiable until restart.
  const verifier = CognitoJwtVerifier.create(
    {
      userPoolId: opts.userPoolId,
      clientId: opts.appClientId,
      tokenUse: 'access',
    },
    { jwksCache: new TtlBoundedJwksCache() },
  )

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
      return reply.code(401).send({ code: 'unauthenticated' })
    }
    const token = header.slice('Bearer '.length).trim()
    if (token.length === 0) {
      return reply.code(401).send({ code: 'unauthenticated' })
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
      return reply.code(401).send({ code: 'unauthenticated' })
    }

    if (typeof payload.sub !== 'string' || payload.sub.length === 0) {
      request.log.warn({ event: 'auth.jwt_missing_sub' }, 'JWT missing sub claim')
      return reply.code(401).send({ code: 'unauthenticated' })
    }
    if (typeof payload.username !== 'string' || payload.username.length === 0) {
      request.log.warn({ event: 'auth.jwt_missing_username' }, 'JWT missing username claim')
      return reply.code(401).send({ code: 'unauthenticated' })
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
