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
      statBlocks: [{ id: 'sb-1' }],
      relationships: [{ sourceEntityId: 'e1', targetEntityId: 'e2' }],
      introduction: { title: 'Ashfall', prose: 'x'.repeat(40), references: [] },
    })
    expect('statBlocks' in parsed).toBe(false)
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

// MYT-102 Track E: entity prose kernels + the world glossary reach the wiki.
// Both collections are DISPLAY projections — every tier/authoring column strips
// at this boundary, and `adjacent_franchises` (real-world IP names) is
// deliberately UNMODELED so it can never reach a render surface.
describe('WorldSnapshotSchema — prose kernels + glossary (MYT-102)', () => {
  it('carries proseKernels narrowed to {entityId, content} (row extras strip)', () => {
    const parsed = WorldSnapshotSchema.parse({
      ...baseSnapshot,
      proseKernels: [
        {
          id: 'pk-1',
          entityId: 'e1',
          content: 'The Ashen Court holds the roads.',
          createdAt: '2026-07-01T00:00:00Z',
          updatedAt: '2026-07-01T00:00:00Z',
        },
      ],
    })
    expect(parsed.proseKernels).toEqual([
      { entityId: 'e1', content: 'The Ashen Court holds the roads.' },
    ])
  })

  it('carries the world glossary narrowed to {term, definition} per entry', () => {
    const parsed = WorldSnapshotSchema.parse({
      ...baseSnapshot,
      world: {
        id: 'w-1',
        name: 'Ashfall',
        tone: 'grim',
        themes: ['ash'],
        era: 'late',
        vocabularyRegistry: {
          entries: [
            {
              term: 'roadwarden',
              definition: 'A sworn keeper of the gate roads.',
              avoids: 'ranger',
              usage_notes: 'never capitalized mid-sentence',
              source: 'stage_1_5',
              access_level: 'known',
            },
          ],
          adjacent_franchises: ['A Real Franchise'],
        },
      },
    })
    // Entry metadata (tier, source, avoids, usage notes) strips; only the
    // display pair survives.
    expect(parsed.world?.vocabularyRegistry.entries).toEqual([
      { term: 'roadwarden', definition: 'A sworn keeper of the gate roads.' },
    ])
    // The world's other columns are not modeled — they strip away.
    expect(parsed.world !== undefined && 'name' in parsed.world).toBe(false)
  })

  it('NEVER carries adjacent_franchises (IP names must not render)', () => {
    const parsed = WorldSnapshotSchema.parse({
      ...baseSnapshot,
      world: {
        vocabularyRegistry: {
          entries: [],
          adjacent_franchises: ['A Real Franchise'],
        },
      },
    })
    expect(
      parsed.world !== undefined && 'adjacent_franchises' in parsed.world.vocabularyRegistry,
    ).toBe(false)
    expect(JSON.stringify(parsed)).not.toContain('A Real Franchise')
  })

  it('is optional — a bare snapshot (no proseKernels, no world) still validates', () => {
    const parsed = WorldSnapshotSchema.parse(baseSnapshot)
    expect(parsed.proseKernels).toBeUndefined()
    expect(parsed.world).toBeUndefined()
  })

  it('rejects a prose kernel missing its entityId (the keyed-body contract)', () => {
    const bad = WorldSnapshotSchema.safeParse({
      ...baseSnapshot,
      proseKernels: [{ content: 'orphaned prose' }],
    })
    expect(bad.success).toBe(false)
  })
})
