import { describe, expect, it } from 'vitest'
import { SkillCheckResultSchema } from '../skill-check.js'
import { loadPrompt } from '../../prompts.js'

const valid = {
  dc: 13,
  outcomes: { fail: 'You slip.', success: 'You hold on.', great_success: 'You vault it.' },
}

describe('SkillCheckResultSchema', () => {
  it('accepts a valid table', () => {
    expect(SkillCheckResultSchema.safeParse(valid).success).toBe(true)
  })
  it('rejects an out-of-band DC (structural bound, ZFC-exempt)', () => {
    expect(SkillCheckResultSchema.safeParse({ ...valid, dc: 200 }).success).toBe(false)
    expect(SkillCheckResultSchema.safeParse({ ...valid, dc: -3 }).success).toBe(false)
    expect(SkillCheckResultSchema.safeParse({ ...valid, dc: 12.5 }).success).toBe(false)
  })
  it('rejects an empty outcome (min floor; NO max on prose)', () => {
    expect(
      SkillCheckResultSchema.safeParse({ ...valid, outcomes: { ...valid.outcomes, fail: '' } }).success,
    ).toBe(false)
  })
})

describe('skill-check prompt template', () => {
  it('carries exactly the FT-tier var contract (tool input + mechanical character data ONLY)', () => {
    const raw = loadPrompt('session', 'skill-check', {
      character_summary: 'CS', world_tone: 'WT', skill: 'SK', context: 'CX',
    })
    expect(raw).toContain('CS')
    expect(raw).toContain('WT')
    expect(raw).toContain('SK')
    expect(raw).toContain('CX')
    expect(raw).not.toContain('{{') // no other vars — never the summary or world-store facts
  })
})
