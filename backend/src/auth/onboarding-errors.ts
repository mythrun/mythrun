// backend/src/auth/onboarding-errors.ts
//
// Custom Error subclasses thrown by the onboarding routes and the
// requireOnboarded hook. Split from route handlers so HTTP-layer code
// can import these for type narrowing without pulling in the route
// factory.

export class UsernameInvalidError extends Error {
  readonly code = 'USERNAME_INVALID'
  constructor(readonly reason: 'format' | 'profane' | 'reserved') {
    super(`Username invalid: ${reason}`)
    this.name = 'UsernameInvalidError'
  }
}

export class DisplayNameInvalidError extends Error {
  readonly code = 'DISPLAY_NAME_INVALID'
  constructor(readonly reason: 'length' | 'profane') {
    super(`Display name invalid: ${reason}`)
    this.name = 'DisplayNameInvalidError'
  }
}

export class UsernameTakenError extends Error {
  readonly code = 'USERNAME_TAKEN'
  constructor(readonly suggestion: string) {
    super(`Username taken; suggestion: ${suggestion}`)
    this.name = 'UsernameTakenError'
  }
}

export class AlreadyOnboardedError extends Error {
  readonly code = 'ALREADY_ONBOARDED'
  constructor(
    readonly currentUsername: string,
    readonly requestedUsername: string,
  ) {
    super(`Caller already onboarded as ${currentUsername}; requested ${requestedUsername}`)
    this.name = 'AlreadyOnboardedError'
  }
}

export class NotCampaignOwnerError extends Error {
  readonly code = 'NOT_CAMPAIGN_OWNER'
  constructor(readonly campaignId: string) {
    super(`Caller is not the owner of campaign ${campaignId}`)
    this.name = 'NotCampaignOwnerError'
  }
}

export class NotCampaignMemberError extends Error {
  readonly code = 'NOT_CAMPAIGN_MEMBER'
  constructor(readonly campaignId: string) {
    super(`Caller is not a member of campaign ${campaignId}`)
    this.name = 'NotCampaignMemberError'
  }
}

export class CampaignNotFoundError extends Error {
  readonly code = 'CAMPAIGN_NOT_FOUND'
  constructor(readonly campaignId: string) {
    super(`Campaign not found: ${campaignId}`)
    this.name = 'CampaignNotFoundError'
  }
}

export class RateLimitedError extends Error {
  readonly code = 'RATE_LIMITED'
  constructor(readonly retryAfterSec: number) {
    super(`Rate limited; retry after ${String(retryAfterSec)}s`)
    this.name = 'RateLimitedError'
  }
}
