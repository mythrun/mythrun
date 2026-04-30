# Auth & Users Sub-Spec

> **Type**: Sub-spec (conforms to Production Architecture Overview)
> **Date**: 2026-04-13
> **Status**: Draft
> **Parent**: `2026-04-06-production-architecture-overview.md`
> **Depends on**: Backend Core (Postgres schema, repository layer, server skeleton)
> **Scope**: Cognito OAuth integration, JWT middleware, token lifecycle, user onboarding (username selection), campaign membership, invite system, ticket-based WebSocket auth, ownership and access control enforcement.

---

## Table of Contents

1. [Overview](#1-overview)
2. [Cognito Configuration](#2-cognito-configuration)
3. [OAuth Flow](#3-oauth-flow)
4. [User Onboarding](#4-user-onboarding)
5. [JWT Middleware](#5-jwt-middleware)
6. [Token Lifecycle](#6-token-lifecycle)
7. [Ticket-Based WebSocket Auth](#7-ticket-based-websocket-auth)
8. [Ownership and Access Control](#8-ownership-and-access-control)
9. [Invite System](#9-invite-system)
10. [API Routes](#10-api-routes)
11. [Out of Scope](#11-out-of-scope)

---

## 1. Overview

This sub-spec adds identity to Mythrun. The deliverable is:

- Users can sign in via Google or Discord OAuth
- New users pick a unique username on first login
- Every API route and WebSocket connection requires authentication
- Campaign ownership, membership, and invite links work
- WebSocket connections use single-use tickets (no JWT in URLs)

After this sub-spec, every request has a `request.user` attached to it. Everything downstream (billing, sessions, combat) builds on this identity layer.

---

## 2. Cognito Configuration

### User Pool

One Cognito User Pool per environment (staging/prod), created via Terraform in the `compute` module.

| Setting | Value |
|---------|-------|
| Pool name | `mythrun-{env}-users` |
| Sign-in | Federated only (no email/password) |
| Identity providers | Google, Discord |
| Username attributes | Email (from OAuth provider) |
| Required attributes | `email` |
| Access token expiration | 1 hour |
| Refresh token expiration | 30 days |
| ID token expiration | 1 hour |

### App Client

| Setting | Value |
|---------|-------|
| Client name | `mythrun-{env}-web` |
| Auth flows | Authorization code grant (PKCE) |
| Callback URLs | `https://mythrun.com/auth/callback`, `http://localhost:5173/auth/callback` (dev) |
| Logout URLs | `https://mythrun.com`, `http://localhost:5173` (dev) |
| Scopes | `openid`, `email`, `profile` |

### Google Identity Provider

Configured in Cognito with Google OAuth client credentials:
- Client ID and secret from Google Cloud Console
- Scopes: `openid`, `email`, `profile`
- Attribute mapping: `email` -> `email`, `name` -> `name`, `picture` -> `picture`

### Discord Identity Provider

Discord is not a native Cognito identity provider. Two approaches:

**Option A: Cognito OIDC provider** — Discord supports OIDC. Configure as a custom OIDC provider in Cognito with Discord's OIDC endpoints. This keeps all auth in Cognito.

**Option B: Custom Lambda trigger** — Use a Cognito Pre-Sign-Up Lambda that handles the Discord OAuth exchange. More control, more code.

**Decision: Option A (OIDC provider).** Less code, fully managed. Discord publishes a working OIDC discovery document at `https://discord.com/.well-known/openid-configuration` and a spec-compliant userinfo endpoint:

- Issuer: `https://discord.com`
- Authorization: `https://discord.com/api/oauth2/authorize`
- Token: `https://discord.com/api/oauth2/token`
- Userinfo: `https://discord.com/api/oauth2/userinfo` (the OIDC-native endpoint, NOT the legacy `/api/users/@me`)
- JWKS: `https://discord.com/api/oauth2/keys`
- Scopes: `openid`, `identify`, `email` — `openid` gates the userinfo endpoint and returns `sub`; `identify` is required for `preferred_username` and `picture`; `email` adds `email` and `email_verified`. All three are required for the attribute mapping to populate fully.
- Attribute mapping in Cognito uses OIDC standard claim names: `email` → `email`, `preferred_username` → Cognito `name`, `picture` → `picture`, `sub` → Cognito internal `username`.

> **Spec correction (2026-04-30):** An earlier draft of this section cited Discord's legacy non-OIDC endpoint (`/api/users/@me`) and a `identify, email` scope set. That configuration predates Discord's native OIDC support and is incompatible with `provider_type = "OIDC"` in Cognito. The OIDC-native config above is what the MYT-36 implementation uses; see `docs/superpowers/specs/2026-04-30-myt-36-cognito-pool-and-idps-design.md` §5 for the validated TF resource shape.

---

## 3. OAuth Flow

The flow is client-driven using PKCE (no client secret exposed to the browser):

```
1. User clicks "Continue with Google" or "Continue with Discord"
2. Frontend redirects to Cognito Hosted UI (or direct to provider)
   URL: https://auth.mythrun.com/oauth2/authorize?
     client_id=...&
     response_type=code&
     scope=openid+email+profile&
     redirect_uri=https://mythrun.com/auth/callback&
     code_challenge=...&
     code_challenge_method=S256&
     identity_provider=Google (or Discord)
3. User authenticates with Google/Discord
4. Provider redirects to Cognito, Cognito redirects to frontend callback
   URL: https://mythrun.com/auth/callback?code=...
5. Frontend exchanges the authorization code for tokens
   POST https://auth.mythrun.com/oauth2/token
   { grant_type: authorization_code, code: ..., code_verifier: ..., redirect_uri: ... }
6. Cognito returns: { access_token, id_token, refresh_token }
7. Frontend stores tokens:
   - access_token: in memory (not localStorage — XSS risk)
   - refresh_token: in httpOnly secure cookie (set via backend endpoint)
   - id_token: in memory (used for user info display)
```

### Cognito Hosted UI vs Custom UI

**Decision: Use Cognito Hosted UI with custom domain** (`auth.mythrun.com`). The Hosted UI handles the OAuth redirects and provider selection. It can be styled with CSS to match the Mythrun brand. This avoids implementing the OAuth state machine ourselves.

The frontend's "Continue with Google" and "Continue with Discord" buttons link directly to the Hosted UI with `identity_provider` pre-selected, so the user never sees the generic Cognito login page.

---

## 4. User Onboarding

### First Login Detection

After the OAuth callback, the frontend calls `GET /api/users/me`. Two scenarios:

1. **User exists in our database** → return user object, proceed to app
2. **User does not exist** (first login) → return 404, frontend shows username selection

### Username Selection Flow

1. Frontend shows the username selection screen (from UX spec: ethereal, one step)
2. User types a username. Frontend validates format client-side: 3-20 chars, lowercase, alphanumeric + underscores, no leading/trailing underscores
3. Frontend calls `POST /api/users/register` with `{ username }` + the JWT
4. Backend:
   a. Validates format (Zod schema)
   b. Checks uniqueness (`SELECT 1 FROM users WHERE username = $1`)
   c. Creates the user row: `id` (UUIDv7), `cognito_sub` (from JWT), `email` (from JWT), `display_name` (from JWT `name` claim), `username`, `avatar_url` (from JWT `picture` claim), `auth_provider` ('google' or 'discord')
   d. Returns the created user
5. Frontend proceeds to the app

### Username Uniqueness

Enforced by a UNIQUE index on `users.username`. The `POST /api/users/register` endpoint returns `409 Conflict` if the username is taken, with a suggestion (append random digits).

### Username vs Display Name vs Character Name

Three levels of identity:

| Context | Name Shown | Source |
|---------|-----------|--------|
| App chrome (campaign lobby, member list, settings) | Display name + @username | `users.display_name`, `users.username` |
| In-session chat (player messages during play) | **Character name** | `characters.name` |
| In-session chat (between sessions, lobby chat) | Display name | `users.display_name` |

During active play, player messages are attributed to their character ("Arin says..."), not their account. The username/display name is the meta-game identity; the character name is the in-game identity.

### Username Changes

Users can change their username via `PATCH /api/users/me` with `{ username }`. Same validation and uniqueness check. Rate-limited to 1 change per 24 hours to prevent abuse.

### Schema Addition

The Backend Core schema needs a `username` column on the `users` table:

```sql
ALTER TABLE users ADD COLUMN username TEXT NOT NULL UNIQUE;
```

This will be added to the initial schema migration (001), not as a separate migration.

---

## 5. JWT Middleware

### Fastify Plugin

A Fastify plugin registered on the server instance that runs on every request:

```typescript
interface AuthUser {
  id: string          // Our internal UUID
  cognitoSub: string  // Cognito's sub claim
  email: string
  displayName: string
  username: string
}

// Attached to every authenticated request
declare module 'fastify' {
  interface FastifyRequest {
    user: AuthUser
  }
}
```

### Middleware Flow

1. Extract `Authorization: Bearer <token>` header
2. If missing, return 401
3. Decode the JWT header (no verification yet) to get the `kid` (key ID)
4. Look up the signing key from Cognito's JWKS endpoint (cached in memory, refreshed every 10 minutes, with rate-limited fallback refresh on cache miss)
5. Verify the JWT signature, expiration, issuer (`https://cognito-idp.us-east-1.amazonaws.com/{poolId}`), and audience (app client ID)
6. Extract `sub`, `email`, `name` from claims
7. Look up the user in our database by `cognito_sub`
8. If user not found, return 401 (they need to register via `/api/users/register` first)
9. Attach `request.user` with our internal user data

### Public Routes

Routes that skip auth middleware:
- `GET /health`, `GET /health/live`, `GET /health/ready`
- `POST /api/users/register` (uses JWT for identity but doesn't require an existing user row)
- `POST /webhooks/stripe` (verified by Stripe signature, not JWT)
- `GET /api/sessions/:sessionId/recap` (public shareable recap page)

For `/api/users/register`: the middleware still validates the JWT (the user authenticated with Cognito) but skips the database lookup (the user doesn't exist yet). It attaches a partial auth context: `{ cognitoSub, email, displayName, avatarUrl, authProvider }`.

### Auth Bypass Mode (Local Dev)

When `AUTH_MODE=bypass` (from Week 0 spec):
- Middleware skips all JWT validation
- Injects a fake user: `{ id: 'dev-user-1', cognitoSub: 'dev-sub-1', email: 'dev@mythrun.com', displayName: 'Dev User', username: 'dev_user' }`
- A second dev user is available via `X-Dev-User: 2` header for testing multiplayer locally

---

## 6. Token Lifecycle

### Access Token Refresh

Access tokens expire after 1 hour. The frontend handles refresh transparently:

1. Before every API call, check if the access token expires within 5 minutes
2. If so, call `POST /api/auth/refresh` with the refresh token (sent automatically via httpOnly cookie)
3. Backend exchanges the refresh token with Cognito for a new access token
4. Returns the new access token to the frontend
5. Frontend updates its in-memory token

### Refresh Token Storage

The refresh token is stored in an **httpOnly, Secure, SameSite=Strict** cookie. This means:
- JavaScript cannot read it (XSS-proof)
- It's only sent to our backend (not to any other domain)
- It's only sent over HTTPS
- The backend's `/api/auth/refresh` endpoint is the only consumer

### Refresh Token Rotation

Cognito supports refresh token rotation: each time a refresh token is used, a new one is issued and the old one is invalidated. This limits the damage window if a refresh token is somehow compromised.

**Enabled in Cognito User Pool configuration.**

### Token Revocation (Banning Users)

JWTs are stateless — once issued, they can't be revoked until expiry. For immediate ban enforcement:

1. A `suspended_at TIMESTAMPTZ` column on the `users` table
2. The JWT middleware checks `suspended_at` on every request (it's already doing a DB lookup for the user row)
3. If `suspended_at` is set, return 403 with `{ error: 'Account suspended' }`
4. Active WebSocket connections for the suspended user are terminated immediately via a Redis pub/sub message on a `user:{userId}:suspend` channel

This means a banned user's existing access token still "works" cryptographically, but our middleware rejects it. Latency: one database query (which we're already doing).

### WebSocket Token Re-validation

Long-lived WebSocket connections don't re-authenticate on every message. But a user's session could outlast their access token. The server periodically re-validates:

1. Every 30 minutes, the server sends a `ping` to each WebSocket client
2. The client responds with a `pong` that includes a fresh access token
3. The server validates the token
4. If validation fails (token expired and refresh failed), the server sends `session_end { reason: 'auth_expired' }` and closes the connection

This catches: expired tokens, revoked users, and stale connections from users who closed their browser without disconnecting.

---

## 7. Ticket-Based WebSocket Auth

As specified in the architecture overview (section 5.2):

### Flow

1. Client calls `POST /api/ws/ticket` with JWT in `Authorization: Bearer` header
2. Server validates the JWT (normal auth middleware)
3. Server generates a 32-byte cryptographic nonce: `crypto.randomBytes(32).toString('hex')`
4. Server stores in Redis: `ws:ticket:{nonce}` -> `{ userId, username, displayName }` with **10-second TTL**
5. Server returns `{ ticket: nonce }`
6. Client connects: `wss://api.mythrun.com/ws/session/:campaignId?ticket={nonce}`
7. On WebSocket upgrade, server:
   a. Extracts ticket from query params
   b. Looks up `ws:ticket:{nonce}` in Redis
   c. If found: reads user context, **deletes the key immediately** (single-use)
   d. If not found or expired: reject the upgrade (destroy socket)
8. Proceeds with normal WebSocket connection setup using the authenticated user context

### Why Not JWT in Query Params

JWTs in URLs appear in ALB access logs, CloudWatch logs, proxy logs, and browser history. A ticket is single-use (consumed on first use) and short-lived (10s TTL). Even if it appears in logs, it's already been consumed and is useless.

---

## 8. Ownership and Access Control

### Campaign Membership Check

A Fastify preHandler hook for all routes under `/api/campaigns/:campaignId/*` and `/api/prep/:campaignId/*`:

```typescript
async function requireCampaignMember(request, reply) {
  const { campaignId } = request.params
  const member = await repo.campaignMembers.get(campaignId, request.user.id)
  if (!member || !member.invite_accepted) {
    return reply.code(403).send({ error: 'Not a member of this campaign' })
  }
  request.campaignMember = member  // Attached for downstream use
}

async function requireCampaignOwner(request, reply) {
  await requireCampaignMember(request, reply)
  if (request.campaignMember.role !== 'owner') {
    return reply.code(403).send({ error: 'Owner access required' })
  }
}
```

This runs **once per request** (not per handler), solving the N+1 ownership check problem flagged in the system design interview.

### Access Control Matrix

| Action | Who Can Do It |
|--------|--------------|
| Create a campaign | Any authenticated user |
| View campaign data | Campaign members only |
| Modify campaign settings | Owner only |
| Delete campaign | Owner only |
| Start a session | Any member (owner pays) |
| Invite players | Owner only |
| Kick a player | Owner only |
| Transfer ownership | Owner only |
| Leave a campaign | Any member (except owner — must transfer first) |
| Create a world | Any authenticated user |
| View a public world | Any authenticated user |
| View a private world | Users with a campaign referencing that world |
| Fork a public world | Any authenticated user |

### World Access Control

Worlds have a different access model than campaigns:
- **Public worlds** (`is_public = true`): readable by anyone, forkable by anyone
- **Private worlds** (`is_public = false`): readable only by users who own a campaign that references the world
- **World modification**: only happens through campaign pipeline stages (Scribe, continuity check). No direct world editing API.

---

## 9. Invite System

### Creating an Invite

Owner clicks "Invite Players" → `POST /api/campaigns/:id/invite`

Backend generates:
- `invite_code`: 12-character base62 string (62^12 ≈ 3.2 × 10^21 possibilities — no brute-force risk)
- No expiry, no max uses by default
- Returns: `{ inviteCode, inviteUrl: "https://mythrun.com/join/{code}" }`

The invite URL is shareable via any channel (Discord, text, email).

### Accepting an Invite

Player clicks the invite link → frontend loads → `POST /api/invites/:code/accept`

Backend:
1. Look up the invite by code
2. If not found or deactivated: return 404
3. If the user is already a member: return 200 (idempotent)
4. Add a `campaign_members` row with `role = 'player'`, `invite_accepted = true`
5. Increment `uses` on the invite
6. Return the campaign ID so the frontend can redirect

### Revoking an Invite

Owner can deactivate an invite link: `DELETE /api/campaigns/:id/invite/:inviteId`

Sets `expires_at = now()` on the invite row. The link stops working immediately.

### Listing Invites

`GET /api/campaigns/:id/invites` → returns all active invites for the campaign (owner only).

---

## 10. API Routes

### Auth Routes

| Method | Path | Auth | Purpose |
|--------|------|------|---------|
| POST | `/api/users/register` | JWT (partial — no user row required) | Create user account + set username |
| GET | `/api/users/me` | JWT | Get current user profile |
| PATCH | `/api/users/me` | JWT | Update profile (username, display name) |
| DELETE | `/api/users/me` | JWT | Soft-delete account (GDPR) |
| POST | `/api/auth/refresh` | Refresh token cookie | Exchange refresh token for new access token |
| POST | `/api/auth/logout` | JWT | Clear refresh token cookie, revoke Cognito tokens |
| POST | `/api/ws/ticket` | JWT | Get single-use WebSocket upgrade ticket |

### Campaign Membership Routes

| Method | Path | Auth | Purpose |
|--------|------|------|---------|
| POST | `/api/campaigns/:id/invite` | Owner | Create an invite link |
| GET | `/api/campaigns/:id/invites` | Owner | List active invites |
| DELETE | `/api/campaigns/:id/invite/:inviteId` | Owner | Revoke an invite |
| POST | `/api/invites/:code/accept` | Any user | Accept an invite and join campaign |
| GET | `/api/campaigns/:id/members` | Member | List campaign members |
| DELETE | `/api/campaigns/:id/members/:userId` | Owner | Remove a member |
| POST | `/api/campaigns/:id/leave` | Member (not owner) | Leave a campaign |
| POST | `/api/campaigns/:id/transfer` | Owner | Transfer ownership to another member |

### Username Validation Route

| Method | Path | Auth | Purpose |
|--------|------|------|---------|
| GET | `/api/users/check-username/:username` | JWT (partial) | Check if a username is available (real-time validation during onboarding) |

---

## 11. Out of Scope

| Feature | Deferred To |
|---------|------------|
| Admin panel for user management | Future — managed via direct DB access initially |
| User search / discovery | Future — not needed with invite-only campaigns |
| Friend lists | Future |
| User reporting / moderation | Observability & Hardening sub-spec |
| Password reset (N/A — OAuth only) | N/A |
| Email verification (handled by Google/Discord) | N/A |
| Multi-factor authentication (handled by Google/Discord) | N/A |
| Profile customization beyond username/display name | Future |
