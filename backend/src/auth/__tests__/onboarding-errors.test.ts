// Constructor sanity for the onboarding error classes. The classes are
// declared ahead of the routes that throw them (onboarding flow lands in
// a later milestone); these tests pin the discriminator + payload shape
// so the error-handler mapper has a stable contract to switch on.

import { describe, it, expect } from 'vitest'
import {
  UsernameInvalidError,
  DisplayNameInvalidError,
  UsernameTakenError,
  AlreadyOnboardedError,
  NotCampaignOwnerError,
  NotCampaignMemberError,
  CampaignNotFoundError,
  RateLimitedError,
} from '../onboarding-errors.js'

describe('onboarding-errors', () => {
  it('UsernameInvalidError carries reason + code', () => {
    const e = new UsernameInvalidError('profane')
    expect(e.code).toBe('USERNAME_INVALID')
    expect(e.reason).toBe('profane')
    expect(e.name).toBe('UsernameInvalidError')
    expect(e.message).toMatch(/profane/)
  })

  it('DisplayNameInvalidError carries reason + code', () => {
    const e = new DisplayNameInvalidError('length')
    expect(e.code).toBe('DISPLAY_NAME_INVALID')
    expect(e.reason).toBe('length')
    expect(e.name).toBe('DisplayNameInvalidError')
  })

  it('UsernameTakenError carries suggestion + code', () => {
    const e = new UsernameTakenError('alice-42')
    expect(e.code).toBe('USERNAME_TAKEN')
    expect(e.suggestion).toBe('alice-42')
    expect(e.name).toBe('UsernameTakenError')
  })

  it('AlreadyOnboardedError carries both usernames + code', () => {
    const e = new AlreadyOnboardedError('current', 'requested')
    expect(e.code).toBe('ALREADY_ONBOARDED')
    expect(e.currentUsername).toBe('current')
    expect(e.requestedUsername).toBe('requested')
    expect(e.name).toBe('AlreadyOnboardedError')
  })

  it('NotCampaignOwnerError carries campaignId + code', () => {
    const e = new NotCampaignOwnerError('camp-1')
    expect(e.code).toBe('NOT_CAMPAIGN_OWNER')
    expect(e.campaignId).toBe('camp-1')
    expect(e.name).toBe('NotCampaignOwnerError')
  })

  it('NotCampaignMemberError carries campaignId + code', () => {
    const e = new NotCampaignMemberError('camp-1')
    expect(e.code).toBe('NOT_CAMPAIGN_MEMBER')
    expect(e.campaignId).toBe('camp-1')
    expect(e.name).toBe('NotCampaignMemberError')
  })

  it('CampaignNotFoundError carries campaignId + code', () => {
    const e = new CampaignNotFoundError('camp-1')
    expect(e.code).toBe('CAMPAIGN_NOT_FOUND')
    expect(e.campaignId).toBe('camp-1')
    expect(e.name).toBe('CampaignNotFoundError')
  })

  it('RateLimitedError carries retryAfterSec + code', () => {
    const e = new RateLimitedError(30)
    expect(e.code).toBe('RATE_LIMITED')
    expect(e.retryAfterSec).toBe(30)
    expect(e.name).toBe('RateLimitedError')
    expect(e.message).toMatch(/30/)
  })
})
