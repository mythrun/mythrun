// backend/src/llm/schemas/__tests__/retcon-author.test.ts
import { describe, expect, it } from 'vitest'
import { RetconResultSchema } from '../retcon-author.js'

const base = {
  retconText: 'Correction — the gatehouse keeper is not the one who turned you away; that was a guard.',
  supersededContent: 'The narrator said the keeper turned the party away.',
  tier: 'known' as const,
}

describe('RetconResultSchema', () => {
  it('accepts a well-formed retcon', () => {
    expect(RetconResultSchema.safeParse(base).success).toBe(true)
  })
  it('rejects empty retconText', () => {
    expect(RetconResultSchema.safeParse({ ...base, retconText: '' }).success).toBe(false)
  })
  it('accepts long retconText (no .max ceiling on free prose)', () => {
    const long = 'word '.repeat(2000).trim()
    expect(RetconResultSchema.safeParse({ ...base, retconText: long }).success).toBe(true)
  })
  it('accepts each tier', () => {
    for (const tier of ['known', 'discoverable', 'secret'] as const) {
      expect(RetconResultSchema.safeParse({ ...base, tier }).success).toBe(true)
    }
  })
  it('rejects an unknown tier', () => {
    expect(RetconResultSchema.safeParse({ ...base, tier: 'public' }).success).toBe(false)
  })
})
