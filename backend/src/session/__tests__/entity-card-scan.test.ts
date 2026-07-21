// Pure unit tests for the myth-dwyuw name-scan + card formatting. No DB — the
// matching rules (normalization, ≥2-token boundary matching, honorific
// robustness, false-positive guards, cap/ordering, card shape) are exercised in
// isolation. The DB-backed orchestrator + enforced-ignorance tiering live in
// turn-context.test.ts.

import { describe, it, expect } from 'vitest'
import {
  ENTITY_CARD_CAP,
  buildEntityCardBlock,
  firstMentionIndex,
  formatEntityCard,
  normalizeName,
  scanMentionedEntities,
  toHaystack,
  type ScanEntity,
} from '../entity-card-scan.js'

describe('normalizeName', () => {
  it('lowercases, folds punctuation/whitespace to single spaces, trims', () => {
    expect(normalizeName('  Captain   Marsen Roud ')).toBe('captain marsen roud')
    expect(normalizeName("Willow's Grace")).toBe('willow s grace')
    expect(normalizeName('House Eyrin-Vale')).toBe('house eyrin vale')
  })
})

describe('firstMentionIndex', () => {
  it('matches the full multi-token name at a word boundary', () => {
    const h = toHaystack('and then Captain Marsen Roud tipped her chin')
    expect(firstMentionIndex('Captain Marsen Roud', h)).not.toBeNull()
  })

  it('matches a canon name via an honorific-stripped run (the live Roud case)', () => {
    // Canon entity is "Captain Marsen Roud"; the transcript said "Marsen Roud".
    const h = toHaystack('Marsen Roud brought me the charter')
    expect(firstMentionIndex('Captain Marsen Roud', h)).not.toBeNull()
  })

  it('does NOT match a single shared token (the false-positive guard)', () => {
    // Only "marsen" appears — one token, below MATCH_MIN_TOKENS.
    expect(firstMentionIndex('Captain Marsen Roud', toHaystack('Marsen went to market'))).toBeNull()
    // Only the surname appears, alone.
    expect(firstMentionIndex('Captain Marsen Roud', toHaystack('the roud rose'))).toBeNull()
  })

  it('does NOT match on a partial-word overlap', () => {
    // "roud" is a token boundary word; "shroud"/"proud" must not match it.
    expect(firstMentionIndex('Marsen Roud', toHaystack('a proud marsen shroud'))).toBeNull()
  })

  it('single-token entity names never match (documented exclusion)', () => {
    expect(firstMentionIndex('Trask', toHaystack('Trask spoke first'))).toBeNull()
  })

  it('returns the earliest match index for ordering', () => {
    const h = toHaystack('x x x x Marsen Roud and later House Eyrin')
    const roud = firstMentionIndex('Marsen Roud', h)
    const house = firstMentionIndex('House Eyrin', h)
    expect(roud).not.toBeNull()
    expect(house).not.toBeNull()
    expect((roud ?? 0) < (house ?? 0)).toBe(true)
  })
})

describe('scanMentionedEntities', () => {
  const entities: readonly ScanEntity[] = [
    { id: 'e-roud', name: 'Captain Marsen Roud', entityType: 'npc' },
    { id: 'e-house', name: 'House Eyrin', entityType: 'faction' },
    { id: 'e-barge', name: "Willow's Grace", entityType: 'item' },
    { id: 'e-trask', name: 'Trask', entityType: 'npc' }, // single-token → never matches
  ]

  it('returns only the mentioned multi-token entities, earliest-first', () => {
    const text = "at the Willow's Grace rail, Marsen Roud produced a writ for House Eyrin"
    const got = scanMentionedEntities(entities, text)
    expect(got.map((e) => e.id)).toEqual(['e-barge', 'e-roud', 'e-house'])
  })

  it('returns [] when nothing is mentioned', () => {
    expect(scanMentionedEntities(entities, 'the tavern was quiet and empty')).toEqual([])
  })

  it('caps the result and keeps the earliest-mentioned entities', () => {
    const many: ScanEntity[] = Array.from({ length: ENTITY_CARD_CAP + 3 }, (_, i) => ({
      id: `id-${String(i).padStart(2, '0')}`,
      name: `Name${String(i)} Surname${String(i)}`,
      entityType: 'npc',
    }))
    // Mention them in order; the first ENTITY_CARD_CAP (by appearance) survive.
    const text = many.map((e) => e.name).join(' then ')
    const got = scanMentionedEntities(many, text)
    expect(got).toHaveLength(ENTITY_CARD_CAP)
    expect(got.map((e) => e.id)).toEqual(many.slice(0, ENTITY_CARD_CAP).map((e) => e.id))
  })

  it('is deterministic across calls (idempotent injection)', () => {
    const text = 'Marsen Roud and House Eyrin'
    expect(scanMentionedEntities(entities, text)).toEqual(scanMentionedEntities(entities, text))
  })
})

describe('formatEntityCard / buildEntityCardBlock', () => {
  it('formats name, type, and joined known facts', () => {
    expect(
      formatEntityCard('Captain Marsen Roud', 'npc', [
        'She is a leading candidate for the harbormaster’s seat.',
        'A slow-water riverwoman with a spotless record.',
      ]),
    ).toBe(
      '- Captain Marsen Roud (npc): She is a leading candidate for the harbormaster’s seat. A slow-water riverwoman with a spotless record.',
    )
  })

  it('formats a card with no known facts as just the labelled name', () => {
    expect(formatEntityCard('House Eyrin', 'faction', [])).toBe('- House Eyrin (faction)')
    // blank fact strings are dropped
    expect(formatEntityCard('House Eyrin', 'faction', ['  ', ''])).toBe('- House Eyrin (faction)')
  })

  it('buildEntityCardBlock returns empty string for no cards', () => {
    expect(buildEntityCardBlock([])).toBe('')
  })

  it('buildEntityCardBlock wraps cards in a labelled, ground-truth block', () => {
    const block = buildEntityCardBlock(['- A (npc): x', '- B (npc): y'])
    expect(block.startsWith('\n\n[')).toBe(true)
    expect(block).toContain('- A (npc): x')
    expect(block).toContain('- B (npc): y')
    expect(block.endsWith(']')).toBe(true)
  })
})
