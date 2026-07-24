import { describe, expect, it } from 'vitest'
import type { CampaignSummary } from '@mythrun/client-core'
import { sortCampaignsForHub } from './hub-sort.ts'

// The hub "continue where you left off" order (MYT-bapkt): most-recent activity
// first, where activity = lastPlayedAt ?? updatedAt. Pure + stable.

function campaign(over: Partial<CampaignSummary> & Pick<CampaignSummary, 'id'>): CampaignSummary {
  return {
    worldId: 'w',
    name: 'C',
    status: 'active',
    language: 'en',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    worldName: 'W',
    worldColors: null,
    creator: null,
    party: [],
    sessionCount: 0,
    lastPlayedAt: null,
    cardPhase: 'not-played',
    ...over,
  }
}

describe('sortCampaignsForHub', () => {
  it('orders most-recently-played first, ahead of never-played', () => {
    const played = campaign({ id: 'played', lastPlayedAt: '2026-06-20T00:00:00.000Z', cardPhase: 'played' })
    const fresh = campaign({ id: 'fresh', updatedAt: '2026-06-01T00:00:00.000Z' })
    expect(sortCampaignsForHub([fresh, played]).map((c) => c.id)).toEqual(['played', 'fresh'])
  })

  it('orders never-played campaigns by most-recent update', () => {
    const older = campaign({ id: 'older', updatedAt: '2026-05-01T00:00:00.000Z' })
    const newer = campaign({ id: 'newer', updatedAt: '2026-06-01T00:00:00.000Z' })
    expect(sortCampaignsForHub([older, newer]).map((c) => c.id)).toEqual(['newer', 'older'])
  })

  it('is stable for equal activity times (preserves input order)', () => {
    const a = campaign({ id: 'a', updatedAt: '2026-06-01T00:00:00.000Z' })
    const b = campaign({ id: 'b', updatedAt: '2026-06-01T00:00:00.000Z' })
    expect(sortCampaignsForHub([a, b]).map((c) => c.id)).toEqual(['a', 'b'])
  })

  it('does not mutate the input array', () => {
    const input = [
      campaign({ id: 'x', updatedAt: '2026-05-01T00:00:00.000Z' }),
      campaign({ id: 'y', updatedAt: '2026-06-01T00:00:00.000Z' }),
    ]
    const before = input.map((c) => c.id)
    sortCampaignsForHub(input)
    expect(input.map((c) => c.id)).toEqual(before)
  })
})
