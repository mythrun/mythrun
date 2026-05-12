// backend/src/auth/types.ts
//
// AuthUser shape + Fastify module augmentation. This is the canonical
// declaration site for FastifyContextConfig.auth and FastifyRequest
// auth-related fields. The previously-duplicated declaration at
// backend/src/types/fastify.d.ts (which carried a stale 'jwt' literal)
// was deleted in MYT-39 — see the design doc §3 file layout.
//
// Spec: docs/superpowers/specs/2026-04-30-myt-37-jwt-middleware-design.md §3
//       docs/superpowers/specs/2026-05-08-myt-39-access-control-ws-ticket-design.md §4.4

import type { CognitoAccessTokenPayload } from 'aws-jwt-verify/jwt-model'
import type { CampaignMember, User, World } from '../repo/types.js'

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

    /** OPTIONAL — populated by `requireOnboarded` after the cognito_sub →
     *  users-row lookup succeeds and `suspended_at IS NULL`. Public and
     *  jwt-no-db routes don't have it. Frozen at attach time so a buggy
     *  or malicious downstream hook can't swap fields in place. Narrow
     *  via `requireDbUser(request)` helper. */
    dbUser?: User

    /** OPTIONAL — populated by `requireCampaignMember` after the membership
     *  check passes. Handlers can read this to skip a redo of the same
     *  query. */
    campaignMember?: CampaignMember

    /** OPTIONAL — populated by `requireWorldCreator` after the ownership
     *  check passes. */
    world?: World

    /** OPTIONAL — set by upstream resolvers (e.g. session→campaign in
     *  `routes/sessions.ts`) to feed `requireCampaignMember` when the
     *  route's URL doesn't directly carry `:campaignId`. Used in preference
     *  to a `request.params` mutation, which would make the route's typed
     *  `Params` shape a partial truth at the type level. */
    resolvedCampaignId?: string
  }

  interface FastifyContextConfig {
    /** Per-route auth opt-out / opt-in.
     *  - 'public' — skip JWT validation entirely; no request.user attached.
     *  - 'jwt-no-db' — verify JWT, attach claims; no users-row DB lookup.
     *    Used by jwt-no-db routes (e.g. /api/users/register) where the row
     *    doesn't exist yet. Allowlist-bound at boot via
     *    JWT_NO_DB_ALLOWLIST in require-onboarded.ts.
     *  - undefined (default) — JWT verify + users-row lookup +
     *    suspended_at check + frozen request.dbUser attach. */
    auth?: 'public' | 'jwt-no-db'
    /** Opt-in marker for routes that participate in the world-gen /
     *  campaign-creation pipeline (MYT-51 D12 revised). The T12 boot-time
     *  hook iterates every registered route and asserts that the marker
     *  set on the route matches an entry in PIPELINE_ROUTES (forward AND
     *  reverse — declared-but-not-mounted is also an error). The marker
     *  itself is a boolean tag; PIPELINE_ROUTES is the source of truth
     *  for what's expected, and the hook fails app.ready() if either
     *  side diverges. */
    pipelineRoute?: boolean
  }

  interface FastifyInstance {
    /** Decorated by jwtPlugin in real mode; absent in bypass mode. MYT-38's
     *  /api/users/register handler reads this to verify a JWT for a route
     *  that doesn't need a DB row. */
    jwtVerifier?: JwtVerifier
  }
}
