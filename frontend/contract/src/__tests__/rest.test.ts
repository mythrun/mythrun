import { describe, it, expect } from 'vitest'
import {
  MeResponseSchema,
  CampaignSummarySchema,
  MyCampaignsResponseSchema,
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

  describe('CampaignSummarySchema', () => {
    it('parses a valid wire-shape campaign summary', () => {
      const parsed = CampaignSummarySchema.parse({
        id: 'c',
        worldId: 'w',
        name: 'My Campaign',
        status: 'setup',
        language: 'en',
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-02T00:00:00.000Z',
      })
      expect(parsed.status).toBe('setup')
    })

    it('accepts every status enum member', () => {
      for (const status of ['setup', 'active', 'archived', 'failed'] as const) {
        const parsed = CampaignSummarySchema.parse({
          id: 'c',
          worldId: 'w',
          name: 'My Campaign',
          status,
          language: 'en',
          createdAt: '2026-01-01T00:00:00.000Z',
          updatedAt: '2026-01-02T00:00:00.000Z',
        })
        expect(parsed.status).toBe(status)
      }
    })

    it('rejects an unknown status', () => {
      expect(() =>
        CampaignSummarySchema.parse({
          id: 'c',
          worldId: 'w',
          name: 'My Campaign',
          status: 'paused',
          language: 'en',
          createdAt: '2026-01-01T00:00:00.000Z',
          updatedAt: '2026-01-02T00:00:00.000Z',
        }),
      ).toThrow()
    })

    it('REJECTS a Date value for createdAt (wire shape is a string)', () => {
      expect(() =>
        CampaignSummarySchema.parse({
          id: 'c',
          worldId: 'w',
          name: 'My Campaign',
          status: 'setup',
          language: 'en',
          createdAt: new Date(),
          updatedAt: '2026-01-02T00:00:00.000Z',
        }),
      ).toThrow()
    })

    it('is a projection: omits sourceWorldId / createdBy', () => {
      const parsed = CampaignSummarySchema.parse({
        id: 'c',
        worldId: 'w',
        name: 'My Campaign',
        status: 'setup',
        language: 'en',
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-02T00:00:00.000Z',
        sourceWorldId: 'leak',
        createdBy: 'leak',
      })
      expect(parsed).not.toHaveProperty('sourceWorldId')
      expect(parsed).not.toHaveProperty('createdBy')
    })
  })

  describe('MyCampaignsResponseSchema', () => {
    it('parses an empty campaigns array', () => {
      const parsed = MyCampaignsResponseSchema.parse({ campaigns: [] })
      expect(parsed.campaigns).toEqual([])
    })

    it('parses a populated campaigns array', () => {
      const parsed = MyCampaignsResponseSchema.parse({
        campaigns: [
          {
            id: 'c',
            worldId: 'w',
            name: 'My Campaign',
            status: 'active',
            language: 'en',
            createdAt: '2026-01-01T00:00:00.000Z',
            updatedAt: '2026-01-02T00:00:00.000Z',
          },
        ],
      })
      expect(parsed.campaigns).toHaveLength(1)
      expect(parsed.campaigns[0]?.id).toBe('c')
    })
  })
})
