// backend/src/auth/index.ts
//
// Auth plugin dispatcher. Registers exactly one of jwtPlugin / bypassPlugin
// based on opts.mode. Re-exports requireUser and types for convenience.
//
// Spec: docs/superpowers/specs/2026-04-30-myt-37-jwt-middleware-design.md §3.

import type { FastifyInstance } from 'fastify'
import { bypassPlugin, type BypassPluginOptions } from './bypass-plugin.js'
import { jwtPlugin, type JwtPluginOptions } from './jwt-plugin.js'

export type AuthMode = 'real' | 'bypass'

export interface RegisterAuthOptions {
  mode: AuthMode
  /** Required when mode === 'real'; ignored in bypass mode. */
  userPoolId?: string
  /** Required when mode === 'real'. */
  appClientId?: string
  /** Passed to bypass plugin's Layer 3 check. */
  issuerUrl?: string
  hostedUiDomain?: string
}

export const registerAuth = async (
  app: FastifyInstance,
  opts: RegisterAuthOptions,
): Promise<void> => {
  if (opts.mode === 'bypass') {
    const bypassOpts: BypassPluginOptions = {}
    if (opts.userPoolId !== undefined) bypassOpts.cognitoUserPoolId = opts.userPoolId
    if (opts.appClientId !== undefined) bypassOpts.cognitoAppClientId = opts.appClientId
    if (opts.issuerUrl !== undefined) bypassOpts.cognitoIssuerUrl = opts.issuerUrl
    if (opts.hostedUiDomain !== undefined) bypassOpts.cognitoHostedUiDomain = opts.hostedUiDomain
    await app.register(bypassPlugin, bypassOpts)
    return
  }
  if (!opts.userPoolId || !opts.appClientId) {
    throw new Error('registerAuth: real mode requires userPoolId and appClientId')
  }
  const jwtOpts: JwtPluginOptions = {
    userPoolId: opts.userPoolId,
    appClientId: opts.appClientId,
  }
  await app.register(jwtPlugin, jwtOpts)
}

export { requireUser } from './require-user.js'
export type { AuthUser, JwtVerifier } from './types.js'
