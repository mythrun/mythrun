import { describe, it, expect } from 'vitest'
import { ReconcilePlanSchema } from '../session-reconcile.js'

const validMintEntity = {
  op: 'mint' as const,
  subjectName: 'the cloaked stranger',
  canonEntityId: null,
  name: 'Veyra',
  entityType: 'npc' as const,
  accessLevel: 'known' as const,
}

const validMatchEntity = {
  op: 'match' as const,
  subjectName: 'the old tavern',
  canonEntityId: '018f2c1a-7b3e-7c4d-8e5f-1a2b3c4d5e6f',
  name: 'The Rusty Anchor',
  entityType: 'location' as const,
  accessLevel: 'known' as const,
}

const validFact = {
  subjectName: 'Veyra',
  topic: 'allegiance',
  content: 'Veyra claims she serves the Ashen Court.',
  accessLevel: 'discoverable' as const,
  claimedBy: 'Veyra',
  supersedesFactId: '018f2c1a-7b3e-7c4d-8e5f-aaaaaaaaaaaa',
}

const validRelationship = {
  fromSubjectName: 'Veyra',
  toSubjectName: 'The Rusty Anchor',
  relationshipType: 'frequents',
  description: 'Veyra is often seen at the tavern after dark.',
}

describe('ReconcilePlanSchema', () => {
  it('accepts a full valid plan', () => {
    const r = ReconcilePlanSchema.safeParse({
      entities: [validMintEntity, validMatchEntity],
      facts: [validFact],
      relationships: [validRelationship],
    })
    expect(r.success).toBe(true)
  })

  it('accepts fully-empty arrays', () => {
    expect(
      ReconcilePlanSchema.safeParse({ entities: [], facts: [], relationships: [] }).success,
    ).toBe(true)
  })

  it('rejects an entity with an entityType not in the enum', () => {
    expect(
      ReconcilePlanSchema.safeParse({
        entities: [{ ...validMintEntity, entityType: 'monster' }],
        facts: [],
        relationships: [],
      }).success,
    ).toBe(false)
  })

  it('rejects a fact object missing topic', () => {
    const { topic: _topic, ...factWithoutTopic } = validFact
    expect(
      ReconcilePlanSchema.safeParse({
        entities: [],
        facts: [factWithoutTopic],
        relationships: [],
      }).success,
    ).toBe(false)
  })

  it('rejects an entity op not in the enum', () => {
    expect(
      ReconcilePlanSchema.safeParse({
        entities: [{ ...validMintEntity, op: 'delete' }],
        facts: [],
        relationships: [],
      }).success,
    ).toBe(false)
  })

  it('strips a stray extra key on a fact', () => {
    const parsed = ReconcilePlanSchema.parse({
      entities: [],
      facts: [{ ...validFact, bogus: 'x' }],
      relationships: [],
    })
    const fact = parsed.facts.at(0)
    expect(fact).toBeDefined()
    expect(fact && 'bogus' in fact).toBe(false)
  })

  it('does not reject a fact with a 2000-char content (no .max)', () => {
    const longContent = 'a'.repeat(2000)
    const r = ReconcilePlanSchema.safeParse({
      entities: [],
      facts: [{ ...validFact, content: longContent }],
      relationships: [],
    })
    expect(r.success).toBe(true)
  })
})
