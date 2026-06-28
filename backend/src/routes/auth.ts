// backend/src/routes/auth.ts
//
// MYT-84 BFF session endpoints. The SPA hands over only { code, codeVerifier }
// and receives only the access token + pre-fill name; the refresh token rides an
// httpOnly cookie set/rotated/cleared here (JS never sees it). All three routes:
//   - config.auth:'public' (in PUBLIC_ROUTE_ALLOWLIST) — no JWT (the user has no
//     access token yet on /session; /refresh & /logout authenticate via cookie).
//   - per-IP config.rateLimit (default keyGenerator = request.ip; correct under
//     trustProxy:1).
//   - /session is application/json ONLY (415 otherwise) — with no form-body parser
//     registered, this is the login-CSRF / session-fixation defense (spec §5).
import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify'
import {
  clearRefreshCookie,
  REFRESH_COOKIE_NAME,
  setRefreshCookie,
} from '../auth/refresh-cookie.js'
import { extractIdTokenName, type CognitoOAuthClient } from '../auth/cognito-oauth-client.js'

interface AuthRoutesOpts {
  readonly cognito: CognitoOAuthClient
  readonly frontendBaseUrl: string
}

interface SessionBody {
  readonly code: string
  readonly codeVerifier: string
}

const RATE_LIMIT = { max: 20, timeWindow: '1 minute' } as const

function parseSessionBody(body: unknown): SessionBody | null {
  if (typeof body !== 'object' || body === null) return null
  const code = (body as { code?: unknown }).code
  const verifier = (body as { codeVerifier?: unknown }).codeVerifier
  if (typeof code !== 'string' || code.length === 0) return null
  if (typeof verifier !== 'string' || verifier.length === 0) return null
  return { code, codeVerifier: verifier }
}

function isJsonRequest(request: FastifyRequest): boolean {
  const ct = request.headers['content-type'] ?? ''
  return ct.toLowerCase().includes('application/json')
}

function errClass(err: unknown): string {
  return err instanceof Error ? err.constructor.name : 'Unknown'
}

// CSRF defense-in-depth on the cookie-authed routes. With the same-origin proxy +
// SameSite=Lax the cookie isn't sent cross-site, but we ALSO reject a forged Origin:
// a present-but-mismatched Origin header is a cross-site request. Absent Origin (a
// non-browser, which can't hold the victim's httpOnly cookie anyway) is allowed.
function isForgedOrigin(request: FastifyRequest, frontendBaseUrl: string): boolean {
  const origin = request.headers.origin
  return origin !== undefined && origin !== frontendBaseUrl
}

async function handleSession(
  request: FastifyRequest,
  reply: FastifyReply,
  opts: AuthRoutesOpts,
): Promise<FastifyReply> {
  if (isForgedOrigin(request, opts.frontendBaseUrl)) {
    return reply.code(403).send({ code: 'forbidden_origin' })
  }
  if (!isJsonRequest(request)) {
    return reply.code(415).send({ code: 'unsupported_media_type' })
  }
  const body = parseSessionBody(request.body)
  if (!body) return reply.code(400).send({ code: 'invalid_request' })
  const redirectUri = `${opts.frontendBaseUrl}/auth/callback`
  let tokens
  try {
    tokens = await opts.cognito.exchangeCode({
      code: body.code,
      codeVerifier: body.codeVerifier,
      redirectUri,
    })
  } catch (err) {
    request.log.warn({ event: 'auth.code_exchange_failed', errorClass: errClass(err) }, 'code exchange failed')
    return reply.code(401).send({ code: 'code_exchange_failed' })
  }
  if (!tokens.refreshToken) {
    request.log.error({ event: 'auth.no_refresh_token' }, 'cognito token response carried no refresh_token')
    return reply.code(502).send({ code: 'no_refresh_token' })
  }
  setRefreshCookie(reply, tokens.refreshToken)
  const name = tokens.idToken ? extractIdTokenName(tokens.idToken) : null
  return reply.send({ accessToken: tokens.accessToken, expiresIn: tokens.expiresIn, name })
}

async function handleRefresh(
  request: FastifyRequest,
  reply: FastifyReply,
  opts: AuthRoutesOpts,
): Promise<FastifyReply> {
  if (isForgedOrigin(request, opts.frontendBaseUrl)) {
    return reply.code(403).send({ code: 'forbidden_origin' })
  }
  const token = request.cookies[REFRESH_COOKIE_NAME]
  if (!token) {
    // No session. 200 with a null token (NOT 401): this endpoint is the SPA's on-load
    // session probe, and a 401 logs a console error on the sign-in screen for a
    // non-error "no session" condition (canonical BFF "anonymous -> 200" pattern).
    clearRefreshCookie(reply)
    return reply.send({ accessToken: null, expiresIn: null })
  }
  let tokens
  try {
    tokens = await opts.cognito.refresh({ refreshToken: token })
  } catch (err) {
    // The session ended (refresh token revoked/expired). Still 200 null — logged-out is
    // not an error to the probe; the failure is recorded server-side for monitoring.
    request.log.warn({ event: 'auth.refresh_failed', errorClass: errClass(err) }, 'refresh failed')
    clearRefreshCookie(reply)
    return reply.send({ accessToken: null, expiresIn: null })
  }
  // Rotation enabled → re-set the ROTATED token; the prior one is now invalid.
  if (tokens.refreshToken) setRefreshCookie(reply, tokens.refreshToken)
  return reply.send({ accessToken: tokens.accessToken, expiresIn: tokens.expiresIn })
}

async function handleLogout(
  request: FastifyRequest,
  reply: FastifyReply,
  opts: AuthRoutesOpts,
): Promise<FastifyReply> {
  if (isForgedOrigin(request, opts.frontendBaseUrl)) {
    return reply.code(403).send({ code: 'forbidden_origin' })
  }
  const token = request.cookies[REFRESH_COOKIE_NAME]
  if (token) {
    try {
      await opts.cognito.revoke({ token })
    } catch (err) {
      // Best-effort revoke: clear the cookie regardless (the already-issued
      // access JWT stays valid until exp ≤ 60m — accepted JWT tradeoff).
      request.log.warn({ event: 'auth.revoke_failed', errorClass: errClass(err) }, 'revoke failed; clearing cookie anyway')
    }
  }
  clearRefreshCookie(reply)
  return reply.code(204).send()
}

// eslint-disable-next-line @typescript-eslint/require-await
export const authRoutes: FastifyPluginAsync<AuthRoutesOpts> = async (app, opts) => {
  const config = { auth: 'public', rateLimit: RATE_LIMIT } as const
  app.post('/api/auth/session', { config }, (request, reply) => handleSession(request, reply, opts))
  app.post('/api/auth/refresh', { config }, (request, reply) => handleRefresh(request, reply, opts))
  app.post('/api/auth/logout', { config }, (request, reply) => handleLogout(request, reply, opts))
}
