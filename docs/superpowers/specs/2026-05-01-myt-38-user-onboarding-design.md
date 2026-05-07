# MYT-38: User Onboarding (Username + Invites) — Design

**Linear:** [MYT-38](https://linear.app/mythrun/issue/MYT-38)
**Spec source:** `docs/specs/2026-04-13-auth-users.md` §4 + §9 (with this design overriding several axes; see §"Spec deviations" at bottom)
**Date:** 2026-05-01
**Related:** MYT-37 (jwt-plugin, shipped), MYT-39 (will subsume `requireOnboarded` hook + adds `loadCurrentUser` caching), MYT-44 (LLM wrapper, replaces profanity stub), `myth-urh6` (post-MYT-44 swap bead)

---

## Goal

Three things, scoped tightly:

1. **Username onboarding** — `POST /api/users/register`, `GET /api/users/check-username` (query param), `GET /api/users/me`. Format validation + (stubbed) profanity gate + uniqueness + suggestion.
2. **First-login gate** — `requireOnboarded` Fastify pre-handler hook + a runtime route enumerator enforcing the `'jwt-no-db'` opt-out allowlist at boot. Returns 403 `{code: 'username_required'}` on protected routes when no Mythrun user row exists for `request.user.sub`.
3. **Invite system** — reusable Discord-style invite links per campaign. Owner-only create/list/revoke + member list; any onboarded user accepts; **public preview** so unsigned-in users can see the campaign name before going through OAuth. Multi-row write paths follow MYT-40's discipline (BEGIN + isolation + dual timeouts + row anchor + ROLLBACK on every error path).

## Identity model — minimal-claims posture (with display name)

**Mythrun stores `cognito_sub`, `username`, and `display_name`. Nothing else from Cognito.**

Cognito OAuth is the authentication layer. After sign-in, the user picks two pieces of identity:

1. **`username`** — the stable, unique handle. Lowercase-unique (case preserved for display), 3-20 chars, alphanumeric + underscores. Used in URLs (`@gandalf`), in member lists' permanent identifier, in invites. Cannot collide with another user.
2. **`display_name`** — the friendly social-recognition label. Free-form, 1-40 chars, profanity-gated, NOT unique. Two users can both be "Alice." Used in campaign chrome and member-list rendering ("Alice (@gandalf)") so an owner inviting their D&D group recognizes the humans, not just the handles.

We do NOT store email, profile picture, or auth-provider derivation. The schema columns for those (`email`, `avatar_url`, `auth_provider` from migration 001) are dropped in **migration 005** as part of this ticket. **`display_name` is RETAINED** (round-5 review caught the UX-spec contradiction).

Implications:
- The register endpoint body is `{username, displayName}`. The SPA pre-fills `displayName` client-side from whatever it has (typically Cognito's `name` claim from the ID token, which the SPA holds from the OAuth flow); the backend doesn't see the ID token.
- Cognito access tokens don't carry profile claims (only `sub`, `cognito:username`, `scope`); we don't need them. The `tokenUse: 'access'` configuration in MYT-37's jwt-plugin is exactly right.
- Display surfaces use `@{username}` for stable references (URLs, mentions) and `{display_name}` (with `@{username}` parenthetical) for human-rendered surfaces (campaign chrome, member lists, invite previews).
- Future profile customization (avatar upload, bio, etc.) is post-launch and ships as user-uploadable fields, not Cognito-claim-derived.
- Future `PATCH /api/users/me` (out of MYT-38 scope) will let users change `display_name` (no rate limit) and `username` (rate-limited per parent spec §4.5).

## Migration 005

```sql
-- 005_drop_profile_columns_users.sql
-- Mythrun's identity model is minimal-claims: we store cognito_sub,
-- username, and display_name. Email / avatar_url / auth_provider were
-- carved out of OAuth claims by the original migration 001 but are
-- not product-load-bearing — Cognito is the authentication layer, the
-- user picks their identity surface (username + display_name). Drop
-- the three claim-derived columns here. Display_name is RETAINED for
-- social-recognition UX (member lists, campaign chrome) per UX spec
-- §3-§4. Future profile fields (avatar upload, bio, etc.) ship
-- post-launch as user-uploadable.

ALTER TABLE users
  DROP COLUMN email,
  DROP COLUMN avatar_url,
  DROP COLUMN auth_provider;

-- The original UNIQUE on users.username was case-sensitive (default for
-- TEXT columns). That allowed Admin / admin / ADMIN to register as three
-- distinct users — which lets an attacker squat a moderator-impersonation
-- name even if the lowercase form is in the deny list. Replace with a
-- case-insensitive UNIQUE on LOWER(username). The display preserves the
-- user's chosen casing.

ALTER TABLE users DROP CONSTRAINT users_username_key;

CREATE UNIQUE INDEX users_username_lower_key ON users (LOWER(username));

-- Post-migration assertion: confirm exactly one unique index on username.
DO $$ BEGIN
  ASSERT (
    SELECT count(*) FROM pg_indexes
    WHERE schemaname = 'public'
      AND tablename = 'users'
      AND indexdef LIKE '%LOWER(username)%'
  ) = 1, 'users_username_lower_key was not created';
END $$;
```

Migration is forward-only; no down migration. The `users` table currently has zero rows in any deployed environment, so the DROP COLUMNs are non-destructive in practice.

## Non-goals (deferred with explicit rationale)

- `PATCH /api/users/me` and `DELETE /api/users/me` — future ticket.
- `removeMember`, `transferOwnership`, `leaveCampaign` — campaign-membership ticket. (Note: `listMembers` IS in scope — review found that deferring it broke owner UX.)
- Real Haiku call for profanity — `myth-urh6`, depends on MYT-44. **The stub still enforces a static deny list of impersonation roots** (see §"Profanity stub").
- `loadCurrentUser` (DB lookup + suspended_at + internal-uuid attachment + per-request caching) — MYT-39 swaps out our `requireOnboarded` hook for that richer one.
- WebSocket ticket exchange — MYT-39.
- Per-invite `max_uses` parameter on the create endpoint. Schema supports it; we don't expose it on the API today. The transaction is designed so adding `max_uses` later is body-only.
- Profile customization (avatar, bio) — post-launch.
- `Decline invite` endpoint — frontend-only sessionStorage clear is sufficient. The invite is reusable; "declining" is just not calling accept.

## Acknowledged trade-offs

- **Per-request `getByCognitoSub` (no caching today).** `requireOnboarded` runs one indexed `SELECT` per protected request, with a `statement_timeout` of 200ms. MYT-39's `loadCurrentUser` will own per-request caching.
- **`POST /api/invites/:code/accept` returns `200 {campaignId}` even on already-member.** Anyone holding a valid invite code (intentionally shareable) can map code → campaignId. That's a property of the reusable-invite-link UX, not a bug.
- **Username existence is publicly enumerable** via `GET /api/users/check-username`. Mitigated with per-IP (10/min) + per-cognito-sub (1/min) rate limiting. Accept the leak; future tickets can add CAPTCHA.
- **Per-recipient invite tracking is impossible** with the reusable-link model. An owner who shares one link with 4 friends and sees 2 acceptances cannot tell *which 2*. That's a product cost of choosing Discord-style reusable links over single-use email-token invites. Future tickets could add an opt-in "name your invitee" hint at create time, but it's not part of MYT-38.
- **OAuth round-trip carrier for the invite code is the SPA's responsibility, not this ticket's.** When an unsigned-in user clicks `mythrun.com/join/<code>`, the SPA needs to preserve the code through Cognito's OAuth redirect dance and resume `POST /api/invites/:code/accept` after onboarding completes. Recommended carrier: encode `redirect=/join/<code>` in Cognito's OAuth `state` parameter (survives all provider redirects, including cross-tab and mobile contexts; sessionStorage does not). Backend's contribution to this flow is the `/preview` endpoint (public, lets SPA render campaign name pre-OAuth) + the OAuth-app config (Cognito Hosted UI accepts `state` round-trip out of the box). The frontend ticket owns the actual implementation; this design declares the contract so it doesn't fall on the floor.
- **Rate limits ship with `@fastify/rate-limit`'s default in-memory store** as a known gap. In-memory limits scale per task, not per fleet — staging is typically one task, so the limit is correct there; production will run multiple tasks and the effective limit becomes (per-task limit × task count). MYT-45 lands a Redis-backed store before production traffic.
- **`trustProxy` configuration is required** on the Fastify root instance with the AWS-ALB hop count (1). IP-keyed rate limiters read `request.ips[0]` (the real client) not `req.ip` (which without trustProxy would be the ALB's private IP, collapsing all traffic into one bucket). The MYT-37 jwt-plugin already assumes this; MYT-38's rate limiters depend on it. Verified by the `loadEnv` boot test that asserts trustProxy is set.
- **Owner-as-character ambiguity.** Owners may also play characters in their own campaigns (not in MYT-38's scope to ship character creation). MYT-39 / character-creation ticket handles.

## Load-bearing invariants

1. **The DM is the AI; campaigns have an OWNER (human creator) and PLAYERS.** No third role on `campaign_members`.
2. **`request.user.cognitoUsername` is the federated id (`Google_xyz` / `Discord_<snowflake>`), NOT the user-chosen `users.username`.** Never compare. The user-chosen value lives in `users.username` and is reachable only via `getByCognitoSub`.
3. **`config.auth = 'jwt-no-db'` is allowlisted at boot, NOT honor-system.** The `requireOnboarded` plugin enumerates registered routes during `app.ready()` and throws if any route's `config.auth === 'jwt-no-db'` is outside an explicit allowlist (`POST /api/users/register`, `GET /api/users/check-username`). New uses require an explicit allowlist update + security review.
4. **`repo.users.getByCognitoSub(req.user.sub)` is the canonical "is this user fully onboarded?" probe.**
5. **MYT-40's discipline applies to every multi-step DB write.** `pool.connect()` checkout, `BEGIN; SET LOCAL transaction_isolation='read committed'; SET LOCAL lock_timeout; SET LOCAL statement_timeout;`, anchor lock on a row that always exists, `ROLLBACK` on every non-success path in `try/catch/finally` with the `inTransaction` flag pattern. **`SET LOCAL` requires a transaction** — even for single-statement reads with a per-call `statement_timeout` (the `requireOnboarded` lookup), wrap in `BEGIN ... COMMIT` because `SET LOCAL` outside a transaction is a silent no-op that leaks state to the next pool checkout.
6. **Username comparisons are case-insensitive (LOWER) at storage and query time.** Display preserves user-chosen casing.
7. **Lock-order convention (load-bearing for deadlock avoidance):** `users` row → `campaigns` row → `campaign_invites` row → `campaign_members` row. Every multi-row write transaction acquires locks in this order. The current paths comply: `acceptInvite` locks invite then inserts member (skipping users + campaigns); `create-invite` locks campaigns then inserts invite (skipping users); `revoke` updates a single invite row. New code paths must respect this order or document why they can't.

## Architecture

Three independent concerns with thin interfaces:

- **Onboarding routes** call `repo.users` (existing, modified) + `classifyProfanity` (stub today, deny-list-protected, MYT-44-eventual).
- **`requireOnboarded` hook** runs `getByCognitoSub` once per protected request; enumerates routes at boot to enforce the `jwt-no-db` allowlist.
- **Invite routes** call a new `repo.invites` namespace + new methods on `repo.campaigns` for membership reads/writes.

## File map

| File | Status | Responsibility |
|---|---|---|
| `backend/migrations/005_drop_profile_columns_users.sql` | Create | Drops `email`, `display_name`, `avatar_url`, `auth_provider`. Replaces case-sensitive UNIQUE on `username` with `UNIQUE LOWER(username)`. |
| `backend/src/config/env.ts` | Modify | Add `frontendBaseUrl: string` (REQUIRED in every env; default `http://localhost:5173` for `development`). Boot validator: parses as URL; in `staging`/`production`, host MUST be in `{mythrun.com, staging.mythrun.com}`; in `development`, also accepts `localhost`/`127.0.0.1`. **Pathname must be `/`, search must be empty, hash must be empty** — otherwise loadEnv throws (closes the open-redirect-via-misconfig surface where a value like `https://staging.mythrun.com/redirect?next=` could compose into a phishing URL). The value is used ONLY for composing `inviteUrl` in `POST /api/campaigns/:id/invites` responses; never concatenated with user-controlled suffix into any redirect target. |
| `backend/src/auth/require-onboarded.ts` | Create | `fastify-plugin` wrapped pre-handler hook + boot-time route enumerator. Skips `public`/`jwt-no-db` routes and 404 fall-throughs; returns 403 if no users row. Throws at boot if any route uses `jwt-no-db` outside the allowlist. |
| `backend/src/auth/onboarding-errors.ts` | Create | `UsernameInvalidError`, `UsernameTakenError`, `NotCampaignOwnerError`, `NotCampaignMemberError`, `CampaignNotFoundError`, `RateLimitedError`. |
| `backend/src/llm/profanity.ts` | Create | Stub `classifyProfanity(text): Promise<{profane: boolean; reason?: 'reserved' \| 'profane'}>`. Static deny list of impersonation roots. MYT-44 keeps the deny list as a fast-path. |
| `backend/src/repo/types.ts` | Modify | Drop `email/displayName/avatarUrl/authProvider` from `User` and `CreateUserInput`. Add `CampaignMember`, `CampaignMemberRole`, `CampaignInvite`, `CampaignInvitePreview`, `CreateInviteInput`. |
| `backend/src/repo/mappers.ts` | Modify | Update `toUser` (no profile columns). Add `CampaignMemberDbRow` + `toCampaignMember`, `CampaignInviteDbRow` + `toCampaignInvite`. |
| `backend/src/repo/users.ts` | Modify | Drop `getByEmail`, `getByCognitoSub` becomes case-sensitive on `cognito_sub` (unchanged) but the `getByUsername` query uses `LOWER(username) = LOWER($1)`. `create` no longer takes profile fields. |
| `backend/src/repo/invites.ts` | Create | `repo.invites`: `create`, `getByCode`, `getCodePreview`, `listForCampaign`, `revoke`, `acceptInvite`. The accept method owns its own transaction with FOR NO KEY UPDATE on the invite row + dual timeouts + 23503 catch. |
| `backend/src/repo/invites-errors.ts` | Create | `InviteNotFoundError`, `InviteRevokedError`, `InviteCapReachedError`, `InviteTimeoutError`, `CampaignGoneError`. |
| `backend/src/repo/campaigns.ts` | Modify | Add `addMember`, `getMembership`, `getOwner`, `listMembers`. `addMember` uses the SELECT-after-DO-NOTHING pattern. |
| `backend/src/repo/index.ts` | Modify | Add `invites: createInvitesRepo(pool)`. |
| `backend/src/routes/users.ts` | Create | The three onboarding endpoints + per-IP rate limiter. |
| `backend/src/routes/invites.ts` | Create | The five invite endpoints + `GET /api/campaigns/:id/members` (lives here for path-coherence with the invite UX). |
| `backend/src/routes/__tests__/onboarding.test.ts` | Create | Route-level tests via `app.inject`. |
| `backend/src/routes/__tests__/invite-flow.test.ts` | Create | Route-level invite-flow tests including races. |
| `backend/src/repo/__tests__/invites.test.ts` | Create | Real-pg integration tests for `repo.invites`. |
| `backend/src/auth/__tests__/require-onboarded.test.ts` | Create | Hook unit tests + boot-time allowlist enforcement test. |
| `backend/src/db/__tests__/migrate-schema.test.ts` | Modify | Update expected columns/indexes/constraints to reflect migration 005's drops + the new LOWER index. |

## Endpoints

### `POST /api/users/register`

- `config.auth = 'jwt-no-db'` (no users row required).
- Body: `{username: string, displayName: string}` validated by Zod. `displayName` is 1-40 chars, profanity-gated (same stub deny list as username), trimmed of leading/trailing whitespace, no uniqueness check (two users can both be "Alice").
- Per-IP rate limit: 5 req/min. Per-`cognito_sub` rate limit: 1 req/min. (Username squatting protection.)
- Statement timeout: 200ms on the connection used for register's read+write.
- Pipeline: format-check → profanity-check (stub today; deny-list-protected) → INSERT. **There is NO uniqueness check before the INSERT.** Doing one would be classic check-then-act TOCTOU; the DB-level UNIQUE constraints are the actual line of defense, the implementation catches `23505`. The `check-username` endpoint exists for UX-debounce probing only; it's advisory, not a reservation.
- The INSERT relies on the DB-level `UNIQUE(cognito_sub)` and `UNIQUE LOWER(username)` constraints as the line of defense. Implementation MUST catch SQLSTATE `23505` and inspect `constraint_name`:

  - `users_cognito_sub_key` → caller is already onboarded. Read the existing row (single-statement SELECT inside a same-connection transaction or via repeatable-read so a future `PATCH /me` doesn't race the post-failure probe) and branch:
     - **If the existing row's `LOWER(username) === LOWER(req.body.username)`** → caller is replaying the same request. Return `200 {user, created: false}` with `Content-Location: /api/users/me`. (NOT `Location` — RFC 7231 says `Content-Location` is the right header on 200 to point at the canonical URL of the response body.)
     - **If the usernames differ** → caller is already onboarded as someone else; the request body would otherwise be silently discarded. Return `409 {code: 'already_onboarded', currentUsername, requestedUsername}` with just the username string from the existing row + the username from the request. Do NOT include the full `User` object in an error body — the SPA can call `GET /api/users/me` to hydrate if it actually needs the full row. Smaller error payload, cleaner schema separation.
  - `users_username_lower_key` → username taken. Return `409 {code: 'username_taken', suggestion: '<original><2-3 random digits>'}`. The suggestion is itself piped through profanity/format checks before being returned (so we don't suggest `admin42`). The suggestion is best-effort, not a reservation; the SPA must call check-username on the suggestion before final submit.

  Any other 23505 (or other error) → propagate as 500.

**Responses:**
- `201 {user, created: true}` — new row created. `Location: /api/users/me` header.
- `200 {user, created: false}` — caller's `cognito_sub` already has a row AND the requested username matches. Idempotent replay. `Content-Location: /api/users/me` header.
- `400 {code: 'username_invalid', reason: 'format' | 'profane' | 'reserved'}`.
- `400 {code: 'display_name_invalid', reason: 'length' | 'profane'}`.
- `409 {code: 'username_taken', suggestion: 'gandalf42'}`.
- `409 {code: 'already_onboarded', currentUsername, requestedUsername}` — caller is onboarded as a different username. SPA hydrates user via /me if needed.
- `429 {code: 'rate_limited', retryAfterSec: N}` + `Retry-After` header.

### `GET /api/users/check-username?username=<value>`

- `config.auth = 'jwt-no-db'`.
- Username via QUERY PARAM (not path).
- Per-IP rate limit: 10 req/min. Per-`cognito_sub`: 60 req/min (allows debounced typing UX).
- Returns `200 {available: true} | {available: false, reason: 'format' | 'taken' | 'reserved' | 'profane'}`. Discriminated union (no optional `reason`). **The `reason` vocabulary is identical to `register`'s** (`'format' | 'profane' | 'reserved'`) plus `'taken'` which is unique to this lookup endpoint. SPA can use one Zod schema for both endpoints' reason fields.
- `429 {code: 'rate_limited', retryAfterSec: N}` + `Retry-After` header.

### `GET /api/users/me`

- Default auth (hook fires).
- Returns `200 {user}`.

The `User` shape (matching repo types after migration 005):

```typescript
interface User {
  id: string                         // UUIDv7
  cognitoSub: string                 // opaque
  username: string                   // user-chosen handle, case preserved
  displayName: string                // user-chosen friendly name, free-form
  stripeCustomerId: string | null
  freeTrialUsed: boolean
  suspendedAt: Date | null
  createdAt: Date
  updatedAt: Date
}
```

### `POST /api/campaigns/:id/invites`

- Default auth.
- Owner-only: `repo.campaigns.getMembership(:id, currentUserId)` → role must be `'owner'` else 403 `{code: 'not_campaign_owner'}`. If campaign doesn't exist → 404 `{code: 'campaign_not_found'}`.
- **Cap with proper locking**: open a transaction with the same MYT-40 triple (`BEGIN; SET LOCAL transaction_isolation = 'read committed'; SET LOCAL lock_timeout = '500ms'; SET LOCAL statement_timeout = '2000ms';`), then `SELECT id FROM campaigns WHERE id = $1 FOR NO KEY UPDATE`, count active invites under the lock, INSERT if `count < 25`. Closes the cap-TOCTOU race. The campaigns-row lock follows the load-bearing lock-order convention (campaigns → invites → members).
- Past the cap → `409 {code: 'invite_cap_reached', activeInvites: 25}`.
- Returns `201 {inviteCode, inviteUrl, uses, expiresAt, createdAt}` with `Location: /api/invites/<code>/preview` header. **`inviteUrl` is always present** (`${env.frontendBaseUrl}/join/${inviteCode}`); `frontendBaseUrl` is required in every env per the env validator above. The frontend never has to compose the URL itself.

### `GET /api/campaigns/:id/invites`

- Default auth, owner-only.
- Returns `200 {invites: [{inviteCode, inviteUrl, uses, expiresAt, createdAt, primary}, ...]}`. The `primary: boolean` field marks the first (oldest, non-revoked) invite — surfaces the canonical "share this" link. Recomputed per-request: if the owner revokes the current primary, the next-oldest non-revoked becomes primary on the next list call. SPAs caching the value should refetch after any mutation.

### `DELETE /api/campaigns/:id/invites/:inviteCode`

- Default auth, owner-only.
- **Addresses by `inviteCode`** (not `inviteId`) for symmetry with `accept` and `preview`, AND so the owner can call DELETE directly from the `listForCampaign` response (which exposes `inviteCode`, not `inviteId`).
- `repo.invites.revoke(inviteCode, campaignId)` sets `expires_at = now()` if the invite belongs to the campaign.
- Returns `204` on success. Returns `404 {code: 'invite_not_found'}` if the code is unknown OR belongs to a different campaign (response shape is identical for both — no enumeration oracle).

### `GET /api/invites/:inviteCode/preview`

- **`config.auth = 'public'`** — pre-OAuth lookup so the SPA can show "Join Alice's campaign" before sign-in.
- Per-IP rate limit: 10 req/min (tightened from earlier 30/min after security review flagged code-enumeration risk).
- `repo.invites.getCodePreview(:inviteCode)` joins `campaign_invites` → `campaigns` → `users`, filtered by `users.suspended_at IS NULL`. Per-statement timeout 200ms (matches `requireOnboarded` discipline). Returns minimal payload:
  - `200 {campaignName: string, ownerUsername: string, ownerDisplayName: string, valid: boolean}` — `valid: false` if revoked. **Always 200 for codes that exist** (whether revoked or not). The SPA renders "Join Alice's campaign" using `ownerDisplayName` with `(@gandalf)` parenthetical. The status-code language differs from `accept` deliberately: preview is a lookup that reports state; accept is an action that fails. SPA renders "this invite is no longer active" from `valid: false` without an HTTP-error branch.
  - `404 {code: 'invite_not_found'}` if no such code OR owner is suspended.
  - `429 {code: 'rate_limited', retryAfterSec: N}`.
- **No campaignId, no inviteId, no createdBy uuid in the response.** Limits the public attack surface.

**Note on UGC**: `ownerUsername` is user-set. The SPA must treat it as untrusted text (escape on render). A future moderation ticket may layer server-side checks against username patterns reported as abusive; today's deny list and profanity gate are the only filters.

### `POST /api/invites/:inviteCode/accept`

- Default auth (any onboarded user).
- Per-`user_id` rate limit: 30 req/min (DB-load protection).
- `repo.invites.acceptInvite({code, userId: currentUserId})` runs in a transaction (see §"acceptInvite transaction" below).
- Outcomes:
  - `201 {campaignId, alreadyMember: false}` — happy path; **new membership row created**. `Location: /api/campaigns/:id` header. (201 vs 200 distinguishes "I just joined" from "I was already in" at the HTTP-status level, in addition to `alreadyMember`.)
  - `200 {campaignId, alreadyMember: true}` — user is already in the campaign; idempotent. **Returned even for codes that are now revoked** — being a member trumps the revoke flag (you're already in, who cares the link expired). The membership-leak-oracle concern from round-5 review was scrutinized and dismissed: the only information disclosed is the caller's own membership in their own campaign, which they can already learn from `/me/campaigns`.
  - `404 {code: 'invite_not_found'}`.
  - `410 {code: 'invite_revoked'}` (no `Retry-After`; the SPA must not auto-retry).
  - `410 {code: 'campaign_gone'}` if the campaign was deleted between invite-create and accept (catches FK violation `23503`).
  - `409 {code: 'campaign_full', activeMembers: 6}` — campaign is at the max-party cap. Owner needs to remove a member (future endpoint) for any new accepts to succeed.
  - `503 {code: 'invite_timeout', retryAfterSec: 1}` + `Retry-After: 1` — `lock_timeout` (55P03) or `statement_timeout` (57014) fired.
  - `429 {code: 'rate_limited', retryAfterSec: N}` + `Retry-After` header.

### `GET /api/campaigns/:id/members`

- Default auth, ANY MEMBER.
- `repo.campaigns.listMembers(:id)` returns `[{userId, role, username, joinedAt}, ...]`. **No display name, no email, no avatar URL** — those columns no longer exist. Frontend renders `@{username}` for each.
- `200 {members: [...]}`. Bare-array-in-object shape (cursor field omitted; the 6-member cap makes pagination irrelevant for the foreseeable future, and additive evolution is allowed by the versioning posture if pagination ever ships).
- `403 {code: 'not_campaign_member'}` if caller isn't a member.
- `404 {code: 'campaign_not_found'}`.

### Versioning posture

Implicitly v1. **Evolution policy: additive-only.** New optional fields can be added; existing fields cannot be renamed or have their type narrowed without a coordinated frontend change. Breaking changes ship at `/v2/...`. **Deprecation signaling**: when a future change deprecates a field, the response will include a `Deprecation: true` header + a `Sunset: <RFC1123 date>` header for the affected endpoints; `Link` header points at the migration doc. (Not used today; documented now so the convention exists.)

## Pre-handler hook (`requireOnboarded`)

```typescript
// backend/src/auth/require-onboarded.ts
import fp from 'fastify-plugin'
import type { FastifyPluginAsync } from 'fastify'
import type { Pool } from 'pg'
import { createUsersRepo } from '../repo/users.js'

interface Opts { readonly pool: Pool }

const JWT_NO_DB_ALLOWLIST = new Set<string>([
  'POST::/api/users/register',
  'GET::/api/users/check-username',
])

const impl: FastifyPluginAsync<Opts> = async (app, opts) => {
  const users = createUsersRepo(opts.pool)

  // Boot-time enumeration: enforce the jwt-no-db allowlist by collecting
  // every route's config at registration via Fastify's onRoute hook
  // (Fastify v5 has no stable public app.routes() API; the canonical
  // pattern is onRoute → collect → validate in onReady). Fails
  // app.ready() if any route uses 'jwt-no-db' outside the allowlist.
  // Runtime check sees the actual config value regardless of how the
  // source spelled it.
  const observedJwtNoDbRoutes: Array<{ method: string; url: string }> = []
  app.addHook('onRoute', (routeOptions) => {
    const cfg = routeOptions.config as { auth?: string } | undefined
    if (cfg?.auth === 'jwt-no-db') {
      // routeOptions.method may be a string OR string[] (multi-method route).
      const methods = Array.isArray(routeOptions.method)
        ? routeOptions.method
        : [routeOptions.method]
      for (const m of methods) {
        observedJwtNoDbRoutes.push({ method: m, url: routeOptions.url })
      }
    }
  })

  app.addHook('onReady', async () => {
    const offenders: string[] = []
    for (const { method, url } of observedJwtNoDbRoutes) {
      // Normalize: uppercase method, strip trailing slash from URL.
      // Without normalization, a typo like '/api/users/register/' or a
      // method-case mismatch would silently slip past the allowlist
      // (the route would still register, the allowlist key wouldn't
      // match, fail-closed kicks in — but the diagnostic gets confusing).
      const normalizedMethod = method.toUpperCase()
      const normalizedUrl = url.replace(/\/$/, '') || '/'
      const key = `${normalizedMethod}::${normalizedUrl}`
      if (!JWT_NO_DB_ALLOWLIST.has(key)) {
        offenders.push(key)
      }
    }
    if (offenders.length > 0) {
      throw new Error(
        `requireOnboarded: jwt-no-db opt-out used on non-allowlisted routes: ${offenders.join(', ')}. ` +
        `If a new route legitimately needs jwt-no-db, add it to JWT_NO_DB_ALLOWLIST in require-onboarded.ts ` +
        `AND get a security review on the PR.`,
      )
    }
  })

  app.addHook('preHandler', async (request, reply) => {
    const cfg = request.routeOptions?.config?.auth
    if (cfg === 'public' || cfg === 'jwt-no-db') return

    if (request.routeOptions?.url === undefined) return

    if (!request.user) {
      return reply.code(401).send({ code: 'unauthenticated' })
    }

    // Statement timeout caps tail latency under DB stress.
    const row = await users.getByCognitoSubWithTimeout(request.user.sub, 200)
    if (!row) {
      return reply.code(403).send({ code: 'username_required' })
    }
  })
}

export const requireOnboarded = fp(impl, {
  fastify: '5.x',
  name: 'mythrun-require-onboarded',
  dependencies: ['mythrun-auth-jwt'],
})
```

`getByCognitoSubWithTimeout(sub, ms)` is a new repo method that **wraps the SELECT inside a short transaction** (`BEGIN; SET LOCAL statement_timeout='200ms'; SELECT ...; COMMIT;`) — `SET LOCAL` is a silent no-op outside a transaction. The transaction is read-only and trivially small. Translates SQLSTATE `57014` to a typed `LookupTimeoutError` → 503.

## Repo additions

### `repo.users` modifications (post-migration 005)

```typescript
interface User {
  readonly id: string
  readonly cognitoSub: string
  readonly username: string
  readonly displayName: string
  readonly stripeCustomerId: string | null
  readonly freeTrialUsed: boolean
  readonly suspendedAt: Date | null
  readonly createdAt: Date
  readonly updatedAt: Date
}

interface CreateUserInput {
  readonly cognitoSub: string
  readonly username: string
  readonly displayName: string
}

createUsersRepo(pool: Pool): {
  create(input: CreateUserInput): Promise<User>
  getById(id: string): Promise<User | null>
  getByCognitoSub(sub: string): Promise<User | null>
  getByCognitoSubWithTimeout(sub: string, statementTimeoutMs: number): Promise<User | null>  // throws LookupTimeoutError on 57014
  getByUsername(username: string): Promise<User | null>  // case-insensitive (LOWER(username) = LOWER($1))
  update(id: string, patch: UserUpdate): Promise<User>
  // getByEmail removed — no email column.
}
```

### `repo.invites` (new file `backend/src/repo/invites.ts`)

```typescript
export interface CampaignInvite {
  readonly id: string
  readonly campaignId: string
  readonly createdBy: string
  readonly inviteCode: string
  readonly maxUses: number | null
  readonly uses: number
  readonly expiresAt: Date | null
  readonly createdAt: Date
  readonly primary: boolean   // computed: true for oldest non-revoked invite
}

export interface CampaignInvitePreview {
  readonly campaignName: string
  readonly ownerUsername: string
  readonly valid: boolean
}

interface AcceptResult {
  readonly campaignId: string
  readonly alreadyMember: boolean
}

createInvitesRepo(pool, opts?: { lockTimeoutMs?: number; statementTimeoutMs?: number }): {
  create(input: { campaignId: string; createdBy: string }): Promise<CampaignInvite>
  getByCode(code: string): Promise<CampaignInvite | null>
  getCodePreview(code: string): Promise<CampaignInvitePreview | null>
  listForCampaign(campaignId: string): Promise<CampaignInvite[]>  // active only, primary computed
  revoke(inviteCode: string, campaignId: string):
    Promise<{ revoked: true } | { notFoundOrWrongCampaign: true }>
  acceptInvite(input: { code: string; userId: string }):
    Promise<
      | AcceptResult
      | { notFound: true }
      | { revoked: true }
      | { campaignGone: true }
    >
  // throws InviteTimeoutError on SQLSTATE 55P03/57014.
}
```

### `acceptInvite` transaction (load-bearing, revised)

The order of operations matters: a user who is already a member sees `alreadyMember: true` even if the invite was later revoked. Membership trumps revoke.

**Implementation MUST issue BEGIN + the three SET LOCALs as a single multi-statement query string** (`BEGIN; SET LOCAL transaction_isolation='read committed'; SET LOCAL lock_timeout='500ms'; SET LOCAL statement_timeout='2000ms';`) — matches MYT-40 discipline. Do NOT wrap in a transaction-helper that hoists BEGIN/COMMIT; ordering of the SET LOCAL statements relative to BEGIN is load-bearing (they're transaction-scoped).

**Party cap check** (added to step 4): before the membership INSERT, also verify the campaign is not at the max-party cap. Default cap is **6 members** (D&D party convention). The check is under the same transaction (the invite-row lock indirectly serializes accepts, but the cap requires its own count):

```sql
-- 4a. Cap check before INSERT.
SELECT count(*) FROM campaign_members WHERE campaign_id = <invite.campaign_id>;
-- if count >= 6 → ROLLBACK; return {campaignFull: true}
```

The campaign-full path returns `409 {code: 'campaign_full', activeMembers: 6}` to the caller. Note: this cap is per-campaign, not per-invite. A future ticket can make the cap owner-configurable; for MYT-38 it's a hardcoded constant.

```sql
BEGIN;
SET LOCAL transaction_isolation = 'read committed';
SET LOCAL lock_timeout = '500ms';
SET LOCAL statement_timeout = '2000ms';

-- 1. Lock the invite row. FOR NO KEY UPDATE in case of future FK targets.
SELECT * FROM campaign_invites WHERE invite_code = $1 FOR NO KEY UPDATE;
-- 0 rows → ROLLBACK; return {notFound: true}

-- 2. Membership check FIRST. If the caller is already a member of the
--    invite's campaign, they short-circuit success regardless of expiry.
--    NOTE for future authors: this SELECT does NOT take a row lock today.
--    That's safe in MYT-38 because there is no removeMember endpoint —
--    `campaign_members` rows are append-only. WHEN removeMember ships
--    (campaign-membership ticket), this SELECT must either become
--    `SELECT … FOR SHARE` (block concurrent removes) OR the entire
--    membership-check path must be replaced by an INSERT-first pattern
--    (let step 4's ON CONFLICT do the membership detection). Filed as
--    a forward-compat concern in the campaign-membership ticket.
SELECT 1 FROM campaign_members
  WHERE campaign_id = <invite.campaign_id> AND user_id = $userId;
-- found → COMMIT; return {campaignId, alreadyMember: true}
-- (Skip step 3-5 entirely on this path; uses is NOT incremented because
--  this user didn't join via this invite — they were already a member.)

-- 3. Expiry check, with the lock held. Only reached for non-members.
-- expires_at IS NOT NULL AND expires_at <= now() → ROLLBACK; return {revoked: true}

-- 4. Insert membership. Catch SQLSTATE 23503 (FK violation) → campaign deleted
--    between invite-create and accept → ROLLBACK; return {campaignGone: true}.
INSERT INTO campaign_members (id, campaign_id, user_id, role, invite_accepted)
VALUES ($id, $campaignId, $userId, 'player', true)
ON CONFLICT (campaign_id, user_id) DO NOTHING
RETURNING *;
-- ┌── rowCount === 1 (we inserted): proceed to step 5.
-- │
-- └── rowCount === 0 (a concurrent accept by THIS user via a DIFFERENT
--     invite landed the row a moment ago): COMMIT; return
--     {campaignId, alreadyMember: true}. Do NOT proceed to step 5;
--     uses on THIS invite must not be incremented because the user did
--     not actually join via this invite. This is the load-bearing fix
--     for the same-user-different-code race.

-- 5. Increment uses — ONLY on the rowCount === 1 path above.
UPDATE campaign_invites SET uses = uses + 1 WHERE id = $inviteId;

COMMIT;
-- return {campaignId, alreadyMember: false}
```

**Invariant**: `uses` on `campaign_invites` reflects the count of successful joins **via that specific invite**. Equivalently: `uses` increments iff the rowCount-=== 1 branch was taken in step 4 of THIS invite's transaction. A user who joins a campaign via invite A and then visits invite B's URL gets `alreadyMember: true` from step 2; B's `uses` stays unchanged.

Catches:
- SQLSTATE `55P03` (lock_timeout) → throw `InviteTimeoutError(sqlstate)`.
- SQLSTATE `57014` (statement_timeout) → throw `InviteTimeoutError(sqlstate)`.
- SQLSTATE `23503` (FK violation on campaign_members.campaign_id) → return `{campaignGone: true}`.
- All other errors → propagate.

ROLLBACK runs in `finally` if `inTransaction` is still true. `client.release()` always.

### `repo.campaigns` extensions

```typescript
addMember(input: {
  campaignId: string
  userId: string
  role: CampaignMemberRole
  inviteAccepted?: boolean
}): Promise<CampaignMember>  // SELECT-after-DO-NOTHING; returns existing on collision

getMembership(campaignId: string, userId: string): Promise<CampaignMember | null>

getOwner(campaignId: string): Promise<CampaignMember | null>

listMembers(campaignId: string): Promise<Array<{
  userId: string
  role: CampaignMemberRole
  username: string
  displayName: string
  characterId: string | null   // always null in MYT-38; populated by character-creation ticket. Forward-compat shape.
  joinedAt: Date
}>>  // join campaign_members → users; filters out users.suspended_at IS NOT NULL
```

### Code generator

```typescript
// 12-char base62. ~71 bits entropy. Modulo bias is ~0.4% on the tail
// alphabet entries; rejection sampling keeps the distribution uniform.
function generateInviteCode(): string {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789'
  const result: string[] = []
  while (result.length < 12) {
    const b = randomBytes(1)[0]!
    if (b < 248) result.push(alphabet[b % 62]!)  // reject the top 8 to remove bias
  }
  return result.join('')
}
```

`repo.invites.create` retries up to 3 times on SQLSTATE `23505` **only when `constraint_name === 'campaign_invites_invite_code_key'`**; any other 23505 (future unique constraints on the table) rethrows immediately rather than masking a real bug. Other errors rethrow. After 3 invite-code-collision retries, throws `InviteCreationError` (genuine schema corruption; never expected at our scale).

## Errors

| Class | Where | HTTP | Body |
|---|---|---|---|
| `UsernameInvalidError` | register, check-username | 400 | `{code: 'username_invalid', reason: 'format' \| 'profane' \| 'reserved'}` |
| `UsernameTakenError` | register | 409 | `{code: 'username_taken', suggestion: 'gandalf42'}` |
| (no class — inline 401 from hook) | hook | 401 | `{code: 'unauthenticated'}` |
| (no class — inline 403 from hook) | hook | 403 | `{code: 'username_required'}` |
| `NotCampaignOwnerError` | invite create/list/revoke | 403 | `{code: 'not_campaign_owner'}` |
| `NotCampaignMemberError` | listMembers | 403 | `{code: 'not_campaign_member'}` |
| `CampaignNotFoundError` | invite create, listMembers | 404 | `{code: 'campaign_not_found'}` |
| `CampaignGoneError` | accept (FK race) | 410 | `{code: 'campaign_gone'}` |
| `InviteCapReachedError` | invite create | 409 | `{code: 'invite_cap_reached', activeInvites: 25}` |
| `CampaignFullError` | accept | 409 | `{code: 'campaign_full', activeMembers: 6}` |
| `InviteNotFoundError` | accept, revoke (combined w/ wrong-campaign), preview | 404 | `{code: 'invite_not_found'}` |
| `InviteRevokedError` | accept (non-member only) | 410 | `{code: 'invite_revoked'}` |
| `InviteTimeoutError` | accept | 503 | `{code: 'invite_timeout', retryAfterSec: 1, cause: 'lock' \| 'statement'}` + `Retry-After: 1` header. The `cause` discriminator splits SQLSTATE 55P03 (lock_timeout — contention) from 57014 (statement_timeout — slow query); dashboards can graph them separately. |
| `LookupTimeoutError` | hook (rare) | 503 | `{code: 'lookup_timeout', retryAfterSec: 1}` + `Retry-After: 1` header |
| `RateLimitedError` | every endpoint with a rate limit | 429 | `{code: 'rate_limited', retryAfterSec: N}` + `Retry-After: N` header |

**Error-body shape contract**: every error body has `{code: string}` + an optional `message?: string` for human-readable display + zero-or-more error-specific fields. SPAs branch on `code`, render `message` if present (fallback to a localized string keyed off `code` if absent).

All custom subclasses with `readonly code` discriminator + readonly fields.

**Error-body shape contract**: every error body has `{code: string}` + zero-or-more error-specific fields. Documented for future endpoints.

**Logging policy**:
- `cognito_sub` and `users.id` (UUID) — OK at info level.
- `username` — OK at info level (user-chosen handle, public).
- `email`, `displayName`, `avatarUrl` — N/A (don't exist anymore).
- Full JWT bodies — never logged.
- `info` for client errors (400/403/404/409/410/429). `warn` for transient 503 (`InviteTimeoutError`, `LookupTimeoutError`). `error` for unexpected throws.

## Profanity stub

```typescript
// backend/src/llm/profanity.ts
//
// STUB. Real Haiku call lands in MYT-44 (LLM wrapper layer).
// Tracking bead: myth-urh6.
//
// The deny list IS NOT a stub — it's the fast-path that MYT-44 keeps in
// place before the Haiku call. Independent of MYT-44 progress.

// Hard impersonation roots only. Common D&D / community handles like
// 'dm', 'owner', 'mod', 'staff', 'team' are intentionally NOT reserved —
// review found they're plausible legitimate usernames in the Mythrun
// audience. The list grows when we discover specific impersonation
// patterns, NOT to cover broad role-words.
const RESERVED_USERNAMES = new Set([
  'admin', 'administrator', 'support', 'help', 'system', 'security',
  'mythrun', 'mythrun_team', 'mythrunhq', 'official',
  'anthropic', 'anthropic_team', 'stripe', 'aws', 'cognito',
  'root', 'noreply', 'no_reply', 'me', 'null', 'undefined',
])

// Open-source profanity seed list. The launch-gap (between MYT-38 ship
// and MYT-44's Haiku call) needs more than impersonation-root protection
// — usernames like 'gandalf69_h1tler' would otherwise register cleanly.
// We bundle the Shutterstock List-of-Dirty-Naughty-Obscene-and-Otherwise-
// Bad-Words English seed list at backend/src/llm/profanity-seed-en.txt
// (~2k entries, MIT-licensed). Match is case-insensitive substring AND
// edit-distance ≤ 1 to catch trivial obfuscations. MYT-44 keeps this as
// a fast-path before calling Haiku.

export interface ProfanityResult {
  readonly profane: boolean
  readonly reason?: 'reserved' | 'profane'
}

export async function classifyProfanity(text: string): Promise<ProfanityResult> {
  if (RESERVED_USERNAMES.has(text.toLowerCase())) {
    return { profane: true, reason: 'reserved' }
  }
  // TODO MYT-44: real Haiku call goes here.
  return { profane: false }
}
```

## Tests

### Repo integration tests (real Postgres)

`repo/users.test.ts` updates:
- Migration 005 dropped columns reflected; tests stop asserting `email`/`displayName`/etc.
- `getByUsername` is case-insensitive: `getByUsername('GANDALF') === getByUsername('gandalf')`.
- INSERT of a second user with same `LOWER(username)` (e.g., `Admin` after `admin`) → SQLSTATE `23505` on `users_username_lower_key`.
- `getByCognitoSubWithTimeout` happy path returns user; with `1ms` timeout against an artificially-slow query throws `LookupTimeoutError(57014)`.

`repo/invites.test.ts`:
- `create` cap: 26th invite throws `InviteCapReachedError` even under concurrent creation (test races two `create` calls when the count is 24, asserts only one succeeds, the other returns the cap-reached error or both succeed and a third one fails — under FOR NO KEY UPDATE on the campaigns row, exactly one is rejected).
- `getByCode` round-trip; null on unknown.
- `getCodePreview` returns campaign name + `ownerUsername`; null on unknown OR owner suspended; `valid: false` on revoked.
- `listForCampaign` excludes expired; `primary: true` on the oldest non-revoked.
- `revoke` returns `{revoked: true}` on success; `{notFoundOrWrongCampaign: true}` for both unknown id AND mismatched campaign.
- `acceptInvite` happy → `{campaignId, alreadyMember: false}`, member row + uses=1.
- `acceptInvite` already-member, NEW invite → `{alreadyMember: true}`, uses NOT incremented.
- `acceptInvite` already-member, REVOKED invite → `{alreadyMember: true}`, NOT `{revoked: true}`. (Membership trumps revoke.)
- `acceptInvite` non-member, revoked invite → `{revoked: true}`.
- `acceptInvite` not-found → `{notFound: true}`.
- `acceptInvite` campaign deleted between invite-create and accept → `{campaignGone: true}` (test inserts an invite, deletes the campaign with `CASCADE` skipped via raw SQL, calls accept, asserts).
- **Concurrent same-user double-accept** → exactly one membership row, exactly one uses increment.
- **Concurrent different-user accept** → both succeed; `uses === 2` exactly; the FOR NO KEY UPDATE serializes them.
- **Concurrent accept-vs-revoke (accept wins)** → accept returns `{alreadyMember: false}`, member row exists, `uses === 1`, subsequent revoke succeeds and leaves both intact.
- **Concurrent accept-vs-revoke (revoke wins)** → accept returns either `{revoked: true}` (revoke commits before accept's lock acquisition) OR `503 InviteTimeoutError` (revoke holds the row long enough that accept's `lock_timeout = 500ms` fires with SQLSTATE 55P03). Both outcomes are correct; the test asserts one OR the other, not just `{revoked: true}`.
- **Concurrent same-user accept on TWO different invites for SAME campaign** → exactly one member row, **uses on each invite is at most 1, and `uses_invite_a + uses_invite_b === 1`** (one join via one of them; the other observes alreadyMember=true at step 2 OR rowCount=0 at step 4 and skips the uses bump). Run 100 iterations.
- **`lock_timeout` mapping** → hold the invite-row lock on a separate connection, race acceptInvite with `{lockTimeoutMs: 200}`, assert `InviteTimeoutError` with SQLSTATE `55P03`, elapsed in `[150ms, 2000ms]`.

`repo/campaigns.test.ts` extensions:
- `addMember` happy + idempotent collision returns existing row.
- `getMembership` / `getOwner` happy + null cases.
- `listMembers` joins users; returns username (no display name field); excludes suspended users.

### Route-level tests (`app.inject`)

`routes/onboarding.test.ts`:
- register happy → 201 `created: true`, user in DB. `Location: /api/users/me` header.
- register self-already-onboarded → 200 `created: false`. Same header.
- register invalid format → 400.
- register reserved (`admin`) → 400 `reason: 'reserved'`.
- register profane (mock `classifyProfanity` → `{profane: true, reason: 'profane'}`) → 400.
- register username conflict (different cognito_sub, same lowercase username) → 409, suggestion is non-deterministic (5 runs, ≥ 2 distinct), suggestion itself is run through profanity (mock to assert).
- register IP rate limit → 429 + Retry-After header after 6th call/min.
- check-username available / invalid / taken / reserved → discriminated-union body.
- check-username rate limit per-IP and per-cognito_sub.
- GET /me before register → 403 `username_required`.
- GET /me after register → 200, includes only `{id, cognitoSub, username, stripeCustomerId, freeTrialUsed, suspendedAt, createdAt, updatedAt}` — assert no email/displayName/avatarUrl/authProvider in payload.

`routes/invite-flow.test.ts`:
- Owner creates invite → 201; `Location` header; `inviteUrl` present in non-dev; `primary: true` on the only invite.
- Cap: 25 invites then 26th → 409 `invite_cap_reached`.
- Cap under concurrency: spawn 26 parallel creates against a fresh campaign → exactly 25 succeed; remaining return 409.
- Non-owner create / list → 403.
- Owner revokes existing invite → 204.
- Owner revokes invite for OTHER campaign → 404 `invite_not_found` (response identical to nonexistent — no enumeration oracle).
- Player accepts new invite → 200 `alreadyMember: false`.
- Player accepts revoked invite they're NOT a member of → 410 `invite_revoked`.
- Player accepts revoked invite they ARE a member of → 200 `alreadyMember: true`. (Membership trumps revoke.)
- Player accepts when campaign deleted → 410 `campaign_gone`.
- Per-user rate limit: 31st accept/min by same user → 429.
- Member calls listMembers → 200 with self in list (only `username` + role + joinedAt fields).
- Non-member calls listMembers → 403.
- Public preview valid → 200 with `campaignName, ownerUsername, valid: true`. NO campaignId, NO inviteId.
- Public preview revoked → **200 with `valid: false`** (preview is a lookup; aligns with the spec body, NOT 410. Earlier draft inconsistency caught in round-3 review.)
- Public preview suspended-owner campaign → 404.
- Public preview rate limit → 429 after 11th call/min.
- Bypass-mode dev hits protected route before register → 403 `username_required`.

### Hook tests

`auth/__tests__/require-onboarded.test.ts`:
- Public/jwt-no-db routes → hook skips.
- 404 fall-through → hook skips.
- No `request.user` → 401.
- User row missing → 403.
- User row present → next.
- **Boot-time allowlist**: app.ready() succeeds when only allowlisted routes use `jwt-no-db`.
- **Boot-time allowlist failure**: app.ready() throws when a non-allowlisted route uses `jwt-no-db`. (Test registers a fixture route + asserts the error message names the offender.)

### Schema-parity test

`db/__tests__/migrate-schema.test.ts` updates:
- Apply migration 005 in the integration test's seed flow.
- EXPECTED_USER_COLUMNS no longer includes `email`/`display_name`/`avatar_url`/`auth_provider`.
- EXPECTED_UNIQUE_INDEXES includes `users_username_lower_key`; excludes the old `users_username_key`.

### Env validator tests

`config/env.test.ts` extensions:
- `frontendBaseUrl=https://staging.mythrun.com` in staging → loadEnv passes.
- `frontendBaseUrl=https://attacker.example.com` → loadEnv throws.
- `frontendBaseUrl=http://localhost:5173` in development → loadEnv passes.
- `frontendBaseUrl=http://localhost:5173` in staging or production → loadEnv throws.
- `frontendBaseUrl` unset in staging or production → loadEnv throws.
- `frontendBaseUrl=https://staging.mythrun.com/redirect` (path component) → loadEnv throws.
- `frontendBaseUrl=https://staging.mythrun.com/?next=foo` (query) → loadEnv throws.
- `frontendBaseUrl=https://staging.mythrun.com/#bar` (hash) → loadEnv throws.

## Spec deviations

This design overrides the parent auth spec (`docs/specs/2026-04-13-auth-users.md`) on several axes. The parent spec gets a patch as part of MYT-38 close.

1. **Identity model is minimal-claims.** The parent spec §4 stores `email`, `display_name`, `avatar_url`, `auth_provider` derived from OAuth claims. This design drops all four (migration 005). Mythrun's identity is `cognito_sub` + `username`. Future profile fields (avatar upload, etc.) ship post-launch as user-uploadable, not Cognito-claim-derived.
2. **Endpoint paths.** Parent §10 lists `/api/users/register`, `/api/users/me`, `/api/campaigns/:id/invite` (singular), `/api/invites/:code/accept`. This design uses plural `/api/campaigns/:id/invites` + adds `/api/invites/:code/preview` (public preview) and `/api/campaigns/:id/members` (member list). Parent spec §10 line 430-432 gets a one-line patch from singular to plural.
3. **First-login gate** is a 403-with-`{code}` from the `requireOnboarded` hook, NOT a 404 from `/api/users/me` (parent §4.1's position). Rejected during brainstorm: 404 conflates "resource not found" with "needs onboarding."
4. **Invite model** is reusable Discord-style links, NOT single-use tokens (the Linear ticket's position). Schema supports reusable; parent §9 specifies reusable.
5. **Invite role parameter** doesn't exist. The DM is the AI; campaign owner = human creator; invitees = players. No third role.
6. **`PATCH /api/users/me` and rate-limited username changes** (parent §4.5) are out of scope here.
7. **Username case-folding** (parent §4 doesn't address): UNIQUE on `LOWER(username)` per migration 005. Display preserves user-chosen casing.

The Linear ticket description should be updated post-implementation to reflect the final endpoint surface. The "Done when" list is structurally compatible with this design (the bullets describe the same surface, with the path/single-use-vs-reusable axes patched per above).
