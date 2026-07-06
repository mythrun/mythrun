import { describe, it, expect } from 'vitest'
import { WORLD_GEN_STAGES } from '../worldgen-stages.js'
import { WORLD_GEN_STAGES as WORLD_GEN_STAGES_VIA_BARREL } from '../index.js'

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
