// backend/src/llm/prep/__tests__/name-resolution.test.ts
import { describe, it, expect } from 'vitest'
import { normalizeName } from '../name-resolution.js'
import { buildResolutionContext } from '../name-resolution.js'
import { resolveRelationship } from '../name-resolution.js'
import type { WorldInventory } from '../world-dump.js'

describe('normalizeName', () => {
  it('trims leading and trailing whitespace', () => {
    expect(normalizeName('  Mother Ehren  ')).toBe('Mother Ehren')
  })

  it('collapses internal whitespace runs to a single space', () => {
    expect(normalizeName('Mother  Ehren\t\tSalt-Tongue')).toBe('Mother Ehren Salt-Tongue')
  })

  it('applies Unicode NFC normalization', () => {
    // 'é' as NFD (e + combining acute U+0301) vs NFC (single code point U+00E9).
    // Use \u escapes so the on-disk bytes stay distinct even if a future tool
    // (editor save action, prettier upgrade, copy-paste) NFC-normalizes the
    // source file — otherwise the two literals would silently collapse to the
    // same bytes and the inequality precondition would pass for the wrong reason.
    const nfd = 'Mar\u0065\u0301n'
    const nfc = 'Mar\u00e9n'
    expect(nfd).not.toBe(nfc)
    expect(normalizeName(nfd)).toBe(nfc)
  })

  it('preserves case (case-sensitive contract)', () => {
    expect(normalizeName('The Drowned Quarter')).toBe('The Drowned Quarter')
    expect(normalizeName('the drowned quarter')).toBe('the drowned quarter')
    expect(normalizeName('The Drowned Quarter')).not.toBe(normalizeName('the drowned quarter'))
  })

  it('is idempotent', () => {
    const input = '  Mother   Ehren  '
    const once = normalizeName(input)
    expect(normalizeName(once)).toBe(once)
  })
})

function makeInv(): WorldInventory {
  return {
    entitiesById: new Map([
      ['ent-1', { id: 'ent-1', name: 'Mother Ehren', entityType: 'npc', accessLevel: 'known' }],
      ['ent-2', { id: 'ent-2', name: '  The Drowned Quarter  ', entityType: 'location', accessLevel: 'known' }],
      ['ent-dup-a', { id: 'ent-dup-a', name: 'Pell', entityType: 'npc', accessLevel: 'known' }],
      ['ent-dup-b', { id: 'ent-dup-b', name: 'Pell', entityType: 'npc', accessLevel: 'known' }],
    ]),
    proseByEntityId: new Map(),
    factsById: new Map([
      ['fact-1', { id: 'fact-1', entityId: 'ent-1', topic: 'role', content: 'Elder.', accessLevel: 'known' }],
      ['fact-2', { id: 'fact-2', entityId: 'ent-1', topic: 'history', content: 'Was once...', accessLevel: 'known' }],
      ['fact-3', { id: 'fact-3', entityId: 'ent-1', topic: 'history', content: 'Also history.', accessLevel: 'known' }],
    ]),
    relationshipsById: new Map([
      ['rel-1', { id: 'rel-1', sourceEntityId: 'ent-1', targetEntityId: 'ent-2', relationshipType: 'leads', description: 'd' }],
    ]),
  }
}

describe('buildResolutionContext', () => {
  it('maps normalized entity names to ids', () => {
    const ctx = buildResolutionContext(makeInv())
    expect(ctx.entityIdByName.get('Mother Ehren')).toBe('ent-1')
    // Whitespace normalized at build time.
    expect(ctx.entityIdByName.get('The Drowned Quarter')).toBe('ent-2')
  })

  it('records duplicate-name entities so the resolver can detect ambiguity', () => {
    const ctx = buildResolutionContext(makeInv())
    expect(ctx.ambiguousEntityNames.has('Pell')).toBe(true)
  })

  it('maps (entity name, fact topic) to fact ids; duplicate topics flagged ambiguous', () => {
    const ctx = buildResolutionContext(makeInv())
    expect(ctx.factIdByPair.get('Mother Ehren')?.get('role')).toEqual(['fact-1'])
    expect(ctx.factIdByPair.get('Mother Ehren')?.get('history')).toEqual(['fact-2', 'fact-3'])
  })

  it('maps (source, target, type) triples to relationship ids', () => {
    const ctx = buildResolutionContext(makeInv())
    expect(
      ctx.relIdByTriple.get('Mother Ehren')?.get('The Drowned Quarter')?.get('leads'),
    ).toEqual(['rel-1'])
  })
})

const decls = new Map<string, { synthId: string; entityType: string }>([
  ['The Whisper Council', { synthId: 'new-001', entityType: 'faction' }],
])

describe('resolveRelationship', () => {
  it('resolves both endpoints when both names are in inventory', () => {
    const ctx = buildResolutionContext(makeInv())
    const r = resolveRelationship(ctx, {
      from_name: 'Mother Ehren', to_name: 'The Drowned Quarter',
      relationship: 'leads', description: 'd',
    }, decls)
    expect(r.kind).toBe('resolved')
    if (r.kind === 'resolved') {
      expect(r.sourceEntityId).toBe('ent-1')
      expect(r.targetEntityId).toBe('ent-2')
      expect(r.relationshipType).toBe('leads')
    }
  })

  it('returns phantom_target when source is real and target is a declaration', () => {
    const ctx = buildResolutionContext(makeInv())
    const r = resolveRelationship(ctx, {
      from_name: 'Mother Ehren', to_name: 'The Whisper Council',
      relationship: 'pursues', description: 'd',
    }, decls)
    expect(r.kind).toBe('phantom_target')
  })

  it('drops with unknown_source when source name is not in inventory or declarations', () => {
    const ctx = buildResolutionContext(makeInv())
    const r = resolveRelationship(ctx, {
      from_name: 'Nobody', to_name: 'The Drowned Quarter',
      relationship: 'leads', description: 'd',
    }, decls)
    expect(r.kind).toBe('dropped')
    if (r.kind === 'dropped') expect(r.reason).toBe('unknown_source')
  })

  it('drops with ambiguous_source when source name has multiple inventory matches', () => {
    const ctx = buildResolutionContext(makeInv())
    const r = resolveRelationship(ctx, {
      from_name: 'Pell', to_name: 'The Drowned Quarter',
      relationship: 'leads', description: 'd',
    }, decls)
    expect(r.kind).toBe('dropped')
    if (r.kind === 'dropped') expect(r.reason).toBe('ambiguous_source')
  })

  it('normalizes whitespace before lookup', () => {
    const ctx = buildResolutionContext(makeInv())
    const r = resolveRelationship(ctx, {
      from_name: '  Mother  Ehren  ', to_name: 'The Drowned Quarter',
      relationship: 'leads', description: 'd',
    }, decls)
    expect(r.kind).toBe('resolved')
  })
})

import {
  resolveFact,
  resolveProseTarget,
  resolveRename,
  resolveDeleteRelationship,
  resolveFixRelationship,
} from '../name-resolution.js'

describe('resolveFact', () => {
  it('resolves a unique (entity, topic) pair to a fact id', () => {
    const ctx = buildResolutionContext(makeInv())
    const r = resolveFact(ctx, { entity_name: 'Mother Ehren', fact_topic: 'role' })
    expect(r.kind).toBe('resolved')
    if (r.kind === 'resolved') expect(r.factId).toBe('fact-1')
  })

  it('drops on ambiguous (multiple facts under same topic)', () => {
    const ctx = buildResolutionContext(makeInv())
    const r = resolveFact(ctx, { entity_name: 'Mother Ehren', fact_topic: 'history' })
    expect(r.kind).toBe('dropped')
    if (r.kind === 'dropped') expect(r.reason).toBe('ambiguous_fact')
  })

  it('drops on unknown entity name', () => {
    const ctx = buildResolutionContext(makeInv())
    const r = resolveFact(ctx, { entity_name: 'Nobody', fact_topic: 'role' })
    expect(r.kind).toBe('dropped')
    if (r.kind === 'dropped') expect(r.reason).toBe('unknown_entity')
  })

  it('drops on unknown topic', () => {
    const ctx = buildResolutionContext(makeInv())
    const r = resolveFact(ctx, { entity_name: 'Mother Ehren', fact_topic: 'nonexistent' })
    expect(r.kind).toBe('dropped')
    if (r.kind === 'dropped') expect(r.reason).toBe('unknown_fact')
  })
})

describe('resolveProseTarget', () => {
  it('resolves an entity by name', () => {
    const ctx = buildResolutionContext(makeInv())
    const r = resolveProseTarget(ctx, { entity_name: 'Mother Ehren' })
    expect(r.kind).toBe('resolved')
    if (r.kind === 'resolved') expect(r.entityId).toBe('ent-1')
  })

  it('drops on ambiguous entity name', () => {
    const ctx = buildResolutionContext(makeInv())
    const r = resolveProseTarget(ctx, { entity_name: 'Pell' })
    expect(r.kind).toBe('dropped')
    if (r.kind === 'dropped') expect(r.reason).toBe('ambiguous_entity')
  })
})

describe('resolveRename', () => {
  it('resolves old_name to entityId', () => {
    const ctx = buildResolutionContext(makeInv())
    const r = resolveRename(ctx, { old_name: 'Mother Ehren', new_name: 'Mother E' })
    expect(r.kind).toBe('resolved')
    if (r.kind === 'resolved') {
      expect(r.entityId).toBe('ent-1')
      expect(r.newName).toBe('Mother E')
    }
  })
})

describe('resolveFixRelationship / resolveDeleteRelationship', () => {
  it('resolves a unique (source, target, type) triple to a relationship id', () => {
    const ctx = buildResolutionContext(makeInv())
    const r = resolveFixRelationship(ctx, {
      source_name: 'Mother Ehren', target_name: 'The Drowned Quarter', current_type: 'leads',
    })
    expect(r.kind).toBe('resolved')
    if (r.kind === 'resolved') expect(r.relationshipId).toBe('rel-1')
  })

  it('drops when triple matches nothing', () => {
    const ctx = buildResolutionContext(makeInv())
    const r = resolveDeleteRelationship(ctx, {
      source_name: 'Mother Ehren', target_name: 'The Drowned Quarter', current_type: 'rivals',
    })
    expect(r.kind).toBe('dropped')
    if (r.kind === 'dropped') expect(r.reason).toBe('unknown_relationship')
  })
})
