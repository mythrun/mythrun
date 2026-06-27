// backend/src/auth/refresh-cookie.ts
//
// The refresh-token cookie: HttpOnly + Secure + SameSite=None + Path=/api/auth +
// host-only (NO Domain — never broadens to sibling subdomains). 30-day Max-Age.
//
// SameSite=None (NOT Lax): the SPA (staging.mythrun.com) and the API
// (staging-api.mythrun.com) are split ORIGINS. Safari REFUSES TO STORE a Lax
// cookie returned by a cross-origin fetch — even same-registrable-domain — so the
// cookie silently never persisted and every reload bounced to sign-in. None+Secure
// is the split-origin requirement. The CSRF surface None opens on the cookie-authed
// routes is closed by: httpOnly (JS can't read it) + the CORS allowlist (a cross-
// site caller can't READ /refresh's response) + an Origin check on /refresh+/logout
// (routes/auth.ts) + /session's JSON-only gate.
//
// clearRefreshCookie MUST mirror path/secure/sameSite/httpOnly so the browser
// clears the SAME cookie.
import type { FastifyReply } from 'fastify'

export const REFRESH_COOKIE_NAME = 'mythrun_refresh'
/** 30 days, in SECONDS (@fastify/cookie's maxAge is seconds, per the cookie spec). */
const REFRESH_COOKIE_MAX_AGE_S = 30 * 24 * 60 * 60

const BASE_ATTRS = {
  httpOnly: true,
  secure: true,
  sameSite: 'none',
  path: '/api/auth',
} as const

export function setRefreshCookie(reply: FastifyReply, token: string): void {
  reply.setCookie(REFRESH_COOKIE_NAME, token, { ...BASE_ATTRS, maxAge: REFRESH_COOKIE_MAX_AGE_S })
}

export function clearRefreshCookie(reply: FastifyReply): void {
  reply.clearCookie(REFRESH_COOKIE_NAME, BASE_ATTRS)
}
