import { describe, it, expect } from 'vitest'
import {
  toUser,
  toWorld,
  toCampaign,
  toSession,
  toCampaignMember,
  toCampaignCharacter,
  toCreditEntry,
  type UserDbRow,
  type WorldDbRow,
  type CampaignDbRow,
  type SessionDbRow,
  type CampaignMemberDbRow,
  type CampaignCharacterDbRow,
  type CreditEntryDbRow,
} from '../mappers.js'

const FIXED_DATE = new Date('2026-04-28T12:00:00.000Z')

const userRow: UserDbRow = {
  id: '019dccef-300b-7ebc-ac99-d08d3a765185',
  cognito_sub: 'google_12345',
  display_name: 'Alice',
  username: 'alice',
  stripe_customer_id: null,
  free_trial_used: false,
  suspended_at: null,
  created_at: FIXED_DATE,
  updated_at: FIXED_DATE,
}

describe('toUser', () => {
  it('maps every field from snake_case to camelCase', () => {
    const u = toUser(userRow)
    expect(u).toEqual({
      id: '019dccef-300b-7ebc-ac99-d08d3a765185',
      cognitoSub: 'google_12345',
      displayName: 'Alice',
      username: 'alice',
      stripeCustomerId: null,
      freeTrialUsed: false,
      suspendedAt: null,
      createdAt: FIXED_DATE,
      updatedAt: FIXED_DATE,
    })
  })

  it('preserves null on nullable columns', () => {
    const u = toUser({ ...userRow, suspended_at: null })
    expect(u.suspendedAt).toBeNull()
  })
})

const worldRow: WorldDbRow = {
  id: '019dccef-300b-7ebc-ac99-d08d3a765199',
  created_by: '019dccef-300b-7ebc-ac99-d08d3a765185',
  source_world_id: null,
  name: 'Realm of X',
  concept: 'A grim world.',
  tone: null,
  themes: null,
  geography_summary: null,
  political_summary: null,
  era: null,
  key_tensions: null,
  world_overview: null,
  follow_up_questions: null,
  starting_situations: null,
  is_public: false,
  fork_count: 0,
  status: 'generating',
  language: 'en',
  moderation_status: 'unreviewed',
  is_demo: false,
  created_at: FIXED_DATE,
  updated_at: FIXED_DATE,
}

describe('toWorld', () => {
  it('maps every field correctly', () => {
    const w = toWorld(worldRow)
    expect(w.id).toBe(worldRow.id)
    expect(w.createdBy).toBe(worldRow.created_by)
    expect(w.sourceWorldId).toBeNull()
    expect(w.geographySummary).toBeNull()
    expect(w.forkCount).toBe(0)
    expect(w.isPublic).toBe(false)
    expect(w.status).toBe('generating')
    expect(w.moderationStatus).toBe('unreviewed')
  })

  it('throws on unexpected status', () => {
    expect(() => toWorld({ ...worldRow, status: 'unknown' })).toThrow(/unexpected world status/)
  })

  it('throws on unexpected moderation_status', () => {
    expect(() => toWorld({ ...worldRow, moderation_status: 'pending' })).toThrow(
      /unexpected moderation_status/,
    )
  })
})

const campaignRow: CampaignDbRow = {
  id: '019dccef-300b-7ebc-ac99-d08d3a76520a',
  world_id: '019dccef-300b-7ebc-ac99-d08d3a765199',
  source_world_id: null,
  created_by: '019dccef-300b-7ebc-ac99-d08d3a765185',
  name: 'My Campaign',
  status: 'setup',
  language: 'en',
  created_at: FIXED_DATE,
  updated_at: FIXED_DATE,
}

describe('toCampaign', () => {
  it('maps every field correctly', () => {
    const c = toCampaign(campaignRow)
    expect(c).toEqual({
      id: campaignRow.id,
      worldId: campaignRow.world_id,
      sourceWorldId: null,
      createdBy: campaignRow.created_by,
      name: 'My Campaign',
      status: 'setup',
      language: 'en',
      createdAt: FIXED_DATE,
      updatedAt: FIXED_DATE,
    })
  })

  it('throws on unexpected status', () => {
    expect(() => toCampaign({ ...campaignRow, status: 'paused' })).toThrow(
      /unexpected campaign status/,
    )
  })
})

const sessionRow: SessionDbRow = {
  id: '019dccef-300b-7ebc-ac99-d08d3a76521b',
  campaign_id: '019dccef-300b-7ebc-ac99-d08d3a76520a',
  session_number: 1,
  status: 'active',
  started_at: FIXED_DATE,
  ended_at: null,
  summary: null,
  st_running_summary: null,
  handoff: null,
}

describe('toSession', () => {
  it('maps every field correctly', () => {
    const s = toSession(sessionRow)
    expect(s).toEqual({
      id: sessionRow.id,
      campaignId: sessionRow.campaign_id,
      sessionNumber: 1,
      status: 'active',
      startedAt: FIXED_DATE,
      endedAt: null,
      summary: null,
      stRunningSummary: null,
      handoff: null,
    })
  })

  it('throws on unexpected status', () => {
    expect(() => toSession({ ...sessionRow, status: 'paused' })).toThrow(
      /unexpected session status/,
    )
  })
})

const memberRow: CampaignMemberDbRow = {
  id: '019dccef-300b-7ebc-ac99-d08d3a76522c',
  campaign_id: '019dccef-300b-7ebc-ac99-d08d3a76520a',
  user_id: '019dccef-300b-7ebc-ac99-d08d3a765185',
  role: 'owner',
  invite_accepted: true,
  joined_at: FIXED_DATE,
}

describe('toCampaignMember', () => {
  it('maps owner role correctly', () => {
    const m = toCampaignMember(memberRow)
    expect(m.role).toBe('owner')
    expect(m.campaignId).toBe(memberRow.campaign_id)
    expect(m.userId).toBe(memberRow.user_id)
    expect(m.inviteAccepted).toBe(true)
    expect(m.joinedAt).toBe(FIXED_DATE)
  })

  it('maps player role correctly', () => {
    const m = toCampaignMember({ ...memberRow, role: 'player' })
    expect(m.role).toBe('player')
  })

  it('throws on unexpected role', () => {
    expect(() => toCampaignMember({ ...memberRow, role: 'admin' })).toThrow(
      /unexpected campaign_members\.role/,
    )
  })
})

const campaignCharacterRow: CampaignCharacterDbRow = {
  id: '019dccef-300b-7ebc-ac99-d08d3a76533d',
  campaign_id: '019dccef-300b-7ebc-ac99-d08d3a76520a',
  character_id: '019dccef-300b-7ebc-ac99-d08d3a76544e',
  user_id: '019dccef-300b-7ebc-ac99-d08d3a765185',
  joined_at: FIXED_DATE,
}

describe('toCampaignCharacter', () => {
  it('maps every field correctly', () => {
    const cc = toCampaignCharacter(campaignCharacterRow)
    expect(cc).toEqual({
      id: campaignCharacterRow.id,
      campaignId: campaignCharacterRow.campaign_id,
      characterId: campaignCharacterRow.character_id,
      userId: campaignCharacterRow.user_id,
      joinedAt: FIXED_DATE,
    })
  })
})

const creditEntryRow: CreditEntryDbRow = {
  id: '019dccef-300b-7ebc-ac99-d08d3a76533d',
  user_id: '019dccef-300b-7ebc-ac99-d08d3a765185',
  credit_type: 'world_gen',
  amount: 5,
  source_type: 'gift',
  source_id: null,
  granted_at: FIXED_DATE,
  expires_at: null,
}

describe('toCreditEntry', () => {
  it('maps world_gen + gift fields correctly', () => {
    const e = toCreditEntry(creditEntryRow)
    expect(e.creditType).toBe('world_gen')
    expect(e.sourceType).toBe('gift')
    expect(e.amount).toBe(5)
  })

  it('maps session credit type correctly', () => {
    const e = toCreditEntry({ ...creditEntryRow, credit_type: 'session' })
    expect(e.creditType).toBe('session')
  })

  it('maps every CreditSourceType variant', () => {
    for (const src of ['purchase', 'subscription', 'gift', 'trial', 'refund', 'debit'] as const) {
      const e = toCreditEntry({ ...creditEntryRow, source_type: src })
      expect(e.sourceType).toBe(src)
    }
  })

  it('throws on unexpected credit_type value from DB', () => {
    expect(() =>
      toCreditEntry({ ...creditEntryRow, credit_type: 'wild_card' }),
    ).toThrow(/unexpected credit_type value from DB: wild_card/)
  })

  it('throws on unexpected source_type value from DB', () => {
    expect(() =>
      toCreditEntry({ ...creditEntryRow, source_type: 'mystery' }),
    ).toThrow(/unexpected source_type value from DB: mystery/)
  })
})
