// backend/src/llm/prep/__tests__/world-dump.test.ts
//
// MYT-54 T5: integration tests for the shared world-dump module.
//
// These functions were previously file-private to stage-7 coherence-pass;
// MYT-54's character-integration worker reuses the same shape so the
// LLM sees an identical full-world dump across both call sites. The
// extraction is a pure move — no behavior change. These tests assert
// the wire-shape contract:
//   - loadWorldInventory returns entities + facts + relationships
//     (+ prose) for a seeded world.
//   - renderWorldDump embeds every entity UUID + name in its output.
//
// Real-Postgres integration tests (seeded via raw INSERTs) — no
// `seedWorldWithEntities` helper exists yet, so we inline the inserts
// under a scoped fixture per CONVENTIONS.md.

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { fileURLToPath } from 'node:url'
import { resolve } from 'node:path'
import pino, { type DestinationStream } from 'pino'
import type { Pool } from 'pg'
import { guardTestDatabase } from '../../../db/__tests__/guard-db.js'
import { runMigrations } from '../../../db/migrate.js'
import { uuidv7 } from '../../../repo/uuidv7.js'
import { entities } from '../../../repo/entities.js'
import { relationships } from '../../../repo/relationships.js'
import {
  cleanupTestScope,
  makeTestScope,
  type TestScope,
} from '../../../repo/__tests__/_helpers/test-scope.js'
import { createTestPool } from '../../../repo/__tests__/_helpers/test-pool.js'
import { loadWorldInventory, renderWorldDump } from '../world-dump.js'

const databaseUrl = process.env.DATABASE_URL ?? ''
const here = fileURLToPath(import.meta.url)
const REAL_MIGRATIONS_DIR = resolve(here, '../../../../../migrations')

function silentLogger(): ReturnType<typeof pino> {
  const sink: DestinationStream = {
    write: () => {
      // discard log output
    },
  }
  return pino(
    { base: { component: 'migrate' }, serializers: { err: pino.stdSerializers.err } },
    sink,
  )
}

interface SeedResult {
  readonly worldId: string
  readonly entityA: string
  readonly entityB: string
  readonly entityAName: string
  readonly entityBName: string
  readonly factId: string
  readonly relId: string
}

describe('world-dump', () => {
  let pool: Pool
  let scope: TestScope
  let userCounter: number

  beforeAll(async () => {
    await guardTestDatabase(databaseUrl)
    pool = createTestPool(databaseUrl)
    await runMigrations({
      pool,
      migrationsDir: REAL_MIGRATIONS_DIR,
      logger: silentLogger(),
    })
    scope = makeTestScope('worlddump')
    userCounter = 0
  })

  afterAll(async () => {
    await cleanupTestScope(pool, scope)
    await pool.end()
  })

  async function seed(): Promise<SeedResult> {
    const n = userCounter++
    const userId = uuidv7()
    const worldId = uuidv7()
    const entityA = uuidv7()
    const entityB = uuidv7()
    const factId = uuidv7()
    const relId = uuidv7()
    const entityAName = `worlddump-loc-${String(n)}`
    const entityBName = `worlddump-npc-${String(n)}`

    await pool.query(
      `INSERT INTO users (id, cognito_sub, display_name, username)
       VALUES ($1, $2, $3, $4)`,
      [userId, scope.userSub(n), scope.displayName(n), scope.username(n)],
    )
    await pool.query(
      `INSERT INTO worlds (id, created_by, name, concept, status)
       VALUES ($1, $2, $3, 'seed concept', 'complete')`,
      [worldId, userId, scope.worldName(n)],
    )
    await pool.query(
      `INSERT INTO entities (id, world_id, entity_type, name, access_level)
       VALUES ($1, $2, 'location', $3, 'known')`,
      [entityA, worldId, entityAName],
    )
    await pool.query(
      `INSERT INTO entities (id, world_id, entity_type, name, access_level)
       VALUES ($1, $2, 'npc', $3, 'discoverable')`,
      [entityB, worldId, entityBName],
    )
    await pool.query(
      `INSERT INTO prose_kernels (id, entity_id, content)
       VALUES ($1, $2, 'A weather-bitten stockade above the river bend.')`,
      [uuidv7(), entityA],
    )
    await pool.query(
      `INSERT INTO facts (id, entity_id, topic, access_level, narrative_status, content)
       VALUES ($1, $2, 'history', 'known', 'undelivered', 'Founded after the second harvest.')`,
      [factId, entityA],
    )
    await pool.query(
      `INSERT INTO relationships (id, source_entity_id, target_entity_id, relationship_type, description)
       VALUES ($1, $2, $3, 'resides_at', 'Has lived in the stockade since the burning.')`,
      [relId, entityB, entityA],
    )

    return { worldId, entityA, entityB, entityAName, entityBName, factId, relId }
  }

  it('loadWorldInventory returns entities, facts, and relationships for a seeded world', async () => {
    const seeded = await seed()
    const client = await pool.connect()
    try {
      const inv = await loadWorldInventory(client, seeded.worldId)

      expect(inv.entitiesById.has(seeded.entityA)).toBe(true)
      expect(inv.entitiesById.has(seeded.entityB)).toBe(true)
      expect(inv.entitiesById.get(seeded.entityA)?.name).toBe(seeded.entityAName)
      expect(inv.entitiesById.get(seeded.entityA)?.entityType).toBe('location')
      expect(inv.entitiesById.get(seeded.entityA)?.accessLevel).toBe('known')
      expect(inv.entitiesById.get(seeded.entityB)?.accessLevel).toBe('discoverable')

      expect(inv.factsById.has(seeded.factId)).toBe(true)
      expect(inv.factsById.get(seeded.factId)?.entityId).toBe(seeded.entityA)
      expect(inv.factsById.get(seeded.factId)?.topic).toBe('history')
      expect(inv.factsById.get(seeded.factId)?.accessLevel).toBe('known')

      expect(inv.relationshipsById.has(seeded.relId)).toBe(true)
      expect(inv.relationshipsById.get(seeded.relId)?.sourceEntityId).toBe(seeded.entityB)
      expect(inv.relationshipsById.get(seeded.relId)?.targetEntityId).toBe(seeded.entityA)

      expect(inv.proseByEntityId.get(seeded.entityA)).toContain('weather-bitten stockade')
    } finally {
      client.release()
    }
  })

  it('renderWorldDump produces a string containing every entity UUID', async () => {
    const seeded = await seed()
    const client = await pool.connect()
    try {
      const inv = await loadWorldInventory(client, seeded.worldId)
      const dump = renderWorldDump(inv)
      expect(dump).toContain(seeded.entityA)
      expect(dump).toContain(seeded.entityB)
    } finally {
      client.release()
    }
  })

  it('renderWorldDump produces a string containing every entity name', async () => {
    const seeded = await seed()
    const client = await pool.connect()
    try {
      const inv = await loadWorldInventory(client, seeded.worldId)
      const dump = renderWorldDump(inv)
      expect(dump).toContain(seeded.entityAName)
      expect(dump).toContain(seeded.entityBName)
    } finally {
      client.release()
    }
  })
})

describe('loadWorldInventory — synthKey on relationships', () => {
  // myth-imxg.3: WorldInventory.relationshipsById must expose the persisted
  // synth_key per relationship so downstream consumers (stage 7 coherence
  // pass, T14's synthKeyByRelationshipId build) can address the row on the
  // wire by its synth_key. The repo layer (T2) already surfaces synthKey on
  // listByWorld; this test asserts the inventory type carries it through.
  let pool: Pool
  let scope: TestScope

  beforeAll(async () => {
    await guardTestDatabase(databaseUrl)
    pool = createTestPool(databaseUrl)
    scope = makeTestScope('worlddump-synthkey')
  })
  afterAll(async () => {
    await cleanupTestScope(pool, scope)
    await pool.end()
  })

  it('returns synthKey per relationship', async () => {
    const userId = uuidv7()
    const worldId = uuidv7()
    const entA = uuidv7()
    const entB = uuidv7()
    await pool.query(
      `INSERT INTO users (id, cognito_sub, display_name, username) VALUES ($1, $2, $3, $4)`,
      [userId, scope.userSub(0), scope.displayName(0), scope.username(0)],
    )
    await pool.query(
      `INSERT INTO worlds (id, created_by, name, concept, status) VALUES ($1, $2, $3, 'C', 'generating')`,
      [worldId, userId, scope.worldName(0)],
    )
    await entities.insert(pool, {
      id: entA, worldId, entityType: 'faction', name: 'A', accessLevel: 'known', createdIn: 'stage:test',
    })
    await entities.insert(pool, {
      id: entB, worldId, entityType: 'location', name: 'B', accessLevel: 'known', createdIn: 'stage:test',
    })

    const synthKey = 'entity_relationships/relationships/3'
    const [relId] = await relationships.insertMany(pool, [{
      sourceEntityId: entA,
      targetEntityId: entB,
      relationshipType: 'adjacent_to',
      description: 'Test edge.',
      synthKey,
    }])

    const client = await pool.connect()
    try {
      const inv = await loadWorldInventory(client, worldId)
      expect(inv.relationshipsById.get(relId ?? '')?.synthKey).toBe(synthKey)
    } finally {
      client.release()
    }
  })
})
