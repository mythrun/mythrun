import { describe, it, expect } from 'vitest'
import {
  toUser,
  toWorld,
  toCampaign,
  toSession,
  type UserDbRow,
  type WorldDbRow,
  type CampaignDbRow,
  type SessionDbRow,
} from '../mappers.js'

const FIXED_DATE = new Date('2026-04-28T12:00:00.000Z')

const userRow: UserDbRow = {
  id: '019dccef-300b-7ebc-ac99-d08d3a765185',
  cognito_sub: 'google_12345',
  email: 'a@b.com',
  display_name: 'Alice',
  username: 'alice',
  avatar_url: 'https://example.com/a.png',
  auth_provider: 'google',
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
      email: 'a@b.com',
      displayName: 'Alice',
      username: 'alice',
      avatarUrl: 'https://example.com/a.png',
      authProvider: 'google',
      stripeCustomerId: null,
      freeTrialUsed: false,
      suspendedAt: null,
      createdAt: FIXED_DATE,
      updatedAt: FIXED_DATE,
    })
  })

  it('preserves null on nullable columns', () => {
    const u = toUser({ ...userRow, avatar_url: null, suspended_at: null })
    expect(u.avatarUrl).toBeNull()
    expect(u.suspendedAt).toBeNull()
  })

  it('throws on unexpected auth_provider values', () => {
    expect(() => toUser({ ...userRow, auth_provider: 'apple' })).toThrow(/unexpected auth_provider/)
  })

  it('accepts both google and discord', () => {
    expect(toUser({ ...userRow, auth_provider: 'google' }).authProvider).toBe('google')
    expect(toUser({ ...userRow, auth_provider: 'discord' }).authProvider).toBe('discord')
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
    expect(() => toWorld({ ...worldRow, moderation_status: 'pending' })).toThrow(/unexpected moderation_status/)
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
    expect(() => toCampaign({ ...campaignRow, status: 'paused' })).toThrow(/unexpected campaign status/)
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
    expect(() => toSession({ ...sessionRow, status: 'paused' })).toThrow(/unexpected session status/)
  })
})
