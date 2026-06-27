// Structural read of a single claim out of a JWT payload — NO verification.
// The backend verifies the access token (signature, audience, token_use); the
// client reads `sub` purely as the opaque routing id for the session store (the
// same immutable id the backend trusts and bypass-mode seeds). A base64url JSON
// decode is mechanical structure-extraction (ZFC-allowed), not intelligence.
//
// Universal (web + RN): no DOM globals — base64 via the standard `atob` (present
// in browsers and Node ≥16). Any malformation → `null` (the caller falls back).

function decodeBase64UrlToJson(segment: string): unknown {
  try {
    const base64 = segment.replace(/-/g, '+').replace(/_/g, '/')
    const json = decodeURIComponent(
      atob(base64)
        .split('')
        .map((c) => `%${c.charCodeAt(0).toString(16).padStart(2, '0')}`)
        .join(''),
    )
    return JSON.parse(json)
  } catch {
    return null
  }
}

/** The `sub` claim of a JWT, or `null` if absent / not a string / malformed. */
export function readSubClaim(token: string): string | null {
  const parts = token.split('.')
  if (parts.length !== 3) return null
  // `parts[1]` is a defined string here (exactly 3 parts); the `?? ''` exists only
  // to satisfy `noUncheckedIndexedAccess` and is unreachable at runtime — there is
  // no 3-part split with an undefined middle segment, so the branch is excluded.
  /* v8 ignore next */
  const payload = decodeBase64UrlToJson(parts[1] ?? '')
  if (typeof payload !== 'object' || payload === null) return null
  const sub = (payload as { sub?: unknown }).sub
  return typeof sub === 'string' ? sub : null
}
