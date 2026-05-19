// backend/src/llm/prep/stages/__tests__/character-sheet.test.ts
//
// MYT-53 / myth-wolj T9: stage 3 of the character-creation worker. Sonnet
// generateObject producing the mechanical half — ability scores, derived
// HP/AC/proficiency, plus the four sub-tables (skills/features/equipment/
// spells). Owns the SINGLE INSERT into `characters` + `campaign_characters`
// + the four sub-tables in one transaction. Idempotent re-run: if a
// characters row already exists for (campaign_id, user_id) via
// campaign_characters, UPDATE-not-INSERT and DELETE the four sub-tables
// before re-INSERT.
//
// Mock target: `'ai'` (the Vercel SDK) — matches the proven pattern used by
// every peer stage test in this directory. Real Postgres seed pattern lifted
// from location-selection.test.ts; member seed scaffolding mirrors
// repo/__tests__/character-concepts.test.ts.

import { describe, it, expect, vi, beforeAll, beforeEach, afterAll } from 'vitest'
import { fileURLToPath } from 'node:url'
import { resolve } from 'node:path'
import pino, { type DestinationStream } from 'pino'
import type { Pool } from 'pg'
import * as ai from 'ai'
import { guardTestDatabase } from '../../../../db/__tests__/guard-db.js'
import { runMigrations } from '../../../../db/migrate.js'
import { createPgPool } from '../../../../db/postgres.js'
import { uuidv7 } from '../../../../repo/uuidv7.js'
import { resetData } from '../../../../repo/__tests__/_helpers/reset-data.js'
import { runCharacterSheetStage } from '../character-sheet.js'

vi.mock('ai', async () => {
  const actual = await vi.importActual<typeof import('ai')>('ai')
  return { ...actual, generateText: vi.fn() }
})

const mockGenerateText = vi.mocked(ai.generateText)

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

const NARRATIVE = {
  name: 'Bran of the Hollow',
  race: 'human',
  class: 'cleric',
  background: 'acolyte',
  level: 1,
  alignment: 'lawful neutral',
  age: 27,
  gender: 'man',
  physical_description:
    'A tall man, weather-worn from years on the road, with a shaved scalp and a faded sept-mark on the back of his left hand.',
  personality_traits: [
    'speaks in measured tones',
    'pauses before answering, as if listening to something else first',
  ],
  ideals: ['order serves the weak'],
  bonds: ['the temple that raised him'],
  flaws: ['quick to suspect deception'],
  backstory:
    'Bran was apprenticed at the Bone Sept in his twelfth year, when the priests took him in after a winter on the moors orphaned him. Twenty years later, when the Sept burned, he walked out with a tin ladle and a name he was no longer sure was his. He has been on the road since, doing temple work for coin, telling himself he is still a cleric of the Hollow, listening for the small voice that used to answer him at the altar.',
}

const SHEET = {
  str: 12,
  dex: 10,
  con: 14,
  int: 13,
  wis: 16,
  cha: 11,
  hit_points: 9,
  max_hit_points: 9,
  armor_class: 14,
  proficiency_bonus: 2,
  skills: [{ name: 'Insight', proficient: true, expertise: false }],
  features: [
    { name: 'Divine Domain: Life', description: 'extra healing for allies' },
  ],
  equipment: [{ name: 'Mace', quantity: 1 }],
  spells: [{ name: 'Cure Wounds', level: 1, prepared: true }],
}

interface SeedResult {
  readonly userId: string
  readonly worldId: string
  readonly campaignId: string
}

describe('runCharacterSheetStage', () => {
  let pool: Pool

  beforeAll(async () => {
    await guardTestDatabase(databaseUrl)
    pool = createPgPool(databaseUrl, { max: 2 })
    await runMigrations({
      pool,
      migrationsDir: REAL_MIGRATIONS_DIR,
      logger: silentLogger(),
    })
  })

  afterAll(async () => {
    await pool.end()
  })

  beforeEach(async () => {
    await resetData(pool)
    vi.clearAllMocks()
  })

  async function seedMember(): Promise<SeedResult> {
    const userId = uuidv7()
    const worldId = uuidv7()
    const campaignId = uuidv7()
    const suffix = userId.slice(0, 8)
    await pool.query(
      `INSERT INTO users (id, cognito_sub, display_name, username)
       VALUES ($1, $2, $3, $4)`,
      [userId, `g_char_sheet_${suffix}`, 'Char Sheet User', `charsheet_${suffix}`],
    )
    await pool.query(
      `INSERT INTO worlds (id, created_by, name, concept, status)
       VALUES ($1, $2, 'Char Sheet World', 'C', 'complete')`,
      [worldId, userId],
    )
    await pool.query(
      `INSERT INTO campaigns (id, world_id, created_by, name)
       VALUES ($1, $2, $3, 'Char Sheet Campaign')`,
      [campaignId, worldId, userId],
    )
    await pool.query(
      `INSERT INTO campaign_members (id, campaign_id, user_id, role, invite_accepted)
       VALUES ($1, $2, $3, 'owner', true)`,
      [uuidv7(), campaignId, userId],
    )
    return { userId, worldId, campaignId }
  }

  it('persists characters row + campaign_characters join + 4 sub-tables on first run', async () => {
    const { userId, worldId, campaignId } = await seedMember()

    mockGenerateText.mockResolvedValueOnce({
      output: SHEET,
      finishReason: 'stop',
      usage: { inputTokens: 2000, outputTokens: 2000, totalTokens: 4000 },
    } as never)

    const result = await runCharacterSheetStage(pool, {
      campaignId,
      userId,
      worldId,
      narrative: NARRATIVE,
      worldTone: 'somber',
      worldEra: 'iron age',
    })

    expect(result.characterId).toBeDefined()
    expect(result.costUsd).toBeCloseTo(
      (2000 / 1_000_000) * 3 + (2000 / 1_000_000) * 15,
      6,
    )
    expect(result.inputTokens).toBe(2000)
    expect(result.outputTokens).toBe(2000)

    const c = await pool.query(
      `SELECT class, species, background, str, dex, con, int, wis, cha,
              hit_points, max_hit_points, armor_class, proficiency_bonus, level, name, user_id
         FROM characters WHERE id = $1`,
      [result.characterId],
    )
    expect(c.rows[0]).toMatchObject({
      class: 'cleric',
      species: 'human',
      background: 'acolyte',
      str: 12,
      dex: 10,
      con: 14,
      int: 13,
      wis: 16,
      cha: 11,
      hit_points: 9,
      max_hit_points: 9,
      armor_class: 14,
      proficiency_bonus: 2,
      level: 1,
      name: 'Bran of the Hollow',
      user_id: userId,
    })

    const join = await pool.query(
      `SELECT campaign_id, character_id, user_id
         FROM campaign_characters WHERE character_id = $1`,
      [result.characterId],
    )
    expect(join.rowCount).toBe(1)
    expect(join.rows[0]).toMatchObject({
      campaign_id: campaignId,
      user_id: userId,
    })

    const skills = await pool.query(
      `SELECT skill_name, proficiency_level FROM character_skills WHERE character_id = $1`,
      [result.characterId],
    )
    expect(skills.rowCount).toBe(1)
    expect(skills.rows[0]).toMatchObject({
      skill_name: 'Insight',
      proficiency_level: 'proficient',
    })

    const features = await pool.query(
      `SELECT feature_name, feature_source, description
         FROM character_features WHERE character_id = $1`,
      [result.characterId],
    )
    expect(features.rowCount).toBe(1)
    expect(features.rows[0]).toMatchObject({
      feature_name: 'Divine Domain: Life',
      feature_source: 'cleric',
      description: 'extra healing for allies',
    })

    const equipment = await pool.query(
      `SELECT item_name, quantity, equipped FROM character_equipment WHERE character_id = $1`,
      [result.characterId],
    )
    expect(equipment.rowCount).toBe(1)
    expect(equipment.rows[0]).toMatchObject({
      item_name: 'Mace',
      quantity: 1,
      equipped: false,
    })

    const spells = await pool.query(
      `SELECT spell_name, spell_level, prepared FROM character_spells WHERE character_id = $1`,
      [result.characterId],
    )
    expect(spells.rowCount).toBe(1)
    expect(spells.rows[0]).toMatchObject({
      spell_name: 'Cure Wounds',
      spell_level: 1,
      prepared: true,
    })
  })

  it('idempotent re-run: existing characters row is UPDATEd, sub-tables DELETEd and re-INSERTed', async () => {
    const { userId, worldId, campaignId } = await seedMember()

    // First run.
    mockGenerateText.mockResolvedValueOnce({
      output: SHEET,
      finishReason: 'stop',
      usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
    } as never)
    const first = await runCharacterSheetStage(pool, {
      campaignId,
      userId,
      worldId,
      narrative: NARRATIVE,
      worldTone: 't',
      worldEra: 'e',
    })

    // Second run with different stats.
    const SHEET2 = {
      ...SHEET,
      str: 18,
      hit_points: 12,
      max_hit_points: 12,
      skills: [
        { name: 'Religion', proficient: true, expertise: true },
        { name: 'Insight', proficient: true, expertise: false },
        // proficient:false + expertise:false maps to 'none' (the
        // proficiency_level enum's third state). Exercises the
        // fall-through return in proficiencyLevel().
        { name: 'Acrobatics', proficient: false, expertise: false },
      ],
    }
    mockGenerateText.mockResolvedValueOnce({
      output: SHEET2,
      finishReason: 'stop',
      usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
    } as never)
    const second = await runCharacterSheetStage(pool, {
      campaignId,
      userId,
      worldId,
      narrative: NARRATIVE,
      worldTone: 't',
      worldEra: 'e',
    })

    expect(second.characterId).toBe(first.characterId)
    const c = await pool.query(
      `SELECT str, hit_points, max_hit_points FROM characters WHERE id = $1`,
      [first.characterId],
    )
    expect(c.rows[0]).toMatchObject({
      str: 18,
      hit_points: 12,
      max_hit_points: 12,
    })

    // Exactly one row in campaign_characters (UNIQUE invariant + idempotent
    // re-run path: no second INSERT into the join table).
    const join = await pool.query(
      `SELECT * FROM campaign_characters WHERE user_id = $1 AND campaign_id = $2`,
      [userId, campaignId],
    )
    expect(join.rowCount).toBe(1)

    // Sub-tables: DELETEd then re-INSERTed. New skills count should match
    // the second sheet, not be appended to the first.
    const skills = await pool.query(
      `SELECT skill_name, proficiency_level
         FROM character_skills WHERE character_id = $1
         ORDER BY skill_name`,
      [first.characterId],
    )
    expect(skills.rowCount).toBe(3)
    expect(skills.rows[0]).toMatchObject({
      skill_name: 'Acrobatics',
      proficiency_level: 'none',
    })
    expect(skills.rows[1]).toMatchObject({
      skill_name: 'Insight',
      proficiency_level: 'proficient',
    })
    expect(skills.rows[2]).toMatchObject({
      skill_name: 'Religion',
      proficiency_level: 'expertise',
    })

    // Features / equipment / spells: one row each (re-INSERTed, not stacked).
    const features = await pool.query(
      `SELECT * FROM character_features WHERE character_id = $1`,
      [first.characterId],
    )
    expect(features.rowCount).toBe(1)
    const equipment = await pool.query(
      `SELECT * FROM character_equipment WHERE character_id = $1`,
      [first.characterId],
    )
    expect(equipment.rowCount).toBe(1)
    const spells = await pool.query(
      `SELECT * FROM character_spells WHERE character_id = $1`,
      [first.characterId],
    )
    expect(spells.rowCount).toBe(1)
  })
})
