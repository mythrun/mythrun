// Constructor sanity for the invite error classes that are declared
// ahead of the routes/repo paths that throw them. The route handler
// switches on `code` to dispatch HTTP responses; pinning the
// discriminator + payload here keeps that contract from drifting.

import { describe, it, expect } from 'vitest'
import {
  InviteNotFoundError,
  InviteRevokedError,
  CampaignFullError,
  CampaignGoneError,
} from '../invites-errors.js'

describe('invites-errors (unused-but-contracted classes)', () => {
  it('InviteNotFoundError carries inviteCode + code', () => {
    const e = new InviteNotFoundError('abc123')
    expect(e.code).toBe('INVITE_NOT_FOUND')
    expect(e.inviteCode).toBe('abc123')
    expect(e.name).toBe('InviteNotFoundError')
    expect(e.message).toMatch(/abc123/)
  })

  it('InviteRevokedError carries inviteCode + code', () => {
    const e = new InviteRevokedError('abc123')
    expect(e.code).toBe('INVITE_REVOKED')
    expect(e.inviteCode).toBe('abc123')
    expect(e.name).toBe('InviteRevokedError')
  })

  it('CampaignFullError carries campaignId + activeMembers + code', () => {
    const e = new CampaignFullError('camp-1', 6)
    expect(e.code).toBe('CAMPAIGN_FULL')
    expect(e.campaignId).toBe('camp-1')
    expect(e.activeMembers).toBe(6)
    expect(e.name).toBe('CampaignFullError')
    expect(e.message).toMatch(/camp-1/)
  })

  it('CampaignGoneError carries campaignId + code', () => {
    const e = new CampaignGoneError('camp-2')
    expect(e.code).toBe('CAMPAIGN_GONE')
    expect(e.campaignId).toBe('camp-2')
    expect(e.name).toBe('CampaignGoneError')
  })
})
