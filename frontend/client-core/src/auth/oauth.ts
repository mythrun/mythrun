// OAuth/PKCE helpers for the Cognito Hosted UI flow — the CANONICAL oauth API
// (Tasks 11 + 12 consume it). Pure + unit-tested. Uses the universal Web Crypto API
// (globalThis.crypto — browser + RN-with-polyfill + Node) for CSPRNG + S256. Two
// things are INJECTED once at boot via configureOAuth: the single-use `state` store
// (an OAuthStateStore platform port — client-core stays DOM-free, R1; the web impl
// is sessionStorage in @mythrun/web) and the Cognito Hosted UI config. parseCallback
// PARSES ONLY (never consumes); the callback then calls consumeAuthState separately.
import type { OAuthStateStore } from '../platform/oauth-state-store.ts'

export type OAuthProvider = 'google' | 'discord'

export interface PkcePair {
  verifier: string
  challenge: string
}

export interface AuthStateData {
  provider: OAuthProvider
  returnTo: string | null
  verifier: string
}

export interface OAuthCognitoConfig {
  /** Bare Hosted UI host, e.g. mythrun-staging.auth.us-east-1.amazoncognito.com */
  domain: string
  clientId: string
  redirectUri: string
  scopes: string[]
}

// Cognito's identity_provider is case-sensitive — map the lowercase app provider.
const PROVIDER_TO_COGNITO: Record<OAuthProvider, string> = { google: 'Google', discord: 'Discord' }

// Configure-once injected runtime (mirrors configureTokenRefresh): the state store
// + the Cognito config. The web bootstrap (main.tsx) wires it; tests inject in-memory.
interface OAuthRuntime {
  store: OAuthStateStore
  cognito: OAuthCognitoConfig
}
let runtime: OAuthRuntime | null = null

export function configureOAuth(config: OAuthRuntime): void {
  runtime = config
}

function requireRuntime(): OAuthRuntime {
  if (runtime === null) {
    throw new Error('configureOAuth not called at boot')
  }
  return runtime
}

function base64url(bytes: Uint8Array): string {
  let s = ''
  for (const b of bytes) s += String.fromCharCode(b)
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

function randomBase64url(byteLength: number): string {
  const bytes = new Uint8Array(byteLength)
  globalThis.crypto.getRandomValues(bytes)
  return base64url(bytes)
}

/** CSPRNG code_verifier (32 bytes → 256 bits) + S256 code_challenge. */
export async function createPkce(): Promise<PkcePair> {
  const verifier = randomBase64url(32)
  const digest = await globalThis.crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier))
  return { verifier, challenge: base64url(new Uint8Array(digest)) }
}

/** Open-redirect guard: a single leading `/`, NOT `//` or `/\` (protocol-relative
 *  / backslash tricks), and no `scheme:` (an absolute URL never starts with `/`).
 *  null/undefined → false. */
export function isLocalPath(returnTo: string | null | undefined): boolean {
  if (returnTo === null || returnTo === undefined) return false
  if (!returnTo.startsWith('/')) return false
  if (returnTo.startsWith('//')) return false
  if (returnTo.startsWith('/\\')) return false
  return true
}

/** Gen PKCE + a CSPRNG opaque state, persist {provider, returnTo, verifier} to the
 *  configured store (single-use), return {state, challenge}. `returnTo` is validated
 *  LOCAL here (else null) so a forged value can never ride the round-trip. */
export async function createAuthState(input: {
  provider: OAuthProvider
  returnTo: string | null
}): Promise<{ state: string; challenge: string }> {
  const { store } = requireRuntime()
  const { verifier, challenge } = await createPkce()
  const state = randomBase64url(16)
  const returnTo = isLocalPath(input.returnTo) ? input.returnTo : null
  store.set(state, { provider: input.provider, returnTo, verifier })
  return { state, challenge }
}

/** Read + DELETE (single-use) the triple stored for `state` (delegates to the store). */
export function consumeAuthState(state: string): AuthStateData | null {
  return requireRuntime().store.take(state)
}

export function buildAuthorizeUrl(input: {
  provider: OAuthProvider
  state: string
  challenge: string
}): string {
  const { cognito } = requireRuntime()
  const url = new URL(`https://${cognito.domain}/oauth2/authorize`)
  url.searchParams.set('response_type', 'code')
  url.searchParams.set('client_id', cognito.clientId)
  url.searchParams.set('redirect_uri', cognito.redirectUri)
  url.searchParams.set('scope', cognito.scopes.join(' '))
  url.searchParams.set('state', input.state)
  url.searchParams.set('code_challenge', input.challenge)
  url.searchParams.set('code_challenge_method', 'S256')
  url.searchParams.set('identity_provider', PROVIDER_TO_COGNITO[input.provider])
  return url.toString()
}

/** Parse the callback query ONLY — never consumes the store (the callback calls
 *  consumeAuthState separately). Provider denial (`?error=`) → { error }; a missing
 *  code/state → { error: 'invalid_request' }; otherwise { code, state }. */
export function parseCallback(search: string): { code: string; state: string } | { error: string } {
  const params = new URLSearchParams(search)
  const error = params.get('error')
  if (error !== null) return { error }
  const code = params.get('code')
  const state = params.get('state')
  if (code === null || state === null) return { error: 'invalid_request' }
  return { code, state }
}

/** TEST-ONLY: clear the configured runtime. NOT exported from the client-core
 *  barrel (imported via the direct module path in tests — mirrors resetTokenManager). */
export function resetOAuthConfig(): void {
  runtime = null
}
