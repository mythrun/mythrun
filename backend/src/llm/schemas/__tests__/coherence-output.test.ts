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

describe('fix_relationship_by_name — newSource / newTarget', () => {
  it('accepts newSource alone', () => {
    expect(() =>
      CoherencePatchSchema.parse({
        kind: 'fix_relationship_by_name',
        source_name: 'A',
        target_name: 'B',
        current_type: 'allied_with',
        newSource: 'A-prime',
        rationale: 'The original source was the wrong entity; correcting.',
      }),
    ).not.toThrow()
  })

  it('accepts newTarget alone', () => {
    expect(() =>
      CoherencePatchSchema.parse({
        kind: 'fix_relationship_by_name',
        source_name: 'A',
        target_name: 'B',
        current_type: 'allied_with',
        newTarget: 'B-prime',
        rationale: 'Wrong target — relationship should land on B-prime.',
      }),
    ).not.toThrow()
  })

  it('accepts newSource + newTarget together', () => {
    expect(() =>
      CoherencePatchSchema.parse({
        kind: 'fix_relationship_by_name',
        source_name: 'A',
        target_name: 'B',
        current_type: 'allied_with',
        newSource: 'A-prime',
        newTarget: 'B-prime',
        rationale: 'Both endpoints were wrong; redirect both.',
      }),
    ).not.toThrow()
  })

  it('rejects a patch with NO new* fields (.refine no-op guard)', () => {
    expect(() =>
      CoherencePatchSchema.parse({
        kind: 'fix_relationship_by_name',
        source_name: 'A',
        target_name: 'B',
        current_type: 'allied_with',
        rationale: 'Reviewer flagged this but supplied no actual change.',
      }),
    ).toThrow(/at least one of newSource, newTarget, newType, newDescription/)
  })

  it('accepts an optional newAccessLevel re-tier', () => {
    expect(() =>
      CoherencePatchSchema.parse({
        kind: 'fix_relationship_by_name',
        source_name: 'A',
        target_name: 'B',
        current_type: 'allied_with',
        newAccessLevel: 'discoverable',
        rationale: 'The relationship should be discoverable, not secret.',
      }),
    ).not.toThrow()
  })

  it('rejects an unknown newAccessLevel tier', () => {
    expect(() =>
      CoherencePatchSchema.parse({
        kind: 'fix_relationship_by_name',
        source_name: 'A',
        target_name: 'B',
        current_type: 'allied_with',
        newAccessLevel: 'public',
        rationale: 'The relationship should be discoverable, not secret.',
      }),
    ).toThrow()
  })
})

describe('add_relationship_by_name', () => {
  it('accepts a valid patch with each access_level', () => {
    for (const access_level of ['known', 'discoverable', 'secret'] as const) {
      expect(() =>
        CoherencePatchSchema.parse({
          kind: 'add_relationship_by_name',
          source_name: 'Brother Anselm',
          target_name: 'Stillwater Monastery',
          relationship: 'keeper_of',
          description: 'Anselm serves as the Keeper of the Order at Stillwater.',
          access_level,
          rationale: 'Prose explicitly states this; structured stage missed it.',
        }),
      ).not.toThrow()
    }
  })

  it('rejects a patch missing access_level', () => {
    expect(() =>
      CoherencePatchSchema.parse({
        kind: 'add_relationship_by_name',
        source_name: 'Brother Anselm',
        target_name: 'Stillwater Monastery',
        relationship: 'keeper_of',
        description: 'Anselm serves as the Keeper of the Order at Stillwater.',
        rationale: 'Prose explicitly states this; structured stage missed it.',
      }),
    ).toThrow()
  })

  it('rejects an unknown access_level tier', () => {
    expect(() =>
      CoherencePatchSchema.parse({
        kind: 'add_relationship_by_name',
        source_name: 'Brother Anselm',
        target_name: 'Stillwater Monastery',
        relationship: 'keeper_of',
        description: 'Anselm serves as the Keeper of the Order at Stillwater.',
        access_level: 'public',
        rationale: 'Prose explicitly states this; structured stage missed it.',
      }),
    ).toThrow()
  })

  it('rejects short description', () => {
    expect(() =>
      CoherencePatchSchema.parse({
        kind: 'add_relationship_by_name',
        source_name: 'A',
        target_name: 'B',
        relationship: 'allied_with',
        description: 'short',
        access_level: 'known',
        rationale: 'Reasonable length but description fails the floor.',
      }),
    ).toThrow()
  })
})

describe('add_fact_by_name', () => {
  it('accepts a valid patch with each access_level', () => {
    for (const access_level of ['known', 'discoverable', 'secret'] as const) {
      expect(() =>
        CoherencePatchSchema.parse({
          kind: 'add_fact_by_name',
          entity_name: 'Brother Anselm',
          topic: 'duties',
          content: 'Walks the cloister every dawn to inspect the offering candles.',
          access_level,
          rationale: `Prose strongly implies this; not yet structured. Tier ${access_level}.`,
        }),
      ).not.toThrow()
    }
  })

  it('rejects unknown access_level', () => {
    expect(() =>
      CoherencePatchSchema.parse({
        kind: 'add_fact_by_name',
        entity_name: 'A',
        topic: 'x',
        content: 'short but legal length',
        access_level: 'public',
        rationale: 'Reasonable length here for the test.',
      }),
    ).toThrow()
  })
})

describe('delete_fact_by_name', () => {
  it('accepts a valid patch with a 60+ char rationale', () => {
    expect(() =>
      CoherencePatchSchema.parse({
        kind: 'delete_fact_by_name',
        entity_name: 'Brother Anselm',
        fact_topic: 'pet_dog',
        rationale: 'The fact says Anselm keeps a dog, but the prose explicitly says the monastery forbids animals; delete since no fix preserves the fact.',
      }),
    ).not.toThrow()
  })

  it('rejects rationale shorter than 60 chars (irreversible delete floor)', () => {
    expect(() =>
      CoherencePatchSchema.parse({
        kind: 'delete_fact_by_name',
        entity_name: 'X',
        fact_topic: 'y',
        rationale: 'too short for delete',
      }),
    ).toThrow()
  })
})
