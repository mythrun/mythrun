import { describe, it, expect } from 'vitest'
import {
  MeResponseSchema,
  CampaignSummarySchema,
  MyCampaignsResponseSchema,
  RegisterRequestSchema,
  RegisterResponseSchema,
  CheckUsernameResponseSchema,
  SessionRequestSchema,
  SessionResponseSchema,
  RefreshResponseSchema,
  WsTicketResponseSchema,
  USERNAME_REGEX,
} from '../rest/index.js'

describe('@mythrun/contract/rest', () => {
  describe('MeResponseSchema', () => {
    it('parses a valid wire-shape /me body (ISO-string createdAt)', () => {
      const parsed = MeResponseSchema.parse({
        user: {
          id: 'u',
          username: 'a',
          displayName: 'A',
          freeTrialUsed: false,
          createdAt: '2026-01-01T00:00:00.000Z',
        },
      })
      expect(parsed.user.username).toBe('a')
      expect(parsed.user.createdAt).toBe('2026-01-01T00:00:00.000Z')
    })

    it('REJECTS a Date value for createdAt (wire shape is a string, never a Date)', () => {
      expect(() =>
        MeResponseSchema.parse({
          user: {
            id: 'u',
            username: 'a',
            displayName: 'A',
            freeTrialUsed: false,
            // A real Date — the backend serializes this to an ISO string over
            // JSON. Modeling the WIRE shape means this must fail the schema.
            createdAt: new Date(),
          },
        }),
      ).toThrow()
    })

    it('is a public projection: omits cognitoSub / stripeCustomerId / suspendedAt / updatedAt', () => {
      const parsed = MeResponseSchema.parse({
        user: {
          id: 'u',
          username: 'a',
          displayName: 'A',
          freeTrialUsed: false,
          createdAt: '2026-01-01T00:00:00.000Z',
          // Extra leaked fields are stripped by Zod's default object parse.
          cognitoSub: 'leak',
          stripeCustomerId: 'leak',
          suspendedAt: '2026-01-01T00:00:00.000Z',
          updatedAt: '2026-01-01T00:00:00.000Z',
        },
      })
      expect(parsed.user).not.toHaveProperty('cognitoSub')
      expect(parsed.user).not.toHaveProperty('stripeCustomerId')
      expect(parsed.user).not.toHaveProperty('suspendedAt')
      expect(parsed.user).not.toHaveProperty('updatedAt')
    })
  })

  describe('CampaignSummarySchema (MYT-87 T11 hub card)', () => {
    // A full, valid hub-card body. Individual tests clone + mutate this.
    const hubCard = {
      id: 'c',
      worldId: 'w',
      name: 'My Campaign',
      status: 'setup' as const,
      language: 'en',
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-02T00:00:00.000Z',
      worldName: 'The Sunless Reach',
      worldColors: { from: 'ember-100', to: 'lapis-800' },
      creator: null,
      party: [{ userId: 'u', displayName: 'Ada', hasCharacter: true }],
      sessionCount: 0,
      lastPlayedAt: null,
      cardPhase: 'needs-character' as const,
    }

    it('parses a valid wire-shape hub card', () => {
      const parsed = CampaignSummarySchema.parse(hubCard)
      expect(parsed.status).toBe('setup')
      expect(parsed.worldName).toBe('The Sunless Reach')
      expect(parsed.worldColors).toEqual({ from: 'ember-100', to: 'lapis-800' })
      expect(parsed.cardPhase).toBe('needs-character')
      expect(parsed.party[0]?.hasCharacter).toBe(true)
    })

    it('accepts every status enum member', () => {
      for (const status of ['setup', 'active', 'archived', 'failed'] as const) {
        const parsed = CampaignSummarySchema.parse({ ...hubCard, status })
        expect(parsed.status).toBe(status)
      }
    })

    it('accepts every cardPhase enum member', () => {
      for (const cardPhase of [
        'generating',
        'failed',
        'needs-character',
        'waiting-for-players',
        'not-played',
        'played',
      ] as const) {
        const parsed = CampaignSummarySchema.parse({ ...hubCard, cardPhase })
        expect(parsed.cardPhase).toBe(cardPhase)
      }
    })

    it('rejects an unknown status', () => {
      expect(() => CampaignSummarySchema.parse({ ...hubCard, status: 'paused' })).toThrow()
    })

    it('rejects an unknown cardPhase', () => {
      expect(() => CampaignSummarySchema.parse({ ...hubCard, cardPhase: 'orbiting' })).toThrow()
    })

    it('accepts a null worldColors (world not yet colored) + a null lastPlayedAt', () => {
      const parsed = CampaignSummarySchema.parse({
        ...hubCard,
        worldColors: null,
        lastPlayedAt: null,
      })
      expect(parsed.worldColors).toBeNull()
      expect(parsed.lastPlayedAt).toBeNull()
    })

    it('rejects a worldColors pair with a color outside the curated set', () => {
      expect(() =>
        CampaignSummarySchema.parse({ ...hubCard, worldColors: { from: 'ember-100', to: 'chartreuse' } }),
      ).toThrow()
    })

    it('REJECTS a Date value for createdAt (wire shape is a string)', () => {
      expect(() => CampaignSummarySchema.parse({ ...hubCard, createdAt: new Date() })).toThrow()
    })

    it('REJECTS a Date value for lastPlayedAt (wire shape is a string)', () => {
      expect(() => CampaignSummarySchema.parse({ ...hubCard, lastPlayedAt: new Date() })).toThrow()
    })

    it('is a projection: omits sourceWorldId / createdBy', () => {
      const parsed = CampaignSummarySchema.parse({
        ...hubCard,
        sourceWorldId: 'leak',
        createdBy: 'leak',
      })
      expect(parsed).not.toHaveProperty('sourceWorldId')
      expect(parsed).not.toHaveProperty('createdBy')
    })

    it('rejects a fractional sessionCount (must be a non-negative int)', () => {
      expect(() => CampaignSummarySchema.parse({ ...hubCard, sessionCount: 1.5 })).toThrow()
      expect(() => CampaignSummarySchema.parse({ ...hubCard, sessionCount: -1 })).toThrow()
    })
  })

  describe('MyCampaignsResponseSchema', () => {
    const hubCard = {
      id: 'c',
      worldId: 'w',
      name: 'My Campaign',
      status: 'active' as const,
      language: 'en',
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-02T00:00:00.000Z',
      worldName: 'The Sunless Reach',
      worldColors: null,
      creator: 'Other Player',
      party: [],
      sessionCount: 3,
      lastPlayedAt: '2026-01-03T00:00:00.000Z',
      cardPhase: 'played' as const,
    }

    it('parses an empty campaigns array', () => {
      const parsed = MyCampaignsResponseSchema.parse({ campaigns: [] })
      expect(parsed.campaigns).toEqual([])
    })

    it('parses a populated campaigns array', () => {
      const parsed = MyCampaignsResponseSchema.parse({ campaigns: [hubCard] })
      expect(parsed.campaigns).toHaveLength(1)
      expect(parsed.campaigns[0]?.id).toBe('c')
      expect(parsed.campaigns[0]?.cardPhase).toBe('played')
    })
  })
})

describe('RegisterRequestSchema', () => {
  it('accepts a regex-valid username + 1..40 display name', () => {
    const ok = RegisterRequestSchema.parse({ username: 'bob_the_brave', displayName: 'Bob' })
    expect(ok.username).toBe('bob_the_brave')
  })
  it('rejects a length-2, a leading underscore, and an over-20 username', () => {
    for (const u of ['ab', '_bob', 'a'.repeat(21)]) {
      expect(() => RegisterRequestSchema.parse({ username: u, displayName: 'X' })).toThrow()
    }
  })
  it('rejects an empty and an over-40 display name', () => {
    expect(() => RegisterRequestSchema.parse({ username: 'bobby', displayName: '' })).toThrow()
    expect(() => RegisterRequestSchema.parse({ username: 'bobby', displayName: 'x'.repeat(41) })).toThrow()
  })
  it('exports the canonical USERNAME_REGEX', () => {
    expect(USERNAME_REGEX.test('bob')).toBe(true)
    expect(USERNAME_REGEX.test('_bob')).toBe(false)
  })
})

describe('RegisterResponseSchema', () => {
  it('parses { user (public projection), created } and strips leaked row fields', () => {
    const parsed = RegisterResponseSchema.parse({
      user: {
        id: 'u', username: 'a', displayName: 'A', freeTrialUsed: true,
        createdAt: '2026-01-01T00:00:00.000Z',
        cognitoSub: 'leak', stripeCustomerId: 'leak', suspendedAt: null, updatedAt: '2026-01-01T00:00:00.000Z',
      },
      created: true,
    })
    expect(parsed.created).toBe(true)
    expect(parsed.user).not.toHaveProperty('cognitoSub')
    expect(parsed.user).not.toHaveProperty('stripeCustomerId')
  })
})

describe('CheckUsernameResponseSchema', () => {
  it('parses available with and without a reason', () => {
    expect(CheckUsernameResponseSchema.parse({ available: true }).available).toBe(true)
    expect(CheckUsernameResponseSchema.parse({ available: false, reason: 'taken' }).reason).toBe('taken')
  })
  it('rejects a non-boolean available', () => {
    expect(() => CheckUsernameResponseSchema.parse({ available: 'yes' })).toThrow()
  })
})

describe('SessionRequestSchema / SessionResponseSchema / RefreshResponseSchema', () => {
  it('SessionRequest requires non-empty code + codeVerifier', () => {
    expect(SessionRequestSchema.parse({ code: 'c', codeVerifier: 'v' }).code).toBe('c')
    expect(() => SessionRequestSchema.parse({ code: '', codeVerifier: 'v' })).toThrow()
  })
  it('SessionResponse accepts a string OR null name + positive int expiresIn', () => {
    expect(SessionResponseSchema.parse({ accessToken: 't', expiresIn: 3600, name: 'Ada' }).name).toBe('Ada')
    expect(SessionResponseSchema.parse({ accessToken: 't', expiresIn: 3600, name: null }).name).toBeNull()
    expect(() => SessionResponseSchema.parse({ accessToken: 't', expiresIn: 0, name: null })).toThrow()
    expect(() => SessionResponseSchema.parse({ accessToken: 't', expiresIn: 1.5, name: null })).toThrow()
  })
  it('RefreshResponse accepts a live { accessToken, expiresIn } OR the null no-session variant', () => {
    expect(RefreshResponseSchema.parse({ accessToken: 't', expiresIn: 60 }).accessToken).toBe('t')
    expect(RefreshResponseSchema.parse({ accessToken: null, expiresIn: null }).accessToken).toBeNull()
    // A token without an expiry (or an expiry without a token) is not a valid variant.
    expect(() => RefreshResponseSchema.parse({ accessToken: 't', expiresIn: null })).toThrow()
    expect(() => RefreshResponseSchema.parse({ accessToken: null, expiresIn: 60 })).toThrow()
  })
})

describe('WsTicketResponseSchema', () => {
  it('parses a non-empty ticket', () => {
    expect(WsTicketResponseSchema.parse({ ticket: 'abc' }).ticket).toBe('abc')
  })
  it('rejects an empty ticket', () => {
    expect(() => WsTicketResponseSchema.parse({ ticket: '' })).toThrow()
  })
})
