// backend/src/repo/__tests__/world-snapshot-view.test.ts
//
// myth-exac T19: world-snapshot-view composes the 7 read queries (T04 +
// T05 + T06 + T07) into a single WorldSnapshot, with a WorldSummary
// allowlist that intentionally omits the plot-bearing world columns
// (`key_tensions`, `political_summary`, `starting_situations`,
// `follow_up_questions`, etc.).
//
// The allowlist is the wire-shape gate; if the consumer ever does
// `JSON.stringify(snap.world)`, only id/name/concept/tone/themes/era
// are emitted. Even under dev_bypass the WorldSummary stays narrow —
// bypass widens entity/fact tiers, not the world's own column set.

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import type { Pool } from 'pg'
import { fileURLToPath } from 'node:url'
import { resolve } from 'node:path'
import pino, { type DestinationStream } from 'pino'
import { runMigrations } from '../../db/migrate.js'
import { guardTestDatabase } from '../../db/__tests__/guard-db.js'
import { uuidv7 } from '../uuidv7.js'
import { entities } from '../entities.js'
import { facts } from '../facts.js'
import { proseKernels } from '../prose-kernels.js'
import { worldSnapshotView } from '../world-snapshot-view.js'
import { cleanupTestScope, makeTestScope, type TestScope } from './_helpers/test-scope.js'
import { createTestPool } from './_helpers/test-pool.js'

const databaseUrl = process.env.DATABASE_URL ?? ''
const here = fileURLToPath(import.meta.url)
const REAL_MIGRATIONS_DIR = resolve(here, '../../../../migrations')

function silentLogger(): ReturnType<typeof pino> {
  const sink: DestinationStream = { write: (): void => undefined }
  return pino({ base: { component: 'migrate' } }, sink)
}

describe('worldSnapshotView.fetch — myth-exac', () => {
  let pool: Pool
  let scope: TestScope

  beforeAll(async () => {
    await guardTestDatabase(databaseUrl)
    pool = createTestPool(databaseUrl)
    await pool.query('DROP EXTENSION IF EXISTS pgcrypto CASCADE')
    await pool.query('DROP SCHEMA public CASCADE')
    await pool.query('CREATE SCHEMA public')
    await pool.query('GRANT ALL ON SCHEMA public TO PUBLIC')
    await pool.query('GRANT ALL ON SCHEMA public TO CURRENT_USER')
    await runMigrations({ pool, migrationsDir: REAL_MIGRATIONS_DIR, logger: silentLogger() })
    scope = makeTestScope('snapshot-view')
  })
  afterAll(async () => {
    await cleanupTestScope(pool, scope)
    await pool.end()
  })
  beforeEach(async () => {
    await cleanupTestScope(pool, scope)
  })

  interface SeededFixture {
    readonly worldId: string
    readonly known1: string
    readonly known2: string
    readonly discoverable: string
  }

  // Seeds a world with three entities (two `known`, one `discoverable`),
  // three facts (mixed tiers), three prose kernels, and two
  // relationships (known→known and known→discoverable). The world row
  // is populated with plot-bearing columns to prove the allowlist
  // suppresses them. When `vocabularyRegistry` is provided, it overrides
  // the column's default empty registry so registry-filtering assertions
  // can exercise mixed-tier entry sets.
  async function seedFixture(opts?: {
    readonly vocabularyRegistry?: unknown
  }): Promise<SeededFixture> {
    const userId = uuidv7()
    const worldId = uuidv7()
    const known1 = uuidv7()
    const known2 = uuidv7()
    const discoverable = uuidv7()
    await pool.query(
      `INSERT INTO users (id, cognito_sub, display_name, username)
       VALUES ($1, $2, $3, $4)`,
      [userId, scope.userSub(0), scope.displayName(0), scope.username(0)],
    )
    if (opts?.vocabularyRegistry !== undefined) {
      await pool.query(
        `INSERT INTO worlds (id, created_by, name, concept, tone, themes, status,
                              dev_bypass_access_filter, era, key_tensions,
                              political_summary, starting_situations,
                              follow_up_questions, vocabulary_registry)
         VALUES ($1, $2, $3, 'c', 't', 'th', 'generating', false,
                 'an era', 'key tensions', 'political secrets',
                 'unrevealed starting situation', 'q?', $4::jsonb)`,
        [worldId, userId, scope.worldName(0), JSON.stringify(opts.vocabularyRegistry)],
      )
    } else {
      await pool.query(
        `INSERT INTO worlds (id, created_by, name, concept, tone, themes, status,
                              dev_bypass_access_filter, era, key_tensions,
                              political_summary, starting_situations,
                              follow_up_questions)
         VALUES ($1, $2, $3, 'c', 't', 'th', 'generating', false,
                 'an era', 'key tensions', 'political secrets',
                 'unrevealed starting situation', 'q?')`,
        [worldId, userId, scope.worldName(0)],
      )
    }
    await entities.insert(pool, {
      id: known1, worldId, entityType: 'location',
      name: `${scope.id}-k1`, accessLevel: 'known',
    })
    await entities.insert(pool, {
      id: known2, worldId, entityType: 'faction',
      name: `${scope.id}-k2`, accessLevel: 'known',
    })
    await entities.insert(pool, {
      id: discoverable, worldId, entityType: 'npc',
      name: `${scope.id}-d`, accessLevel: 'discoverable',
    })
    await facts.insertMany(pool, [
      { entityId: known1, topic: 'a', accessLevel: 'known', content: 'k1-public' },
      { entityId: known1, topic: 'b', accessLevel: 'secret', content: 'k1-hidden' },
      { entityId: discoverable, topic: 'c', accessLevel: 'known', content: 'd-public' },
    ])
    await proseKernels.insert(pool, { entityId: known1, content: 'prose-k1' })
    await proseKernels.insert(pool, { entityId: known2, content: 'prose-k2' })
    await proseKernels.insert(pool, { entityId: discoverable, content: 'prose-d' })
    await pool.query(
      `INSERT INTO relationships (id, source_entity_id, target_entity_id, relationship_type, description)
       VALUES ($1, $2, $3, 'controls', 'd1'), ($4, $5, $6, 'knows', 'd2')`,
      [uuidv7(), known1, known2, uuidv7(), known1, discoverable],
    )
    return { worldId, known1, known2, discoverable }
  }

  it('returns only known-tier entities + facts + same-tier relationships when bypass:false', async () => {
    const { worldId, known1, known2 } = await seedFixture()

    const snap = await worldSnapshotView.fetch(pool, worldId, { bypass: false })

    // WorldSummary allowlist — assert the wire-shape projection.
    expect(snap.world.id).toBe(worldId)
    expect(snap.world.name).toBe(scope.worldName(0))
    expect(Object.keys(snap.world).sort()).toEqual(
      ['concept', 'era', 'id', 'name', 'themes', 'tone', 'vocabularyRegistry'].sort(),
    )

    // Critically — these MUST NOT appear under any tier.
    expect('starting_situations' in snap.world).toBe(false)
    expect('startingSituations' in snap.world).toBe(false)
    expect('key_tensions' in snap.world).toBe(false)
    expect('keyTensions' in snap.world).toBe(false)
    expect('political_summary' in snap.world).toBe(false)
    expect('politicalSummary' in snap.world).toBe(false)
    expect('follow_up_questions' in snap.world).toBe(false)
    expect('dev_bypass_access_filter' in snap.world).toBe(false)
    expect('devBypassAccessFilter' in snap.world).toBe(false)

    // Entities: only the two known-tier ones surface.
    expect(snap.entities).toHaveLength(2)
    expect(snap.entities.map((e) => e.id).sort()).toEqual([known1, known2].sort())

    // Facts: only known-tier facts that belong to known-tier entities.
    // The discoverable entity's known fact is filtered out at the entity
    // tier — the entity isn't in the surface set, so its facts shouldn't
    // appear in the snapshot either.
    expect(snap.facts).toHaveLength(1)
    expect(snap.facts[0]?.content).toBe('k1-public')

    // Relationships: only the known→known edge. known→discoverable is
    // filtered out by listAmong (target is not in the entity set).
    expect(snap.relationships).toHaveLength(1)
    expect(snap.relationships[0]?.sourceEntityId).toBe(known1)
    expect(snap.relationships[0]?.targetEntityId).toBe(known2)

    // Prose kernels: only the two known-tier ones.
    expect(snap.proseKernels).toHaveLength(2)
    const proseEntityIds = snap.proseKernels.map((p) => p.entityId).sort()
    expect(proseEntityIds).toEqual([known1, known2].sort())

    // Hierarchy + statBlocks: empty here since the fixture seeds neither.
    expect(snap.entityHierarchy).toEqual([])
    expect(snap.statBlocks).toEqual([])
  })

  it('returns all tiers when bypass:true but the WorldSummary still omits plot columns', async () => {
    const { worldId, known1, known2, discoverable } = await seedFixture()

    const snap = await worldSnapshotView.fetch(pool, worldId, { bypass: true })

    // Same allowlist applies under bypass. Bypass widens entity/fact
    // tiers (and registry entry tiers), but the world's own column
    // projection stays narrow.
    expect(Object.keys(snap.world).sort()).toEqual(
      ['concept', 'era', 'id', 'name', 'themes', 'tone', 'vocabularyRegistry'].sort(),
    )
    expect('starting_situations' in snap.world).toBe(false)
    expect('key_tensions' in snap.world).toBe(false)

    // All three entities surface.
    expect(snap.entities).toHaveLength(3)
    expect(snap.entities.map((e) => e.id).sort()).toEqual(
      [known1, known2, discoverable].sort(),
    )

    // All three facts surface (k1 known + k1 secret + d known).
    expect(snap.facts).toHaveLength(3)

    // Both relationships surface — both endpoints are now in the set.
    expect(snap.relationships).toHaveLength(2)

    // All three prose kernels surface.
    expect(snap.proseKernels).toHaveLength(3)
  })

  it('surfaces a non-empty vocabulary registry (all-known tier, with adjacent_franchises) when bypass:false', async () => {
    const { worldId } = await seedFixture({
      vocabularyRegistry: {
        entries: [
          {
            term: 'glimwick',
            definition:
              'a hand-warmer charm used by hedge-witches; emits a soft amber glow in cold',
            source: 'stage_1_5',
            access_level: 'known',
          },
          {
            term: 'fenring',
            definition:
              'the brackish marsh that rings the lowland villages and floods every spring',
            source: 'stage_1_5',
            access_level: 'known',
          },
          {
            term: 'cinder-coin',
            definition:
              'a small bronze token traded at hearthside markets; held to ward off chill',
            source: 'stage_1_5',
            access_level: 'known',
          },
        ],
        adjacent_franchises: ['studio ghibli', 'dishonored'],
      },
    })

    const snap = await worldSnapshotView.fetch(pool, worldId, { bypass: false })

    expect(snap.world.vocabularyRegistry.entries).toHaveLength(3)
    expect(snap.world.vocabularyRegistry.entries.map((e) => e.term).sort()).toEqual(
      ['cinder-coin', 'fenring', 'glimwick'],
    )
    expect(snap.world.vocabularyRegistry.adjacent_franchises).toEqual([
      'studio ghibli',
      'dishonored',
    ])
  })

  it('filters discoverable + secret entries out of the registry when bypass:false (adjacent_franchises still surface)', async () => {
    const { worldId } = await seedFixture({
      vocabularyRegistry: {
        entries: [
          {
            term: 'glimwick',
            definition:
              'a hand-warmer charm used by hedge-witches; emits a soft amber glow in cold',
            source: 'stage_1_5',
            access_level: 'known',
          },
          {
            term: 'wayfen oath',
            definition:
              'an old promise sworn between the marsh-clans; rumored to bind across generations',
            source: 'stage_1_5',
            access_level: 'discoverable',
          },
          {
            term: 'ashroot',
            definition:
              'the secret name of the burned king buried under the fenring; never spoken aloud',
            source: 'stage_1_5',
            access_level: 'secret',
          },
        ],
        adjacent_franchises: ['studio ghibli', 'dishonored'],
      },
    })

    const snap = await worldSnapshotView.fetch(pool, worldId, { bypass: false })

    expect(snap.world.vocabularyRegistry.entries).toHaveLength(1)
    expect(snap.world.vocabularyRegistry.entries[0]?.term).toBe('glimwick')
    expect(snap.world.vocabularyRegistry.entries[0]?.access_level).toBe('known')
    // Adjacent franchises are metadata, not player-secret content — they
    // surface regardless of the tier filter.
    expect(snap.world.vocabularyRegistry.adjacent_franchises).toEqual([
      'studio ghibli',
      'dishonored',
    ])
  })

  it('surfaces all registry tiers (known + discoverable + secret) when bypass:true', async () => {
    const { worldId } = await seedFixture({
      vocabularyRegistry: {
        entries: [
          {
            term: 'glimwick',
            definition:
              'a hand-warmer charm used by hedge-witches; emits a soft amber glow in cold',
            source: 'stage_1_5',
            access_level: 'known',
          },
          {
            term: 'wayfen oath',
            definition:
              'an old promise sworn between the marsh-clans; rumored to bind across generations',
            source: 'stage_1_5',
            access_level: 'discoverable',
          },
          {
            term: 'ashroot',
            definition:
              'the secret name of the burned king buried under the fenring; never spoken aloud',
            source: 'stage_1_5',
            access_level: 'secret',
          },
        ],
        adjacent_franchises: ['studio ghibli', 'dishonored'],
      },
    })

    const snap = await worldSnapshotView.fetch(pool, worldId, { bypass: true })

    expect(snap.world.vocabularyRegistry.entries).toHaveLength(3)
    expect(snap.world.vocabularyRegistry.entries.map((e) => e.access_level).sort()).toEqual(
      ['discoverable', 'known', 'secret'],
    )
    expect(snap.world.vocabularyRegistry.adjacent_franchises).toEqual([
      'studio ghibli',
      'dishonored',
    ])
  })

  it('throws when the world id does not exist', async () => {
    const missing = uuidv7()
    await expect(
      worldSnapshotView.fetch(pool, missing, { bypass: false }),
    ).rejects.toThrow(/not found/)
  })
})
