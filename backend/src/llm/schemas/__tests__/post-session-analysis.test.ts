import { describe, it, expect } from 'vitest'
import { PostSessionAnalysisSchema } from '../post-session-analysis.js'

const validPartyMember = {
  characterName: 'Brannor',
  location: 'the flooded crypt antechamber',
  condition: 'bloodied, down to a single spell slot',
}

const validNpc = {
  name: 'Sister Halix',
  state: 'wary of the party after they refused her bargain',
  voice: ['"You think coin buys silence here?"', '"The Court remembers slights."'],
}

const validKeyLocation = {
  name: 'the flooded crypt',
  atmosphere: 'ankle-deep brackish water, dripping echoes, faint phosphorescence',
}

const validAnalysis = {
  summary: 'The party descended into the crypt and broke off negotiations with Sister Halix.',
  emergingThreads: ['the broken bargain with the Court', 'the locked inner sanctum'],
  handoff: {
    party: [validPartyMember],
    timeOfDay: 'late evening',
    unresolvedThreads: ['who opened the sluice gate', 'the sealed sarcophagus'],
    npcs: [validNpc],
    keyLocations: [validKeyLocation],
  },
}

describe('PostSessionAnalysisSchema', () => {
  it('accepts a full valid object', () => {
    const r = PostSessionAnalysisSchema.safeParse(validAnalysis)
    expect(r.success).toBe(true)
  })

  it('accepts empty arrays for party/emergingThreads/npcs/keyLocations', () => {
    const r = PostSessionAnalysisSchema.safeParse({
      summary: 'A quiet session of travel and rest.',
      emergingThreads: [],
      handoff: {
        party: [],
        timeOfDay: 'dawn',
        unresolvedThreads: [],
        npcs: [],
        keyLocations: [],
      },
    })
    expect(r.success).toBe(true)
  })

  it('rejects an npcs array of length 9 (.max(8))', () => {
    const nineNpcs = Array.from({ length: 9 }, (_, i) => ({
      ...validNpc,
      name: `NPC ${String(i)}`,
    }))
    const r = PostSessionAnalysisSchema.safeParse({
      ...validAnalysis,
      handoff: { ...validAnalysis.handoff, npcs: nineNpcs },
    })
    expect(r.success).toBe(false)
  })

  it('rejects a voice array of length 5 (.max(4))', () => {
    const fiveVoice = Array.from({ length: 5 }, (_, i) => `"line ${String(i)}"`)
    const r = PostSessionAnalysisSchema.safeParse({
      ...validAnalysis,
      handoff: {
        ...validAnalysis.handoff,
        npcs: [{ ...validNpc, voice: fiveVoice }],
      },
    })
    expect(r.success).toBe(false)
  })

  it('rejects an empty-string summary (.min(1))', () => {
    const r = PostSessionAnalysisSchema.safeParse({ ...validAnalysis, summary: '' })
    expect(r.success).toBe(false)
  })

  it('accepts a multi-paragraph summary (blank-line beat breaks) verbatim', () => {
    // ux-run2 myth-3lgh5: the writer emits 1-4 short paragraphs separated by
    // blank lines when the session had multiple movements; the schema must pass
    // the breaks through untouched (the recap surface renders them as paragraphs).
    const multi = [
      'The party crossed the causeway at low tide and found the middle gate unbarred.',
      'Inside, Sister Halix named her price and the party refused it.',
      'They climbed back to the tide-stair as the water rose, carrying the sealed ledger.',
    ].join('\n\n')
    const parsed = PostSessionAnalysisSchema.parse({ ...validAnalysis, summary: multi })
    expect(parsed.summary).toBe(multi)
  })

  it('accepts a 4000-char summary (no string .max)', () => {
    const longSummary = 'a'.repeat(4000)
    const r = PostSessionAnalysisSchema.safeParse({ ...validAnalysis, summary: longSummary })
    expect(r.success).toBe(true)
  })

  it('strips a stray extra key on handoff', () => {
    const parsed = PostSessionAnalysisSchema.parse({
      ...validAnalysis,
      handoff: { ...validAnalysis.handoff, bogus: 'x' },
    })
    expect('bogus' in parsed.handoff).toBe(false)
  })
})
