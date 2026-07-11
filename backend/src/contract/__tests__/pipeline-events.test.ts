import { describe, it, expect } from 'vitest'
import type { PipelineEvent, PipelinePhase } from '../pipeline-events.js'

describe('PipelineEvent contract — myth-exac narrow shapes', () => {
  it('entity-added carries name (not data)', () => {
    const ev: PipelineEvent = {
      type: 'entity-added',
      synthKey: 's',
      entityKind: 'location',
      name: 'X',
    }
    expect(ev).toMatchObject({ name: 'X' })
    // Type-level assertion: no `data` field allowed.
    const bad: PipelineEvent = {
      type: 'entity-added',
      synthKey: 's',
      entityKind: 'location',
      // @ts-expect-error — data is removed from the contract
      data: {},
    }
    void bad
  })

  it('edge-added carries no description', () => {
    const ev: PipelineEvent = {
      type: 'edge-added',
      synthKey: 's',
      from: 'a',
      to: 'b',
      relationship: 'r',
    }
    expect(ev.relationship).toBe('r')
    const bad: PipelineEvent = {
      type: 'edge-added',
      synthKey: 's',
      from: 'a',
      to: 'b',
      relationship: 'r',
      // @ts-expect-error — description is removed from the contract
      description: 'd',
    }
    void bad
  })

  it('character_creation_complete carries userId (MYT-90 A8)', () => {
    const ev: PipelineEvent = {
      type: 'character_creation_complete',
      userId: 'user-123',
    }
    expect(ev).toMatchObject({ type: 'character_creation_complete', userId: 'user-123' })
    // Type-level assertion: userId is REQUIRED — the FE loading beat filters
    // completion by the current user, so an event without it is meaningless.
    // (A missing-property error attaches to the assignment, so the directive
    // sits before the statement, not on the property line.)
    // @ts-expect-error — userId is required on character_creation_complete
    const bad: PipelineEvent = { type: 'character_creation_complete' }
    void bad
  })

  it('PipelinePhase includes world_snapshot_ready', () => {
    const phase: PipelinePhase = 'world_snapshot_ready'
    expect(phase).toBe('world_snapshot_ready')
  })
})
