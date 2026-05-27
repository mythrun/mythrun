import { describe, it, expect } from 'vitest'
import { CoherencePatchSchema, CoherenceOutputSchema } from '../coherence-output.js'

describe('CoherencePatchSchema — existing kinds', () => {
  it('accepts a valid fix_fact_by_name patch', () => {
    expect(() =>
      CoherencePatchSchema.parse({
        kind: 'fix_fact_by_name',
        entity_name: 'Old Eredil',
        fact_topic: 'history',
        new_content: 'The village burned a generation ago.',
        rationale: 'Existing fact contradicted the prose.',
      }),
    ).not.toThrow()
  })

  it('accepts a valid fix_prose_by_name patch', () => {
    expect(() =>
      CoherencePatchSchema.parse({
        kind: 'fix_prose_by_name',
        entity_name: 'Old Eredil',
        new_prose:
          'A weathered fishing village, half rebuilt after the fire that took the upper quarter generations ago.',
        rationale: 'Prose contradicted historical timeline.',
      }),
    ).not.toThrow()
  })

  it('accepts a valid fix_relationship_by_name patch with newType only', () => {
    expect(() =>
      CoherencePatchSchema.parse({
        kind: 'fix_relationship_by_name',
        source_name: 'Old Eredil',
        target_name: 'Mara',
        current_type: 'rivalry',
        newType: 'distrusts',
        rationale: 'Type rivalry too strong for the prose.',
      }),
    ).not.toThrow()
  })

  it('accepts a valid rename_entity_by_name patch', () => {
    expect(() =>
      CoherencePatchSchema.parse({
        kind: 'rename_entity_by_name',
        old_name: 'Mara',
        new_name: 'Mara Salt-Hand',
        rationale: 'Other prose references the longer form.',
      }),
    ).not.toThrow()
  })

  it('accepts a valid delete_relationship_by_name patch', () => {
    expect(() =>
      CoherencePatchSchema.parse({
        kind: 'delete_relationship_by_name',
        source_name: 'Mara',
        target_name: 'The Wharf',
        current_type: 'employed_by',
        rationale: 'Redundant with another relationship after the prior fix.',
      }),
    ).not.toThrow()
  })

  it('rejects unknown kind', () => {
    expect(() =>
      CoherencePatchSchema.parse({
        kind: 'invent_entity',
        entity_name: 'X',
        rationale: 'too short for nothing',
      }),
    ).toThrow()
  })
})

describe('CoherenceOutputSchema', () => {
  it('caps patches at 40', () => {
    const patches = Array.from({ length: 41 }).map(() => ({
      kind: 'fix_fact_by_name',
      entity_name: 'X',
      fact_topic: 'y',
      new_content: 'aaaaaaaaaa',
      rationale: 'this is a long enough rationale for the test',
    }))
    expect(() => CoherenceOutputSchema.parse({ patches })).toThrow()
  })
})
