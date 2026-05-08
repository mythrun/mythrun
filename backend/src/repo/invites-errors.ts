// backend/src/repo/invites-errors.ts
//
// Custom Error subclasses thrown by repo.invites and the invite routes.

export class InviteNotFoundError extends Error {
  readonly code = 'INVITE_NOT_FOUND'
  constructor(readonly inviteCode: string) {
    super(`Invite not found: ${inviteCode}`)
    this.name = 'InviteNotFoundError'
  }
}

export class InviteRevokedError extends Error {
  readonly code = 'INVITE_REVOKED'
  constructor(readonly inviteCode: string) {
    super(`Invite revoked: ${inviteCode}`)
    this.name = 'InviteRevokedError'
  }
}

export class InviteCapReachedError extends Error {
  readonly code = 'INVITE_CAP_REACHED'
  constructor(
    readonly campaignId: string,
    readonly activeInvites: number,
  ) {
    super(`Invite cap reached for campaign ${campaignId} (${String(activeInvites)} active)`)
    this.name = 'InviteCapReachedError'
  }
}

export class CampaignFullError extends Error {
  readonly code = 'CAMPAIGN_FULL'
  constructor(
    readonly campaignId: string,
    readonly activeMembers: number,
  ) {
    super(`Campaign ${campaignId} is full (${String(activeMembers)} members)`)
    this.name = 'CampaignFullError'
  }
}

export class CampaignGoneError extends Error {
  readonly code = 'CAMPAIGN_GONE'
  constructor(readonly campaignId: string) {
    super(`Campaign ${campaignId} no longer exists`)
    this.name = 'CampaignGoneError'
  }
}

export class InviteCreationError extends Error {
  readonly code = 'INVITE_CREATION_ERROR'
  constructor(readonly retries: number) {
    super(`Invite creation exceeded ${String(retries)} retry attempts on UNIQUE collision`)
    this.name = 'InviteCreationError'
  }
}

export class InviteTimeoutError extends Error {
  readonly code = 'INVITE_TIMEOUT'
  constructor(
    readonly inviteCode: string,
    readonly cause: 'lock' | 'statement',
    readonly sqlstate: '55P03' | '57014',
  ) {
    super(`Invite operation timed out for ${inviteCode} (${cause}, sqlstate=${sqlstate})`)
    this.name = 'InviteTimeoutError'
  }
}

// ─── Constants ──────────────────────────────────────────────────────────────

export const ACCEPT_LOCK_TIMEOUT_MS = 500
export const ACCEPT_STATEMENT_TIMEOUT_MS = 2000
export const INVITE_CAP_PER_CAMPAIGN = 25
export const PARTY_SIZE_CAP = 6
export const INVITE_CODE_RETRIES = 3
