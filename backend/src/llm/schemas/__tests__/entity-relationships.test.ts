// backend/src/llm/schemas/__tests__/entity-relationships.test.ts
import { describe, it, expect } from 'vitest'
import {
  EntityRelationshipsSchema,
  relationshipItemSchema,
  declarationItemSchema,
} from '../entity-relationships.js'

describe('entity-relationships schema (name-based)', () => {
  it('accepts a relationship with from_name + to_name + free-text relationship + access_level', () => {
    const r = relationshipItemSchema.safeParse({
      from_name: 'Mother Ehren',
      to_name: 'The Drowned Quarter',
      relationship: 'leads',
      description: 'Mother Ehren leads the Quarter through council.',
      access_level: 'secret',
    })
    expect(r.success).toBe(true)
  })

  it('rejects a relationship missing from_name', () => {
    const r = relationshipItemSchema.safeParse({
      to_name: 'X', relationship: 'leads', description: 'short description here',
      access_level: 'known',
    })
    expect(r.success).toBe(false)
  })

  it('rejects a relationship missing access_level', () => {
    const r = relationshipItemSchema.safeParse({
      from_name: 'Mother Ehren',
      to_name: 'The Drowned Quarter',
      relationship: 'leads',
      description: 'Mother Ehren leads the Quarter through council.',
    })
    expect(r.success).toBe(false)
  })

  it('rejects an invalid access_level tier', () => {
    const r = relationshipItemSchema.safeParse({
      from_name: 'Mother Ehren',
      to_name: 'The Drowned Quarter',
      relationship: 'leads',
      description: 'Mother Ehren leads the Quarter through council.',
      access_level: 'public',
    })
    expect(r.success).toBe(false)
  })

  it('declarationItemSchema drops placeholder_id', () => {
    const r = declarationItemSchema.safeParse({
      name: 'The Whisper Council', entity_type: 'faction',
    })
    expect(r.success).toBe(true)
  })

  it('full tree validates with name-based shape', () => {
    const r = EntityRelationshipsSchema.safeParse({
      new_entity_declarations: [],
      relationships: Array.from({ length: 5 }, (_, i) => ({
        from_name: `A${String(i)}`, to_name: `B${String(i)}`,
        relationship: 'allied_with', description: 'plausible 10-plus char description',
        access_level: 'known' as const,
      })),
      hierarchy_stragglers: [],
    })
    expect(r.success).toBe(true)
  })
})
