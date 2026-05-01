# MYT-38: User Onboarding (Username + Invites) — Design

**Linear:** [MYT-38](https://linear.app/mythrun/issue/MYT-38)
**Spec source:** `docs/specs/2026-04-13-auth-users.md` §4 + §9
**Date:** 2026-05-01
**Related:** MYT-37 (jwt-plugin, shipped), MYT-39 (will subsume `requireOnboarded` hook + adds `loadCurrentUser` caching), MYT-44 (LLM wrapper, replaces profanity stub), `myth-urh6` (post-MYT-44 swap bead)

---

## Goal

Three things, scoped tightly:

1. **Username onboarding** — `POST /api/users/register`, `GET /api/users/check-username` (query param), `GET /api/users/me`. Format validation + (stubbed) profanity gate + uniqueness + suggestion.
2. **First-login gate** — `requireOnboarded` Fastify pre-handler hook + a CI test enforcing the `'jwt-no-db'` opt-out allowlist. Returns 403 `{code: 'username_required'}` on protected routes when no Mythrun user row exists for `request.user.sub`. Onboarding routes opt out via `config.auth = 'jwt-no-db'` (the existing flag from MYT-37).
3. **Invite system** — reusable Discord-style invite links per campaign. Owner-only create/list/revoke + member-list; any onboarded user accepts; **public preview** so unsigned-in users can see the campaign name before going through OAuth. Multi-row safety story matches MYT-40's discipline (BEGIN + isolation + dual timeouts + row anchor).

## Non-goals (deferred with explicit rationale)

- `PATCH /api/users/me` and `DELETE /api/users/me` — future ticket.
- `removeMember`, `transferOwnership`, `leaveCampaign` — campaign-membership ticket. (Note: `listMembers` IS in scope — see §"Endpoints"; review found that deferring it broke owner UX.)
- Real Haiku call for profanity — `myth-urh6`, depends on MYT-44. **The stub still enforces a static deny list of impersonation roots** (see §"Profanity stub").
- `loadCurrentUser` (DB lookup + suspended_at + internal-uuid attachment + per-request caching) — MYT-39 swaps out our `requireOnboarded` hook for that richer one. Same shape, more behavior.
- WebSocket ticket exchange — MYT-39.
- Per-invite `max_uses` parameter on the create endpoint. Schema supports it; we don't expose it on the API today. The transaction in `acceptInvite` is designed so adding `max_uses` later is body-only (the `FOR NO KEY UPDATE` lock already in place is what makes the cap-check safe to add).

## Acknowledged trade-offs (flagged, accepted)

- **Per-request `getByCognitoSub` (no caching today).** `requireOnboarded` runs one indexed `SELECT` per protected request. MYT-39's `loadCurrentUser` will own the per-request caching + DB-statement timeout. Until then, accept the load — at 200-500 concurrent sessions × few req/s, this is sub-1k QPS against a primary-key-equivalent index, well within Postgres comfort.
- **`POST /api/invites/:code/accept` returns `200 {campaignId}` even on already-member.** Anyone holding a valid invite code (intentionally shareable) can map code → campaignId via this endpoint. That's a property of the invite-link UX, not a bug. Documented here so future changes don't accidentally treat it as one.
- **Username existence is publicly enumerable** via `GET /api/users/check-username`. That's the cost of giving the SPA a "this name is taken before you submit" affordance. We mitigate with per-IP rate limiting on the endpoint (10 req/min) and accept the leak. Future tickets can layer a CAPTCHA if abuse appears.
- **Owner-as-character ambiguity.** The "owner role" on `campaign_members` is not the same as "the player's character." Owners may also play characters in their own campaigns (UX spec §5 has owners go through character creation). The data model supports this (`characters` belongs to `users`, not to `campaign_members.role`). Not in MYT-38's scope to ship character creation; flagged so MYT-39 / character-creation tickets handle it.

## Load-bearing invariants

1. **The DM is the AI; campaigns have an OWNER (human creator) and PLAYERS.** No third role on `campaign_members`. Future "co-DM" promotions are a separate ticket with its own UX.
2. **`request.user.cognitoUsername` is the federated id (`Google_xyz` / `Discord_<snowflake>`), NOT the user-chosen `users.username`.** Never compare. The user-chosen value lives in `users.username` and is reachable only via `getByCognitoSub`. (See `backend/src/auth/types.ts:16-24` for the contract.)
3. **`config.auth = 'jwt-no-db'` is allowlisted, NOT honor-system.** A CI-run unit test enumerates files using the flag and fails the build if anything outside the allowlist (`backend/src/routes/users.ts` for register + check-username; `backend/src/routes/invites.ts` for the public preview endpoint) sets it. New uses require an explicit allowlist update + security review.
4. **`repo.users.getByCognitoSub(req.user.sub)` is the canonical "is this user fully onboarded?" probe.** MYT-39 will replace it with a richer `loadCurrentUser` that also enforces `suspended_at`, attaches the internal UUID, and caches per-request. Until then, this is the contract.
5. **Multi-row write paths follow MYT-40's discipline:** `pool.connect()` checkout, `BEGIN; SET LOCAL transaction_isolation='read committed'; SET LOCAL lock_timeout='Xms'; SET LOCAL statement_timeout='Yms';`, anchor lock on a row that always exists, `ROLLBACK` on every non-success path in `try/catch/finally`. Applies to `acceptInvite` (locks the invite row).

## Architecture

Three independent concerns with thin interfaces:

- **Onboarding routes** call `repo.users` (existing) + `classifyProfanity` (stub today, deny-list-protected, MYT-44-eventual).
- **`requireOnboarded` hook** runs `getByCognitoSub` once per protected request.
- **Invite routes** call a new `repo.invites` namespace + new methods on `repo.campaigns` for membership reads/writes.

No DB schema changes. The `users`, `campaign_invites`, and `campaign_members` tables already exist from migration 001 with the columns we need.

## File map

| File | Status | Responsibility |
|---|---|---|
| `backend/src/config/env.ts` | Modify | Add `frontendBaseUrl?: string` field. Boot-time validator: if set, must parse as URL with host in allowlist (`mythrun.com`, `staging.mythrun.com`, `localhost`, `127.0.0.1`); otherwise loadEnv throws. Prevents open-redirect-via-misconfig. |
| `backend/src/auth/require-onboarded.ts` | Create | `fastify-plugin` wrapped pre-handler hook. Skips `public`/`jwt-no-db` routes and 404 fall-throughs; returns 403 `{code: 'username_required'}` if no users row. |
| `backend/src/auth/onboarding-errors.ts` | Create | `UsernameInvalidError`, `UsernameTakenError`, `UsernameAlreadyOnboardedError`, `NotCampaignOwnerError`, `CampaignNotFoundError`. Custom Error subclasses with `readonly code` discriminator. |
| `backend/src/auth/__tests__/jwt-no-db-allowlist.test.ts` | Create | Greps `backend/src/routes/` for `'jwt-no-db'`; asserts the set equals an explicit allowlist (`users.ts`, `invites.ts`). Fails CI on any addition. Mirrors MYT-37's `request.user!` lint. |
| `backend/src/llm/profanity.ts` | Create | Stub `classifyProfanity(text): Promise<{profane: boolean; reason?: string}>`. Static deny list of impersonation roots (`admin`, `support`, `system`, `mythrun`, `moderator`, `staff`, `anthropic`, `stripe`) returns `{profane: true, reason: 'reserved'}`. Everything else returns `{profane: false}`. MYT-44 swaps the body, keeping the deny list as a fast-path before the Haiku call. Bead `myth-urh6` tracks. |
| `backend/src/repo/types.ts` | Modify | Add `CampaignMember`, `CampaignMemberRole`, `CampaignInvite`, `CreateInviteInput`. |
| `backend/src/repo/mappers.ts` | Modify | Add `CampaignMemberDbRow` + `toCampaignMember`, `CampaignInviteDbRow` + `toCampaignInvite`. |
| `backend/src/repo/invites.ts` | Create | `repo.invites`: `create`, `getByCode`, `getCodePreview`, `listForCampaign`, `revoke`, `acceptInvite`. The accept method owns its own transaction with FOR NO KEY UPDATE on the invite row + dual timeouts. |
| `backend/src/repo/invites-errors.ts` | Create | `InviteNotFoundError`, `InviteRevokedError`, `InviteWrongCampaignError`, `InviteTimeoutError`. |
| `backend/src/repo/campaigns.ts` | Modify | Add `addMember`, `getMembership`, `getOwner`, `listMembers`. `addMember` uses the SELECT-after-DO-NOTHING pattern to actually return the existing row on conflict (the naive `ON CONFLICT DO NOTHING RETURNING *` returns 0 rows on conflict — design bug caught in review). |
| `backend/src/repo/index.ts` | Modify | Add `invites: createInvitesRepo(pool)` to the factory return. |
| `backend/src/repo/__tests__/_helpers/reset-data.ts` | Verify | Already lists `campaign_invites` and `campaign_members`; no change. |
| `backend/src/routes/users.ts` | Create | The three onboarding endpoints (register, check-username, /me). |
| `backend/src/routes/invites.ts` | Create | The five invite endpoints (create, list, revoke, accept, preview) + `GET /api/campaigns/:id/members`. |
| `backend/src/app.ts` | Modify | Register `requireOnboarded` after `auth` plugin; register the two route modules. |
| `backend/src/repo/__tests__/invites.test.ts` | Create | Real-pg integration tests for `repo.invites`. |
| `backend/src/__tests__/onboarding.test.ts` | Create | `app.inject` route-level tests for the three onboarding endpoints. |
| `backend/src/__tests__/invite-flow.test.ts` | Create | `app.inject` end-to-end invite flow tests, including accept-vs-revoke race + same-user double-accept + different-user race. |
| `backend/src/auth/__tests__/require-onboarded.test.ts` | Create | Hook unit tests with mocked repo. |

## Endpoints

### `POST /api/users/register`

- `config.auth = 'jwt-no-db'` (no users row required).
- Body: `{username: string}` validated by Zod.
- Pipeline: format-check → profanity-check (stub today; deny-list-protected) → uniqueness-check → INSERT.
- Username derived fields come from the JWT: `cognitoSub` from `sub`, `email` from `email` claim, `displayName` from `name` claim, `avatarUrl` from `picture` claim, `authProvider` derived from `cognito:username` prefix (`Google_*` → `'google'`, `Discord_*` → `'discord'`, anything else → 500).

**Race semantics (NOT idempotent):** the format/profanity/uniqueness checks before INSERT are advisory only. The DB-level `UNIQUE(cognito_sub)` and `UNIQUE(username)` constraints are the line of defense. The implementation MUST catch SQLSTATE `23505` and inspect `constraint_name`:

- `users_cognito_sub_key` → user already onboarded (someone else won this user's race) → `409 {code: 'already_onboarded'}` with the existing user object so the SPA can route to /me.
- `users_username_key` → username taken → `409 {code: 'username_taken', suggestion: '<original><random-2-3-digits>'}`.
- Any other 23505 (or any other error) → propagate as 500.

The suggestion uses 2-3 random digits, not deterministic `<original>123` — two friends racing on `gandalf` should not both be suggested `gandalf123`.

**Responses:**
- `201 {user}` — new row created. `Location: /api/users/me` header included.
- `400 {code: 'username_invalid', reason: 'format' | 'profane' | 'reserved'}` — format / profanity / impersonation-root rejection.
- `409 {code: 'username_taken', suggestion: 'gandalf42'}` — username conflict.
- `409 {code: 'already_onboarded', user: {...}}` — your `cognito_sub` already has a row (you're trying to register twice).

### `GET /api/users/check-username?username=<value>`

- `config.auth = 'jwt-no-db'`.
- Username via QUERY PARAM (not path) — avoids URL-encoding edge cases for any future Unicode usernames, lets blank string return a clean 400 instead of route-mismatching.
- Per-IP rate limit: 10 req/min. Returns 429 `{code: 'rate_limited', retryAfterSec: N}` past the limit.
- Returns `200 {available: boolean, reason?: 'invalid' | 'taken' | 'reserved'}`. Always 200 on the success path — this is a lookup, not an action.
- The `reason: 'reserved'` value covers the static deny list (impersonation roots).
- Calls the same format/profanity/uniqueness pipeline as register, dry-run.

### `GET /api/users/me`

- Default auth (hook fires).
- Reaches the handler only if `requireOnboarded` passed → user row exists.
- Re-runs `getByCognitoSub` to fetch the row (the hook didn't attach it; MYT-39 will add caching).
- Returns `200 {user}`.

### `POST /api/campaigns/:id/invites`

- Default auth.
- Owner-only: `repo.campaigns.getMembership(:id, currentUserId)` → role must be `'owner'` else 403 `{code: 'not_campaign_owner'}`. If the campaign doesn't exist at all → 404 `{code: 'campaign_not_found'}`.
- Cap: max 25 active invites per campaign. Past the cap → `409 {code: 'invite_cap_reached', activeInvites: 25}`. Owners revoke or wait.
- `repo.invites.create({campaignId, createdBy: currentUserId})` generates a 12-char base62 code (3 retries on SQLSTATE `23505`; rethrows other errors), inserts a row.
- Returns `201 {inviteCode, inviteUrl, uses, expiresAt, createdAt}` with `Location: /api/invites/<code>/preview` header. `inviteUrl` = `${env.frontendBaseUrl}/join/${inviteCode}` if set; **always returned in non-dev environments** (loadEnv requires it in `staging`/`production`); in `development` may be omitted (the frontend composes from `inviteCode` if so).

### `GET /api/campaigns/:id/invites`

- Default auth, owner-only.
- `repo.invites.listForCampaign(:id)` returns active invites only (`expires_at IS NULL OR expires_at > now()`).
- Returns `200 {invites: [{inviteCode, inviteUrl, uses, expiresAt, createdAt}, ...]}` — wrapped in an object, NOT a bare array, so the response has room to grow (pagination, count, etc.) without a breaking change.

### `DELETE /api/campaigns/:id/invites/:inviteId`

- Default auth, owner-only.
- `repo.invites.revoke(inviteId, campaignId)` sets `expires_at = now()` IF the invite belongs to the campaign.
- Distinct error codes:
  - `404 {code: 'invite_not_found'}` — no row with that `inviteId` exists at all.
  - `403 {code: 'invite_wrong_campaign'}` — invite exists but doesn't belong to this campaign (URL tampering or stale link).
- Returns `204` on success.

### `GET /api/invites/:inviteCode/preview`

- **`config.auth = 'public'`** — accessible to unsigned-in users so the SPA can show "Join Alice's campaign" before sending the user through OAuth.
- Per-IP rate limit: 30 req/min. (More generous than check-username; previews fire on every page-load of the join URL.)
- `repo.invites.getCodePreview(:inviteCode)` does a tight query joining `campaign_invites` → `campaigns` → `users` (the campaign owner) and returns ONLY:
  - `200 {campaignName: string, ownerDisplayName: string, valid: boolean}` — minimal payload, no campaignId, no inviteId, no createdBy uuid. Limits the public attack surface.
  - `404 {code: 'invite_not_found'}` — no such code.
- The unsigned-in flow:
  1. User clicks `mythrun.com/join/AbCdEf` from a Discord share.
  2. Frontend calls `GET /api/invites/AbCdEf/preview` → renders campaign name + owner.
  3. Frontend stashes `AbCdEf` in `sessionStorage`, redirects through Cognito Hosted UI.
  4. After OAuth callback + onboarding (if needed), frontend reads `AbCdEf` from sessionStorage and POSTs `/api/invites/AbCdEf/accept`.

  Backend's contract: the four endpoints above. Frontend owns the sessionStorage stash; backend doesn't see it.

### `POST /api/invites/:inviteCode/accept`

- Default auth (any onboarded user).
- `repo.invites.acceptInvite({code, userId: currentUserId})` runs in a transaction with the MYT-40 discipline (see §"acceptInvite transaction" below).
- Outcomes:
  - `200 {campaignId, alreadyMember: false}` — happy path; new membership created.
  - `200 {campaignId, alreadyMember: true}` — user is already in the campaign; idempotent no-op. Frontend renders "already a member, opening campaign" instead of "welcome".
  - `404 {code: 'invite_not_found'}` — no invite with that code.
  - `410 {code: 'invite_revoked'}` — invite exists but `expires_at <= now()`.
  - `503 {code: 'invite_timeout', retryAfterSec: 1}` — `lock_timeout` or `statement_timeout` fired (lock contention or stuck query). Maps from `InviteTimeoutError` carrying SQLSTATE `55P03` or `57014`.

### `GET /api/campaigns/:id/members`

- Default auth, ANY MEMBER (not just owner). Per UX spec §4 / §8: party members + "Waiting for N players" status is the primary feedback loop during the invite flow.
- `repo.campaigns.listMembers(:id)`: returns each member's `userId`, `role`, `displayName`, `username`, `avatarUrl`, `joinedAt`.
- 200 → `{members: [{...}]}`.
- 403 `{code: 'not_campaign_member'}` if the caller isn't in the campaign.
- 404 `{code: 'campaign_not_found'}` if the campaign doesn't exist.

### Versioning posture

This API surface is implicitly v1. **Evolution policy: additive-only.** New optional fields can be added; existing fields cannot be renamed or have their type narrowed without a coordinated frontend change. Breaking changes ship at `/v2/...` paths if they ever happen. No `/v1/` prefix today; if we add one, every existing path moves under it in one PR.

## Pre-handler hook (`requireOnboarded`)

```typescript
// backend/src/auth/require-onboarded.ts
import fp from 'fastify-plugin'
import type { FastifyPluginAsync } from 'fastify'
import type { Pool } from 'pg'
import { createUsersRepo } from '../repo/users.js'

interface Opts { readonly pool: Pool }

const impl: FastifyPluginAsync<Opts> = async (app, opts) => {
  const users = createUsersRepo(opts.pool)

  app.addHook('preHandler', async (request, reply) => {
    const cfg = request.routeOptions?.config?.auth
    if (cfg === 'public' || cfg === 'jwt-no-db') return

    // 404 fall-through: routeOptions exists but routeOptions.url is undefined.
    if (request.routeOptions?.url === undefined) return

    if (!request.user) {
      return reply.code(401).send({ code: 'unauthenticated' })
    }

    const row = await users.getByCognitoSub(request.user.sub)
    if (!row) {
      return reply.code(403).send({ code: 'username_required' })
    }
    // Don't attach the row — MYT-39's loadCurrentUser will own caching + attachment.
  })
}

export const requireOnboarded = fp(impl, {
  fastify: '5.x',
  name: 'mythrun-require-onboarded',
  dependencies: ['mythrun-auth-jwt'],
})
```

**Why `fastify-plugin`**: same encapsulation rationale as MYT-37's auth plugins.

**Why dependency declaration**: Fastify enforces registration order. If someone reorders plugins in `app.ts`, boot fails loudly rather than silently skipping the hook.

**Why no row attachment**: MYT-39's `loadCurrentUser` will do this lookup PLUS suspended-at PLUS internal-uuid attachment PLUS per-request caching in one query. Doing partial attachment now would fork the design.

**`jwt-no-db` allowlist enforcement** (separate test file, runs in CI):

```typescript
// backend/src/auth/__tests__/jwt-no-db-allowlist.test.ts
import { describe, it, expect } from 'vitest'
import { execSync } from 'node:child_process'

const ALLOWLIST = new Set([
  'src/routes/users.ts',     // POST /api/users/register, GET /api/users/check-username
  'src/routes/invites.ts',   // GET /api/invites/:code/preview (config.auth = 'public', not 'jwt-no-db' — but listed for awareness)
])

describe("'jwt-no-db' opt-out allowlist", () => {
  it('only allowlisted files set config.auth = "jwt-no-db"', () => {
    const out = execSync(
      `git grep -l "'jwt-no-db'" -- 'backend/src/**/*.ts' || true`,
      { encoding: 'utf8' },
    )
    const files = out
      .split('\n')
      .filter(Boolean)
      .map((f) => f.replace(/^backend\//, ''))
      .filter((f) => !f.includes('__tests__/') && !f.includes('jwt-plugin') && !f.includes('types.ts') && !f.includes('require-onboarded'))
    const offenders = files.filter((f) => !ALLOWLIST.has(f))
    expect(offenders).toEqual([])
  })
})
```

Same shape as MYT-37's `request.user!` grep test. New uses require an explicit allowlist update + security review at PR time.

**Bypass mode behavior**: bypass auth attaches `request.user.sub === 'bypass:dev-1'`. The hook will look that up via `getByCognitoSub` and return 403 unless the dev has registered. That's correct — bypass dev still needs to onboard once. A `pnpm dev:seed-user` script can be added later.

## Repo additions

### `repo.invites` (new file `backend/src/repo/invites.ts`)

```typescript
export interface CampaignInvite { /* ... */ }
export interface CampaignInvitePreview {
  readonly campaignName: string
  readonly ownerDisplayName: string
  readonly valid: boolean
}
export interface CreateInviteInput { /* ... */ }

createInvitesRepo(pool: Pool, opts?: { readonly lockTimeoutMs?: number; readonly statementTimeoutMs?: number }): {
  create(input: CreateInviteInput): Promise<CampaignInvite>
  getByCode(code: string): Promise<CampaignInvite | null>
  getCodePreview(code: string): Promise<CampaignInvitePreview | null>
  listForCampaign(campaignId: string): Promise<CampaignInvite[]>  // active only
  revoke(inviteId: string, campaignId: string):
    Promise<CampaignInvite | { wrongCampaign: true } | null>
  acceptInvite(input: { code: string; userId: string }):
    Promise<
      | { campaignId: string; alreadyMember: boolean }
      | { notFound: true }
      | { revoked: true }
    >
}
```

`acceptInvite` may also throw `InviteTimeoutError` (for `lock_timeout`/`statement_timeout` SQLSTATEs), which the route layer maps to 503.

### `acceptInvite` transaction (load-bearing)

```sql
-- All run on a checked-out PoolClient. Pool.query() does NOT start a real
-- transaction (each pool.query checks out a client and releases it) — must
-- use pool.connect() + client.query + client.release, like MYT-40's credits.

BEGIN;
SET LOCAL transaction_isolation = 'read committed';
SET LOCAL lock_timeout = '500ms';        -- ACCEPT_LOCK_TIMEOUT_MS
SET LOCAL statement_timeout = '2000ms';   -- ACCEPT_STATEMENT_TIMEOUT_MS

-- Lock the invite row. FOR NO KEY UPDATE (not FOR UPDATE) so concurrent
-- FK-validating selects against this row are not blocked. Closes the
-- accept-vs-revoke race AND the future max_uses cap race in one fix.
SELECT * FROM campaign_invites WHERE invite_code = $1 FOR NO KEY UPDATE;
-- if 0 rows → ROLLBACK; return {notFound: true}

-- Expiry check, with the lock now held.
-- if expires_at IS NOT NULL AND expires_at <= now() → ROLLBACK; return {revoked: true}

-- Insert membership; ON CONFLICT means "already a member"
INSERT INTO campaign_members (id, campaign_id, user_id, role, invite_accepted)
VALUES ($id, $campaignId, $userId, 'player', true)
ON CONFLICT (campaign_id, user_id) DO NOTHING
RETURNING *;
-- rowCount === 0 → already a member → COMMIT; return {campaignId, alreadyMember: true}
-- (Note: do NOT increment uses on the already-member path.)

-- New member: increment uses
UPDATE campaign_invites SET uses = uses + 1 WHERE id = $inviteId;

COMMIT;
-- return {campaignId, alreadyMember: false}
```

Catch SQLSTATE `55P03` (lock_timeout) and `57014` (statement_timeout) → rethrow as `InviteTimeoutError(sqlstate)`. ROLLBACK on every non-success path with the `inTransaction` flag pattern from MYT-40's credits.ts. `client.release()` in `finally`.

### `repo.campaigns` extensions

```typescript
addMember(input: {
  campaignId: string
  userId: string
  role: CampaignMemberRole
  inviteAccepted?: boolean
}): Promise<CampaignMember>  // SELECT-after-DO-NOTHING pattern; returns existing on collision

getMembership(campaignId: string, userId: string): Promise<CampaignMember | null>

getOwner(campaignId: string): Promise<CampaignMember | null>

listMembers(campaignId: string): Promise<Array<{
  userId: string
  role: CampaignMemberRole
  displayName: string
  username: string
  avatarUrl: string | null
  joinedAt: Date
}>>  // join campaign_members → users
```

### `addMember` ON CONFLICT pattern (load-bearing, design bug caught in review)

```sql
-- WRONG (the old design):
-- INSERT ... ON CONFLICT (campaign_id, user_id) DO NOTHING RETURNING *
-- This returns 0 rows on conflict, NOT the existing row.

-- RIGHT:
INSERT INTO campaign_members (...) VALUES (...)
  ON CONFLICT (campaign_id, user_id) DO NOTHING
  RETURNING *;
-- if rowCount === 1 → return new row
-- if rowCount === 0 → already exists; SELECT it:
SELECT * FROM campaign_members WHERE campaign_id = $1 AND user_id = $2;
```

The `acceptInvite` transaction can branch on `rowCount` directly without calling addMember-as-a-method; this pattern is for any other code path that wants the idempotent "ensure membership" semantic.

### Code generator

```typescript
function generateInviteCode(): string {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789'
  const bytes = randomBytes(12)
  let code = ''
  for (let i = 0; i < 12; i++) {
    code += alphabet[bytes[i]! % 62]
  }
  return code
}
```

`62^12 ≈ 3.2×10²¹` entries before birthday-bound collision becomes plausible. `repo.invites.create` retries up to 3 times on SQLSTATE `23505` (unique_violation); rethrows on any other error code. If still failing after 3 retries, throws `InviteCreationError` (genuine schema corruption; never expected).

## Errors

| Class | Where | HTTP | Body |
|---|---|---|---|
| `UsernameInvalidError` | register, check-username | 400 | `{code: 'username_invalid', reason: 'format' \| 'profane' \| 'reserved'}` |
| `UsernameTakenError` | register | 409 | `{code: 'username_taken', suggestion: 'gandalf42'}` |
| `UsernameAlreadyOnboardedError` | register | 409 | `{code: 'already_onboarded', user: {...}}` |
| (no class — inline 401 from hook) | hook | 401 | `{code: 'unauthenticated'}` |
| (no class — inline 403 from hook) | hook | 403 | `{code: 'username_required'}` |
| `NotCampaignOwnerError` | invite create/list/revoke | 403 | `{code: 'not_campaign_owner'}` |
| `NotCampaignMemberError` | listMembers | 403 | `{code: 'not_campaign_member'}` |
| `CampaignNotFoundError` | invite create, listMembers | 404 | `{code: 'campaign_not_found'}` |
| `InviteCapReachedError` | invite create | 409 | `{code: 'invite_cap_reached', activeInvites: 25}` |
| `InviteNotFoundError` | accept, revoke, preview | 404 | `{code: 'invite_not_found'}` |
| `InviteWrongCampaignError` | revoke | 403 | `{code: 'invite_wrong_campaign'}` |
| `InviteRevokedError` | accept | 410 | `{code: 'invite_revoked'}` |
| `InviteTimeoutError` | accept | 503 | `{code: 'invite_timeout', retryAfterSec: 1}` |
| `RateLimitedError` | check-username, preview | 429 | `{code: 'rate_limited', retryAfterSec: N}` |

All custom subclasses with `readonly code` discriminator. Lives in `backend/src/auth/onboarding-errors.ts` and `backend/src/repo/invites-errors.ts`.

**Error-body shape contract**: every error body has a `code` field (string discriminator) plus zero-or-more error-specific fields. Documented here so future endpoints don't reinvent the convention.

Logging: `info` for client errors (400/403/404/409/410/429). `warn` for `503 InviteTimeoutError` (transient, retry-able). `error` for unexpected throws. `cognito_sub` is OK in logs; raw `email` and full JWT bodies are NOT.

## Profanity stub

```typescript
// backend/src/llm/profanity.ts
//
// STUB. Real Haiku call lands in MYT-44 (LLM wrapper layer).
// Tracking bead: myth-urh6.

const RESERVED_USERNAMES = new Set([
  // Impersonation roots — block these regardless of MYT-44 status.
  'admin', 'administrator', 'support', 'help', 'system', 'staff',
  'moderator', 'mod', 'mythrun', 'mythrun_team', 'official',
  'anthropic', 'stripe', 'aws', 'cognito', 'security',
])

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

The deny list is preserved in MYT-44's swap (it's a fast-path before calling Haiku, costs nothing). The list scales easily — if we discover other impersonation roots, append. Hard-coded vs config-table is a YAGNI question; for ~20 entries hard-coding is fine.

## Tests

### Repo integration tests (real Postgres)

`repo/invites.test.ts`:
- `create` → 12-char base62 code, persisted with the right campaign/owner.
- `create` cap → 26th invite throws (cap = 25).
- `getByCode` round-trip; null on unknown.
- `getCodePreview` returns campaign name + owner display name; null on unknown; `valid: false` if expired.
- `listForCampaign` excludes expired entries.
- `revoke` sets `expires_at`; returns `{wrongCampaign: true}` on cross-campaign mismatch; null on unknown id.
- `acceptInvite` happy → adds member, increments uses, returns `{campaignId, alreadyMember: false}`.
- `acceptInvite` already-member → `{alreadyMember: true}`, uses NOT incremented.
- `acceptInvite` revoked → `{revoked: true}`, no membership write.
- `acceptInvite` not-found → `{notFound: true}`.
- **Concurrent same-user double-accept** → exactly one membership row, exactly one uses increment.
- **Concurrent different-user accept** → both succeed (different `user_id` doesn't conflict), uses incremented twice. (Note: the FOR NO KEY UPDATE serializes the two transactions on the invite row, but both still complete since neither hits the UNIQUE constraint.)
- **Concurrent accept-vs-revoke** → revoke either wins (subsequent accepts return revoked) or loses (one accept sneaks in, then revoke succeeds and blocks future accepts). Either ordering is correct; the test asserts no torn state (no membership row + revoke without uses increment, etc.).
- **`lock_timeout` mapping** → hold the invite-row lock on a separate connection, race acceptInvite with `{lockTimeoutMs: 200}`, assert `InviteTimeoutError` with SQLSTATE `55P03` and elapsed in `[150ms, 2000ms]`.

`repo/campaigns.test.ts` extensions:
- `addMember` happy, idempotent collision returns existing row.
- `getMembership` returns role; null on absence.
- `getOwner` returns owner row.
- `listMembers` joins to users table; correct field names.

### Route-level tests (`app.inject`)

`onboarding.test.ts`:
- register happy → 201, user row in DB.
- register invalid format → 400.
- register reserved name (`admin`) → 400 with `reason: 'reserved'`.
- register profane (mock `classifyProfanity` to return `{profane: true, reason: 'profane'}`) → 400.
- register conflict (cognito_sub) → 409 `already_onboarded` with user.
- register conflict (username) → 409 `username_taken` with suggestion (assert non-deterministic — run 5x, expect at least 2 distinct suggestions).
- check-username available / invalid / taken / reserved → 200 with right body.
- check-username rate limit → 429 after 11th call in same minute.
- GET /me before register → 403 `username_required`.
- GET /me after register → 200 with user.

`invite-flow.test.ts`:
- Owner creates invite → 201 with URL.
- Cap: owner creates 25 invites then 26th → 409 `invite_cap_reached`.
- Non-owner create → 403.
- Non-owner list → 403.
- Owner revokes existing invite → 204.
- Owner revokes invite belonging to other campaign → 403 `invite_wrong_campaign`.
- Owner revokes nonexistent → 404 `invite_not_found`.
- Player accepts new invite → 200 with `alreadyMember: false`.
- Player accepts same invite twice → both 200, second has `alreadyMember: true`, only one membership row.
- Member calls listMembers → 200 with self in list.
- Non-member calls listMembers → 403.
- Public preview of valid code → 200 with `campaignName`, `ownerDisplayName`, `valid: true`. NO campaignId in response.
- Public preview of revoked code → 200 with `valid: false`.
- Public preview of nonexistent code → 404.
- Public preview rate limit → 429 after 31st call.
- Bypass-mode dev hits protected route before register → 403 `username_required`.

### Hook unit tests (mocked repo)

`require-onboarded.test.ts`:
- `auth: 'public'` route → hook skips.
- `auth: 'jwt-no-db'` route → hook skips.
- 404 fall-through → hook skips.
- No `request.user` → 401.
- User row missing → 403 `username_required`.
- User row present → next.

### Allowlist enforcement test

`jwt-no-db-allowlist.test.ts`:
- The greppable list of files setting `'jwt-no-db'` matches the explicit allowlist exactly. (See full code in §"Pre-handler hook".)

### Env validator test

`config/env.test.ts` extension:
- `frontendBaseUrl` set to `https://staging.mythrun.com` → loadEnv succeeds.
- `frontendBaseUrl` set to `https://attacker.example.com` → loadEnv throws.
- `frontendBaseUrl` unset in `production` → loadEnv throws.
- `frontendBaseUrl` unset in `development` → loadEnv succeeds.

## Linear ticket reconciliation

The Linear ticket (MYT-38) and the parent spec (`docs/specs/2026-04-13-auth-users.md` §4 + §9) disagree on five axes. This design follows the spec on path naming and invite model, follows Linear on the first-login gate mechanism, and patches the parent spec on a path-pluralization typo:

1. **Endpoint paths — spec wins.** `/api/users/...`, `/api/invites/...`. Linear's `/auth/onboarding/...` was a wording shift; spec's path style is consistent with the rest of the API surface.
2. **Path pluralization in parent spec §10 — patch the parent spec.** Lines 430–432 have `/api/campaigns/:id/invite` (singular) and `/api/campaigns/:id/invite/:inviteId`. The schema and design use plural (`invites`, `:inviteId`). The parent spec gets a one-line patch to plural to match. Done as part of MYT-38 close (similar to MYT-40's parent-spec patch).
3. **First-login gate — Linear wins.** 403 `{code: 'username_required'}` from a pre-handler hook. The 404-from-/me approach (spec's position) overloads 404 with "you need to onboard"; rejected during brainstorm in favor of explicit code-as-discriminator.
4. **Invite model — spec wins.** Reusable Discord-style links, not single-use tokens.
5. **Invite role parameter — neither.** The DM is the AI; campaign owner = human creator; invitees = players. No third role to invite into.

The Linear ticket description should be updated post-implementation to reflect these decisions. The "Done when" list is structurally compatible with this design.
