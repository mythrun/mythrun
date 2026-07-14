import { describe, it, expect } from 'vitest'
import { partyRosterViewModel, type CharacterCreationProgress } from '../index.ts'

// partyRosterViewModel maps the character-creation-progress response into roster
// rows: it marks the viewer's own row, derives creating/ready/gathering status from
// the concept status (a member with no concept yet is `gathering` — a real joined
// teammate still building, NOT the synthetic invite slot), and orders the campaign
// owner (host) first so the caller can read the owner's readiness off a known
// position (the owner may sit in `missing`).

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
  it('marks the viewer row and derives creating / ready / gathering status', () => {
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
    // A member with no concept yet is `gathering` — a real joined teammate still
    // building — never `empty` (the invite slot is synthetic, appended downstream).
    expect(byId.get(OWNER)).toEqual({
      userId: OWNER,
      displayName: 'Host',
      status: 'gathering',
      isViewer: false,
    })
  })

  it('maps every `missing` member to `gathering`, never `empty` (retains displayName + isViewer)', () => {
    const rows = partyRosterViewModel(
      progress({
        concepts: [],
        missing: [
          { userId: OWNER, displayName: 'Host' },
          { userId: VIEWER, displayName: 'You' },
        ],
      }),
      VIEWER,
      OWNER,
    )
    // No row is ever `empty` — the view-model produces only real-member statuses.
    expect(rows.some((r) => r.status === 'empty')).toBe(false)
    expect(rows.every((r) => r.status === 'gathering')).toBe(true)
    expect(rows.find((r) => r.userId === VIEWER)).toEqual({
      userId: VIEWER,
      displayName: 'You',
      status: 'gathering',
      isViewer: true,
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
