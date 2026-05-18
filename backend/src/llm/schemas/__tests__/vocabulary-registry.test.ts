// backend/src/llm/schemas/__tests__/vocabulary-registry.test.ts
import { describe, expect, it } from 'vitest'
import {
  VocabularyEntrySchema,
  VocabularyRegistrySchema,
  VocabularyIntakeOutputSchema,
} from '../vocabulary-registry.js'

describe('VocabularyEntrySchema', () => {
  it('accepts a minimal valid entry (term + definition + source)', () => {
    const result = VocabularyEntrySchema.safeParse({
      term: 'the unwitched',
      definition: 'non-magical people; this world\'s term for those without arcane sight.',
      source: 'stage_1_5',
    })
    expect(result.success).toBe(true)
    // access_level defaults to 'known' when omitted.
    if (result.success) expect(result.data.access_level).toBe('known')
  })

  it('accepts a fully-populated entry with avoids and usage_notes', () => {
    const result = VocabularyEntrySchema.safeParse({
      term: 'the Concordat of Concealment',
      definition: 'the law forbidding magical revelation to the unwitched.',
      avoids: 'Statute of Secrecy',
      usage_notes: 'often shortened to "the Concordat".',
      source: 'stage_1_5',
      access_level: 'known',
    })
    expect(result.success).toBe(true)
  })

  it('rejects term shorter than 1 char', () => {
    const result = VocabularyEntrySchema.safeParse({
      term: '',
      definition: 'a sufficiently long definition that satisfies the min(30) check.',
      source: 'stage_1_5',
    })
    expect(result.success).toBe(false)
  })

  it('rejects definition shorter than 10 chars', () => {
    const result = VocabularyEntrySchema.safeParse({
      term: 'x',
      definition: 'short',
      source: 'stage_1_5',
    })
    expect(result.success).toBe(false)
  })

  it('rejects term longer than 80 chars', () => {
    const result = VocabularyEntrySchema.safeParse({
      term: 'a'.repeat(81),
      definition: 'a sufficiently long definition that satisfies the min(30) check.',
      source: 'stage_1_5',
    })
    expect(result.success).toBe(false)
  })

  it('rejects definition longer than 800 chars', () => {
    const result = VocabularyEntrySchema.safeParse({
      term: 'x',
      definition: 'a'.repeat(801),
      source: 'stage_1_5',
    })
    expect(result.success).toBe(false)
  })

  it('rejects invalid source enum value', () => {
    const result = VocabularyEntrySchema.safeParse({
      term: 'x',
      definition: 'a sufficiently long definition that satisfies the min(30) check.',
      source: 'invalid',
    })
    expect(result.success).toBe(false)
  })

  it('rejects invalid access_level enum value', () => {
    const result = VocabularyEntrySchema.safeParse({
      term: 'x',
      definition: 'a sufficiently long definition that satisfies the min(30) check.',
      source: 'stage_1_5',
      access_level: 'public',
    })
    expect(result.success).toBe(false)
  })
})

describe('VocabularyRegistrySchema', () => {
  it('accepts an empty registry', () => {
    const result = VocabularyRegistrySchema.safeParse({
      entries: [],
      adjacent_franchises: [],
    })
    expect(result.success).toBe(true)
  })

  it('accepts a populated registry', () => {
    const result = VocabularyRegistrySchema.safeParse({
      entries: [
        {
          term: 'the unwitched',
          definition: 'non-magical people; this world\'s term for those without arcane sight.',
          avoids: 'muggle',
          source: 'stage_1_5',
          access_level: 'known',
        },
      ],
      adjacent_franchises: ['Harry Potter'],
    })
    expect(result.success).toBe(true)
  })

  it('rejects entries array exceeding cap of 60', () => {
    const entry = {
      term: 'x',
      definition: 'a sufficiently long definition that satisfies the min(30) check.',
      source: 'stage_1_5' as const,
    }
    const result = VocabularyRegistrySchema.safeParse({
      entries: new Array(61).fill(entry),
      adjacent_franchises: [],
    })
    expect(result.success).toBe(false)
  })

  it('rejects adjacent_franchises array exceeding cap of 8', () => {
    const result = VocabularyRegistrySchema.safeParse({
      entries: [],
      adjacent_franchises: new Array(9).fill('Franchise X'),
    })
    expect(result.success).toBe(false)
  })
})

describe('VocabularyIntakeOutputSchema', () => {
  // Per myth-pfke's design pivot: model output is entries-only. No
  // adjacent_franchises, no avoids, no source, no access_level. Handler
  // stamps source + access_level + adjacent_franchises:[] before storage.
  it('accepts entries-only model output', () => {
    const result = VocabularyIntakeOutputSchema.safeParse({
      entries: [
        {
          term: 'the unwitched',
          definition: "non-magical people; this world's term for those without arcane sight.",
        },
      ],
    })
    expect(result.success).toBe(true)
  })

  it('strips extras (source, avoids, adjacent_franchises) from model output', () => {
    // Sonnet sometimes emits passthrough fields even when the prompt says
    // to omit. Zod default strips them silently; the handler's stamp-pass
    // overwrites anything the model emitted in those slots anyway.
    const result = VocabularyIntakeOutputSchema.safeParse({
      entries: [
        {
          term: 'x',
          definition: 'long enough definition.',
          source: 'stage_1_5',
          avoids: 'muggle',
        },
      ],
      adjacent_franchises: ['Harry Potter'],
    })
    expect(result.success).toBe(true)
    if (result.success) {
      expect(result.data.entries[0]).not.toHaveProperty('source')
      expect(result.data.entries[0]).not.toHaveProperty('avoids')
      expect(result.data).not.toHaveProperty('adjacent_franchises')
    }
  })

  it('rejects entries exceeding cap of 30', () => {
    const entry = {
      term: 'x',
      definition: 'long enough definition.',
    }
    const result = VocabularyIntakeOutputSchema.safeParse({
      entries: new Array(31).fill(entry),
    })
    expect(result.success).toBe(false)
  })

  it('accepts empty entries (degenerate world)', () => {
    const result = VocabularyIntakeOutputSchema.safeParse({ entries: [] })
    expect(result.success).toBe(true)
  })
})
