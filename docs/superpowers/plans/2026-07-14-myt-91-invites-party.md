# MYT-91 Invite & Party Assembly — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship the full invite → join → party-assembly loop on top of the already-shipped invite backend (MYT-75): an owner-facing `InvitePanel` (share link + copy + native share + revoke) replacing the campaign-page invite seam; the public `/join/:code` preview that routes a signed-out visitor through the EXISTING guarded `returnTo` sign-in round-trip and a signed-in visitor to an inline accept → join-summary; and a live party roster pinned to the real `character_creation_complete` status-stream signal (plus reconnect / focus / slow-foreground-poll refetch), with the home-hub card reflecting the assembling party.

**Architecture:** Client-core owns the brains — invite endpoint slices (`defineEndpoint`), the accept-arm mapping + share/return-path helpers (pure), and a live-roster hook that folds the shipped status SSE. `@mythrun/ui` owns the two new presentational components (`InvitePanel`, `JoinPreview`), each barrel-exported with a story + tests. Web routes compose; every web-global (clipboard, `navigator.share`, window focus/visibility) is a thin `src/platform/web/**` port the DOM-free layers never touch (R1). **No new backend surface and NO new redirect mechanism** — the join handoff reuses the shipped `isLocalPath`-guarded `?returnTo` + OAuth `state` round-trip verbatim.

**Tech Stack:** React + Vite + Tailwind; `@mythrun/{contract,client-core,ui}` + web; Vitest + RTL; Zod; the shipped `sse-status-client` (MYT-85) + `oauth.ts` round-trip (MYT-84); react-i18next.

## Global Constraints

- **No new backend read/write surface.** Every route MYT-91 calls is already shipped (`backend/src/routes/invites.ts` — create/list/revoke/preview/accept/members; the status SSE; `GET …/character-creation-progress`). If a task seems to need a new endpoint, STOP and flag it.
- **No new redirect mechanism (hard rule).** The signed-out join handoff routes through the EXISTING `isLocalPath`-guarded `?returnTo` + OAuth `state` round-trip (`signin.tsx` → `callback.tsx`). No new query parameter, no unvalidated target. The shipped guard is the open-redirect defense and is reused as-is.
- **ZFC:** no heuristics / semantic matching. The accept-arm mapping keys on the backend's TYPED error `code` strings (structural policy mapping — the ZFC-exempt kind), never on prose.
- **DOM-free brains (R1):** `@mythrun/client-core` and `@mythrun/ui` never touch `window`/`document`/`navigator`. Clipboard, `navigator.share`, and window focus/visibility are `src/platform/web/**` ports the web routes wire in (mirrors `redirectTo`).
- **i18n:** every user-facing string is a key with a `[ph:]` placeholder value; `common.json` (`frontend/client-core/src/i18n/locales/en/common.json`) + `descriptions.ts` are edited in LOCKSTEP (`resources.test.ts` asserts `Object.keys(descriptions)` equals the catalog keys — a key in one but not the other fails the suite). MYT-100 remains the single copy pass.
- **Named exports only; strict TS** (no `any`, no assertions unless unavoidable); functions <50 lines; modules <400 lines.
- **All backend access through `defineEndpoint` slices** in `frontend/client-core/src/api/**` — never a raw `fetch` in a route or component.
- **Design-system-first:** no ad-hoc UI. `InvitePanel`/`JoinPreview` live in `@mythrun/ui` with a Storybook story + tests; their props come from `@mythrun/client-core/contract`. Register: paper/1-bit, square, NO circles / status dots / chips — state is prose or implicit data (calm notices use the shipped `Banner`).
- **Responsive:** desktop AND ~375px, by construction (`min-w-0`, flex columns).
- **TDD:** failing test first, always. **Frequent commits** (Conventional Commits, one per task). Implementers run ONLY their own test during a task; the controller sweeps full lint + scoped coverage before the merge.
- **Declared collision surface:** `frontend/src/routes/home/home-card.tsx` (+ `card-phase-line.ts`) — 91 OWNS the live-party restructure; 95's low-credit treatment is layered by the controller at merge. Keep the card foot composable; do not restructure it wholesale.
- **No router.tsx edits.** `/join/:code` and `/campaigns/:id/join` already exist in the tree (router is 95's single-writer this wave, §7). MYT-91 fills the existing `<JoinRoute />` element only.
- Test conventions: read `backend/src/__tests__/CONVENTIONS.md` + the frontend co-located `*.test.tsx` patterns before authoring tests.

---

## File Structure

**client-core (brains):**
- `frontend/client-core/src/api/invites.ts` — NEW: the 5 endpoint slices (create/list/revoke/preview/accept) + `ensurePrimaryInvite` orchestration.
- `frontend/client-core/src/invites/accept-arm.ts` — NEW: `mapAcceptError` (typed-code → arm) + `signinReturnToJoin` / `joinPath` helpers (pure).
- `frontend/client-core/src/invites/use-live-roster.ts` — NEW: the status-SSE-fold live-roster hook.
- `frontend/client-core/src/contract/invite/types.ts` — NEW: `AcceptArmKind`, `InvitePanelProps`, `JoinPreviewProps`.
- `frontend/client-core/src/contract/character/types.ts` — MODIFY: extend `RosterStatus` with `'gathering'`.
- `frontend/client-core/src/character/party-roster-view-model.ts` — MODIFY: `missing[]` → `'gathering'` (not `'empty'`).
- `frontend/client-core/src/index.ts` — MODIFY (append-only): barrel the new api + helpers + hook.

**@mythrun/ui:**
- `frontend/ui/src/components/InvitePanel/{InvitePanel.tsx,.stories.tsx,.test.tsx}` — NEW.
- `frontend/ui/src/components/JoinPreview/{JoinPreview.tsx,.stories.tsx,.test.tsx}` — NEW.
- `frontend/ui/src/components/PartyRoster/PartyRoster.tsx` (+ `.test.tsx`, `.stories.tsx`) — MODIFY: render the new `'gathering'` status as a real member row.
- `frontend/ui/src/index.ts` — MODIFY (append-only): barrel the two new components.

**web:**
- `frontend/src/platform/web/share.ts` — NEW: `canWebShare` / `webShare` / `copyText`.
- `frontend/src/platform/web/use-foreground-refetch.ts` — NEW: focus reload + visible-only slow poll.
- `frontend/src/routes/campaign-page.tsx` — MODIFY: replace the invite `StubSeam` with the owner-gated wired `InvitePanel`.
- `frontend/src/routes/join.tsx` — MODIFY: the real public join flow.
- `frontend/src/routes/character-new/party-staging.tsx` — MODIFY: swap the 5s poll for `useLiveRoster` + `useForegroundRefetch`.
- `frontend/src/routes/home/home-card.tsx` — MODIFY (declared collision): live-party imprint.

**i18n:** `frontend/client-core/src/i18n/locales/en/common.json` + `frontend/client-core/src/i18n/descriptions.ts` (append-only, lockstep).

---

## Task 1: Verify-first — the `returnTo` round-trip carries `/join/:code` + public preview loads signed-out

**This is a PROBE, not a build. No production code, no commit.** Deliverable: `tmp/sdd/myt91-verify-notes.md` recording what the shipped flow actually does, so the wiring tasks ground on observed behavior, not assumption.

**Files:**
- Read: `frontend/client-core/src/auth/oauth.ts` (`isLocalPath`, `createAuthState`, `consumeAuthState`), `frontend/src/routes/signin.tsx`, `frontend/src/routes/callback.tsx`, `frontend/src/app/providers.tsx` (confirm `ApiClientProvider` wraps the router so a PUBLIC route has `ApiContext`).
- Create: `tmp/sdd/myt91-verify-notes.md` (gitignored `tmp/` — not committed).

- [ ] **Step 1 — trace the round-trip in code.** Confirm and write down: (a) `signin.tsx` reads `?returnTo`, validates `isLocalPath`, and rides it on the OAuth `state`; (b) `callback.tsx` re-validates `isLocalPath` and navigates to `returnTo` on `ready`, or to `/auth/onboard` with `state:{ returnTo }` preserved on `onboarding-required`; (c) `isLocalPath('/join/ABC123')` returns `true` and `isLocalPath('https://evil.com')` / `'//evil.com'` / `'/\\evil.com'` return `false`. Record the exact fallback target when the guard rejects (signin → `/home`, callback → `/`).
- [ ] **Step 2 — drive it end-to-end on the dev stack.** With `pnpm dev` up, in a browser: hit `/auth/signin?returnTo=%2Fjoin%2F<realCode>` signed-out, complete OAuth (dev bypass or a real provider), and confirm you land back on `/join/<realCode>`. Then hit `/auth/signin?returnTo=https%3A%2F%2Fevil.com` and confirm you land on `/home` (guard held). Record both outcomes. If browser sign-in is impractical this session, drive the same assertions through `frontend/src/routes/__tests__` against `createMemoryRouter` (signin + callback with a scripted `consumeAuthState`) and note that substitution.
- [ ] **Step 3 — probe the public preview seam.** Confirm `ApiClientProvider` is mounted ABOVE the router (so `/join/:code`, a public-branch route, can call `useApiContext`). With the dev stack up, `curl -s http://localhost:3030/api/invites/<realCode>/preview` (NO auth header) and confirm a `200` with `{campaignName, ownerUsername, ownerDisplayName, valid}`, plus `curl` an unknown code → `404 invite_not_found`. Record the exact body shape (esp. whether `ownerDisplayName` can be `null`) — Task 2's Zod schema mirrors it.
- [ ] **Step 4 — record findings + go/no-go.** Write `tmp/sdd/myt91-verify-notes.md`: the confirmed round-trip contract, the guard fallbacks, the preview body shape, and any surprise. If ANY assumption fails (e.g., preview needs auth, or `ApiContext` is unavailable on the public route), STOP and flag the controller before Task 2 — the whole join flow depends on these. No commit (probe only).

---

## Task 2: client-core invite endpoint slices + `ensurePrimaryInvite`

**Files:**
- Create: `frontend/client-core/src/api/invites.ts`
- Modify: `frontend/client-core/src/index.ts` (barrel — append-only)
- Test: `frontend/client-core/src/api/__tests__/invites.test.tsx`

**Interfaces:**
- Consumes: `defineEndpoint`, `ApiContext` (`./endpoint.ts`); `HttpError` (`./errors.ts`).
- Produces:
  - `createInvite(ctx, campaignId): Promise<Invite>` — `Invite = { inviteCode, inviteUrl, uses, expiresAt: string | null, createdAt: string }`.
  - `listInvites(ctx, campaignId): Promise<{ invites: InviteListItem[] }>` — `InviteListItem = Invite & { primary: boolean }`.
  - `revokeInvite(ctx, campaignId, inviteCode): Promise<void>` (204).
  - `previewInvite(ctx, inviteCode): Promise<InvitePreview>` — `InvitePreview = { campaignName, ownerUsername, ownerDisplayName: string | null, valid: boolean }`; PUBLIC (`skipAuthRetry: true`).
  - `acceptInvite(ctx, inviteCode): Promise<AcceptResult>` — `AcceptResult = { campaignId: string, alreadyMember: boolean }`.
  - `ensurePrimaryInvite(ctx, campaignId): Promise<InviteListItem | Invite>` — list → the `primary` item if present, else `createInvite`.

- [ ] **Step 1 — write the failing tests.** Cover each slice's method/path/body/parse against a stubbed `ApiContext.fetch`, plus `ensurePrimaryInvite`'s two branches. Adjust the timestamp/`ownerDisplayName` nullability to match Task 1's recorded body shape.

```tsx
// frontend/client-core/src/api/__tests__/invites.test.tsx
import { describe, it, expect, vi } from 'vitest'
import { createInvite, listInvites, revokeInvite, previewInvite, acceptInvite, ensurePrimaryInvite } from '../invites.ts'
import type { ApiContext } from '../endpoint.ts'

function ctxReturning(status: number, body: unknown): ApiContext {
  const fetchMock = vi.fn().mockResolvedValue(
    new Response(status === 204 ? null : JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } }),
  )
  vi.stubGlobal('fetch', fetchMock)
  return { baseUrl: 'http://api.test', getAuthHeaders: () => Promise.resolve({}) }
}

describe('invite slices', () => {
  it('createInvite POSTs the campaign invites path and parses the invite', async () => {
    const ctx = ctxReturning(201, { inviteCode: 'ABC', inviteUrl: 'http://app/join/ABC', uses: 0, expiresAt: null, createdAt: '2026-07-14T00:00:00.000Z' })
    const invite = await createInvite(ctx, 'camp-1')
    expect(invite.inviteCode).toBe('ABC')
    expect(fetch).toHaveBeenCalledWith('http://api.test/api/campaigns/camp-1/invites', expect.objectContaining({ method: 'POST' }))
  })

  it('previewInvite GETs the PUBLIC preview path (no retry) and parses validity', async () => {
    const ctx = ctxReturning(200, { campaignName: 'Ashfall', ownerUsername: 'mara', ownerDisplayName: 'Mara', valid: true })
    const preview = await previewInvite(ctx, 'ABC')
    expect(preview.valid).toBe(true)
    expect(fetch).toHaveBeenCalledWith('http://api.test/api/invites/ABC/preview', expect.anything())
  })

  it('acceptInvite parses {campaignId, alreadyMember} on 201', async () => {
    const ctx = ctxReturning(201, { campaignId: 'camp-1', alreadyMember: false })
    expect(await acceptInvite(ctx, 'ABC')).toEqual({ campaignId: 'camp-1', alreadyMember: false })
  })

  it('ensurePrimaryInvite returns the existing primary without creating', async () => {
    const ctx = ctxReturning(200, { invites: [{ inviteCode: 'P', inviteUrl: 'u', uses: 1, expiresAt: null, createdAt: 'x', primary: true }] })
    const invite = await ensurePrimaryInvite(ctx, 'camp-1')
    expect(invite.inviteCode).toBe('P')
    expect(fetch).toHaveBeenCalledTimes(1) // list only, no create
  })
})
```

- [ ] **Step 2 — run** `pnpm --filter @mythrun/client-core test invites` → FAIL (module missing).
- [ ] **Step 3 — implement the slices.**

```ts
// frontend/client-core/src/api/invites.ts
import { z } from 'zod'
import { defineEndpoint, type ApiContext } from './endpoint.ts'

// The invite slice of the data layer (MYT-91). Wraps the shipped MYT-75 invite
// routes as declarative endpoints — the ONLY sanctioned reach to the invite
// backend. The preview is PUBLIC (the /join/:code route calls it pre-auth), so
// its slice sets skipAuthRetry: true — it returns 200/404, never 401, and a
// signed-out call must never spin the refresh path.

const InviteSchema = z.object({
  inviteCode: z.string(),
  inviteUrl: z.string(),
  uses: z.number().int().nonnegative(),
  expiresAt: z.string().nullable(),
  createdAt: z.string(),
})
export type Invite = z.infer<typeof InviteSchema>

const InviteListItemSchema = InviteSchema.extend({ primary: z.boolean() })
export type InviteListItem = z.infer<typeof InviteListItemSchema>

const InvitePreviewSchema = z.object({
  campaignName: z.string(),
  ownerUsername: z.string(),
  ownerDisplayName: z.string().nullable(),
  valid: z.boolean(),
})
export type InvitePreview = z.infer<typeof InvitePreviewSchema>

const AcceptResultSchema = z.object({ campaignId: z.string(), alreadyMember: z.boolean() })
export type AcceptResult = z.infer<typeof AcceptResultSchema>

const createEndpoint = defineEndpoint<Invite, { campaignId: string }>({
  method: 'POST',
  path: (i) => `/api/campaigns/${encodeURIComponent(i.campaignId)}/invites`,
  response: InviteSchema,
})
const listEndpoint = defineEndpoint<{ invites: InviteListItem[] }, { campaignId: string }>({
  method: 'GET',
  path: (i) => `/api/campaigns/${encodeURIComponent(i.campaignId)}/invites`,
  response: z.object({ invites: z.array(InviteListItemSchema) }),
})
const revokeEndpoint = defineEndpoint<void, { campaignId: string; inviteCode: string }>({
  method: 'DELETE',
  path: (i) => `/api/campaigns/${encodeURIComponent(i.campaignId)}/invites/${encodeURIComponent(i.inviteCode)}`,
  response: z.void(),
})
const previewEndpoint = defineEndpoint<InvitePreview, { inviteCode: string }>({
  method: 'GET',
  path: (i) => `/api/invites/${encodeURIComponent(i.inviteCode)}/preview`,
  response: InvitePreviewSchema,
  skipAuthRetry: true, // PUBLIC — never trigger the 401 refresh from a signed-out call.
})
const acceptEndpoint = defineEndpoint<AcceptResult, { inviteCode: string }>({
  method: 'POST',
  path: (i) => `/api/invites/${encodeURIComponent(i.inviteCode)}/accept`,
  response: AcceptResultSchema,
})

/** Owner-only. Mints a fresh invite (201). Throws `HttpError` 409 `invite_cap_reached`. */
export function createInvite(ctx: ApiContext, campaignId: string): Promise<Invite> {
  return createEndpoint({ campaignId }, ctx)
}
/** Owner-only. Lists this campaign's active invites (the `primary` flag marks the share link). */
export function listInvites(ctx: ApiContext, campaignId: string): Promise<{ invites: InviteListItem[] }> {
  return listEndpoint({ campaignId }, ctx)
}
/** Owner-only. Revokes an invite (204). Throws `HttpError` 404 `invite_not_found`. */
export function revokeInvite(ctx: ApiContext, campaignId: string, inviteCode: string): Promise<void> {
  return revokeEndpoint({ campaignId, inviteCode }, ctx)
}
/** PUBLIC. Pre-auth lookup of a code (200 with `valid:false` for expired/revoked). Throws 404 `invite_not_found`. */
export function previewInvite(ctx: ApiContext, inviteCode: string): Promise<InvitePreview> {
  return previewEndpoint({ inviteCode }, ctx)
}
/** Any onboarded user. Joins the campaign (201/200). Throws `HttpError` 409 `campaign_full`,
 *  410 `invite_revoked`/`campaign_gone`, 404 `invite_not_found`, 503 `invite_timeout`. */
export function acceptInvite(ctx: ApiContext, inviteCode: string): Promise<AcceptResult> {
  return acceptEndpoint({ inviteCode }, ctx)
}

/** Owner-only. The one primary share link for a campaign: the existing primary
 *  invite if one exists, else a freshly minted one (idempotent per campaign — the
 *  panel shows a single link, never a dashboard). */
export async function ensurePrimaryInvite(ctx: ApiContext, campaignId: string): Promise<InviteListItem | Invite> {
  const { invites } = await listInvites(ctx, campaignId)
  return invites.find((i) => i.primary) ?? (await createInvite(ctx, campaignId))
}
```

- [ ] **Step 4 — barrel the exports** in `frontend/client-core/src/index.ts` (append-only): `createInvite`, `listInvites`, `revokeInvite`, `previewInvite`, `acceptInvite`, `ensurePrimaryInvite`, and the `Invite`/`InviteListItem`/`InvitePreview`/`AcceptResult` types.
- [ ] **Step 5 — run** the test → PASS. `pnpm --filter @mythrun/client-core typecheck` → PASS.
- [ ] **Step 6 — commit** `feat(MYT-91): client-core invite endpoint slices + ensurePrimaryInvite`.

---

## Task 3: client-core accept-arm mapping + join-path helpers

**Files:**
- Create: `frontend/client-core/src/invites/accept-arm.ts`
- Create: `frontend/client-core/src/contract/invite/types.ts`
- Modify: `frontend/client-core/src/contract/index.ts` (re-export), `frontend/client-core/src/index.ts` (barrel)
- Test: `frontend/client-core/src/invites/__tests__/accept-arm.test.ts`

**Interfaces:**
- Consumes: `HttpError` (`../api/errors.ts`).
- Produces:
  - `AcceptArmKind = 'full' | 'revoked' | 'gone' | 'not-found' | 'timeout' | 'error'` (in `contract/invite/types.ts`).
  - `mapAcceptError(err: unknown): AcceptArmKind` — maps the accept endpoint's typed `HttpError.code` to an arm; anything unrecognized / non-HttpError → `'error'`.
  - `signinReturnToJoin(code: string): string` → `/auth/signin?returnTo=%2Fjoin%2F<code>` (the code + the whole `/join/…` path url-encoded).
  - `joinPath(code: string): string` → `/join/<code>`.
  - Prop contracts `InvitePanelProps`, `JoinPreviewProps` (in `contract/invite/types.ts`).

- [ ] **Step 1 — write the failing tests.**

```ts
// frontend/client-core/src/invites/__tests__/accept-arm.test.ts
import { describe, it, expect } from 'vitest'
import { mapAcceptError, signinReturnToJoin, joinPath } from '../accept-arm.ts'
import { HttpError } from '../../api/errors.ts'

describe('mapAcceptError', () => {
  it.each([
    ['campaign_full', 'full'],
    ['invite_revoked', 'revoked'],
    ['campaign_gone', 'gone'],
    ['invite_not_found', 'not-found'],
    ['invite_timeout', 'timeout'],
  ] as const)('maps %s → %s', (code, arm) => {
    expect(mapAcceptError(new HttpError(409, 'x', code))).toBe(arm)
  })
  it('unrecognized code → error', () => {
    expect(mapAcceptError(new HttpError(500, 'x', 'weird'))).toBe('error')
  })
  it('a non-HttpError (network) → error', () => {
    expect(mapAcceptError(new Error('offline'))).toBe('error')
  })
})

describe('join path helpers', () => {
  it('signinReturnToJoin url-encodes the /join/:code target', () => {
    expect(signinReturnToJoin('AbC-123')).toBe('/auth/signin?returnTo=%2Fjoin%2FAbC-123')
  })
  it('joinPath builds the public join path', () => {
    expect(joinPath('AbC-123')).toBe('/join/AbC-123')
  })
})
```

- [ ] **Step 2 — run** → FAIL.
- [ ] **Step 3 — implement.** Confirm `HttpError`'s constructor arg order (`status, statusText, code, body`) against `frontend/client-core/src/api/errors.ts` before writing the test's `new HttpError(...)`.

```ts
// frontend/client-core/src/invites/accept-arm.ts
import { HttpError } from '../api/errors.ts'
import type { AcceptArmKind } from '../contract/invite/types.ts'

// Structural (ZFC-exempt) mapping of the accept endpoint's TYPED error codes to a
// calm-notice arm. This keys on the backend's `code` strings — a policy mapping,
// never a semantic read of prose. Any unknown code or a non-HTTP failure (a
// network drop) collapses to the generic `error` arm.
const CODE_TO_ARM: Record<string, AcceptArmKind> = {
  campaign_full: 'full',
  invite_revoked: 'revoked',
  campaign_gone: 'gone',
  invite_not_found: 'not-found',
  invite_timeout: 'timeout',
}

export function mapAcceptError(err: unknown): AcceptArmKind {
  if (err instanceof HttpError && err.code !== undefined) {
    return CODE_TO_ARM[err.code] ?? 'error'
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
```

```ts
// frontend/client-core/src/contract/invite/types.ts
// Prop contracts for the invite/join components (MYT-91). Platform-neutral (§9):
// callbacks are plain functions, never DOM events; all decided booleans (owner
// gating, share availability, signed-in) arrive resolved.

/** The calm-notice arm a failed accept resolves to (see mapAcceptError). */
export type AcceptArmKind = 'full' | 'revoked' | 'gone' | 'not-found' | 'timeout' | 'error'

/** Props for the owner's InvitePanel — the single primary share link + copy /
 *  native-share / revoke. `inviteUrl` is null while loading or after a revoke with
 *  no fresh link yet. `notice` surfaces a calm cap/error line. */
export interface InvitePanelProps {
  inviteUrl: string | null
  loading: boolean
  /** navigator.share is available on this platform (the web wiring decides). */
  canShare: boolean
  /** A transient "copied" acknowledgement (the route owns the timer). */
  copied: boolean
  notice: 'cap-reached' | 'error' | null
  onCopy: () => void
  onShare: () => void
  onRevoke: () => void
  /** Mint a fresh link when none exists (post-revoke). */
  onCreate: () => void
}

/** Props for the public JoinPreview on /join/:code. `valid` is the preview's own
 *  validity (a revoked/expired code previews `valid:false`); `arm` is the
 *  post-accept calm-notice arm (null until a failed accept). */
export interface JoinPreviewProps {
  campaignName: string
  ownerName: string
  valid: boolean
  signedIn: boolean
  accepting: boolean
  arm: AcceptArmKind | null
  /** Signed-in accept path. */
  onAccept: () => void
  /** Signed-out path — route to the guarded sign-in returnTo. */
  onSignIn: () => void
}
```

- [ ] **Step 4 — re-export + barrel.** Add `invite/types.ts` re-exports to `frontend/client-core/src/contract/index.ts`; barrel `mapAcceptError`, `signinReturnToJoin`, `joinPath`, and the `AcceptArmKind` type from `frontend/client-core/src/index.ts`.
- [ ] **Step 5 — run** the test + `pnpm --filter @mythrun/client-core typecheck` → PASS.
- [ ] **Step 6 — commit** `feat(MYT-91): accept-arm mapping + join-path helpers + invite prop contracts`.

---

## Task 4: `@mythrun/ui` InvitePanel (presentational)

**Files:**
- Create: `frontend/ui/src/components/InvitePanel/{InvitePanel.tsx,InvitePanel.stories.tsx,InvitePanel.test.tsx}`
- Modify: `frontend/ui/src/index.ts` (barrel — append-only)
- Test: co-located `InvitePanel.test.tsx`

**Interfaces:**
- Consumes: `InvitePanelProps` from `@mythrun/client-core/contract` (Task 3).
- Produces: `InvitePanel` — the campaign-page invite surface. Presentational only: renders the read-only link, a copy button (`onCopy`; shows the `copied` ack), a share button ONLY when `canShare` (`onShare`), a revoke/"replace link" button (`onRevoke`), a "generate a link" action when `inviteUrl === null && !loading` (`onCreate`), a calm `Banner` for the `notice` arm. No network, no clipboard — those are the route's ports.

- [ ] **Step 1 — failing tests** (RTL): (a) renders the `inviteUrl` read-only and fires `onCopy` on the copy button; (b) the share button appears ONLY when `canShare` and fires `onShare`; (c) `loading` shows a calm loading line, no link; (d) `inviteUrl === null && !loading` shows the "generate a link" action firing `onCreate`; (e) `notice: 'cap-reached'` renders a `Banner`; (f) the `copied` prop swaps the copy label to the copied ack. Run → FAIL.
- [ ] **Step 2 — implement** per the register (square, 1-bit, mono chrome; the link value in `--font-ui`; reuse `Button` variants + `Banner`; NO chips/dots). Interim display strings follow PartyRoster's `[ph:]` const pattern for evocative lines; the i18n keys the ROUTE passes for the panel heading/hint are `campaign.invite.*` (added in Task 6). Keep it terse — one link, three actions, no dashboard.
- [ ] **Step 3 — barrel** `InvitePanel` from `frontend/ui/src/index.ts`.
- [ ] **Step 4 — story** `InvitePanel.stories.tsx`: `Ready` (link + copy + share), `NoShare` (copy only), `Loading`, `NoLink` (generate), `CapReached` (notice), `Copied`. Desktop + 375px.
- [ ] **Step 5 — run** the test + `pnpm --filter @mythrun/ui typecheck` → PASS.
- [ ] **Step 6 — commit** `feat(MYT-91): InvitePanel component (@mythrun/ui)`.

---

## Task 5: `@mythrun/ui` JoinPreview (presentational)

**Files:**
- Create: `frontend/ui/src/components/JoinPreview/{JoinPreview.tsx,JoinPreview.stories.tsx,JoinPreview.test.tsx}`
- Modify: `frontend/ui/src/index.ts` (barrel — append-only)
- Test: co-located.

**Interfaces:**
- Consumes: `JoinPreviewProps` from `@mythrun/client-core/contract` (Task 3).
- Produces: `JoinPreview` — the public invite landing card: the campaign name + "invited by {ownerName}", then the single CTA that branches on `signedIn` (accept vs "sign in to join"), an `accepting` busy state, an invalid arm when `valid === false`, and a calm `Banner` for a post-accept `arm`. Presentational only — `onAccept`/`onSignIn` are the route's.

- [ ] **Step 1 — failing tests** (RTL): (a) `signedIn: true` shows the accept CTA firing `onAccept`; (b) `signedIn: false` shows the sign-in CTA firing `onSignIn`; (c) `valid: false` renders the invalid/expired arm and NO accept CTA; (d) `accepting: true` disables the CTA / shows a busy state; (e) each `arm` value renders its `Banner` line. Run → FAIL.
- [ ] **Step 2 — implement** per register (paper card, serif campaign name, mono "invited by", `Banner` for notices; square; responsive). Interim strings the component emits follow the `[ph:]` const pattern; the route supplies the i18n'd CTA/eyebrow/notice keys (`join.*`, Task 7) as props/children where the copy is dynamic.
- [ ] **Step 3 — barrel** `JoinPreview`.
- [ ] **Step 4 — story**: `SignedOut`, `SignedIn`, `Invalid`, `Accepting`, `FullNotice`, `RevokedNotice`. Desktop + 375px.
- [ ] **Step 5 — run** the test + `pnpm --filter @mythrun/ui typecheck` → PASS.
- [ ] **Step 6 — commit** `feat(MYT-91): JoinPreview component (@mythrun/ui)`.

---

## Task 6: Web — platform share/clipboard port + campaign-page InvitePanel wiring

**Files:**
- Create: `frontend/src/platform/web/share.ts`
- Modify: `frontend/src/routes/campaign-page.tsx` (replace the invite `StubSeam` with the owner-gated wired `InvitePanel`)
- Modify: `frontend/client-core/src/i18n/locales/en/common.json` + `frontend/client-core/src/i18n/descriptions.ts` (lockstep)
- Test: `frontend/src/routes/campaign-page.test.tsx` (extend), `frontend/src/platform/web/__tests__/share.test.ts`

**Interfaces:**
- Consumes: `ensurePrimaryInvite`, `revokeInvite`, `createInvite`, `HttpError` (client-core); `InvitePanel` (ui); the injected `characterDeps`/`fetchCampaigns` pattern already on `CampaignPage`.
- Produces: `canWebShare(): boolean`, `webShare(input: { title?: string; url: string }): Promise<void>`, `copyText(text: string): Promise<void>` (web-globals, R1 carve-out). The campaign page mounts `InvitePanel` ONLY for the owner (`campaign.creator === null`); a non-owner sees nothing where the seam was (invite create/list/revoke are owner-only).

- [ ] **Step 1 — failing tests.** (a) `share.test.ts`: `canWebShare` reflects `navigator.share` presence; `copyText` calls `navigator.clipboard.writeText`. (b) `campaign-page.test.tsx`: with an owner campaign + an injected invite seam that resolves a primary link, the panel renders the link; copy calls the injected `copyText` and flips the `copied` ack; a non-owner campaign renders NO invite panel; a `409 invite_cap_reached` on create surfaces the `cap-reached` notice. Inject the invite endpoints + ports through a new optional `inviteDeps` prop (mirror `characterDeps`) so the test never hits a real endpoint/clipboard. Run → FAIL.
- [ ] **Step 2 — implement the port.**

```ts
// frontend/src/platform/web/share.ts
// Web realizations of the share/clipboard capabilities the InvitePanel needs.
// Lives under src/platform/web/** (the sanctioned web-globals carve-out); the
// campaign page consumes these so the DOM-free layers (R1) never touch navigator.
export function canWebShare(): boolean {
  return typeof navigator !== 'undefined' && typeof navigator.share === 'function'
}
export async function webShare(input: { title?: string; url: string }): Promise<void> {
  await navigator.share(input)
}
export async function copyText(text: string): Promise<void> {
  await navigator.clipboard.writeText(text)
}
```

- [ ] **Step 3 — wire the panel** into `campaign-page.tsx`: add an `inviteDeps` seam (`ensurePrimary`/`revoke`/`create`/`copyText`/`webShare`/`canShare`, defaulting to the real client-core fns + the web port); a small `useInvitePanel(campaignId, ctx, deps)` local hook that resolves the primary link on mount (owner only), owns `inviteUrl`/`loading`/`copied`/`notice` state, and maps a `409 invite_cap_reached` → `notice: 'cap-reached'`; copy → `copyText(inviteUrl)` then set `copied` (clear after ~2s); share → `webShare({ url: inviteUrl })`; revoke → `revokeInvite` then re-`ensurePrimary` (or clear to the create affordance). Replace the `INVITE_SEAM_TESTID` `StubSeam` with `campaign.creator === null ? <InvitePanel …/> : null`. Keep the panel testid `seam-invite` so existing selectors don't dangle. Do NOT touch the `CharacterSurface` sibling.
- [ ] **Step 4 — i18n keys** (both files, lockstep, `[ph:]` values): repurpose `campaign.invite.title` as the panel label; add `campaign.invite.hint`, `campaign.invite.copy`, `campaign.invite.copied`, `campaign.invite.share`, `campaign.invite.revoke`, `campaign.invite.create`, `campaign.invite.capReached`, `campaign.invite.linkError`. Update/keep `campaign.invite.body` (or drop it — if dropped, remove it from `descriptions.ts` too, or `resources.test.ts` fails on the dangling key).
- [ ] **Step 5 — run** `campaign-page.test.tsx` + `share.test.ts` + `pnpm --filter @mythrun/client-core test resources` (lockstep) → PASS.
- [ ] **Step 6 — commit** `feat(MYT-91): wire InvitePanel into the campaign page (owner-gated) + web share port`.

---

## Task 7: Web — the public `/join/:code` route (preview → guarded sign-in → inline accept)

**Files:**
- Modify: `frontend/src/routes/join.tsx` (fill the stub)
- Modify: `frontend/client-core/src/i18n/locales/en/common.json` + `descriptions.ts` (lockstep)
- Test: `frontend/src/routes/join.test.tsx` (new)

**Interfaces:**
- Consumes: `previewInvite`, `acceptInvite`, `mapAcceptError`, `signinReturnToJoin` (client-core); `JoinPreview` (ui); `useApiContext`, `useSessionStore` (signed-in = `status === 'ready'`), `useParams<{ code: string }>()`, `useNavigate`.
- Produces: the real `JoinRoute`. On mount → `previewInvite(code)` → render `JoinPreview` (loading/error/ready). Signed-out CTA → `navigate(signinReturnToJoin(code))` (the guarded round-trip; on return the route re-mounts signed-in). Signed-in CTA → `acceptInvite(code)` → on success navigate: `alreadyMember` → `/campaigns/${campaignId}` (D8 routes them correctly), new member → `/campaigns/${campaignId}/join` (the shipped join-summary). On accept failure → `mapAcceptError(err)` sets the `arm` (calm notice, no navigation).

- [ ] **Step 1 — failing tests** (RTL over `createMemoryRouter` at `/join/ABC`, injected `fetchPreview`/`accept` seams + a scripted `useSessionStore` status): (a) renders the previewed campaign name + owner; (b) signed-OUT accept CTA navigates to `signinReturnToJoin('ABC')`; (c) signed-IN accept for a new member navigates to `/campaigns/camp-1/join`; (d) signed-IN accept for an `alreadyMember` navigates to `/campaigns/camp-1`; (e) a `409 campaign_full` accept renders the `full` calm notice and does NOT navigate; (f) a `valid:false` preview renders the invalid arm with no accept CTA; (g) a failed preview fetch shows a calm retry. Run → FAIL.
- [ ] **Step 2 — implement** `JoinRoute`: a `useParams` code, a `previewInvite` effect (loading→ready|error, mirror `join-summary.tsx`'s calm-error+retry shape), `signedIn = useSessionStore((s) => s.status === 'ready')`, an `accepting` + `arm` state, the accept handler above. Inject `fetchPreview`/`accept`/`navigateTo` seams (props defaulting to the real fns) so tests drive it without a live endpoint. Compose `<JoinPreview …/>` — the route owns the i18n'd strings (eyebrow, invited-by, CTAs, notices) passed as props/children.
- [ ] **Step 3 — i18n keys** (both files, lockstep, `[ph:]`): replace `stub.join` usage; add `join.eyebrow`, `join.invitedBy` (interp `{{owner}}`), `join.acceptCta`, `join.signInCta`, `join.invalid`, `join.accepting`, `join.loadError`, `join.retry`, and `join.notice.full` / `join.notice.revoked` / `join.notice.gone` / `join.notice.notFound` / `join.notice.timeout` / `join.notice.error`. (Leave `stub.join` in the catalog if still referenced elsewhere; if not, remove it from BOTH files.)
- [ ] **Step 4 — run** `join.test.tsx` + the lockstep resources test → PASS.
- [ ] **Step 5 — commit** `feat(MYT-91): public /join/:code preview + guarded sign-in + inline accept`.

---

## Task 8: Roster — distinguish a joined-uncreated member from the invite affordance

**Why:** the shipped `partyRosterViewModel` maps `progress.missing[]` (a member who joined but hasn't started a character) to `status: 'empty'`, and `PartyRoster` renders every `'empty'` row as the "Invite a friend" CTA. In MYT-90's owner-only world `missing` never held OTHER people; MYT-91 introduces real joined members, so a genuine teammate would render as a second "Invite a friend" row. Split the states: `'gathering'` (a real joined member, still building) vs `'empty'` (the synthetic invite slot only).

**Files:**
- Modify: `frontend/client-core/src/contract/character/types.ts` (`RosterStatus`)
- Modify: `frontend/client-core/src/character/party-roster-view-model.ts`
- Modify: `frontend/ui/src/components/PartyRoster/PartyRoster.tsx` (+ `.stories.tsx`)
- Test: `frontend/client-core/src/character/__tests__/party-roster-view-model.test.ts`, `frontend/ui/src/components/PartyRoster/PartyRoster.test.tsx`

**Interfaces:**
- Produces: `RosterStatus = 'creating' | 'ready' | 'gathering' | 'empty'`. The view-model maps `missing[]` → `'gathering'`; the synthetic invite slot (`__invite__`, appended by `party-staging`'s `withInviteSlot`) stays `'empty'`. `PartyRoster` renders `'gathering'` as a real member row (the member's `displayName` + a "just joined — making their character…" sub-line + a terse "gathering…" marker), and continues rendering `'empty'` as the dashed invite CTA.

- [ ] **Step 1 — failing tests.** (a) view-model: a `missing` member yields a row with `status: 'gathering'` (NOT `'empty'`), retaining `displayName` + `isViewer`; the invite slot semantics are untouched. (b) PartyRoster: a `'gathering'` member renders a `party-roster-member` row (not `party-roster-invite`) with the gathering marker; an `'empty'` row still renders `party-roster-invite`; `realCount` counts a gathering member. Run → FAIL.
- [ ] **Step 2 — implement** the `RosterStatus` widening; in the view-model change the `missing` map's `status: 'empty' as const` → `status: 'gathering' as const`. In `PartyRoster`, extend the status derivation + `STATUS_MARK`/`STATUS_TONE` to a `'gathering'` case (marker `'gathering…'`, tone `text-ink-tertiary`), and route only `status === 'empty'` to `InviteRow` (a `'gathering'` row goes to `MemberRow`, whose sub-line is the joined-not-started stand-in). Confirm `withInviteSlot`'s `realCount`/`hasEmpty` still behave: a party of `[owner ready, B gathering]` now has `realCount === 2` + `hasEmpty === false` → no synthetic slot (correct).
- [ ] **Step 3 — story** update: add a `PartyWithGatheringMember` story (owner ready + a just-joined member gathering).
- [ ] **Step 4 — run** both tests + `pnpm --filter @mythrun/client-core typecheck` + `pnpm --filter @mythrun/ui typecheck` → PASS.
- [ ] **Step 5 — commit** `feat(MYT-91): roster distinguishes a joined-gathering member from the invite slot`.

---

## Task 9: client-core live-roster hook + web foreground refetch + party-staging rewrite

**Files:**
- Create: `frontend/client-core/src/invites/use-live-roster.ts`
- Create: `frontend/src/platform/web/use-foreground-refetch.ts`
- Modify: `frontend/src/routes/character-new/party-staging.tsx` (swap the 5s `useProgressPolling` for `useLiveRoster` + `useForegroundRefetch`)
- Modify: `frontend/client-core/src/index.ts` (barrel)
- Test: `frontend/client-core/src/invites/__tests__/use-live-roster.test.tsx`, `frontend/src/routes/character-new/party-staging.test.tsx` (extend), `frontend/src/platform/web/__tests__/use-foreground-refetch.test.tsx`

**Interfaces:**
- Consumes: `getCharacterCreationProgress`, `createSseStatusClient`, `type SseStatusClient`, `type CharacterCreationProgress`, `type PipelineEvent` (`character_creation_complete` carries `userId`), the per-instance `connectionState` store.
- Produces:
  - `useLiveRoster(campaignId, ctx, deps?) → { state: ProgressState; reload: () => void }` where `ProgressState = { status: 'loading' } | { status: 'error' } | { status: 'ready'; progress: CharacterCreationProgress }`, `deps = { getProgress?; createClient? }`. Owns the initial fetch; opens the campaign status SSE (`/api/campaigns/:id/status/stream`); folds `character_creation_complete` → `reload()`; reloads whenever the connection transitions to `'connected'` (initial + each reconnect); closes the SSE on unmount. **No DOM.**
  - `useForegroundRefetch(reload: () => void, pollMs?): void` (web) — reloads on `window` `focus`; runs a slow interval (default 15000ms) ONLY while `document` is visible (the "slow poll while foregrounded" per §3), pausing on `visibilitychange` to hidden.

- [ ] **Step 1 — failing tests.** (a) `use-live-roster.test.tsx`: inject a hand-driven `SseStatusClient` (an `onEvent` emitter + a `connectionState` store) + a `getProgress` spy; assert the initial fetch, a refetch when a `character_creation_complete` event fires, and a refetch when the connection store flips to `'connected'`; assert `close()` on unmount. (b) `use-foreground-refetch.test.tsx`: dispatch `window` `focus` → `reload` called; advance fake timers while "visible" → `reload` called on the interval; set `document.hidden` + dispatch `visibilitychange` → the interval stops. (c) `party-staging.test.tsx`: with an injected `createClient` + `getProgress`, a `character_creation_complete` event refetches the roster and a newly-`ready` member appears without a manual reload; the owner-role + `canBegin` behavior is unchanged. Run → FAIL.
- [ ] **Step 2 — implement `useLiveRoster`.** Mirror `use-character-creation-stream.ts`'s connect/teardown + mounted-ref discipline; the fold is just "any `character_creation_complete` (any user) → reload" (the owner refetches the whole roster; the event is the trigger, not the data). Subscribe to `client.connectionState` and reload on each transition INTO `'connected'`.

```ts
// frontend/client-core/src/invites/use-live-roster.ts (shape — fill in per the tests)
export interface LiveRosterDeps {
  readonly getProgress?: (ctx: ApiContext, campaignId: string) => Promise<CharacterCreationProgress>
  readonly createClient?: (ctx: ApiContext) => SseStatusClient
}
export type ProgressState =
  | { readonly status: 'loading' }
  | { readonly status: 'error' }
  | { readonly status: 'ready'; readonly progress: CharacterCreationProgress }

export function useLiveRoster(
  campaignId: string,
  ctx: ApiContext,
  deps: LiveRosterDeps = {},
): { state: ProgressState; reload: () => void } {
  // 1. reloadKey state + a fetch effect (getProgress → ready|error), self-healing.
  // 2. an SSE effect: createClient(ctx).open(streamPath(campaignId));
  //    onEvent(ev => { if (ev.type === 'character_creation_complete') reload() });
  //    subscribe connectionState → reload() on each entry to 'connected';
  //    close() on cleanup. Guard setState behind a mounted ref.
}
```

- [ ] **Step 3 — implement `useForegroundRefetch`** (web port): a `focus` listener → `reload`; a visibility-gated `setInterval(reload, pollMs)` that starts when visible and clears on hide.
- [ ] **Step 4 — rewrite `party-staging.tsx`** to consume them: replace `useProgressPolling` with `const { state, reload } = useLiveRoster(campaignId, ctx, { getProgress, createClient })` + `useForegroundRefetch(reload)`. Update `PartyStagingDeps` (drop `pollMs`; add optional `createClient`; keep `getProgress`/`finalize`/`getCampaigns`). Keep the `useOwnerRole` + `partyRosterViewModel` + `withInviteSlot` + `canBegin` logic intact (Task 8 already fixed the gathering distinction). Remove the now-stale "MYT-91: live WS updates" comments.
- [ ] **Step 5 — barrel** `useLiveRoster` + its types from `frontend/client-core/src/index.ts`.
- [ ] **Step 6 — run** all three test files + both typechecks → PASS.
- [ ] **Step 7 — commit** `feat(MYT-91): live-roster hook (status-SSE fold) + foreground refetch; party-staging goes live`.

---

## Task 10: Home-card live party imprint (declared collision surface)

> **Scope note (flag at review):** "live party data restructure" is under-specified in the spec. This task takes the concrete, register-clean reading: the hub card's foot party seals reflect the assembling party — members WITH a character render as pigment `Avatar` seals (as today), members still building (`hasCharacter === false`) render as a muted 1-bit placeholder seal (the roster's hatch treatment), so an owner watching the hub sees the party fill — plus the hub refetches on window focus so a newly-joined member surfaces without a manual reload. NO new status dot/chip (register rule). If a richer treatment is wanted, that is a follow-up. **Keep the card foot composable — 95 layers its low-credit treatment on the same foot at merge (§7).**

**Files:**
- Modify: `frontend/src/routes/home/home-card.tsx`
- Possibly modify: `frontend/src/routes/home.tsx` (the react-query `useMyCampaigns` — ensure `refetchOnWindowFocus` for `['campaigns','mine']`)
- Modify: `frontend/client-core/src/i18n/*` only if a new string is needed (prefer none)
- Test: `frontend/src/routes/home/home-card.test.tsx` (or the home route test)

**Interfaces:**
- Consumes: `campaign.party: HubPartyMember[]` (`{ userId, displayName, hasCharacter }`).
- Produces: the foot imprint renders built members as `Avatar` seals and still-building members as a muted placeholder seal (distinct, no chip); the seal count reflects the whole joined party; the hub refetches on focus.

- [ ] **Step 1 — failing test.** A card whose `party` mixes `hasCharacter:true` and `false` renders the built members as `Avatar` seals AND a distinct still-building seal for the unbuilt member (assert by testid/role, not a chip); a solo owner (`party` length 1, built) renders one seal. Run → FAIL.
- [ ] **Step 2 — implement** the foot restructure: split `party` into built vs building; render built via the existing `AvatarGroup`/`Avatar`, building via a small muted square seal (reuse the roster's `--ink-tertiary` hatch treatment, square, 1-bit — NO new DS component unless reused; compose in the foot `Stack`). Preserve `MAX_SEALS` truncation across the combined party. Do not otherwise restructure the foot (95's low-credit line lands here at merge).
- [ ] **Step 3 — focus refetch.** Confirm `useMyCampaigns` (react-query) refetches on window focus; if `refetchOnWindowFocus` is disabled globally, enable it for the `['campaigns','mine']` query so a just-joined member's seal appears. (No SSE on the hub — focus/refetch is the liveness here.)
- [ ] **Step 4 — run** the test → PASS. `pnpm --filter @mythrun/web typecheck` → PASS.
- [ ] **Step 5 — commit** `feat(MYT-91): home-card reflects the assembling party (built vs building seals)`.

---

## Task 11: Two-identity E2E + open-redirect probe (verification)

**Files:**
- Create/extend: a Playwright spec under the repo's E2E harness (mirror the MYT-90 smoke shape); `tmp/sdd/myt91-e2e-notes.md` for captured observations.
- (No production code — this task verifies + fixes anything it surfaces.)

**Done-when (verbatim from spec §3):** Two-identity E2E on dev: owner generates link → second identity (signed out) hits `/join/:code`, signs in via the guarded returnTo, accepts, join-summary → creates a character → owner's roster updates on the finalize signal without reload; cap/revoked arms render calm notices; a crafted `returnTo` to an external host is rejected (open-redirect probe).

- [ ] **Step 1 — precondition + stack.** `pnpm dev` (backend :3030 + web) up; two browser contexts (owner + joiner) with distinct dev identities. Confirm the invite backend + status SSE are live (`curl` a preview + the members endpoint).
- [ ] **Step 2 — drive the happy path.** Owner: open the campaign page, copy the `InvitePanel` primary link (assert the link value; `psql` the `invites` row exists). Joiner (signed OUT): open `/join/:code`, assert the previewed campaign name; click sign-in, complete OAuth, assert the browser returns to `/join/:code` signed-in; accept, assert navigation to `/campaigns/:id/join` (join-summary), then create a character through finalize. Owner (still on the campaign-page party-staging, NO reload): assert the roster shows the joiner appear — `gathering` while they build, then `ready` on the `character_creation_complete` signal (the observable end state, per the Playwright-asserts-end-state rule: assert the joiner's roster row reaches `ready`, not merely "page loaded").
- [ ] **Step 3 — arms.** Drive `campaign_full` (seed the campaign to the 6-member cap via `psql`/repeat-accept, then a 7th accept → assert the `full` calm notice on `/join/:code`) and `revoked` (owner revokes the link, joiner reloads `/join/:code` → assert `valid:false` invalid arm, and an accept attempt on a stale code → the `revoked` notice).
- [ ] **Step 4 — open-redirect probe.** Navigate a signed-out context to `/auth/signin?returnTo=https%3A%2F%2Fevil.com`, complete sign-in, assert the browser lands on `/home` (the shipped `isLocalPath` guard held — NO external redirect). Repeat with `//evil.com` and `/\evil.com`. This proves MYT-91 reused the guarded flow and introduced no bypass.
- [ ] **Step 5 — record + fix.** Capture WS/SSE frames + the `invites` / `campaign_members` / `campaign_characters` rows inspected. If any step fails, root-cause and fix (this is the task, not a nice-to-have), then re-run. Commit the E2E spec `test(MYT-91): two-identity invite→join→party E2E + open-redirect probe`.

---

## Self-review

**Spec §3 coverage:**
- Client-core invite endpoint slices (create/list/revoke/accept/preview) + view-models → **Task 2** (slices + `ensurePrimaryInvite`) + **Task 3** (accept-arm + helpers + prop contracts).
- `InvitePanel` (link + copy + `navigator.share` + revoke) replacing the campaign-page seam → **Task 4** (component) + **Task 6** (owner-gated wiring + web share port).
- `JoinPreview` on `/join/:code` (public preview; signed-out → guarded `returnTo` sign-in → return → accept; signed-in → inline accept → join-summary) → **Task 5** (component) + **Task 7** (route), grounded by **Task 1** (verify-first).
- Roster liveness pinned to the REAL signals (`character_creation_complete` + reconnect/focus/slow-foreground-poll; NO invented `member_joined`) → **Task 9** (live-roster hook + foreground refetch), with **Task 8** fixing the joined-vs-invite-slot rendering that the pre-finalize window exposes.
- Home-card live party restructure → **Task 10** (declared collision; scoped + flagged).
- Calm-notice arms for `campaign_full`/`revoked` (and `gone`/`not-found`/`timeout`) → **Task 3** mapping + **Tasks 5/7** rendering + **Task 11** E2E.
- Declared deviation (approved): NO home-screen invite banner — honored (Task 7 accepts inline on the join route; no banner task exists).
- Verify-first bead FIRST (**Task 1**), two-identity E2E + open-redirect probe LAST (**Task 11**), both verbatim from the brief.

**No new backend / no new redirect:** every route is shipped (Task 2 lists them); the join handoff reuses `signinReturnToJoin` → the shipped `isLocalPath`+OAuth-state round-trip (Tasks 1, 3, 7, 11). No `router.tsx` edit (Global Constraints).

**Placeholder scan:** load-bearing code is inline (all 5 slices, `ensurePrimaryInvite`, `mapAcceptError`, the path helpers, the prop contracts, the web share port, the `useLiveRoster`/`useForegroundRefetch` shapes). UI/web tasks carry props + test intent + i18n key lists per house style. No "TBD".

**Type consistency:** `Invite`/`InviteListItem`/`InvitePreview`/`AcceptResult`, `AcceptArmKind`, `mapAcceptError`, `signinReturnToJoin`/`joinPath`, `InvitePanelProps`/`JoinPreviewProps`, `RosterStatus` (`+'gathering'`), `useLiveRoster`/`ProgressState`, `useForegroundRefetch` used consistently across tasks; the accept endpoint's typed `code` strings (`campaign_full`/`invite_revoked`/`campaign_gone`/`invite_not_found`/`invite_timeout`) match `backend/src/routes/invites.ts` verbatim.

**Ambiguities flagged (not silently resolved):** (1) "live party data restructure" for the home card — scoped conservatively in Task 10, flagged for review; (2) the roster `missing`→`'empty'` conflation is a genuine pre-existing bug the multi-member case exposes — surfaced as Task 8; (3) the spec's "the campaign page already [holds the status stream]" is NOT true of the shipped code (party-staging polls) — Task 9 adds the subscription. See the handoff note.
