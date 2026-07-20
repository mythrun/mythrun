// Pure-function unit test for the prep's prior-session-context parser
// (MYT-74b T10). buildPriorSessionContext takes the repo's NEWEST-first rows and
// produces the prep's PriorSessionContext: chronological previousSummaries +
// the newest row's safeParsed handoff. All parsing is tolerant — malformed /
// legacy rows degrade to omission, never a throw mid-prep.
import { describe, it, expect } from 'vitest'
import { buildPriorSessionContext } from '../prior-session-context.js'
import type { SessionHandoff } from '../../schemas/post-session-analysis.js'

function makeHandoff(): SessionHandoff {
  return {
    party: [{ characterName: 'Bram', location: 'the cellar', condition: 'wounded' }],
    timeOfDay: 'dusk',
    unresolvedThreads: ['the locked door'],
    npcs: [{ name: 'Mira', state: 'wary of the party', voice: ['You should not have come.'] }],
    keyLocations: [{ name: 'the cellar', atmosphere: 'damp and cold' }],
  }
}

describe('buildPriorSessionContext', () => {
  it('reverses NEWEST-first rows into chronological previousSummaries and takes the newest handoff', () => {
    const handoff = makeHandoff()
    // Repo rows are NEWEST first: session 3, then 2, then 1.
    const rows = [
      { sessionNumber: 3, summaryJson: JSON.stringify({ summary: 'newest' }), handoffJson: JSON.stringify(handoff) },
      { sessionNumber: 2, summaryJson: JSON.stringify({ summary: 'middle' }), handoffJson: null },
      { sessionNumber: 1, summaryJson: JSON.stringify({ summary: 'oldest' }), handoffJson: null },
    ]
    const result = buildPriorSessionContext(rows)
    // Chronological (oldest → newest).
    expect(result.previousSummaries).toEqual(['oldest', 'middle', 'newest'])
    // latestHandoff = the NEWEST row's handoff.
    expect(result.latestHandoff).toEqual(handoff)
  })

  it('skips a malformed summaryJson wrapper without throwing', () => {
    const rows = [
      { sessionNumber: 2, summaryJson: 'not json{', handoffJson: null },
      { sessionNumber: 1, summaryJson: JSON.stringify({ summary: 'valid' }), handoffJson: null },
    ]
    const result = buildPriorSessionContext(rows)
    // The malformed row is dropped; only the valid summary survives.
    expect(result.previousSummaries).toEqual(['valid'])
  })

  it('skips a summaryJson wrapper whose summary is missing or non-string', () => {
    const rows = [
      { sessionNumber: 3, summaryJson: JSON.stringify({ emergingThreads: ['t'] }), handoffJson: null },
      { sessionNumber: 2, summaryJson: JSON.stringify({ summary: 42 }), handoffJson: null },
      { sessionNumber: 1, summaryJson: JSON.stringify({ summary: '' }), handoffJson: null },
    ]
    const result = buildPriorSessionContext(rows)
    // Missing summary, non-string summary, and empty-string summary all dropped.
    expect(result.previousSummaries).toEqual([])
  })

  it('omits latestHandoff when the newest row has a null handoffJson', () => {
    const rows = [
      { sessionNumber: 1, summaryJson: JSON.stringify({ summary: 'only' }), handoffJson: null },
    ]
    const result = buildPriorSessionContext(rows)
    expect('latestHandoff' in result).toBe(false)
  })

  it('omits latestHandoff when the newest row has a malformed handoffJson', () => {
    const rows = [
      { sessionNumber: 1, summaryJson: JSON.stringify({ summary: 'only' }), handoffJson: 'not json{' },
    ]
    const result = buildPriorSessionContext(rows)
    expect('latestHandoff' in result).toBe(false)
  })

  it('omits latestHandoff when the newest handoffJson fails schema validation', () => {
    // Valid JSON but not a SessionHandoff (missing required fields) → safeParse fails.
    const rows = [
      { sessionNumber: 1, summaryJson: JSON.stringify({ summary: 'only' }), handoffJson: JSON.stringify({ party: 'wrong' }) },
    ]
    const result = buildPriorSessionContext(rows)
    expect('latestHandoff' in result).toBe(false)
  })

  it('returns an empty context for empty input', () => {
    const result = buildPriorSessionContext([])
    expect(result).toEqual({ previousSummaries: [] })
    expect('latestHandoff' in result).toBe(false)
  })

  it('myth-8mom0: a handoff/summary encoding the FAREWELL end-state carries into next-session prep', () => {
    // The post-session analysis now anchors its summary + handoff end-state to the
    // farewell wind-down (an NPC's departure). This is the surface the prep engine
    // reads for "Where We Left Off" (serialize-world-state-for-prep) — assert the
    // closing state survives the producer→prep bridge intact, so the next session
    // opens on where the last one ENDED, not a mid-session moment.
    const closingHandoff: SessionHandoff = {
      party: [{ characterName: 'Bram', location: 'the empty tavern', condition: 'settled for the night' }],
      timeOfDay: 'well past midnight',
      unresolvedThreads: ['Renn left town — where did he go?'],
      npcs: [{ name: 'Renn', state: 'gone — packed his tools and left, his bench sits empty', voice: [] }],
      keyLocations: [{ name: 'the tavern', atmosphere: 'quiet, one lamp still lit' }],
    }
    const rows = [
      {
        sessionNumber: 2,
        summaryJson: JSON.stringify({ summary: 'Renn finished the bracket, said his goodbyes, and left town for good.' }),
        handoffJson: JSON.stringify(closingHandoff),
      },
      { sessionNumber: 1, summaryJson: JSON.stringify({ summary: 'The party met Renn the carver.' }), handoffJson: null },
    ]
    const result = buildPriorSessionContext(rows)

    // The closing summary is the newest recap the prep renders under "Prior Sessions".
    expect(result.previousSummaries.at(-1)).toContain('left town for good')
    // The farewell end-state (Renn gone) is the "Where We Left Off" anchor.
    expect(result.latestHandoff).toEqual(closingHandoff)
    expect(result.latestHandoff?.npcs[0]?.state).toContain('gone')
  })
})
