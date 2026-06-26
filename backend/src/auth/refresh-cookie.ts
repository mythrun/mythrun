// backend/src/auth/refresh-cookie.ts
//
// The refresh-token cookie: HttpOnly + Secure + SameSite=Lax + Path=/api/auth +
// host-only (NO Domain — never broadens to sibling subdomains). 30-day Max-Age.
// JS never sees it (httpOnly); it is sent only on the /api/auth/* fetches
// (credentials:'include' + the same-SITE registrable domain). clearRefreshCookie
// MUST mirror path/secure/sameSite/httpOnly so the browser clears the SAME cookie.
import type { FastifyReply } from 'fastify'

export const REFRESH_COOKIE_NAME = 'mythrun_refresh'
/** 30 days, in SECONDS (@fastify/cookie's maxAge is seconds, per the cookie spec). */
const REFRESH_COOKIE_MAX_AGE_S = 30 * 24 * 60 * 60

const BASE_ATTRS = {
  httpOnly: true,
  secure: true,
  sameSite: 'lax',
  path: '/api/auth',
} as const

export function setRefreshCookie(reply: FastifyReply, token: string): void {
  reply.setCookie(REFRESH_COOKIE_NAME, token, { ...BASE_ATTRS, maxAge: REFRESH_COOKIE_MAX_AGE_S })
}

export function clearRefreshCookie(reply: FastifyReply): void {
  reply.clearCookie(REFRESH_COOKIE_NAME, BASE_ATTRS)
}
