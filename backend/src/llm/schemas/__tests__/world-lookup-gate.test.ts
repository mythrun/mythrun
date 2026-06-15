import { describe, expect, it } from 'vitest'
import { WorldLookupGateResultSchema } from '../world-lookup-gate.js'
import { loadPrompt } from '../../prompts.js'

const valid = {
  auto_success: false,
  dc: 14,
  outcomes: {
    fail: "You can't quite place it.",
    success: 'You recall the broad shape of it.',
    great_success: 'You recall it in precise detail.',
  },
}

describe('WorldLookupGateResultSchema', () => {
  it('accepts a valid gate table', () => {
    expect(WorldLookupGateResultSchema.safeParse(valid).success).toBe(true)
  })

  it('accepts auto_success true', () => {
    expect(WorldLookupGateResultSchema.safeParse({ ...valid, auto_success: true }).success).toBe(true)
  })

  it('rejects an out-of-band DC (structural bound, ZFC-exempt)', () => {
    expect(WorldLookupGateResultSchema.safeParse({ ...valid, dc: 0 }).success).toBe(false)
    expect(WorldLookupGateResultSchema.safeParse({ ...valid, dc: 31 }).success).toBe(false)
    expect(WorldLookupGateResultSchema.safeParse({ ...valid, dc: 12.5 }).success).toBe(false)
  })

  it('rejects a missing auto_success flag', () => {
    const withoutFlag = { dc: valid.dc, outcomes: valid.outcomes }
    expect(WorldLookupGateResultSchema.safeParse(withoutFlag).success).toBe(false)
  })

  it('rejects an empty outcome (min floor; NO max on prose)', () => {
    expect(
      WorldLookupGateResultSchema.safeParse({
        ...valid,
        outcomes: { ...valid.outcomes, fail: '' },
      }).success,
    ).toBe(false)
  })

  it('accepts a long outcome (no max on free prose)', () => {
    const long = 'You recall it. '.repeat(200)
    expect(
      WorldLookupGateResultSchema.safeParse({
        ...valid,
        outcomes: { ...valid.outcomes, great_success: long },
      }).success,
    ).toBe(true)
  })
})

describe('world-lookup-gate prompt template', () => {
  it('carries exactly the public-standing var contract', () => {
    const raw = loadPrompt('session', 'world-lookup-gate', {
      asker_summary: 'AS',
      channel: 'CH',
      world_tone: 'WT',
      topic: 'TP',
    })
    expect(raw).toContain('AS')
    expect(raw).toContain('CH')
    expect(raw).toContain('WT')
    expect(raw).toContain('TP')
    expect(raw).not.toContain('{{') // no other vars — public standing only
  })
})
