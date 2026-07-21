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

// `ownerDisplayName` is NON-nullable: the shipped preview join reads
// `users.display_name` (TEXT NOT NULL, migration 001) off an INNER JOIN, and the
// backend types it `string` (repo/types.ts CampaignInvitePreview). The plan's
// draft hedged `.nullable()` pending the verify-first probe; the shipped
// contract resolves it to a plain string. (Deviation flagged in the T2 report.)
const InvitePreviewSchema = z.object({
  campaignName: z.string(),
  ownerUsername: z.string(),
  ownerDisplayName: z.string(),
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
// Res is INFERRED from `response: z.void()` (the 204-no-content revoke) rather
// than written as an explicit `<void, …>` generic — mirrors the shipped `logout`
// slice and keeps `void` out of an explicit type-argument position (the repo's
// @typescript-eslint/no-invalid-void-type rule). The input is typed via the path
// param annotation instead.
const revokeEndpoint = defineEndpoint({
  method: 'DELETE',
  path: (i: { campaignId: string; inviteCode: string }) =>
    `/api/campaigns/${encodeURIComponent(i.campaignId)}/invites/${encodeURIComponent(i.inviteCode)}`,
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
// The idempotent get-or-create of the primary share link (myth-y5c4q). PUT
// (not POST) — repeated calls return the SAME code, so the StrictMode
// double-mount / two-tab race can't mint a duplicate. Server-side atomic; the
// response carries `primary: true`.
const ensurePrimaryEndpoint = defineEndpoint<InviteListItem, { campaignId: string }>({
  method: 'PUT',
  path: (i) => `/api/campaigns/${encodeURIComponent(i.campaignId)}/invites/primary`,
  response: InviteListItemSchema,
})

/** Owner-only. Mints a fresh invite (201). Throws `HttpError` 409 `invite_cap_reached`. */
export function createInvite(ctx: ApiContext, campaignId: string): Promise<Invite> {
  return createEndpoint({ campaignId }, ctx)
}
/** Owner-only. Lists this campaign's active invites (the `primary` flag marks the share link). */
export function listInvites(
  ctx: ApiContext,
  campaignId: string,
): Promise<{ invites: InviteListItem[] }> {
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
 *  invite if one exists, else a freshly minted one. A SINGLE idempotent server
 *  call (PUT .../invites/primary) — the get-or-create is atomic server-side, so
 *  a StrictMode double-mount or two owner tabs can't double-mint (myth-y5c4q,
 *  replacing the old list-then-create read-modify-write). */
export function ensurePrimaryInvite(ctx: ApiContext, campaignId: string): Promise<InviteListItem> {
  return ensurePrimaryEndpoint({ campaignId }, ctx)
}
