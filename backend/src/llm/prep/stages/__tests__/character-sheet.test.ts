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
import { uuidv7 } from '../../../../repo/uuidv7.js'
import {
  cleanupTestScope,
  makeTestScope,
  type TestScope,
} from '../../../../repo/__tests__/_helpers/test-scope.js'
import { createTestPool } from '../../../../repo/__tests__/_helpers/test-pool.js'
import { createRepo } from '../../../../repo/index.js'
import {
  runCharacterSheetStage,
  CharacterSheetCoherenceError,
  dedupeMergeEquipment,
  dedupeMergeFeatures,
  dedupeMergeSpells,
  validateCoherence,
} from '../character-sheet.js'
import type { CharacterSheetOutput } from '../../../schemas/character-sheet.js'

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

const SHEET: CharacterSheetOutput = {
  str: 12,
  dex: 10,
  con: 14,
  int: 13,
  wis: 16,
  cha: 11,
  // L1, con 14 (+2), hit_die 8 → the only coherent max HP is 10 (band [10,11]).
  // A5's HP-band check now rejects the prior 9; a fresh sheet is at full health.
  hit_points: 10,
  max_hit_points: 10,
  armor_class: 14,
  proficiency_bonus: 2,
  // MYT-70 §3.2 ledger-init source fields.
  starting_gold: 15,
  hit_die: 8,
  // cleric: a full caster — L1 cleric has a single level-1 slot row [{1,2}].
  spellcasting_progression: 'full',
  skills: [{ name: 'Insight', proficient: true, expertise: false }],
  features: [
    {
      name: 'Divine Domain: Life',
      description: 'extra healing for allies',
      max_uses: null,
      recharge: 'none',
    },
  ],
  equipment: [{ name: 'Mace', quantity: 1, consumable: false }],
  spells: [{ name: 'Cure Wounds', level: 1, prepared: true, ritual: false }],
}

interface SeedResult {
  readonly userId: string
  readonly worldId: string
  readonly campaignId: string
}

// myth-5jdo: characters.user_id is RESTRICT-FK to users — must delete
// scope-user characters BEFORE cleanupTestScope's user delete.
async function cleanupCharactersFor(p: Pool, scope: TestScope): Promise<void> {
  await p.query(
    `DELETE FROM characters
       WHERE user_id IN (SELECT id FROM users WHERE cognito_sub LIKE $1)`,
    [`${scope.id}%`],
  )
  await cleanupTestScope(p, scope)
}

describe('runCharacterSheetStage', () => {
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
    scope = makeTestScope('charsh')
    userCounter = 0
  })

  afterAll(async () => {
    // myth-5jdo: characters delete must precede scope user delete.
    await cleanupCharactersFor(pool, scope)
    await pool.end()
  })

  beforeEach(() => {
    vi.clearAllMocks()
  })

  async function seedMember(): Promise<SeedResult> {
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
      `INSERT INTO worlds (id, created_by, name, concept, status)
       VALUES ($1, $2, $3, 'C', 'complete')`,
      [worldId, userId, scope.worldName(n)],
    )
    await pool.query(
      `INSERT INTO campaigns (id, world_id, created_by, name)
       VALUES ($1, $2, $3, $4)`,
      [campaignId, worldId, userId, scope.campaignName(n)],
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

    const result = await runCharacterSheetStage(createRepo(pool), {
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
              hit_points, max_hit_points, armor_class, proficiency_bonus, level, name, user_id,
              gold, hit_die, hit_dice_remaining, spellcasting_progression
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
      hit_points: 10,
      max_hit_points: 10,
      armor_class: 14,
      proficiency_bonus: 2,
      level: 1,
      name: 'Bran of the Hollow',
      user_id: userId,
      // §3.2 ledger init.
      gold: 15,
      hit_die: 8,
      hit_dice_remaining: 1,
      spellcasting_progression: 'full',
    })

    // §3.2 slot rows: a level-1 full caster has exactly one row — two level-1
    // slots, written full (max = remaining).
    const slots = await pool.query(
      `SELECT slot_level, slots_max, slots_remaining
         FROM character_spell_slots WHERE character_id = $1
         ORDER BY slot_level`,
      [result.characterId],
    )
    expect(slots.rowCount).toBe(1)
    expect(slots.rows[0]).toMatchObject({
      slot_level: 1,
      slots_max: 2,
      slots_remaining: 2,
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
      `SELECT feature_name, feature_source, description, max_uses, uses_remaining, recharge
         FROM character_features WHERE character_id = $1`,
      [result.characterId],
    )
    expect(features.rowCount).toBe(1)
    expect(features.rows[0]).toMatchObject({
      feature_name: 'Divine Domain: Life',
      feature_source: 'cleric',
      description: 'extra healing for allies',
      // §3.2: untracked feature — both NULL (max IS NULL ⟺ uses_remaining IS NULL).
      max_uses: null,
      uses_remaining: null,
      recharge: 'none',
    })

    const equipment = await pool.query<{ item_name: string; quantity: number }>(
`SELECT item_name, quantity, equipped, consumable FROM character_equipment WHERE character_id = $1`,
      [result.characterId],
    )
    expect(equipment.rowCount).toBe(1)
    expect(equipment.rows[0]).toMatchObject({
      item_name: 'Mace',
      quantity: 1,
      equipped: false,
      consumable: false,
    })

    const spells = await pool.query(
      `SELECT spell_name, spell_level, prepared, ritual FROM character_spells WHERE character_id = $1`,
      [result.characterId],
    )
    expect(spells.rowCount).toBe(1)
    expect(spells.rows[0]).toMatchObject({
      spell_name: 'Cure Wounds',
      spell_level: 1,
      prepared: true,
      ritual: false,
    })
  })

  it('threads narrative.level into the rendered {{level}} placeholder', async () => {
    const { userId, worldId, campaignId } = await seedMember()

    mockGenerateText.mockResolvedValueOnce({
      // A5 coherence: at level 5 the sheet needs proficiency_bonus +3 and HP in
      // the L5 band (con-14 hit_die-8 → [22,55]); the base SHEET is L1-shaped.
      output: { ...SHEET, proficiency_bonus: 3, hit_points: 40, max_hit_points: 40 },
      finishReason: 'stop',
      usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
    } as never)

    await runCharacterSheetStage(createRepo(pool), {
      campaignId,
      userId,
      worldId,
      // A level-5 party: the rendered prompt must carry level 5, not the old
      // hardcoded level-1 framing.
      narrative: { ...NARRATIVE, level: 5 },
      worldTone: 't',
      worldEra: 'e',
    })

    const prompt = mockGenerateText.mock.calls[0]?.[0]?.prompt as string | undefined
    expect(prompt).toContain('level-5')
    // No unrendered placeholder leaks through.
    expect(prompt).not.toContain('{{level}}')
  })

  it('idempotent re-run: existing characters row is UPDATEd, sub-tables DELETEd and re-INSERTed', async () => {
    const { userId, worldId, campaignId } = await seedMember()

    // First run.
    mockGenerateText.mockResolvedValueOnce({
      output: SHEET,
      finishReason: 'stop',
      usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
    } as never)
    const first = await runCharacterSheetStage(createRepo(pool), {
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
      // L1 con-14 band ceiling is 11 (10 + 1 racial slack); the prior 12 now
      // trips A5's HP-band check. 11 still differs from SHEET's 10 (tests UPDATE).
      hit_points: 11,
      max_hit_points: 11,
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
    const second = await runCharacterSheetStage(createRepo(pool), {
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
      hit_points: 11,
      max_hit_points: 11,
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

  it('dedupe-merges equipment (SUM qty) + features/spells (keep-first) before the write', async () => {
    const { userId, worldId, campaignId } = await seedMember()

    const DUPED: CharacterSheetOutput = {
      ...SHEET,
      // Two "Healing Potion" rows (case-different) → one row, qty summed (2+3).
      equipment: [
        { name: 'Healing Potion', quantity: 2, consumable: true },
        { name: 'Mace', quantity: 1, consumable: false },
        { name: 'healing potion', quantity: 3, consumable: true },
      ],
      // Two same-name features (keep-first: the FIRST description wins).
      features: [
        { name: 'Channel Divinity', description: 'first wins', max_uses: 1, recharge: 'short_rest' },
        { name: 'channel divinity', description: 'second loses', max_uses: 2, recharge: 'long_rest' },
      ],
      // Two same-name spells (keep-first).
      spells: [
        { name: 'Cure Wounds', level: 1, prepared: true, ritual: false },
        { name: 'cure wounds', level: 1, prepared: false, ritual: false },
      ],
    }

    mockGenerateText.mockResolvedValueOnce({
      output: DUPED,
      finishReason: 'stop',
      usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
    } as never)

    const result = await runCharacterSheetStage(createRepo(pool), {
      campaignId,
      userId,
      worldId,
      narrative: NARRATIVE,
      worldTone: 't',
      worldEra: 'e',
    })

    const equipment = await pool.query<{ item_name: string; quantity: number }>(
      `SELECT item_name, quantity FROM character_equipment
         WHERE character_id = $1 ORDER BY item_name`,
      [result.characterId],
    )
    expect(equipment.rowCount).toBe(2)
    const potion = equipment.rows.find((r) => r.item_name === 'Healing Potion')
    expect(potion).toMatchObject({ item_name: 'Healing Potion', quantity: 5 })

    const features = await pool.query(
      `SELECT feature_name, description, max_uses FROM character_features WHERE character_id = $1`,
      [result.characterId],
    )
    expect(features.rowCount).toBe(1)
    expect(features.rows[0]).toMatchObject({
      feature_name: 'Channel Divinity',
      description: 'first wins',
      max_uses: 1,
    })

    const spells = await pool.query(
      `SELECT spell_name, prepared FROM character_spells WHERE character_id = $1`,
      [result.characterId],
    )
    expect(spells.rowCount).toBe(1)
    expect(spells.rows[0]).toMatchObject({ spell_name: 'Cure Wounds', prepared: true })
  })

  it('initializes a tracked feature (uses_remaining = max_uses, written full)', async () => {
    const { userId, worldId, campaignId } = await seedMember()

    const TRACKED: CharacterSheetOutput = {
      ...SHEET,
      features: [
        { name: 'Channel Divinity', description: 'turn undead', max_uses: 1, recharge: 'short_rest' },
      ],
    }
    mockGenerateText.mockResolvedValueOnce({
      output: TRACKED,
      finishReason: 'stop',
      usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
    } as never)

    const result = await runCharacterSheetStage(createRepo(pool), {
      campaignId,
      userId,
      worldId,
      narrative: NARRATIVE,
      worldTone: 't',
      worldEra: 'e',
    })

    const features = await pool.query(
      `SELECT max_uses, uses_remaining, recharge FROM character_features WHERE character_id = $1`,
      [result.characterId],
    )
    expect(features.rows[0]).toMatchObject({
      max_uses: 1,
      uses_remaining: 1,
      recharge: 'short_rest',
    })
  })

  it('regenerates on a coherence violation, then succeeds (incoherent → coherent)', async () => {
    const { userId, worldId, campaignId } = await seedMember()

    // First generation: a level-3 spell on a level-1 full caster (max slot
    // level 1) — incoherent, must trigger a regenerate.
    const INCOHERENT: CharacterSheetOutput = {
      ...SHEET,
      spells: [{ name: 'Fireball', level: 3, prepared: true, ritual: false }],
    }
    mockGenerateText
      .mockResolvedValueOnce({
        output: INCOHERENT,
        finishReason: 'stop',
        usage: { inputTokens: 5, outputTokens: 5, totalTokens: 10 },
      } as never)
      // Second generation: coherent.
      .mockResolvedValueOnce({
        output: SHEET,
        finishReason: 'stop',
        usage: { inputTokens: 7, outputTokens: 3, totalTokens: 10 },
      } as never)

    const result = await runCharacterSheetStage(createRepo(pool), {
      campaignId,
      userId,
      worldId,
      narrative: NARRATIVE,
      worldTone: 't',
      worldEra: 'e',
    })

    // Two generations happened; cost accrued across BOTH attempts.
    expect(mockGenerateText).toHaveBeenCalledTimes(2)
    expect(result.inputTokens).toBe(12)
    expect(result.outputTokens).toBe(8)

    // The persisted sheet is the coherent one (Cure Wounds, level 1).
    const spells = await pool.query(
      `SELECT spell_name FROM character_spells WHERE character_id = $1`,
      [result.characterId],
    )
    expect(spells.rows[0]).toMatchObject({ spell_name: 'Cure Wounds' })
  })

  it('terminal-fails LOUD after the coherence-retry budget is exhausted', async () => {
    const { userId, worldId, campaignId } = await seedMember()

    const INCOHERENT: CharacterSheetOutput = {
      ...SHEET,
      spells: [{ name: 'Fireball', level: 3, prepared: true, ritual: false }],
    }
    // Every attempt returns the incoherent sheet — exhausts the budget.
    mockGenerateText.mockResolvedValue({
      output: INCOHERENT,
      finishReason: 'stop',
      usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
    } as never)

    await expect(
      runCharacterSheetStage(createRepo(pool), {
        campaignId,
        userId,
        worldId,
        narrative: NARRATIVE,
        worldTone: 't',
        worldEra: 'e',
      }),
    ).rejects.toBeInstanceOf(CharacterSheetCoherenceError)

    // No character was written for this member (the write is gated on coherence).
    const join = await pool.query(
      `SELECT * FROM campaign_characters WHERE campaign_id = $1 AND user_id = $2`,
      [campaignId, userId],
    )
    expect(join.rowCount).toBe(0)
  })

  it('rethrows a NON-coherence error from the validation pass instead of retrying', async () => {
    const { userId, worldId, campaignId } = await seedMember()

    // SHEET carries a leveled spell, so validateCoherence reaches maxSlotLevel →
    // spellSlotsFor, which THROWS a plain Error (not a CharacterSheetCoherenceError)
    // on an out-of-range character level. The loop must rethrow it immediately
    // (the §138 `throw err` arm) — never swallow it as a coherence retry.
    mockGenerateText.mockResolvedValue({
      output: SHEET,
      finishReason: 'stop',
      usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
    } as never)

    await expect(
      runCharacterSheetStage(createRepo(pool), {
        campaignId,
        userId,
        worldId,
        // Out of the 1..20 range spellSlotsFor accepts → a plain Error, not a
        // coherence violation.
        narrative: { ...NARRATIVE, level: 99 },
        worldTone: 't',
        worldEra: 'e',
      }),
    ).rejects.toThrow(/level out of range/)

    // The non-coherence error short-circuits: only ONE generation, no retry budget burn.
    expect(mockGenerateText).toHaveBeenCalledTimes(1)
  })
})

// Pure-helper unit tests — no LLM, no DB; the dedupe/coherence functions are
// pure and testable directly (the plan's Step 1).
describe('character-sheet pure helpers', () => {
  describe('dedupeMergeEquipment', () => {
    it('sums quantities for normalized name collisions', () => {
      const merged = dedupeMergeEquipment([
        { name: 'Torch', quantity: 2, consumable: true },
        { name: ' torch ', quantity: 3, consumable: true },
        { name: 'Rope', quantity: 1, consumable: false },
      ])
      expect(merged).toHaveLength(2)
      expect(merged.find((e) => e.name === 'Torch')).toMatchObject({ quantity: 5 })
      expect(merged.find((e) => e.name === 'Rope')).toMatchObject({ quantity: 1 })
    })
  })

  describe('dedupeMergeFeatures', () => {
    it('keeps the first occurrence on a name collision', () => {
      const merged = dedupeMergeFeatures([
        { name: 'Rage', description: 'first', max_uses: 2, recharge: 'long_rest' },
        { name: 'rage', description: 'second', max_uses: 3, recharge: 'long_rest' },
      ])
      expect(merged).toHaveLength(1)
      expect(merged[0]).toMatchObject({ description: 'first', max_uses: 2 })
    })
  })

  describe('dedupeMergeSpells', () => {
    it('keeps the first occurrence on a name collision', () => {
      const merged = dedupeMergeSpells([
        { name: 'Light', level: 0, prepared: true, ritual: false },
        { name: 'light', level: 0, prepared: false, ritual: false },
      ])
      expect(merged).toHaveLength(1)
      expect(merged[0]).toMatchObject({ prepared: true })
    })
  })

  describe('validateCoherence', () => {
    function sheetWith(over: Partial<CharacterSheetOutput>): CharacterSheetOutput {
      return { ...SHEET, ...over }
    }

    it('passes a cantrip-only list with progression none', () => {
      expect(() =>
        { validateCoherence(
          sheetWith({
            spellcasting_progression: 'none',
            spells: [{ name: 'Light', level: 0, prepared: true, ritual: false }],
          }),
          1,
        ); },
      ).not.toThrow()
    })

    it('passes an empty spell list with progression none', () => {
      expect(() =>
        { validateCoherence(sheetWith({ spellcasting_progression: 'none', spells: [] }), 1); },
      ).not.toThrow()
    })

    it('throws when leveled spells are present with progression none', () => {
      expect(() =>
        { validateCoherence(
          sheetWith({
            spellcasting_progression: 'none',
            spells: [{ name: 'Cure Wounds', level: 1, prepared: true, ritual: false }],
          }),
          1,
        ); },
      ).toThrow(CharacterSheetCoherenceError)
    })

    it('throws when a leveled spell exceeds the max slot level', () => {
      expect(() =>
        { validateCoherence(
          sheetWith({
            spellcasting_progression: 'full',
            spells: [{ name: 'Fireball', level: 3, prepared: true, ritual: false }],
          }),
          1,
        ); },
      ).toThrow(CharacterSheetCoherenceError)
    })

    it('passes a leveled spell at exactly the max slot level', () => {
      // L5 full caster has level-3 slots (FULL_TABLE L5 = [4,3,2]). A L5 sheet
      // also needs proficiency_bonus +3 and HP in the L5 band, else the new
      // level-scaled checks fire before we reach the slot-cap assertion.
      expect(() =>
        { validateCoherence(
          sheetWith({
            spellcasting_progression: 'full',
            spells: [{ name: 'Fireball', level: 3, prepared: true, ritual: false }],
            proficiency_bonus: 3,
            max_hit_points: 40,
          }),
          5,
        ); },
      ).not.toThrow()
    })

    // MYT-90 A5: level-scaled coherence — proficiency bonus + HP band.
    it('throws when proficiency_bonus is wrong for the level (L5 needs +3)', () => {
      // HP set in-band for L5 so the ONLY failing invariant is the pb.
      expect(() =>
        { validateCoherence(sheetWith({ proficiency_bonus: 2, max_hit_points: 40 }), 5); },
      ).toThrow(/proficiency_bonus/)
    })

    it('throws when max_hit_points is above the level band (L1 over-HP)', () => {
      expect(() =>
        { validateCoherence(sheetWith({ max_hit_points: 40 }), 1); },
      ).toThrow(/max_hit_points/)
    })

    it('throws when max_hit_points is below the level band (L5 fighter under-HP)', () => {
      expect(() =>
        { validateCoherence(
          sheetWith({
            hit_die: 10,
            max_hit_points: 9,
            proficiency_bonus: 3,
            spellcasting_progression: 'none',
            spells: [],
          }),
          5,
        ); },
      ).toThrow(/max_hit_points/)
    })

    it('passes a coherent level-5 fighter (pb +3, HP in band)', () => {
      // hit_die 10, con 14 (+2), L5: floor 10+2+4*3=24, ceil 5*12+5=65.
      expect(() =>
        { validateCoherence(
          sheetWith({
            hit_die: 10,
            max_hit_points: 44,
            proficiency_bonus: 3,
            spellcasting_progression: 'none',
            spells: [],
          }),
          5,
        ); },
      ).not.toThrow()
    })

    it('passes a level-3 Hill-Dwarf sheet at the band ceiling (+1/level slack)', () => {
      // con 14 (+2), hit_die 8, L3: plain max = 3*(8+2) = 30; a Hill Dwarf adds
      // +1/level = +3 → 33 real max HP. SLACK_PER_LEVEL=1 lifts the ceiling to
      // 3*10 + 3 = 33, so 33 sits exactly at the edge and must NOT terminal-fail.
      expect(() =>
        { validateCoherence(
          sheetWith({
            hit_die: 8,
            proficiency_bonus: 2,
            max_hit_points: 33,
            spellcasting_progression: 'none',
            spells: [],
          }),
          3,
        ); },
      ).not.toThrow()
    })
  })
})
