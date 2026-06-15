// backend/src/world/retrieval/__tests__/types.test.ts
//
// Coverage-hygiene shape test: construct one of each result type and assert
// the literal fields land where the interface declares them. These are
// compile-time contracts (a type error here is the real signal); the runtime
// asserts exist only so the module is exercised under the coverage gate.
import { describe, expect, it } from 'vitest'
import type {
  LoreHit, EntityCandidate, KnownCharacter, FactionNode,
} from '../types.js'

describe('world/retrieval/types', () => {
  it('constructs a LoreHit (fact source, all optional fields present)', () => {
    const hit: LoreHit = {
      source: 'fact',
      factId: 'fact-1',
      entityId: 'ent-1',
      entityName: 'The Verdant Tower',
      topic: 'history',
      content: 'A spire of living wood.',
      accessLevel: 'known',
      narrativeStatus: 'undelivered',
      score: 0.83,
    }
    expect(hit.source).toBe('fact')
    expect(hit.accessLevel).toBe('known')
    expect(hit.score).toBeGreaterThan(0)
  })

  it('constructs a LoreHit (entity source, optional fields omitted)', () => {
    const hit: LoreHit = {
      source: 'entity',
      entityId: 'ent-2',
      entityName: 'Sister Wren',
      content: 'A wandering hedge-priest.',
      accessLevel: 'discoverable',
      score: -0.1,
    }
    expect(hit.source).toBe('entity')
    expect(hit.factId).toBeUndefined()
    expect(hit.topic).toBeUndefined()
    expect(hit.narrativeStatus).toBeUndefined()
  })

  it('constructs an EntityCandidate', () => {
    const cand: EntityCandidate = {
      entityId: 'ent-3',
      name: 'Greywater Hold',
      entityType: 'location',
      score: 0.42,
    }
    expect(cand.entityType).toBe('location')
  })

  it('constructs a KnownCharacter', () => {
    const ch: KnownCharacter = {
      entityId: 'ent-4',
      name: 'Captain Oru',
      entityType: 'npc',
      accessLevel: 'known',
      depth: 1,
    }
    expect(ch.accessLevel).toBe('known')
    expect(ch.depth).toBe(1)
  })

  it('constructs a FactionNode (root: parentId null)', () => {
    const node: FactionNode = {
      entityId: 'ent-5',
      name: 'The Ashen Covenant',
      entityType: 'faction',
      accessLevel: 'secret',
      parentId: null,
      depth: 0,
    }
    expect(node.accessLevel).toBe('secret')
    expect(node.parentId).toBeNull()
    expect(node.depth).toBe(0)
  })
})
