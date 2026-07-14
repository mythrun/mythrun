import { HttpError } from '../api/errors.ts'
import type { AcceptArmKind, PreviewArmKind } from '../contract/invite/types.ts'

// The invite error → arm mappings (MYT-91). Both key on the backend's TYPED
// error `code` strings — a structural policy mapping, the ZFC-exempt kind, never
// a semantic read of prose. Plus the pure join-path helpers the /join/:code flow
// and the InvitePanel share link build. All DOM-free.

// Accept endpoint (POST /api/invites/:code/accept): each typed code maps to its
// calm-notice arm. Any unknown code or a non-HTTP failure (a network drop)
// collapses to the generic `error` arm.
const CODE_TO_ARM: Record<string, AcceptArmKind> = {
  campaign_full: 'full',
  invite_revoked: 'revoked',
  campaign_gone: 'gone',
  invite_not_found: 'not-found',
  invite_timeout: 'timeout',
}

/** Map a caught accept failure to its calm-notice arm. */
export function mapAcceptError(err: unknown): AcceptArmKind {
  if (err instanceof HttpError && err.code !== undefined) {
    return CODE_TO_ARM[err.code] ?? 'error'
  }
  return 'error'
}

/** Map a caught *preview* failure to its fork. The preview endpoint only throws
 *  404 `invite_not_found` (a code that never existed) — that is `invalid`, a
 *  terminal calm notice where retry is pointless. Everything else (a network drop
 *  or a 5xx) is `error` → offer retry. A revoked/expired code never reaches here:
 *  the endpoint resolves 200 `valid:false` for those, read off the parsed body. */
export function mapPreviewError(err: unknown): PreviewArmKind {
  if (err instanceof HttpError && err.code === 'invite_not_found') {
    return 'invalid'
  }
  return 'error'
}

/** The sign-in URL that returns to this invite after auth — the whole `/join/:code`
 *  path url-encoded onto the SHIPPED `?returnTo`. No new redirect mechanism: the
 *  guarded `isLocalPath` + OAuth-state round-trip validates + carries it. */
export function signinReturnToJoin(code: string): string {
  return `/auth/signin?returnTo=${encodeURIComponent(`/join/${code}`)}`
}

/** The public invite path for a code. */
export function joinPath(code: string): string {
  return `/join/${code}`
}
