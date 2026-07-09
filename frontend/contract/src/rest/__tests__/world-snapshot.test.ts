import { describe, it, expect } from 'vitest'
import {
  WorldSnapshotSchema,
  WorldSnapshotIntroductionSchema,
} from '../world-snapshot.js'

// The world-snapshot REST projection is a FOCUSED superset-tolerant schema: the
// backend view emits a richer payload (world summary, prose kernels, stat
// blocks, relationships) that `z.object()` strips. myth-zaqxh adds the
// introduction page to the wire shape — OPTIONAL so pre-existing bare-snapshot
// fixtures keep validating even though a real 200 always carries it.

const baseSnapshot = {
  entities: [{ id: 'e1', entityType: 'faction', name: 'The Ashen Court' }],
  facts: [{ id: 'f1', entityId: 'e1', topic: 'rule', content: 'They tax the roads.' }],
  entityHierarchy: [],
}

describe('WorldSnapshotSchema — introduction (myth-zaqxh)', () => {
  it('carries a well-formed introduction (title + prose + resolved references)', () => {
    const parsed = WorldSnapshotSchema.parse({
      ...baseSnapshot,
      introduction: {
        title: 'Ashfall',
        prose: 'Ashfall is a city the Ashen Court taxes at every gate.',
        references: [{ entityId: 'e1', name: 'The Ashen Court' }],
      },
    })
    expect(parsed.introduction?.title).toBe('Ashfall')
    expect(parsed.introduction?.references).toEqual([{ entityId: 'e1', name: 'The Ashen Court' }])
  })

  it('is optional — a bare snapshot (no introduction) still validates', () => {
    const parsed = WorldSnapshotSchema.parse(baseSnapshot)
    expect(parsed.introduction).toBeUndefined()
  })

  it('strips the backend payload’s unmodeled keys (focused projection)', () => {
    const parsed = WorldSnapshotSchema.parse({
      ...baseSnapshot,
      world: { name: 'Ashfall', concept: 'secret plot seed' },
      relationships: [{ sourceEntityId: 'e1', targetEntityId: 'e2' }],
      introduction: { title: 'Ashfall', prose: 'x'.repeat(40), references: [] },
    })
    expect('world' in parsed).toBe(false)
    expect('relationships' in parsed).toBe(false)
  })

  it('rejects a reference missing its entityId (the resolved-id contract)', () => {
    const bad = WorldSnapshotIntroductionSchema.safeParse({
      title: 'Ashfall',
      prose: 'x',
      references: [{ name: 'The Ashen Court' }],
    })
    expect(bad.success).toBe(false)
  })
})
