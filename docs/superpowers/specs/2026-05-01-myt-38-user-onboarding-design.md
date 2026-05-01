# MYT-38: User Onboarding (Username + Invites) — Design

**Linear:** [MYT-38](https://linear.app/mythrun/issue/MYT-38)
**Spec source:** `docs/specs/2026-04-13-auth-users.md` §4 + §9
**Date:** 2026-05-01
**Related:** MYT-37 (jwt-plugin, shipped), MYT-39 (will subsume `requireOnboarded` hook), MYT-44 (LLM wrapper, replaces profanity stub), `myth-urh6` (post-MYT-44 swap bead)

---

## Goal

Three things, scoped tightly:

1. **Username onboarding** — `POST /api/users/register`, `GET /api/users/check-username/:username`, `GET /api/users/me`. Format validation + (stubbed) profanity gate + uniqueness + suggestion.
2. **First-login gate** — `requireOnboarded` Fastify pre-handler hook. Returns 403 `{code: 'username_required'}` on protected routes when no Mythrun user row exists for `request.user.sub`. Onboarding routes opt out via `config.auth = 'jwt-no-db'` (the existing flag from MYT-37).
3. **Invite system** — reusable Discord-style invite links per campaign. POST/GET/DELETE on `/api/campaigns/:id/invites`, POST on `/api/invites/:code/accept`. Owner-only for create/list/revoke; any onboarded user for accept.

## Non-goals (deferred)

- `PATCH /api/users/me` and `DELETE /api/users/me` — future ticket.
- `removeMember`, `transferOwnership`, `leaveCampaign`, `listMembers` — campaign-membership ticket.
- Real Haiku call for profanity — `myth-urh6`, depends on MYT-44.
- `loadCurrentUser` (DB lookup + suspended_at + internal-uuid attachment) — MYT-39 swaps out our `requireOnboarded` hook for that richer one. Same shape, more behavior.
- WebSocket ticket exchange — MYT-39.
- Per-invite `max_uses` parameter on the create endpoint. Schema supports it; we don't expose it on the API today.

## Load-bearing invariants

1. **The DM is the AI; campaigns have an OWNER (human creator) and PLAYERS.** No third role on `campaign_members`. Future "co-DM" promotions are a separate ticket with its own UX.
2. **`request.user.cognitoUsername` is the federated id (`Google_xyz` / `Discord_<snowflake>`), NOT the user-chosen `users.username`.** Never compare. The user-chosen value lives in `users.username` and is reachable only via `getByCognitoSub`. (See `backend/src/auth/types.ts:16-24` for the contract.)
3. **Routes on the onboarding path opt out of `requireOnboarded` via `config.auth = 'jwt-no-db'`.** Anywhere else in the codebase that sets that flag is a security review trigger.
4. **`repo.users.getByCognitoSub(req.user.sub)` is the canonical "is this user fully onboarded?" probe.** MYT-39 will replace it with a richer `loadCurrentUser` that also enforces `suspended_at` and attaches the internal UUID. Until then, this is the contract.

## Architecture

Three independent concerns with thin interfaces:

- **Onboarding routes** call `repo.users` (existing) + a stubbed `classifyProfanity` (this ticket).
- **`requireOnboarded` hook** runs `getByCognitoSub` once per protected request.
- **Invite routes** call a new `repo.invites` namespace + new methods on `repo.campaigns`.

No DB schema changes. The `users` and `campaign_invites` and `campaign_members` tables already exist from migration 001 with the columns we need.

## File map

| File | Status | Responsibility |
|---|---|---|
| `backend/src/auth/require-onboarded.ts` | Create | `fastify-plugin` wrapped pre-handler hook. Skips `public`/`jwt-no-db` routes and 404 fall-throughs; returns 403 `{code: 'username_required'}` if no users row. |
| `backend/src/auth/onboarding-errors.ts` | Create | `UsernameInvalidError`, `UsernameTakenError`, `OnboardingRequiredError`, `NotCampaignOwnerError`, `CampaignNotFoundError`. Custom Error subclasses with `readonly code` discriminator. |
| `backend/src/llm/profanity.ts` | Create | Stub `classifyProfanity(text): Promise<{profane: boolean; reason?: string}>`. Returns `{profane: false}` always. MYT-44 swaps the body. Bead `myth-urh6` tracks. |
| `backend/src/repo/types.ts` | Modify | Add `CampaignMember`, `CampaignMemberRole`, `CampaignInvite`, `CreateInviteInput`. |
| `backend/src/repo/mappers.ts` | Modify | Add `CampaignMemberDbRow` + `toCampaignMember`, `CampaignInviteDbRow` + `toCampaignInvite`. |
| `backend/src/repo/invites.ts` | Create | `repo.invites`: `create`, `getByCode`, `listForCampaign`, `revoke`, `acceptInvite`. The accept method owns its own transaction. |
| `backend/src/repo/invites-errors.ts` | Create | `InviteNotFoundError`, `InviteRevokedError`. |
| `backend/src/repo/campaigns.ts` | Modify | Add `addMember`, `getMembership`, `getOwner`. `addMember` swallows the `UNIQUE(campaign_id, user_id)` violation for idempotent re-adds. |
| `backend/src/repo/index.ts` | Modify | Add `invites: createInvitesRepo(pool)` to the factory return. |
| `backend/src/repo/__tests__/_helpers/reset-data.ts` | Verify | Already lists `campaign_invites` and `campaign_members`; no change. |
| `backend/src/routes/users.ts` | Create | The three onboarding endpoints. |
| `backend/src/routes/invites.ts` | Create | The four invite endpoints. |
| `backend/src/app.ts` | Modify | Register `requireOnboarded` after `auth` plugin; register the two route modules. |
| `backend/src/app-deps.ts` | Verify / Modify | If routes need a `pool` injection beyond what's already there, extend. |
| `backend/src/repo/__tests__/invites.test.ts` | Create | Real-pg integration tests for `repo.invites`. |
| `backend/src/__tests__/onboarding.test.ts` | Create | `app.inject` route-level tests for the three onboarding endpoints. |
| `backend/src/__tests__/invite-flow.test.ts` | Create | `app.inject` end-to-end invite flow tests. |
| `backend/src/auth/__tests__/require-onboarded.test.ts` | Create | Hook unit tests with mocked repo. |

## Endpoints

### `POST /api/users/register`

- `config.auth = 'jwt-no-db'` (no users row required).
- Body: `{username: string}` validated by Zod.
- Pipeline: format-check → profanity-check (stub today) → uniqueness-check → INSERT.
- Username derived fields come from the JWT: `cognitoSub` from `sub`, `email` from `email` claim, `displayName` from `name` claim, `avatarUrl` from `picture` claim, `authProvider` derived from `cognito:username` prefix (`Google_*` → `'google'`, `Discord_*` → `'discord'`, anything else → 500).
- Idempotent semantics: if the user already has a row (someone races register), return 409 with the EXISTING username as the "taken" value. Don't 200; the user wanted to set a username and a different process won.
- Responses:
  - `201 {user}` — new row created.
  - `400 {code: 'username_invalid', reason: 'format' | 'profane'}` — format or profanity rejection.
  - `409 {code: 'username_taken', suggestion: '<original>123'}` — conflict; UI re-prompts.

### `GET /api/users/check-username/:username`

- `config.auth = 'jwt-no-db'`.
- Returns `200 {available: boolean, reason?: 'invalid' | 'taken' | 'profane'}`. Always 200 — this is a lookup, not an action.
- Calls the same format/profanity/uniqueness pipeline as register, in dry-run mode.

### `GET /api/users/me`

- Default auth (hook fires).
- Reaches the handler only if `requireOnboarded` passed → user row exists.
- Re-runs `getByCognitoSub` to fetch the row (the hook didn't attach it; MYT-39 will).
- Returns `200 {user}`.

### `POST /api/campaigns/:id/invites`

- Default auth.
- Owner-only: `repo.campaigns.getMembership(:id, currentUserId)` → role must be `'owner'` else 403 `not_campaign_owner`.
- `repo.invites.create({campaignId, createdBy: currentUserId})` generates a 12-char base62 code (3 retries on UNIQUE violation), inserts a row.
- Returns `201 {inviteCode, inviteUrl, uses, expiresAt, createdAt}` where `inviteUrl` = `${env.FRONTEND_BASE_URL}/join/${inviteCode}` if the `FRONTEND_BASE_URL` env var is set, omitted from the response otherwise. The env var is added to `loadEnv()` as a new optional field. Staging will set it to `https://staging.mythrun.com`; production to `https://mythrun.com`. Local dev can omit; the frontend constructs the join URL from the code itself.

### `GET /api/campaigns/:id/invites`

- Default auth, owner-only.
- `repo.invites.listForCampaign(:id)` returns active invites only (`expires_at IS NULL OR expires_at > now()`).
- Returns `200 [{inviteCode, inviteUrl, uses, expiresAt, createdAt}, ...]`.

### `DELETE /api/campaigns/:id/invites/:inviteId`

- Default auth, owner-only.
- `repo.invites.revoke(inviteId, campaignId)` sets `expires_at = now()` if the invite belongs to the campaign; returns null if mismatch.
- Returns `204` on success or `404 invite_not_found` on mismatch.

### `POST /api/invites/:code/accept`

- Default auth (any onboarded user).
- `repo.invites.acceptInvite({code, userId: currentUserId})` runs in a transaction:
  - Looks up by code; missing → return `{notFound: true}`.
  - If `expires_at IS NOT NULL AND expires_at <= now()` → return `{revoked: true}`.
  - INSERT into `campaign_members` with `ON CONFLICT (campaign_id, user_id) DO NOTHING RETURNING *`.
  - If the INSERT inserted (rowCount === 1): increment `uses` on the invite, return `{campaignId, alreadyMember: false}`.
  - If conflict (already a member): return `{campaignId, alreadyMember: true}`. Do NOT increment `uses` — the counter reflects distinct accepts, not retries.
- HTTP mapping:
  - `200 {campaignId}` — both happy path AND already-member.
  - `404 invite_not_found`.
  - `410 invite_revoked`.

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
    // Don't attach the row — MYT-39's loadCurrentUser will own that.
  })
}

export const requireOnboarded = fp(impl, {
  fastify: '5.x',
  name: 'mythrun-require-onboarded',
  dependencies: ['mythrun-auth-jwt'],
})
```

**Why `fastify-plugin`**: same encapsulation rationale as MYT-37's auth plugins — without it, the hook only applies to routes registered inside the plugin's child scope.

**Why dependency declaration**: Fastify enforces registration order. If someone reorders plugins in `app.ts`, boot fails loudly rather than silently skipping the hook.

**Why no row attachment**: MYT-39's `loadCurrentUser` will do this lookup PLUS suspended-at PLUS internal-uuid attachment in one query. Doing partial attachment now would fork the design and force a refactor in MYT-39. Routes that need the row in MYT-38 (`/api/users/me`, `/api/invites/:code/accept`) call `getByCognitoSub` directly. Two extra round-trips per affected route — a transient cost worth the simpler MYT-38 → MYT-39 transition.

**Bypass mode behavior**: bypass auth attaches `request.user.sub === 'bypass:dev-1'`. The hook will look that up via `getByCognitoSub` and return 403 unless the dev has registered. That's correct behavior — bypass dev still needs to onboard once. A `pnpm dev:seed-user` script can be added later if it becomes annoying; not in scope today.

## Repo additions

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
}

export interface CreateInviteInput {
  readonly campaignId: string
  readonly createdBy: string
}

createInvitesRepo(pool: Pool): {
  create(input: CreateInviteInput): Promise<CampaignInvite>
  getByCode(code: string): Promise<CampaignInvite | null>
  listForCampaign(campaignId: string): Promise<CampaignInvite[]>  // active only
  revoke(inviteId: string, campaignId: string): Promise<CampaignInvite | null>
  acceptInvite(input: { code: string; userId: string }):
    Promise<{ campaignId: string; alreadyMember: boolean } | { notFound: true } | { revoked: true }>
}
```

### `repo.campaigns` extensions

```typescript
addMember(input: {
  campaignId: string
  userId: string
  role: CampaignMemberRole
  inviteAccepted?: boolean
}): Promise<CampaignMember>  // returns existing row on UNIQUE collision (idempotent)

getMembership(campaignId: string, userId: string): Promise<CampaignMember | null>

getOwner(campaignId: string): Promise<CampaignMember | null>
```

### `acceptInvite` transaction (load-bearing)

```sql
BEGIN;
SET LOCAL transaction_isolation = 'read committed';

-- Lookup
SELECT * FROM campaign_invites WHERE invite_code = $1;
-- if 0 rows → ROLLBACK; return {notFound: true}

-- Expiry check
-- if expires_at IS NOT NULL AND expires_at <= now() → ROLLBACK; return {revoked: true}

-- Insert membership; ON CONFLICT means "already a member"
INSERT INTO campaign_members (id, campaign_id, user_id, role, invite_accepted)
VALUES ($id, $campaignId, $userId, 'player', true)
ON CONFLICT (campaign_id, user_id) DO NOTHING
RETURNING *;
-- rowCount === 0 → already a member → COMMIT; return {campaignId, alreadyMember: true}

-- New member: increment uses
UPDATE campaign_invites SET uses = uses + 1 WHERE id = $inviteId;

COMMIT;
-- return {campaignId, alreadyMember: false}
```

The transaction is short and uncontested in practice; READ COMMITTED is sufficient. No users-row anchor needed (unlike MYT-40's atomicDebit) because there's no balance-or-similar invariant — we're just guarding "exactly one membership row per (campaign, user)" which the UNIQUE constraint owns.

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

`62^12 ≈ 3.2×10²¹` — collision is effectively impossible at our scale. `repo.invites.create` retries up to 3 times on UNIQUE violation as defense-in-depth; if still failing after 3 retries, throws (genuine schema corruption).

## Errors

| Class | Where | HTTP | Body |
|---|---|---|---|
| `UsernameInvalidError` | register, check-username | 400 | `{code: 'username_invalid', reason: 'format' \| 'profane'}` |
| `UsernameTakenError` | register | 409 | `{code: 'username_taken', suggestion: 'alice123'}` |
| `OnboardingRequiredError` | hook (sent inline as 403; no class needed for this since the hook builds the response directly) | 403 | `{code: 'username_required'}` |
| `NotCampaignOwnerError` | invite create/list/revoke | 403 | `{code: 'not_campaign_owner'}` |
| `CampaignNotFoundError` | invite create | 404 | `{code: 'campaign_not_found'}` |
| `InviteNotFoundError` | accept, revoke | 404 | `{code: 'invite_not_found'}` |
| `InviteRevokedError` | accept | 410 | `{code: 'invite_revoked'}` |

All custom subclasses with `readonly code` discriminator. Lives in `backend/src/auth/onboarding-errors.ts` and `backend/src/repo/invites-errors.ts` (split from factories so HTTP-layer code can import for type narrowing).

Logging level: `info` for client errors (400/403/404/409/410). `error` for unexpected throws.

No central error-handler plugin today; each route handler catches its specific error class and maps. Future Fastify error-handler plugin can centralize when more routes need it.

## Profanity stub

```typescript
// backend/src/llm/profanity.ts
//
// STUB. Real implementation lands in MYT-44 (LLM wrapper layer).
// Tracking bead: myth-urh6.
//
// Returns {profane: false} for every input today. The signature MUST stay
// stable so MYT-44's swap is body-only, not API-shape work.

export interface ProfanityResult {
  readonly profane: boolean
  readonly reason?: string
}

export async function classifyProfanity(_text: string): Promise<ProfanityResult> {
  return { profane: false }
}
```

The route handlers call `classifyProfanity` and treat `profane === true` as a 400. Today nothing returns true, so the gate is a no-op — but the call site exists, the test mocks exist, and MYT-44 swaps the body without touching anything else.

## Tests

### Repo integration tests (real Postgres)

`repo/invites.test.ts`:
- `create` → 12-char base62 code, persisted with the right campaign/owner.
- `getByCode` round-trip; null on unknown.
- `listForCampaign` excludes expired entries.
- `revoke` sets `expires_at`; `null` return on mismatch.
- `acceptInvite` happy → adds member, increments uses, returns `{campaignId, alreadyMember: false}`.
- `acceptInvite` already-member → `{alreadyMember: true}`, uses NOT incremented.
- `acceptInvite` revoked → `{revoked: true}`, no membership write.
- `acceptInvite` not-found → `{notFound: true}`.
- Concurrent double-accept by same user → exactly one membership row, exactly one uses increment. (Real-pg, two pool clients, `Promise.all`.)

### Route-level tests (`app.inject`)

`onboarding.test.ts`:
- register happy → 201, user row in DB.
- register invalid format → 400.
- register profane (mock `classifyProfanity` to return `{profane: true}`) → 400.
- register conflict → 409 with `suggestion`.
- check-username available / invalid / taken / profane → 200 with right body.
- GET /me before register → 403 `username_required`.
- GET /me after register → 200 with user.

`invite-flow.test.ts`:
- Owner creates invite → 201 with URL.
- Non-owner create → 403.
- Non-owner list → 403.
- Owner revokes → 204; subsequent accept → 410.
- Player accepts new invite → 200; campaign appears in `repo.campaigns.listByUser` for player.
- Player accepts same invite twice → both 200, only one `campaign_members` row, uses=1.
- Bypass-mode dev hits protected route before register → 403.

### Hook unit tests (mocked repo)

`require-onboarded.test.ts`:
- `auth: 'public'` route → hook skips.
- `auth: 'jwt-no-db'` route → hook skips.
- 404 fall-through (no route matched) → hook skips.
- No `request.user` → 401.
- User row missing → 403 `username_required`.
- User row present → next.

## Linear ticket reconciliation

The Linear ticket (MYT-38) and the parent spec (`docs/specs/2026-04-13-auth-users.md` §4 + §9) disagree on four axes. This design follows the spec on each, with reasoning:

1. **Endpoint paths** — spec's `/api/users/register`, `/api/users/check-username/:username`, `/api/campaigns/:id/invites`, `/api/invites/:code/accept`. Linear's `/auth/onboarding/...` was a wording shift; the spec's path style is consistent with the rest of the API surface.
2. **First-login gate** — 403 `{code: 'username_required'}` from a pre-handler hook (Linear's position), NOT 404-from-`/api/users/me` (spec's position). User pushed back on the 404 approach during brainstorm: 404 conflates "resource doesn't exist" with "you need to onboard," and a real 404 page is a real product surface. The hook's lookup is the same one MYT-39's `loadCurrentUser` will do, so it's not duplicated work.
3. **Invite model** — reusable Discord-style links, not single-use tokens. Spec's position. The `campaign_invites` schema (with `max_uses` nullable + `uses` counter) supports this directly.
4. **Invite role parameter** — not a thing. The DM is the AI; campaign owner = human creator; invitees = players. No third role to invite into.

The Linear ticket description should be updated post-implementation to reflect these decisions. The "Done when" list is structurally compatible with this design (the bullets describe the same surface, just with different path naming and the single-use-vs-reusable axis).
