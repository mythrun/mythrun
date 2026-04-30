// backend/src/auth/types.ts
//
// AuthUser shape + Fastify module augmentation.
//
// Spec: docs/superpowers/specs/2026-04-30-myt-37-jwt-middleware-design.md §3.

import type { CognitoAccessTokenPayload } from 'aws-jwt-verify/jwt-model'

export interface AuthUser {
  /** Cognito sub claim — stable per-user identifier across token refreshes.
   *  This is the canonical identifier for cross-system reference (matching
   *  to `users.cognito_sub` after MYT-38 onboarding creates the row).
   *  Treat as immutable; do NOT use Cognito's `username` claim for identity. */
  readonly sub: string

  /** Cognito's internal username for the federated user.
   *  For Google sign-in: 'Google_<google-sub>'
   *  For Discord sign-in: 'Discord_<discord-snowflake>'
   *  For bypass mode: 'bypass_dev_1'
   *
   *  DO NOT confuse this with `users.username` — the user-chosen name
   *  Mythrun adds in MYT-38 onboarding. This field is the cognito-internal
   *  identifier; treat as opaque (no prefix-based reasoning). */
  readonly cognitoUsername: string

  /** OAuth scopes granted to this token, parsed at the boundary into an
   *  array. Consumers should use `scopes.includes('admin')` not
   *  `scope.includes('admin')` — the latter would substring-match
   *  'administrator' (a real authorization bug class). Treat as a set. */
  readonly scopes: readonly string[]
}

/** Minimal verifier interface decorated onto FastifyInstance.
 *  Pinned to a method shape (rather than the parameterized
 *  CognitoJwtVerifier<...> generic) so consumers like MYT-38's
 *  /api/users/register handler can use it without depending on the
 *  library's internal type variance. */
export interface JwtVerifier {
  verify(token: string): Promise<CognitoAccessTokenPayload>
}

declare module 'fastify' {
  interface FastifyRequest {
    /** OPTIONAL — public routes don't have a user attached. Protected
     *  handlers should narrow via the `requireUser(request)` helper rather
     *  than dereferencing `request.user.sub` directly, which would throw
     *  at runtime if a route accidentally lands here without auth. */
    user?: AuthUser
  }

  interface FastifyContextConfig {
    /** Per-route auth opt-out / opt-in.
     *  - 'public' — skip validation entirely; no request.user attached.
     *  - 'jwt-no-db' — verify JWT, attach claims; no DB lookup. Used by
     *    MYT-38's /api/users/register since the user row doesn't exist yet.
     *  - undefined (default) — default-require. Today: same as 'jwt-no-db'.
     *    After MYT-39: also DB lookup + suspended_at check. */
    auth?: 'public' | 'jwt-no-db'
  }

  interface FastifyInstance {
    /** Decorated by jwtPlugin in real mode; absent in bypass mode. MYT-38's
     *  /api/users/register handler reads this to verify a JWT for a route
     *  that doesn't need a DB row. */
    jwtVerifier?: JwtVerifier
  }
}
