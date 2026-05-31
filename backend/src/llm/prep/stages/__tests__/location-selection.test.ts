// backend/src/llm/prep/stages/__tests__/location-selection.test.ts
//
// MYT-53 / myth-7kmz T7. Stage 1 of the character-creation worker. No-LLM
// resolver: reads campaigns.starting_situation_index +
// worlds.starting_situation_entries[index], validates the referenced
// location entity exists, returns the resolved location entity id.
// Writes nothing — stage 4 re-derives the same id when emitting the
// deferred "starts at $location" fact (spec §Stages, §Risks #3).

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { fileURLToPath } from 'node:url'
import { resolve } from 'node:path'
import pino, { type DestinationStream } from 'pino'
import type { Pool } from 'pg'
import { guardTestDatabase } from '../../../../db/__tests__/guard-db.js'
import { runMigrations } from '../../../../db/migrate.js'
import { uuidv7 } from '../../../../repo/uuidv7.js'
import {
  cleanupTestScope,
  makeTestScope,
  type TestScope,
} from '../../../../repo/__tests__/_helpers/test-scope.js'
import { createTestPool } from '../../../../repo/__tests__/_helpers/test-pool.js'
import { createRepo } from '../../../../repo/index.js'
import { runLocationSelectionStage } from '../location-selection.js'

const databaseUrl = process.env.DATABASE_URL ?? ''
const here = fileURLToPath(import.meta.url)
const REAL_MIGRATIONS_DIR = resolve(here, '../../../../../../migrations')

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

interface SeedArgs {
  readonly entries: readonly {
    index: number
    locationEntityId: string
    prose: string
  }[]
  readonly startingSituationIndex: number | null
  /**
   * Entity rows to seed into `entities`. Each row must reference the
   * world being created. Caller controls whether a referenced
   * locationEntityId actually has a matching row (omit to exercise the
   * drift / missing-entity branch).
   */
  readonly entities: readonly { id: string; name: string }[]
}

interface SeedResult {
  readonly userId: string
  readonly worldId: string
  readonly campaignId: string
}

describe('runLocationSelectionStage', () => {
  let pool: Pool
  let scope: TestScope
  let userCounter: number

  beforeAll(async () => {
    await guardTestDatabase(databaseUrl)
    pool = createTestPool(databaseUrl)
    await runMigrations({ pool, migrationsDir: REAL_MIGRATIONS_DIR, logger: silentLogger() })
    scope = makeTestScope('locsel')
    userCounter = 0
  })

  afterAll(async () => {
    // myth-5jdo: scoped cleanup before pool teardown.
    await cleanupTestScope(pool, scope)
    await pool.end()
  })

  async function seed(args: SeedArgs): Promise<SeedResult> {
    const userId = uuidv7()
    const worldId = uuidv7()
    const campaignId = uuidv7()
    const n = userCounter++
    await pool.query(
      `INSERT INTO users (id, cognito_sub, display_name, username)
       VALUES ($1, $2, $3, $4)`,
      [userId, scope.userSub(n), scope.displayName(n), scope.username(n)],
    )
    await pool.query(
      `INSERT INTO worlds (id, created_by, name, concept, status, starting_situation_entries)
       VALUES ($1, $2, $3, 'C', 'complete', $4::jsonb)`,
      [worldId, userId, scope.worldName(n), JSON.stringify(args.entries)],
    )
    for (const entity of args.entities) {
      await pool.query(
        `INSERT INTO entities (id, world_id, entity_type, name)
         VALUES ($1, $2, 'location', $3)`,
        [entity.id, worldId, entity.name],
      )
    }
    await pool.query(
      `INSERT INTO campaigns (id, world_id, created_by, name, starting_situation_index)
       VALUES ($1, $2, $3, $4, $5)`,
      [campaignId, worldId, userId, scope.campaignName(n), args.startingSituationIndex],
    )
    return { userId, worldId, campaignId }
  }

  it('returns the resolved locationEntityId from the chosen starting situation', async () => {
    const locId = uuidv7()
    const otherLocId1 = uuidv7()
    const otherLocId2 = uuidv7()
    const { worldId, campaignId } = await seed({
      startingSituationIndex: 0,
      entries: [
        { index: 0, locationEntityId: locId, prose: 'a candlelit tavern' },
        { index: 1, locationEntityId: otherLocId1, prose: 'on a dusty road' },
        { index: 2, locationEntityId: otherLocId2, prose: 'in the ruins' },
      ],
      entities: [
        { id: locId, name: 'The Tavern' },
        { id: otherLocId1, name: 'The Road' },
        { id: otherLocId2, name: 'The Ruins' },
      ],
    })

    const result = await runLocationSelectionStage(createRepo(pool), { campaignId, worldId })

    expect(result.locationEntityId).toBe(locId)
    expect(result.costUsd).toBe(0)
    expect(result.inputTokens).toBe(0)
    expect(result.outputTokens).toBe(0)
  })

  it('throws when the chosen entity does not exist', async () => {
    const ghostId = uuidv7()
    const { worldId, campaignId } = await seed({
      startingSituationIndex: 0,
      entries: [{ index: 0, locationEntityId: ghostId, prose: 'nowhere' }],
      // Intentionally seed NO entity rows so the drift-detection branch fires.
      entities: [],
    })

    await expect(
      runLocationSelectionStage(createRepo(pool), { campaignId, worldId }),
    ).rejects.toThrow(/location entity not found|drift/i)
  })

  it('throws when starting_situation_index is NULL', async () => {
    const { worldId, campaignId } = await seed({
      startingSituationIndex: null,
      entries: [],
      entities: [],
    })

    await expect(
      runLocationSelectionStage(createRepo(pool), { campaignId, worldId }),
    ).rejects.toThrow(/starting_situation_index|not chosen/i)
  })
})
