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

  it('PipelinePhase includes world_snapshot_ready', () => {
    const phase: PipelinePhase = 'world_snapshot_ready'
    expect(phase).toBe('world_snapshot_ready')
  })
})
