import { describe, expect, it, vi } from 'vitest'
import {
  CognitoOAuthError,
  createCognitoOAuthClient,
  extractIdTokenName,
} from '../cognito-oauth-client.js'

const HOST = 'mythrun-staging.auth.us-east-1.amazoncognito.com'

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
}

function makeIdToken(payload: Record<string, unknown>): string {
  const seg = (o: unknown): string => Buffer.from(JSON.stringify(o)).toString('base64url')
  return `${seg({ alg: 'none' })}.${seg(payload)}.sig`
}

describe('createCognitoOAuthClient', () => {
  it('exchangeCode POSTs the PKCE authorization_code form to /oauth2/token', async () => {
    let url = ''
    let body = ''
    const fetchImpl = vi.fn((u: string, init?: RequestInit) => {
      url = u
      body = typeof init?.body === 'string' ? init.body : ''
      return Promise.resolve(jsonResponse({ access_token: 'a', expires_in: 3600, id_token: 'i', refresh_token: 'r' }))
    }) as unknown as typeof fetch
    const client = createCognitoOAuthClient({ hostedUiDomain: HOST, clientId: 'c1', fetchImpl })
    const tokens = await client.exchangeCode({ code: 'CODE', codeVerifier: 'VER', redirectUri: 'https://x/auth/callback' })
    expect(tokens).toEqual({ accessToken: 'a', expiresIn: 3600, idToken: 'i', refreshToken: 'r' })
    expect(url).toBe(`https://${HOST}/oauth2/token`)
    const p = new URLSearchParams(body)
    expect(p.get('grant_type')).toBe('authorization_code')
    expect(p.get('client_id')).toBe('c1')
    expect(p.get('code')).toBe('CODE')
    expect(p.get('code_verifier')).toBe('VER')
    expect(p.get('redirect_uri')).toBe('https://x/auth/callback')
  })

  it('refresh POSTs the refresh_token grant', async () => {
    let body = ''
    const fetchImpl = vi.fn((_u: string, init?: RequestInit) => {
      body = typeof init?.body === 'string' ? init.body : ''
      return Promise.resolve(jsonResponse({ access_token: 'a2', expires_in: 3600, refresh_token: 'rotated' }))
    }) as unknown as typeof fetch
    const client = createCognitoOAuthClient({ hostedUiDomain: HOST, clientId: 'c1', fetchImpl })
    const tokens = await client.refresh({ refreshToken: 'old' })
    expect(tokens.refreshToken).toBe('rotated')
    expect(new URLSearchParams(body).get('grant_type')).toBe('refresh_token')
    expect(new URLSearchParams(body).get('refresh_token')).toBe('old')
  })

  it('revoke POSTs token + client_id to /oauth2/revoke', async () => {
    let url = ''
    let body = ''
    const fetchImpl = vi.fn((u: string, init?: RequestInit) => {
      url = u
      body = typeof init?.body === 'string' ? init.body : ''
      return Promise.resolve(new Response(null, { status: 200 }))
    }) as unknown as typeof fetch
    const client = createCognitoOAuthClient({ hostedUiDomain: HOST, clientId: 'c1', fetchImpl })
    await client.revoke({ token: 'tok' })
    expect(url).toBe(`https://${HOST}/oauth2/revoke`)
    expect(new URLSearchParams(body).get('token')).toBe('tok')
    expect(new URLSearchParams(body).get('client_id')).toBe('c1')
  })

  it('throws CognitoOAuthError on a non-2xx token response', async () => {
    const fetchImpl = vi.fn(() => Promise.resolve(jsonResponse({ error: 'invalid_grant' }, 400))) as unknown as typeof fetch
    const client = createCognitoOAuthClient({ hostedUiDomain: HOST, clientId: 'c1', fetchImpl })
    await expect(client.exchangeCode({ code: 'x', codeVerifier: 'y', redirectUri: 'z' })).rejects.toBeInstanceOf(CognitoOAuthError)
  })

  it('throws CognitoOAuthError on a non-2xx revoke response', async () => {
    const fetchImpl = vi.fn(() => Promise.resolve(new Response(null, { status: 401 }))) as unknown as typeof fetch
    const client = createCognitoOAuthClient({ hostedUiDomain: HOST, clientId: 'c1', fetchImpl })
    await expect(client.revoke({ token: 't' })).rejects.toBeInstanceOf(CognitoOAuthError)
  })

  it('throws when the token response is missing access_token/expires_in', async () => {
    const fetchImpl = vi.fn(() => Promise.resolve(jsonResponse({ token_type: 'Bearer' }))) as unknown as typeof fetch
    const client = createCognitoOAuthClient({ hostedUiDomain: HOST, clientId: 'c1', fetchImpl })
    await expect(client.refresh({ refreshToken: 'r' })).rejects.toBeInstanceOf(CognitoOAuthError)
  })

  it('omits idToken/refreshToken from the set when absent', async () => {
    const fetchImpl = vi.fn(() => Promise.resolve(jsonResponse({ access_token: 'a', expires_in: 60 }))) as unknown as typeof fetch
    const client = createCognitoOAuthClient({ hostedUiDomain: HOST, clientId: 'c1', fetchImpl })
    const tokens = await client.exchangeCode({ code: 'x', codeVerifier: 'y', redirectUri: 'z' })
    expect(tokens).toEqual({ accessToken: 'a', expiresIn: 60 })
  })
})

describe('extractIdTokenName', () => {
  it('returns the name claim', () => {
    expect(extractIdTokenName(makeIdToken({ name: 'Ada Lovelace' }))).toBe('Ada Lovelace')
  })
  it('returns null for a blank/absent name, a non-3-part token, and malformed payload', () => {
    expect(extractIdTokenName(makeIdToken({ name: '' }))).toBeNull()
    expect(extractIdTokenName(makeIdToken({ sub: 'x' }))).toBeNull()
    expect(extractIdTokenName('not.a.jwt.at.all')).toBeNull()
    expect(extractIdTokenName('one-part')).toBeNull()
    expect(extractIdTokenName('a.%%%.c')).toBeNull()
  })
})
