// backend/src/llm/prep/__tests__/vocabulary-renderer.test.ts
import { describe, expect, it } from 'vitest'
import { renderVocabularyRegistry } from '../vocabulary-renderer.js'
import type { VocabularyRegistry } from '../../schemas/vocabulary-registry.js'

describe('renderVocabularyRegistry', () => {
  it('returns the empty-registry placeholder when both arrays are empty', () => {
    const registry: VocabularyRegistry = { entries: [], adjacent_franchises: [] }
    expect(renderVocabularyRegistry(registry)).toBe(
      'No registered vocabulary for this world.',
    )
  })

  it('renders adjacent franchises as a single avoidance line', () => {
    const registry: VocabularyRegistry = {
      entries: [],
      adjacent_franchises: ['Harry Potter', 'Diagon Alley'],
    }
    expect(renderVocabularyRegistry(registry)).toBe(
      'Adjacent franchises whose iconic vocabulary you must AVOID in your output: Harry Potter, Diagon Alley.',
    )
  })

  it('renders an entry with term and definition (no avoids, no usage_notes)', () => {
    const registry: VocabularyRegistry = {
      entries: [
        {
          term: 'Spireday',
          definition: 'the first day of the working week in this world\'s calendar.',
          source: 'stage_1_5',
          access_level: 'known',
        },
      ],
      adjacent_franchises: [],
    }
    expect(renderVocabularyRegistry(registry)).toBe(
      `This world's distinctive vocabulary:\n- "Spireday": the first day of the working week in this world's calendar.`,
    )
  })

  it('renders an entry with avoids', () => {
    const registry: VocabularyRegistry = {
      entries: [
        {
          term: 'the unwitched',
          definition: 'non-magical people; this world\'s term for those without arcane sight.',
          avoids: 'muggle',
          source: 'stage_1_5',
          access_level: 'known',
        },
      ],
      adjacent_franchises: [],
    }
    expect(renderVocabularyRegistry(registry)).toBe(
      `This world's distinctive vocabulary:\n- "the unwitched" (use instead of "muggle"): non-magical people; this world's term for those without arcane sight.`,
    )
  })

  it('renders an entry with usage_notes', () => {
    const registry: VocabularyRegistry = {
      entries: [
        {
          term: 'the unwitched',
          definition: 'non-magical people; this world\'s term for those without arcane sight.',
          usage_notes: 'always lowercase',
          source: 'stage_1_5',
          access_level: 'known',
        },
      ],
      adjacent_franchises: [],
    }
    expect(renderVocabularyRegistry(registry)).toBe(
      `This world's distinctive vocabulary:\n- "the unwitched": non-magical people; this world's term for those without arcane sight. — always lowercase`,
    )
  })

  it('renders an entry with both avoids and usage_notes', () => {
    const registry: VocabularyRegistry = {
      entries: [
        {
          term: 'the unwitched',
          definition: 'non-magical people; this world\'s term for those without arcane sight.',
          avoids: 'muggle',
          usage_notes: 'always lowercase',
          source: 'stage_1_5',
          access_level: 'known',
        },
      ],
      adjacent_franchises: [],
    }
    expect(renderVocabularyRegistry(registry)).toBe(
      `This world's distinctive vocabulary:\n- "the unwitched" (use instead of "muggle"): non-magical people; this world's term for those without arcane sight. — always lowercase`,
    )
  })

  it('renders franchises + multiple entries with stable line ordering', () => {
    const registry: VocabularyRegistry = {
      entries: [
        {
          term: 'the unwitched',
          definition: 'non-magical people; this world\'s term for those without arcane sight.',
          avoids: 'muggle',
          source: 'stage_1_5',
          access_level: 'known',
        },
        {
          term: 'the Concordat of Concealment',
          definition: 'the law forbidding magical revelation to the unwitched.',
          avoids: 'Statute of Secrecy',
          source: 'stage_1_5',
          access_level: 'known',
        },
      ],
      adjacent_franchises: ['Harry Potter'],
    }
    const expected = [
      'Adjacent franchises whose iconic vocabulary you must AVOID in your output: Harry Potter.',
      `This world's distinctive vocabulary:`,
      `- "the unwitched" (use instead of "muggle"): non-magical people; this world's term for those without arcane sight.`,
      `- "the Concordat of Concealment" (use instead of "Statute of Secrecy"): the law forbidding magical revelation to the unwitched.`,
    ].join('\n')
    expect(renderVocabularyRegistry(registry)).toBe(expected)
  })
})
