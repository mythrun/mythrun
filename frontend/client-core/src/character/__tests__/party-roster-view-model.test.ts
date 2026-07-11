import { describe, it, expect } from 'vitest'
import { partyRosterViewModel, type CharacterCreationProgress } from '../index.ts'

// partyRosterViewModel maps the character-creation-progress response into roster
// rows: it marks the viewer's own row, derives creating/ready/empty status from the
// concept status, and orders the campaign owner (host) first so the caller can read
// the owner's readiness off a known position (the owner may sit in `missing`).

const VIEWER = 'user-viewer'
const OWNER = 'user-owner'

function progress(over: Partial<CharacterCreationProgress> = {}): CharacterCreationProgress {
  return {
    campaignId: 'camp-1',
    totalMembers: 3,
    concepts: [
      { userId: VIEWER, displayName: 'You', status: 'processing', submittedAt: 't1' },
      { userId: 'user-c', displayName: 'Cass', status: 'completed', submittedAt: 't2' },
    ],
    missing: [{ userId: OWNER, displayName: 'Host' }],
    ...over,
  }
}

describe('partyRosterViewModel', () => {
  it('marks the viewer row and derives creating / ready / empty status', () => {
    const rows = partyRosterViewModel(progress(), VIEWER, OWNER)
    const byId = new Map(rows.map((r) => [r.userId, r]))
    expect(byId.get(VIEWER)).toEqual({
      userId: VIEWER,
      displayName: 'You',
      status: 'creating',
      isViewer: true,
    })
    expect(byId.get('user-c')).toEqual({
      userId: 'user-c',
      displayName: 'Cass',
      status: 'ready',
      isViewer: false,
    })
    expect(byId.get(OWNER)).toEqual({
      userId: OWNER,
      displayName: 'Host',
      status: 'empty',
      isViewer: false,
    })
  })

  it("treats an 'integrated' concept as ready", () => {
    const rows = partyRosterViewModel(
      progress({
        concepts: [{ userId: 'x', displayName: 'X', status: 'integrated', submittedAt: 't' }],
        missing: [],
      }),
      VIEWER,
      OWNER,
    )
    expect(rows[0]?.status).toBe('ready')
  })

  it('places the owner row first even when the owner has not submitted a concept yet', () => {
    const rows = partyRosterViewModel(progress(), VIEWER, OWNER)
    expect(rows[0]?.userId).toBe(OWNER)
  })

  it('marks the viewer even when the viewer is the owner', () => {
    const rows = partyRosterViewModel(progress(), OWNER, OWNER)
    expect(rows.find((r) => r.userId === OWNER)?.isViewer).toBe(true)
  })
})
