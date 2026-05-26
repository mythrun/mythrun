// backend/src/llm/prep/__tests__/name-resolution.test.ts
import { describe, it, expect } from 'vitest'
import { normalizeName } from '../name-resolution.js'
import { buildResolutionContext } from '../name-resolution.js'
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
