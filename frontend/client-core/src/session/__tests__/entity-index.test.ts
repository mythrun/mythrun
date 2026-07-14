import { describe, it, expect } from 'vitest'
import type { WorldGenSnapshot } from '../../api/campaigns.ts'
import { buildEntityIndex } from '../entity-index.ts'

// The matcher is pure + DOM-free: build a snapshot fixture, assert the emitted
// prose segments / cards. Enforced ignorance is server-side — these fixtures
// stand in for the already-known-tier-filtered `getWorldSnapshot` projection.

type Entity = WorldGenSnapshot['entities'][number]
type Fact = WorldGenSnapshot['facts'][number]

function snap(parts: { entities?: Entity[]; facts?: Fact[] }): WorldGenSnapshot {
  return {
    entities: parts.entities ?? [],
    facts: parts.facts ?? [],
    entityHierarchy: [],
    relationships: [],
  }
}

describe('buildEntityIndex — segment', () => {
  it('splits prose into text/entity runs with the right ids + glyphs', () => {
    const index = buildEntityIndex(
      snap({
        entities: [
          { id: 'e1', entityType: 'npc', name: 'Elenya' },
          { id: 'l1', entityType: 'location', name: 'Highreach' },
          { id: 'f1', entityType: 'faction', name: 'The Ashen Hand' },
        ],
      }),
    )
    expect(index.segment('Elenya walked to Highreach.')).toEqual([
      { kind: 'entity', text: 'Elenya', entityId: 'e1', glyph: 'npc' },
      { kind: 'text', text: ' walked to ' },
      { kind: 'entity', text: 'Highreach', entityId: 'l1', glyph: 'location' },
      { kind: 'text', text: '.' },
    ])
    expect(index.segment('The Ashen Hand rises.')).toEqual([
      { kind: 'entity', text: 'The Ashen Hand', entityId: 'f1', glyph: 'faction' },
      { kind: 'text', text: ' rises.' },
    ])
  })

  it('longest-match wins when a shorter name is a prefix of a longer one', () => {
    const index = buildEntityIndex(
      snap({
        entities: [
          { id: 'g1', entityType: 'npc', name: 'Gorm the Bloody' },
          { id: 'g2', entityType: 'npc', name: 'Gorm' },
        ],
      }),
    )
    expect(index.segment('Gorm the Bloody nods')).toEqual([
      { kind: 'entity', text: 'Gorm the Bloody', entityId: 'g1', glyph: 'npc' },
      { kind: 'text', text: ' nods' },
    ])
    // the shorter name still matches where the longer one cannot
    expect(index.segment('Gorm frowns')).toEqual([
      { kind: 'entity', text: 'Gorm', entityId: 'g2', glyph: 'npc' },
      { kind: 'text', text: ' frowns' },
    ])
  })

  it('does not match inside a longer word (word-boundary guard)', () => {
    const index = buildEntityIndex(snap({ entities: [{ id: 'l1', entityType: 'location', name: 'Highreach' }] }))
    expect(index.segment('The Highreacher guild.')).toEqual([{ kind: 'text', text: 'The Highreacher guild.' }])
  })

  it('matches case-insensitively but preserves the original casing in the segment text', () => {
    const index = buildEntityIndex(snap({ entities: [{ id: 'e1', entityType: 'npc', name: 'Elenya' }] }))
    expect(index.segment('ELENYA and elenya greet Elenya.')).toEqual([
      { kind: 'entity', text: 'ELENYA', entityId: 'e1', glyph: 'npc' },
      { kind: 'text', text: ' and ' },
      { kind: 'entity', text: 'elenya', entityId: 'e1', glyph: 'npc' },
      { kind: 'text', text: ' greet ' },
      { kind: 'entity', text: 'Elenya', entityId: 'e1', glyph: 'npc' },
      { kind: 'text', text: '.' },
    ])
  })

  it('does not highlight item or pc entities', () => {
    const index = buildEntityIndex(
      snap({
        entities: [
          { id: 'i1', entityType: 'item', name: 'Sunblade' },
          { id: 'p1', entityType: 'pc', name: 'Aria' },
          { id: 'e1', entityType: 'npc', name: 'Elenya' },
        ],
      }),
    )
    expect(index.segment('Aria draws the Sunblade near Elenya.')).toEqual([
      { kind: 'text', text: 'Aria draws the Sunblade near ' },
      { kind: 'entity', text: 'Elenya', entityId: 'e1', glyph: 'npc' },
      { kind: 'text', text: '.' },
    ])
    expect(index.card('i1')).toBeNull()
    expect(index.card('p1')).toBeNull()
  })

  it('matches names carrying non-ASCII boundary letters (Unicode-aware boundary)', () => {
    // Plain ASCII \b would silently drop these (a leading/trailing accented
    // letter is not an ASCII word char) — the matcher uses Unicode-aware guards.
    const index = buildEntityIndex(
      snap({
        entities: [
          { id: 'e1', entityType: 'npc', name: 'Éowyn' },
          { id: 'e2', entityType: 'npc', name: 'André' },
        ],
      }),
    )
    expect(index.segment('Éowyn met André today.')).toEqual([
      { kind: 'entity', text: 'Éowyn', entityId: 'e1', glyph: 'npc' },
      { kind: 'text', text: ' met ' },
      { kind: 'entity', text: 'André', entityId: 'e2', glyph: 'npc' },
      { kind: 'text', text: ' today.' },
    ])
  })

  it('treats regex metacharacters in names as literals (escaping)', () => {
    const index = buildEntityIndex(
      snap({ entities: [{ id: 'l1', entityType: 'location', name: 'The Vault (Sealed)' }] }),
    )
    expect(index.segment('They breached The Vault (Sealed) at dawn.')).toEqual([
      { kind: 'text', text: 'They breached ' },
      { kind: 'entity', text: 'The Vault (Sealed)', entityId: 'l1', glyph: 'location' },
      { kind: 'text', text: ' at dawn.' },
    ])
    // the parens are NOT an optional/group operator: the paren-less form must not match
    expect(index.segment('The Vault Sealed today')).toEqual([{ kind: 'text', text: 'The Vault Sealed today' }])
  })

  it('resolves duplicate names to the first by (name, id) stable order', () => {
    const index = buildEntityIndex(
      snap({
        entities: [
          { id: 'm2', entityType: 'location', name: 'Mira' },
          { id: 'm1', entityType: 'npc', name: 'Mira' },
          { id: 'g1', entityType: 'npc', name: 'Gorm' },
        ],
      }),
    )
    // 'Mira'(m1) sorts before 'Mira'(m2) by id → m1 (npc) is the winner.
    // 'Mira' and 'Gorm' are equal length → exercises the longest-first tiebreak.
    expect(index.segment('Mira greets Gorm')).toEqual([
      { kind: 'entity', text: 'Mira', entityId: 'm1', glyph: 'npc' },
      { kind: 'text', text: ' greets ' },
      { kind: 'entity', text: 'Gorm', entityId: 'g1', glyph: 'npc' },
    ])
  })

  it('leaves a case-fold-divergent match as plain text (never a broken entity)', () => {
    // Greek final sigma ς vs capital Σ: /ς/iu matches "Σ", but "Σ".toLowerCase()
    // is "σ" (≠ the stored key "ς"), so resolution misses and the char degrades
    // gracefully to plain text rather than emitting an unresolved entity.
    const index = buildEntityIndex(snap({ entities: [{ id: 's1', entityType: 'npc', name: 'ς' }] }))
    expect(index.segment('The Σ appears.')).toEqual([{ kind: 'text', text: 'The Σ appears.' }])
  })

  it('emits an entity segment with no surrounding text when the whole string is a name', () => {
    const index = buildEntityIndex(snap({ entities: [{ id: 'e1', entityType: 'npc', name: 'Elenya' }] }))
    expect(index.segment('Elenya')).toEqual([{ kind: 'entity', text: 'Elenya', entityId: 'e1', glyph: 'npc' }])
  })

  it('emits no trailing text when a name ends the string', () => {
    const index = buildEntityIndex(snap({ entities: [{ id: 'e1', entityType: 'npc', name: 'Elenya' }] }))
    expect(index.segment('Meet Elenya')).toEqual([
      { kind: 'text', text: 'Meet ' },
      { kind: 'entity', text: 'Elenya', entityId: 'e1', glyph: 'npc' },
    ])
  })

  it('returns a single text segment for the empty string (populated index)', () => {
    const index = buildEntityIndex(snap({ entities: [{ id: 'e1', entityType: 'npc', name: 'Elenya' }] }))
    expect(index.segment('')).toEqual([{ kind: 'text', text: '' }])
  })

  it('returns one text segment for any input when there are no highlightable names', () => {
    const index = buildEntityIndex(snap({ entities: [{ id: 'i1', entityType: 'item', name: 'Sunblade' }] }))
    expect(index.segment('Sunblade gleams.')).toEqual([{ kind: 'text', text: 'Sunblade gleams.' }])
    expect(index.segment('')).toEqual([{ kind: 'text', text: '' }])
    expect(index.card('i1')).toBeNull()
  })
})

describe('buildEntityIndex — card', () => {
  it('returns name + glyph + the first known fact as the lead line', () => {
    const index = buildEntityIndex(
      snap({
        entities: [
          { id: 'e1', entityType: 'npc', name: 'Elenya' },
          { id: 'l1', entityType: 'location', name: 'Highreach' },
        ],
        facts: [
          // inserted out of id order to exercise the id-ordered lead-line pick
          { id: 'f2', entityId: 'e1', topic: 'role', content: 'A ranger of the north.' },
          { id: 'f1', entityId: 'e1', topic: 'name', content: 'Elenya Dawnrunner.' },
          { id: 'f3', entityId: 'e1', topic: 'note', content: 'Wary of strangers.' },
        ],
      }),
    )
    expect(index.card('e1')).toEqual({
      entityId: 'e1',
      name: 'Elenya',
      glyph: 'npc',
      leadLine: 'Elenya Dawnrunner.', // the lowest-id fact (f1)
    })
  })

  it('returns an empty lead line for an entity with no facts', () => {
    const index = buildEntityIndex(snap({ entities: [{ id: 'l1', entityType: 'location', name: 'Highreach' }] }))
    expect(index.card('l1')).toEqual({ entityId: 'l1', name: 'Highreach', glyph: 'location', leadLine: '' })
  })

  it('returns null for an unknown id', () => {
    const index = buildEntityIndex(snap({ entities: [{ id: 'e1', entityType: 'npc', name: 'Elenya' }] }))
    expect(index.card('missing')).toBeNull()
  })
})
