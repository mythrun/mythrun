import { describe, it, expect } from 'vitest'
import {
  ENTITY_STAGES,
  PREP_STAGES,
  REVEAL_BOUNDARY_STAGE,
  TAIL_STAGES,
  WATCHED_ENTITY_STAGES,
  WATCHED_STAGES,
  WORLD_GEN_STAGES,
} from '../worldgen-stages.js'
import {
  ENTITY_STAGES as ENTITY_STAGES_VIA_BARREL,
  PREP_STAGES as PREP_STAGES_VIA_BARREL,
  REVEAL_BOUNDARY_STAGE as REVEAL_BOUNDARY_STAGE_VIA_BARREL,
  TAIL_STAGES as TAIL_STAGES_VIA_BARREL,
  WATCHED_ENTITY_STAGES as WATCHED_ENTITY_STAGES_VIA_BARREL,
  WATCHED_STAGES as WATCHED_STAGES_VIA_BARREL,
  WORLD_GEN_STAGES as WORLD_GEN_STAGES_VIA_BARREL,
} from '../index.js'

describe('WORLD_GEN_STAGES canonical taxonomy', () => {
  it('lists the 11 world-gen stages in the real pipeline order', () => {
    // The authority is the worker's stage loop
    // (backend/src/llm/prep/world-gen-processor.ts). Any reorder here MUST
    // mirror a reorder there — this list is the single source both consumers
    // (the processor + sse/derive-phase) import.
    expect([...WORLD_GEN_STAGES]).toEqual([
      'concept_intake',
      'world_color',
      'vocabulary_intake',
      'world_and_factions',
      'locations_and_npcs',
      'entity_relationships',
      'entity_consolidation',
      'starting_situation',
      'random_tables',
      'coherence_pass',
      'embed_world',
    ])
  })

  it('includes entity_consolidation (the stage the drifted 10-copy omitted)', () => {
    expect(WORLD_GEN_STAGES).toContain('entity_consolidation')
    expect(WORLD_GEN_STAGES).toHaveLength(11)
  })

  it('ends with embed_world immediately after coherence_pass', () => {
    const last = WORLD_GEN_STAGES[WORLD_GEN_STAGES.length - 1]
    const penultimate = WORLD_GEN_STAGES[WORLD_GEN_STAGES.length - 2]
    expect(last).toBe('embed_world')
    expect(penultimate).toBe('coherence_pass')
  })

  it('is re-exported from the events barrel', () => {
    expect(WORLD_GEN_STAGES_VIA_BARREL).toBe(WORLD_GEN_STAGES)
  })
})

describe('PREP_STAGES / ENTITY_STAGES split (MYT-89 two-act generating flow)', () => {
  it('splits at world_and_factions — the first stage that emits entity-added', () => {
    // The boundary authority is the backend stage handlers: world_and_factions
    // is the first stage wired through streaming-extractor.ts (which publishes
    // `entity-added`); the three stages before it emit no entity events.
    expect([...PREP_STAGES]).toEqual(['concept_intake', 'world_color', 'vocabulary_intake'])
    expect(ENTITY_STAGES[0]).toBe('world_and_factions')
  })

  it('the two slices reassemble the canonical taxonomy exactly (no drift)', () => {
    expect([...PREP_STAGES, ...ENTITY_STAGES]).toEqual([...WORLD_GEN_STAGES])
  })

  it('covers the 8 entity-generation stages of the graph act', () => {
    expect([...ENTITY_STAGES]).toEqual([
      'world_and_factions',
      'locations_and_npcs',
      'entity_relationships',
      'entity_consolidation',
      'starting_situation',
      'random_tables',
      'coherence_pass',
      'embed_world',
    ])
  })

  it('is re-exported from the events barrel', () => {
    expect(PREP_STAGES_VIA_BARREL).toBe(PREP_STAGES)
    expect(ENTITY_STAGES_VIA_BARREL).toBe(ENTITY_STAGES)
  })
})

describe('the WIKI-REVEAL boundary split (MYT-89 reveal timing)', () => {
  it('places the boundary at entity_relationships — connection-weaving ends the visible wait', () => {
    // The reveal moment fires the instant the connections are woven; everything
    // after entity_relationships runs SILENTLY behind the wiki reveal.
    expect(REVEAL_BOUNDARY_STAGE).toBe('entity_relationships')
    expect(WATCHED_STAGES[WATCHED_STAGES.length - 1]).toBe(REVEAL_BOUNDARY_STAGE)
    expect(TAIL_STAGES[0]).toBe('entity_consolidation')
  })

  it('WATCHED_STAGES is the visible wait: prep + the entity stages through the boundary', () => {
    expect([...WATCHED_STAGES]).toEqual([
      'concept_intake',
      'world_color',
      'vocabulary_intake',
      'world_and_factions',
      'locations_and_npcs',
      'entity_relationships',
    ])
  })

  it('WATCHED_ENTITY_STAGES is the status card slice — entity stages up to the boundary', () => {
    expect([...WATCHED_ENTITY_STAGES]).toEqual([
      'world_and_factions',
      'locations_and_npcs',
      'entity_relationships',
    ])
  })

  it('TAIL_STAGES is the silent stretch behind the reveal', () => {
    expect([...TAIL_STAGES]).toEqual([
      'entity_consolidation',
      'starting_situation',
      'random_tables',
      'coherence_pass',
      'embed_world',
    ])
  })

  it('the slices reassemble the canonical taxonomy exactly (no drift)', () => {
    expect([...WATCHED_STAGES, ...TAIL_STAGES]).toEqual([...WORLD_GEN_STAGES])
    expect([...PREP_STAGES, ...WATCHED_ENTITY_STAGES]).toEqual([...WATCHED_STAGES])
    expect([...WATCHED_ENTITY_STAGES, ...TAIL_STAGES]).toEqual([...ENTITY_STAGES])
  })

  it('is re-exported from the events barrel', () => {
    expect(REVEAL_BOUNDARY_STAGE_VIA_BARREL).toBe(REVEAL_BOUNDARY_STAGE)
    expect(WATCHED_STAGES_VIA_BARREL).toBe(WATCHED_STAGES)
    expect(WATCHED_ENTITY_STAGES_VIA_BARREL).toBe(WATCHED_ENTITY_STAGES)
    expect(TAIL_STAGES_VIA_BARREL).toBe(TAIL_STAGES)
  })
})
