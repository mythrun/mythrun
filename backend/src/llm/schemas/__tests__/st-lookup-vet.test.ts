// backend/src/llm/schemas/__tests__/st-lookup-vet.test.ts
import { describe, expect, it } from 'vitest'
import { StLookupVetResultSchema } from '../st-lookup-vet.js'

const base = {
  mode: 'relay' as const,
  text: 'You recall the old bridge was rebuilt after the spring floods two winters back.',
  tier: 'known' as const,
}

describe('StLookupVetResultSchema', () => {
  it('accepts each mode', () => {
    for (const mode of ['relay', 'none', 'invent'] as const) {
      expect(StLookupVetResultSchema.safeParse({ ...base, mode }).success).toBe(true)
    }
  })
  it('accepts each tier', () => {
    for (const tier of ['known', 'discoverable', 'secret'] as const) {
      expect(StLookupVetResultSchema.safeParse({ ...base, tier }).success).toBe(true)
    }
  })
  it('rejects empty text', () => {
    expect(StLookupVetResultSchema.safeParse({ ...base, text: '' }).success).toBe(false)
  })
  it('accepts long text (no .max ceiling on free prose)', () => {
    const long = 'word '.repeat(2000).trim()
    expect(StLookupVetResultSchema.safeParse({ ...base, text: long }).success).toBe(true)
  })
  it('rejects an unknown mode', () => {
    expect(StLookupVetResultSchema.safeParse({ ...base, mode: 'reveal' }).success).toBe(false)
  })
  it('rejects an unknown tier', () => {
    expect(StLookupVetResultSchema.safeParse({ ...base, tier: 'public' }).success).toBe(false)
  })
})
