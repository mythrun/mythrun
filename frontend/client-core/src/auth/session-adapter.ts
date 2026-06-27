import { getMe } from '../api/users.ts'
import { isHttpError } from '../api/errors.ts'
import { useSessionStore } from '../stores/session.ts'
import { readSubClaim } from './jwt-claims.ts'
import { getAccessToken, runRefresh } from './token-manager.ts'
import type { ApiContext } from '../api/endpoint.ts'

// The `/me` → session-store mapping, applied IDENTICALLY on the OAuth callback
// (after createSession sets the access token) and on the on-load bootstrap (after
// a successful refresh). `useMe` is NEVER the onboarding-discovery seam — the
// adapter settles the store BEFORE the Hub's `useMe` runs.
//
// `sub` is the access-token `sub` claim (the immutable Cognito id the backend
// trusts), read for BOTH the 200 and the 403 paths — the 403 has no body, and the
// 200 body's `user.id` is the DB row id, not the Cognito sub. Decoded structurally
// (no verification — that is the backend's job).

function currentSub(): string {
  const token = getAccessToken()
  return (token !== null ? readSubClaim(token) : null) ?? ''
}

/** Resolve the access-token-bearing session: GET /me, map status → store. */
export async function applyMe(ctx: ApiContext): Promise<void> {
  const store = useSessionStore.getState()
  try {
    await getMe(undefined, ctx)
    store.setReady(currentSub())
  } catch (err) {
    if (isHttpError(err) && err.status === 403 && err.code === 'username_required') {
      store.setOnboardingRequired(currentSub())
      return
    }
    if (isHttpError(err) && err.status === 403 && err.code === 'account_suspended') {
      store.setSuspended()
      return
    }
    // 401 / network / contract drift → no usable session.
    store.setUnauthenticated()
  }
}

/** Boot: attempt the on-load refresh; success → applyMe; failure → unauthenticated. */
export async function bootstrapSession(ctx: ApiContext): Promise<void> {
  const ok = await runRefresh()
  if (ok) {
    await applyMe(ctx)
    return
  }
  useSessionStore.getState().setUnauthenticated()
}
