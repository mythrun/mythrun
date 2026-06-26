// backend/src/auth/cognito-oauth-client.ts
//
// The single abstraction over Cognito's OAuth2 token + revoke endpoints. All
// Cognito HTTP calls in the BFF session/refresh/logout flow go through here (no
// inline fetch in the route handlers) — mirrors the "all Anthropic calls through
// one layer" convention. PUBLIC client (PKCE): there is no client_secret.

export interface CognitoTokenSet {
  readonly accessToken: string
  readonly expiresIn: number
  readonly idToken?: string
  readonly refreshToken?: string
}

export interface CognitoOAuthClient {
  exchangeCode(input: {
    code: string
    codeVerifier: string
    redirectUri: string
  }): Promise<CognitoTokenSet>
  refresh(input: { refreshToken: string }): Promise<CognitoTokenSet>
  revoke(input: { token: string }): Promise<void>
}

export class CognitoOAuthError extends Error {
  readonly status: number
  constructor(status: number, message: string) {
    super(message)
    this.name = 'CognitoOAuthError'
    this.status = status
  }
}

export interface CognitoOAuthClientOpts {
  /** Bare host, e.g. mythrun-staging.auth.us-east-1.amazoncognito.com */
  readonly hostedUiDomain: string
  readonly clientId: string
  /** Injected in tests; defaults to global fetch. */
  readonly fetchImpl?: typeof fetch
}

interface RawTokenResponse {
  access_token?: unknown
  expires_in?: unknown
  id_token?: unknown
  refresh_token?: unknown
}

function toTokenSet(raw: RawTokenResponse): CognitoTokenSet {
  if (typeof raw.access_token !== 'string' || typeof raw.expires_in !== 'number') {
    throw new CognitoOAuthError(502, 'cognito token response missing access_token/expires_in')
  }
  return {
    accessToken: raw.access_token,
    expiresIn: raw.expires_in,
    ...(typeof raw.id_token === 'string' ? { idToken: raw.id_token } : {}),
    ...(typeof raw.refresh_token === 'string' ? { refreshToken: raw.refresh_token } : {}),
  }
}

export function createCognitoOAuthClient(opts: CognitoOAuthClientOpts): CognitoOAuthClient {
  const fetchImpl = opts.fetchImpl ?? fetch
  const tokenUrl = `https://${opts.hostedUiDomain}/oauth2/token`
  const revokeUrl = `https://${opts.hostedUiDomain}/oauth2/revoke`

  const postForm = (url: string, params: Record<string, string>): Promise<Response> =>
    fetchImpl(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams(params).toString(),
    })

  const tokenRequest = async (params: Record<string, string>): Promise<CognitoTokenSet> => {
    const res = await postForm(tokenUrl, params)
    if (!res.ok) {
      throw new CognitoOAuthError(res.status, `cognito token endpoint returned ${String(res.status)}`)
    }
    return toTokenSet((await res.json()) as RawTokenResponse)
  }

  return {
    exchangeCode: ({ code, codeVerifier, redirectUri }) =>
      tokenRequest({
        grant_type: 'authorization_code',
        client_id: opts.clientId,
        code,
        code_verifier: codeVerifier,
        redirect_uri: redirectUri,
      }),
    refresh: ({ refreshToken }) =>
      tokenRequest({
        grant_type: 'refresh_token',
        client_id: opts.clientId,
        refresh_token: refreshToken,
      }),
    revoke: async ({ token }) => {
      const res = await postForm(revokeUrl, { token, client_id: opts.clientId })
      if (!res.ok) {
        throw new CognitoOAuthError(res.status, `cognito revoke endpoint returned ${String(res.status)}`)
      }
    },
  }
}

/** Decode (no verification needed — the id_token came straight from Cognito's
 *  token endpoint over TLS) the JWT payload and return the `name` claim, or null
 *  when absent/blank/malformed. */
export function extractIdTokenName(idToken: string): string | null {
  const parts = idToken.split('.')
  if (parts.length !== 3) return null
  try {
    const payload = JSON.parse(
      Buffer.from(parts[1] ?? '', 'base64url').toString('utf8'),
    ) as { name?: unknown }
    return typeof payload.name === 'string' && payload.name.length > 0 ? payload.name : null
  } catch {
    return null
  }
}
