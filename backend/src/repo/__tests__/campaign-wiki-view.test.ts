// backend/src/repo/__tests__/campaign-wiki-view.test.ts
//
// MYT-74c T9: campaignWikiView composes the PLAYER campaign-wiki read — a
// purpose-built NARROW `known`-tier projection, distinct from the owner-only
// worldSnapshotView. The wiki carries ONLY player-safe known-tier content:
// the narrow world summary (no `concept`, known-filtered vocabulary), known
// entities (id/name/type), their known facts, and known-tier relationships
// among them. NO prose kernels, NO stat blocks — those are owner-snapshot
// content, not player-wiki content.

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import type { Pool } from 'pg'
import { guardTestDatabase } from '../../db/__tests__/guard-db.js'
import { uuidv7 } from '../uuidv7.js'
import { entities } from '../entities.js'
import { facts } from '../facts.js'
import { campaignWikiView } from '../campaign-wiki-view.js'
import { cleanupTestScope, makeTestScope, type TestScope } from './_helpers/test-scope.js'
import { createTestPool } from './_helpers/test-pool.js'

const databaseUrl = process.env.DATABASE_URL ?? ''

describe('campaignWikiView.fetch — MYT-74c', () => {
  let pool: Pool
  let scope: TestScope

  beforeAll(async () => {
    await guardTestDatabase(databaseUrl)
    pool = createTestPool(databaseUrl)
    scope = makeTestScope('campaign-wiki-view')
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
    readonly knownEntity: string
    readonly secretEntity: string
  }

  // Seeds a world with one `known` entity (+ a known fact), one `secret`
  // entity (+ a secret fact), and a relationship between them. The world row
  // is populated with plot-bearing columns + a mixed-tier vocabulary registry
  // so the narrow-summary + known-filter assertions have something to bite on.
  async function seedFixture(): Promise<SeededFixture> {
    const userId = uuidv7()
    const worldId = uuidv7()
    const knownEntity = uuidv7()
    const secretEntity = uuidv7()
    await pool.query(
      `INSERT INTO users (id, cognito_sub, display_name, username)
       VALUES ($1, $2, $3, $4)`,
      [userId, scope.userSub(0), scope.displayName(0), scope.username(0)],
    )
    await pool.query(
      `INSERT INTO worlds (id, created_by, name, concept, tone, themes, status,
                            dev_bypass_access_filter, era, key_tensions,
                            political_summary, starting_situations,
                            follow_up_questions, vocabulary_registry)
       VALUES ($1, $2, $3, 'owner-seed-concept', 't', 'th', 'generating', false,
               'an era', 'key tensions', 'political secrets',
               'unrevealed starting situation', 'q?', $4::jsonb)`,
      [
        worldId,
        userId,
        scope.worldName(0),
        JSON.stringify({
          entries: [
            {
              term: 'glimwick',
              definition:
                'a hand-warmer charm used by hedge-witches; emits a soft amber glow in cold',
              source: 'stage_1_5',
              access_level: 'known',
            },
            {
              term: 'ashroot',
              definition:
                'the secret name of the burned king buried under the fen; never spoken aloud',
              source: 'stage_1_5',
              access_level: 'secret',
            },
          ],
          adjacent_franchises: ['studio ghibli', 'dishonored'],
        }),
      ],
    )
    await entities.insert(pool, {
      id: knownEntity, worldId, entityType: 'location',
      name: `${scope.id}-known`, accessLevel: 'known', createdIn: 'stage:test',
    })
    await entities.insert(pool, {
      id: secretEntity, worldId, entityType: 'npc',
      name: `${scope.id}-secret`, accessLevel: 'secret', createdIn: 'stage:test',
    })
    await facts.insertMany(pool, [
      { entityId: knownEntity, topic: 'a', accessLevel: 'known', content: 'known-fact' },
      { entityId: secretEntity, topic: 'b', accessLevel: 'secret', content: 'secret-fact' },
    ])
    await pool.query(
      `INSERT INTO relationships (id, source_entity_id, target_entity_id, relationship_type, description)
       VALUES ($1, $2, $3, 'guards', 'd1')`,
      [uuidv7(), knownEntity, secretEntity],
    )
    return { worldId, knownEntity, secretEntity }
  }

  it('returns the narrow summary + only known entities/facts; excludes the secret-endpoint relationship', async () => {
    const { worldId, knownEntity } = await seedFixture()

    const result = await campaignWikiView.fetch(pool, worldId)

    // Narrow world summary — NO `concept` (owner's raw world seed can carry plot).
    expect(result.world.id).toBe(worldId)
    expect(result.world.name).toBe(scope.worldName(0))
    expect('concept' in result.world).toBe(false)
    expect(Object.keys(result.world).sort()).toEqual(
      ['era', 'id', 'name', 'themes', 'tone', 'vocabularyRegistry'].sort(),
    )

    // Vocabulary registry filtered to known-tier entries; adjacent_franchises
    // are metadata and surface regardless.
    expect(result.world.vocabularyRegistry.entries).toHaveLength(1)
    expect(result.world.vocabularyRegistry.entries[0]?.term).toBe('glimwick')
    expect(result.world.vocabularyRegistry.entries[0]?.access_level).toBe('known')
    expect(result.world.vocabularyRegistry.adjacent_franchises).toEqual([
      'studio ghibli',
      'dishonored',
    ])

    // Entities: ONLY the known one, projected to id + name + entityType.
    expect(result.entities).toHaveLength(1)
    expect(result.entities[0]).toEqual({
      id: knownEntity,
      name: `${scope.id}-known`,
      entityType: 'location',
    })

    // Facts: ONLY the known fact.
    expect(result.facts).toHaveLength(1)
    expect(result.facts[0]?.content).toBe('known-fact')
    expect(result.facts[0]?.accessLevel).toBe('known')

    // Relationships: the known→secret edge is excluded — listAmong over only
    // the known entity ids returns none (one endpoint is secret → filtered).
    expect(result.relationships).toHaveLength(0)

    // No owner-snapshot content keys leak onto the wiki shape.
    expect('proseKernels' in result).toBe(false)
    expect('statBlocks' in result).toBe(false)
  })

  // MYT-89 Phase A (A5): THE SECURITY GATE on the player-facing wiki. A
  // `secret` relationship between two `known` entities passes the entity
  // filter (both endpoints are known) — only the relationship's OWN tier
  // keeps it off the player wiki. This is the more player-facing of the two
  // reveal surfaces, so the exclusion must hold here too.
  it('excludes a secret relationship between two known entities from the player wiki', async () => {
    const userId = uuidv7()
    const worldId = uuidv7()
    const known1 = uuidv7()
    const known2 = uuidv7()
    await pool.query(
      `INSERT INTO users (id, cognito_sub, display_name, username)
       VALUES ($1, $2, $3, $4)`,
      [userId, scope.userSub(0), scope.displayName(0), scope.username(0)],
    )
    await pool.query(
      `INSERT INTO worlds (id, created_by, name, concept, tone, themes, era, status)
       VALUES ($1, $2, $3, 'c', 't', 'th', 'an era', 'generating')`,
      [worldId, userId, scope.worldName(0)],
    )
    await entities.insert(pool, {
      id: known1, worldId, entityType: 'location',
      name: `${scope.id}-k1`, accessLevel: 'known', createdIn: 'stage:test',
    })
    await entities.insert(pool, {
      id: known2, worldId, entityType: 'faction',
      name: `${scope.id}-k2`, accessLevel: 'known', createdIn: 'stage:test',
    })
    // One open (known) edge + one secret edge, both between the SAME two
    // known entities. Migration 031 defaults access_level to 'secret', so
    // the tiers are explicit here.
    await pool.query(
      `INSERT INTO relationships (id, source_entity_id, target_entity_id, relationship_type, description, access_level)
       VALUES ($1, $2, $3, 'allied_with', 'an open alliance', 'known'),
              ($4, $5, $6, 'secretly_funds', 'a hidden money trail', 'secret')`,
      [uuidv7(), known1, known2, uuidv7(), known1, known2],
    )

    const result = await campaignWikiView.fetch(pool, worldId)

    // Only the open (known) edge surfaces; the secret one is filtered out.
    expect(result.relationships).toHaveLength(1)
    expect(result.relationships[0]?.relationshipType).toBe('allied_with')
    expect(result.relationships.some((r) => r.relationshipType === 'secretly_funds')).toBe(false)
  })

  it('throws when the world id does not exist', async () => {
    const missing = uuidv7()
    await expect(campaignWikiView.fetch(pool, missing)).rejects.toThrow(/not found/)
  })
})
