import { describe, it, expect } from 'vitest'
import { type SessionHandoff } from '../../../llm/schemas/post-session-analysis.js'
import {
  verifyHandoffContainment,
  type AnalysisTranscriptRow,
} from '../containment.js'

// ---------------------------------------------------------------------------
// Builders. The verifier is a SECURITY-CRITICAL pure function (enforced
// ignorance): it must drop any voice/atmosphere excerpt that is NOT a verbatim
// (whitespace/case-normalized) substring of a NON-correction/farewell row. Each
// builder keeps a case's intent legible — "a clean handoff, mutated at exactly
// one seam".
// ---------------------------------------------------------------------------

function row(content: string, triggerKind: string | null): AnalysisTranscriptRow {
  return { content, triggerKind }
}

function handoff(o: Partial<SessionHandoff> = {}): SessionHandoff {
  return {
    party: [{ characterName: 'Mira', location: 'The Cellar', condition: 'wounded' }],
    timeOfDay: 'dusk',
    unresolvedThreads: ['the missing ledger'],
    npcs: [],
    keyLocations: [],
    ...o,
  }
}

// A string deep-search so the "NEVER contains a dropped string" invariant is
// checked structurally, not by eyeballing the shape.
function jsonContains(value: SessionHandoff, needle: string): boolean {
  return JSON.stringify(value).includes(needle)
}

describe('verifyHandoffContainment', () => {
  it('keeps a voice excerpt that matches a normal triggerKind:"auto" row verbatim', () => {
    const excerpt = 'Coin first.'
    const result = verifyHandoffContainment(
      handoff({ npcs: [{ name: 'Vex', state: 'wary', voice: [excerpt] }] }),
      [row('Vex narrows her eyes. Coin first.', 'auto')],
    )
    expect(result.handoff.npcs[0]?.voice).toEqual([excerpt])
    expect(result.droppedVoice).toBe(0)
  })

  it('keeps a voice excerpt that matches a triggerKind:null (player / pre-028) row verbatim', () => {
    const excerpt = 'I never trusted him.'
    const result = verifyHandoffContainment(
      handoff({ npcs: [{ name: 'Vex', state: 'wary', voice: [excerpt] }] }),
      [row('I never trusted him.', null)],
    )
    expect(result.handoff.npcs[0]?.voice).toEqual([excerpt])
    expect(result.droppedVoice).toBe(0)
  })

  it('drops a voice excerpt that matches ONLY a correction row (source-exclusion)', () => {
    const secretEcho = '[[DM CORRECTION:]] the duke is the cult leader'
    const result = verifyHandoffContainment(
      handoff({ npcs: [{ name: 'Vex', state: 'wary', voice: [secretEcho] }] }),
      [row(secretEcho, 'correction')],
    )
    expect(result.handoff.npcs[0]?.voice).toEqual([])
    expect(result.droppedVoice).toBe(1)
    expect(jsonContains(result.handoff, 'the duke is the cult leader')).toBe(false)
  })

  it('drops a voice excerpt that matches ONLY a farewell row (source-exclusion)', () => {
    const farewell = 'Until next time, travelers.'
    const result = verifyHandoffContainment(
      handoff({ npcs: [{ name: 'Vex', state: 'wary', voice: [farewell] }] }),
      [row(farewell, 'farewell')],
    )
    expect(result.handoff.npcs[0]?.voice).toEqual([])
    expect(result.droppedVoice).toBe(1)
  })

  it('drops a fabricated voice excerpt that matches NO row', () => {
    const result = verifyHandoffContainment(
      handoff({ npcs: [{ name: 'Vex', state: 'wary', voice: ['A line she never said.'] }] }),
      [row('Vex says nothing of the sort.', 'auto')],
    )
    expect(result.handoff.npcs[0]?.voice).toEqual([])
    expect(result.droppedVoice).toBe(1)
    expect(jsonContains(result.handoff, 'A line she never said.')).toBe(false)
  })

  it('tolerates whitespace/case differences when matching', () => {
    const result = verifyHandoffContainment(
      handoff({ npcs: [{ name: 'Vex', state: 'wary', voice: ['  Coin First.  '] }] }),
      [row('coin first.', 'auto')],
    )
    expect(result.handoff.npcs[0]?.voice).toEqual(['  Coin First.  '])
    expect(result.droppedVoice).toBe(0)
  })

  it('drops an empty-string voice excerpt (defensive: needle.length > 0)', () => {
    const result = verifyHandoffContainment(
      handoff({ npcs: [{ name: 'Vex', state: 'wary', voice: ['   '] }] }),
      [row('Vex narrows her eyes. Coin first.', 'auto')],
    )
    expect(result.handoff.npcs[0]?.voice).toEqual([])
    expect(result.droppedVoice).toBe(1)
  })

  it('removes a keyLocation whose atmosphere is not locatable and keeps one that is', () => {
    const locatable = 'Smoke hung over the broken tables.'
    const fabricated = 'A chandelier of bones swayed overhead.'
    const result = verifyHandoffContainment(
      handoff({
        keyLocations: [
          { name: 'The Tavern', atmosphere: locatable },
          { name: 'The Vault', atmosphere: fabricated },
        ],
      }),
      [row('Smoke hung over the broken tables.', 'auto')],
    )
    expect(result.handoff.keyLocations).toEqual([{ name: 'The Tavern', atmosphere: locatable }])
    expect(result.droppedAtmosphere).toBe(1)
    expect(jsonContains(result.handoff, fabricated)).toBe(false)
  })

  it('retains an NPC (name + state) even when ALL its voice excerpts drop', () => {
    const result = verifyHandoffContainment(
      handoff({ npcs: [{ name: 'Vex', state: 'wary, owed a debt', voice: ['fabricated'] }] }),
      [row('No matching prose here.', 'auto')],
    )
    expect(result.handoff.npcs).toHaveLength(1)
    expect(result.handoff.npcs[0]?.name).toBe('Vex')
    expect(result.handoff.npcs[0]?.state).toBe('wary, owed a debt')
    expect(result.handoff.npcs[0]?.voice).toEqual([])
    expect(result.droppedVoice).toBe(1)
  })

  it('never leaks any dropped string into the returned handoff', () => {
    const droppedVoice = 'A secret line from a retcon.'
    const droppedAtmosphere = 'A fabricated room.'
    const result = verifyHandoffContainment(
      handoff({
        npcs: [{ name: 'Vex', state: 'wary', voice: [droppedVoice] }],
        keyLocations: [{ name: 'The Vault', atmosphere: droppedAtmosphere }],
      }),
      [row(droppedVoice, 'correction'), row('Nothing else matches.', 'auto')],
    )
    expect(jsonContains(result.handoff, droppedVoice)).toBe(false)
    expect(jsonContains(result.handoff, droppedAtmosphere)).toBe(false)
    expect(result.droppedVoice).toBe(1)
    expect(result.droppedAtmosphere).toBe(1)
  })
})
