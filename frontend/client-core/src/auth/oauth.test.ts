import { beforeAll, beforeEach, describe, expect, it } from 'vitest'
import {
  buildAuthorizeUrl,
  configureOAuth,
  consumeAuthState,
  createAuthState,
  createPkce,
  isLocalPath,
  parseCallback,
  resetOAuthConfig,
} from './oauth.ts'
import type { AuthStateData } from './oauth.ts'
import type { OAuthStateStore } from '../platform/oauth-state-store.ts'

// jsdom does not implement crypto.subtle; ensure the Web Crypto API is present
// (Node's webcrypto) so createPkce's S256 digest works in the test env.
beforeAll(async () => {
  if (typeof globalThis.crypto.subtle === 'undefined') {
    const { webcrypto } = await import('node:crypto')
    Object.defineProperty(globalThis, 'crypto', { value: webcrypto, configurable: true })
  }
})

// An in-memory OAuthStateStore — the helper is DOM-free (R1) and reaches
// persistence only through this injected port (R2). single-use is the Map delete.
function createMemoryStore(): OAuthStateStore {
  const map = new Map<string, AuthStateData>()
  return {
    set: (state, payload) => {
      map.set(state, payload)
    },
    take: (state) => {
      const v = map.get(state) ?? null
      map.delete(state)
      return v
    },
  }
}

const COGNITO = {
  domain: 'mythrun-staging.auth.us-east-1.amazoncognito.com',
  clientId: 'client123',
  redirectUri: 'https://staging.mythrun.com/auth/callback',
  scopes: ['openid', 'email', 'profile'],
}

beforeEach(() => {
  configureOAuth({ store: createMemoryStore(), cognito: COGNITO })
})

describe('createPkce', () => {
  it('produces a base64url verifier (≥128 bits) and a distinct S256 challenge', async () => {
    const a = await createPkce()
    const b = await createPkce()
    expect(a.verifier).toMatch(/^[A-Za-z0-9_-]+$/)
    expect(a.verifier.length).toBeGreaterThanOrEqual(43) // 32 bytes → 43 b64url chars
    expect(a.challenge).toMatch(/^[A-Za-z0-9_-]+$/)
    expect(a.challenge).not.toBe(a.verifier)
    expect(a.verifier).not.toBe(b.verifier) // CSPRNG → unique
  })
})

describe('isLocalPath — open-redirect guard', () => {
  it('accepts a valid local path', () => {
    expect(isLocalPath('/join/x')).toBe(true)
    expect(isLocalPath('/')).toBe(true)
  })
  it('rejects protocol-relative, backslash, absolute-URL, scheme, null, and undefined inputs', () => {
    for (const bad of ['//evil.com', '/\\evil.com', 'https://evil.com', 'javascript:alert(1)', '', 'no-leading-slash']) {
      expect(isLocalPath(bad)).toBe(false)
    }
    expect(isLocalPath(null)).toBe(false)
    expect(isLocalPath(undefined)).toBe(false)
  })
})

describe('createAuthState / consumeAuthState', () => {
  it('gens pkce + state, persists {provider, returnTo, verifier}, returns {state, challenge}; single-use', async () => {
    const { state, challenge } = await createAuthState({ provider: 'google', returnTo: '/join/x' })
    expect(state).toMatch(/^[A-Za-z0-9_-]+$/)
    expect(challenge).toMatch(/^[A-Za-z0-9_-]+$/)
    const first = consumeAuthState(state)
    expect(first?.provider).toBe('google')
    expect(first?.returnTo).toBe('/join/x')
    expect(typeof first?.verifier).toBe('string')
    expect(consumeAuthState(state)).toBeNull() // single-use
  })
  it('stores returnTo as null when it is not a local path', async () => {
    const { state } = await createAuthState({ provider: 'discord', returnTo: 'https://evil.com' })
    expect(consumeAuthState(state)?.returnTo).toBeNull()
  })
  it('returns null consuming an unknown state', () => {
    expect(consumeAuthState('nope')).toBeNull()
  })
})

describe('buildAuthorizeUrl', () => {
  it('builds the authorize URL from the configured cognito config + maps provider casing', () => {
    const url = new URL(buildAuthorizeUrl({ provider: 'discord', state: 'st', challenge: 'chal' }))
    expect(url.origin).toBe('https://mythrun-staging.auth.us-east-1.amazoncognito.com')
    expect(url.pathname).toBe('/oauth2/authorize')
    expect(url.searchParams.get('response_type')).toBe('code')
    expect(url.searchParams.get('client_id')).toBe('client123')
    expect(url.searchParams.get('redirect_uri')).toBe('https://staging.mythrun.com/auth/callback')
    expect(url.searchParams.get('scope')).toBe('openid email profile')
    expect(url.searchParams.get('identity_provider')).toBe('Discord')
    expect(url.searchParams.get('code_challenge')).toBe('chal')
    expect(url.searchParams.get('code_challenge_method')).toBe('S256')
    expect(url.searchParams.get('state')).toBe('st')
  })
  it('maps the google provider to Cognito casing', () => {
    const url = new URL(buildAuthorizeUrl({ provider: 'google', state: 's', challenge: 'c' }))
    expect(url.searchParams.get('identity_provider')).toBe('Google')
  })
})

describe('parseCallback (parse-only — does NOT consume the store)', () => {
  it('returns { code, state } when both present', () => {
    expect(parseCallback('?code=AUTHCODE&state=st')).toEqual({ code: 'AUTHCODE', state: 'st' })
  })
  it('returns { error } on a provider-denial error param', () => {
    expect(parseCallback('?error=access_denied')).toEqual({ error: 'access_denied' })
  })
  it('returns { error: invalid_request } when code or state is missing', () => {
    expect(parseCallback('?state=x')).toEqual({ error: 'invalid_request' })
    expect(parseCallback('?code=x')).toEqual({ error: 'invalid_request' })
  })
  it('does NOT consume the store (a separate consumeAuthState still works)', async () => {
    const { state } = await createAuthState({ provider: 'google', returnTo: '/' })
    parseCallback(`?code=c&state=${state}`)
    expect(consumeAuthState(state)?.returnTo).toBe('/') // parseCallback left it intact
  })
})

describe('configureOAuth guard', () => {
  it('throws when an oauth helper is used before configureOAuth', () => {
    resetOAuthConfig()
    expect(() => consumeAuthState('x')).toThrow()
  })
})
