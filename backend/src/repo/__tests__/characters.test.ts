import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import { fileURLToPath } from 'node:url'
import { resolve } from 'node:path'
import pino, { type DestinationStream } from 'pino'
import type { Pool } from 'pg'
import { runMigrations } from '../../db/migrate.js'
import { guardTestDatabase } from '../../db/__tests__/guard-db.js'
import { createUsersRepo } from '../users.js'
import { createWorldsRepo } from '../worlds.js'
import { createCampaignsRepo } from '../campaigns.js'
import { createCharactersRepo } from '../characters.js'
import { createSessionsRepo } from '../sessions.js'
import { createSessionParticipantsRepo } from '../session-participants.js'
import type { ClientLike } from '../_types.js'
import {
  CharacterAlreadyInCampaignError,
  UserAlreadyHasCharacterInCampaignError,
} from '../characters-errors.js'
import { cleanupTestScope, makeTestScope, type TestScope } from './_helpers/test-scope.js'
import { createTestPool } from './_helpers/test-pool.js'

// myth-5jdo: characters.user_id is RESTRICT-FK to users — must delete
// characters owned by scope users BEFORE cleanupTestScope's user delete.
// MYT-68 Task 9: session_participants.character_id is a RESTRICT-FK to
// characters, so participant rows pinning this scope's characters must go
// before the characters delete. Per-test cleanup wrapper that removes the
// scope's participant rows, then its characters, then delegates to the
// shared helper.
async function cleanupCharactersScope(p: Pool, scope: TestScope): Promise<void> {
  await p.query(
    `DELETE FROM session_participants
       WHERE character_id IN (
         SELECT id FROM characters
          WHERE user_id IN (SELECT id FROM users WHERE cognito_sub LIKE $1)
       )`,
    [`${scope.id}%`],
  )
  await p.query(
    `DELETE FROM characters
       WHERE user_id IN (SELECT id FROM users WHERE cognito_sub LIKE $1)`,
    [`${scope.id}%`],
  )
  await cleanupTestScope(p, scope)
}

const databaseUrl = process.env.DATABASE_URL ?? ''
const here = fileURLToPath(import.meta.url)
const REAL_MIGRATIONS_DIR = resolve(here, '../../../../migrations')

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

const baseCharacterInput = {
  name: 'Aila Thornwood',
  level: 1,
  class: 'Ranger',
  species: 'Half-Elf',
  background: 'Outlander',
  str: 12,
  dex: 16,
  con: 13,
  int: 11,
  wis: 14,
  cha: 10,
  hitPoints: 11,
  maxHitPoints: 11,
  armorClass: 14,
  proficiencyBonus: 2,
}

describe('repo.characters', () => {
  let pool: Pool
  let scope: TestScope
  let userId: string
  let campaignId: string

  beforeAll(async () => {
    await guardTestDatabase(databaseUrl)
    pool = createTestPool(databaseUrl)
    await runMigrations({ pool, migrationsDir: REAL_MIGRATIONS_DIR, logger: silentLogger() })
    scope = makeTestScope('chars')
  })

  afterAll(async () => {
    // myth-5jdo: cleanup only this scope's rows; the seeded dev users
    // + system user + demo world remain intact for the next test file.
    await cleanupCharactersScope(pool, scope)
    await pool.end()
  })

  beforeEach(async () => {
    // myth-5jdo: scoped cleanup replaces resetData. Removes only this
    // scope's rows; system + dev users persist via globalSetup.
    await cleanupCharactersScope(pool, scope)

    const users = createUsersRepo(pool)
    const client = await pool.connect()
    try {
      await client.query('BEGIN')
      const user = await users.create(client, {
        cognitoSub: scope.userSub(0),
        username: scope.username(0),
        displayName: scope.displayName(0),
      })
      await client.query('COMMIT')
      userId = user.id
    } finally {
      client.release()
    }

    const worlds = createWorldsRepo(pool)
    const world = await worlds.create({
      createdBy: userId,
      name: scope.worldName(0),
      concept: 'A test world.',
    })

    const campaigns = createCampaignsRepo(pool)
    const campaign = await campaigns.create({
      worldId: world.id,
      createdBy: userId,
      name: scope.campaignName(0),
    })
    campaignId = campaign.id
  })

  describe('create', () => {
    it('defensively throws when INSERT returns no row (fake client)', async () => {
      const characters = createCharactersRepo(pool)
      const fakeTx = {
        query: () => Promise.resolve({ rows: [], rowCount: 0 }),
      }
      await expect(
        characters.create(fakeTx as unknown as ClientLike, { userId, ...baseCharacterInput }),
      ).rejects.toThrow(/INSERT returned no row/)
    })

    it('returns a Character row matching the input', async () => {
      const characters = createCharactersRepo(pool)
      const client = await pool.connect()
      let created
      try {
        await client.query('BEGIN')
        created = await characters.create(client, { userId, ...baseCharacterInput })
        await client.query('COMMIT')
      } finally {
        client.release()
      }

      expect(created.id).toMatch(/^[0-9a-f-]{36}$/)
      expect(created.userId).toBe(userId)
      expect(created.name).toBe('Aila Thornwood')
      expect(created.level).toBe(1)
      expect(created.class).toBe('Ranger')
      expect(created.hitPoints).toBe(11)
      expect(created.maxHitPoints).toBe(11)
      expect(created.armorClass).toBe(14)
      expect(created.proficiencyBonus).toBe(2)
      expect(created.entityId).toBeNull()
    })
  })

  describe('addToCampaign', () => {
    it('inserts a join row on first call', async () => {
      const characters = createCharactersRepo(pool)
      const client = await pool.connect()
      let charId: string
      try {
        await client.query('BEGIN')
        const created = await characters.create(client, { userId, ...baseCharacterInput })
        await client.query('COMMIT')
        charId = created.id
      } finally {
        client.release()
      }

      await characters.addToCampaign(campaignId, charId, userId)

      const rows = await pool.query<{ count: string }>(
        `SELECT count(*)::text AS count
         FROM campaign_characters
         WHERE campaign_id = $1 AND character_id = $2 AND user_id = $3`,
        [campaignId, charId, userId],
      )
      expect(rows.rows[0]?.count).toBe('1')
    })

    it('throws CharacterAlreadyInCampaignError on duplicate (campaign_id, character_id)', async () => {
      const characters = createCharactersRepo(pool)
      const client = await pool.connect()
      let charId: string
      try {
        await client.query('BEGIN')
        const created = await characters.create(client, { userId, ...baseCharacterInput })
        await client.query('COMMIT')
        charId = created.id
      } finally {
        client.release()
      }

      await characters.addToCampaign(campaignId, charId, userId)

      await expect(characters.addToCampaign(campaignId, charId, userId)).rejects.toBeInstanceOf(
        CharacterAlreadyInCampaignError,
      )
    })

    it('rethrows non-23505 errors verbatim (FK violation 23503 from unknown campaign)', async () => {
      const characters = createCharactersRepo(pool)
      const client = await pool.connect()
      let charId: string
      try {
        await client.query('BEGIN')
        const created = await characters.create(client, { userId, ...baseCharacterInput })
        await client.query('COMMIT')
        charId = created.id
      } finally {
        client.release()
      }
      // campaignId points at a campaign that doesn't exist → FK violation 23503,
      // which is NOT 23505 and must escape the catch via the trailing rethrow.
      const phantomCampaignId = '019dccef-0000-7000-8000-000000aaaaaa'
      await expect(
        characters.addToCampaign(phantomCampaignId, charId, userId),
      ).rejects.toThrow()
    })

    it('throws UserAlreadyHasCharacterInCampaignError when same user adds a different character', async () => {
      const characters = createCharactersRepo(pool)
      const client = await pool.connect()
      let charA: string
      let charB: string
      try {
        await client.query('BEGIN')
        const a = await characters.create(client, { userId, ...baseCharacterInput })
        const b = await characters.create(client, {
          userId,
          ...baseCharacterInput,
          name: 'Borin Stoneshield',
          class: 'Fighter',
        })
        await client.query('COMMIT')
        charA = a.id
        charB = b.id
      } finally {
        client.release()
      }

      await characters.addToCampaign(campaignId, charA, userId)

      await expect(characters.addToCampaign(campaignId, charB, userId)).rejects.toBeInstanceOf(
        UserAlreadyHasCharacterInCampaignError,
      )
    })
  })

  describe('listForCampaign', () => {
    it('returns characters joined to the campaign', async () => {
      const characters = createCharactersRepo(pool)
      const users = createUsersRepo(pool)

      // Create a second user so we can have two PCs in the campaign
      const client = await pool.connect()
      let userBId: string
      let charA: string
      let charB: string
      try {
        await client.query('BEGIN')
        const userB = await users.create(client, {
          cognitoSub: scope.userSub(1),
          username: scope.username(1),
          displayName: scope.displayName(1),
        })
        userBId = userB.id

        const a = await characters.create(client, { userId, ...baseCharacterInput })
        const b = await characters.create(client, {
          userId: userBId,
          ...baseCharacterInput,
          name: 'Borin Stoneshield',
          class: 'Fighter',
        })
        await client.query('COMMIT')
        charA = a.id
        charB = b.id
      } finally {
        client.release()
      }

      await characters.addToCampaign(campaignId, charA, userId)
      await characters.addToCampaign(campaignId, charB, userBId)

      const list = await characters.listForCampaign(campaignId)

      expect(list).toHaveLength(2)
      expect(list.map((c) => c.id).sort()).toEqual([charA, charB].sort())
    })

    it('returns [] for a campaign with no characters', async () => {
      const characters = createCharactersRepo(pool)
      const list = await characters.listForCampaign(campaignId)
      expect(list).toEqual([])
    })
  })

  describe('findUserCharacterForCampaign', () => {
    it("returns the user's character when one is joined to the campaign", async () => {
      const characters = createCharactersRepo(pool)
      const client = await pool.connect()
      let charId: string
      try {
        await client.query('BEGIN')
        const created = await characters.create(client, { userId, ...baseCharacterInput })
        await client.query('COMMIT')
        charId = created.id
      } finally {
        client.release()
      }

      await characters.addToCampaign(campaignId, charId, userId)

      const found = await characters.findUserCharacterForCampaign(userId, campaignId)
      expect(found?.id).toBe(charId)
      expect(found?.userId).toBe(userId)
    })

    it('returns null when the user has no character in the campaign', async () => {
      const characters = createCharactersRepo(pool)
      const found = await characters.findUserCharacterForCampaign(userId, campaignId)
      expect(found).toBeNull()
    })
  })

  // myth-gp2c Cluster C: the 6-table character-sheet write absorbed from
  // the character-sheet stage. SQL is exercised here at the binder level;
  // the stage test (character-sheet.test.ts) covers the Zod→DB mapping.
  describe('replaceSubTables', () => {
    const sheetInput = (overrides?: Partial<Parameters<
      ReturnType<typeof createCharactersRepo>['replaceSubTables']
    >[0]>) => ({
      campaignId,
      userId,
      name: 'Bran of the Hollow',
      level: 1,
      class: 'cleric',
      species: 'human',
      background: 'acolyte',
      str: 12,
      dex: 10,
      con: 14,
      int: 13,
      wis: 16,
      cha: 11,
      hitPoints: 9,
      maxHitPoints: 9,
      armorClass: 14,
      proficiencyBonus: 2,
      skills: [{ name: 'Insight', proficiencyLevel: 'proficient' as const }],
      features: [{ name: 'Divine Domain', source: 'cleric', description: 'extra healing' }],
      equipment: [{ name: 'Mace', quantity: 1 }],
      spells: [{ name: 'Cure Wounds', level: 1, prepared: true }],
      ...overrides,
    })

    it('first run: INSERTs characters + campaign_characters join + 4 sub-tables', async () => {
      const characters = createCharactersRepo(pool)
      const characterId = await characters.replaceSubTables(sheetInput())

      expect(characterId).toMatch(/^[0-9a-f-]{36}$/)

      const c = await pool.query<{ species: string; str: number; user_id: string }>(
        `SELECT species, str, user_id FROM characters WHERE id = $1`,
        [characterId],
      )
      expect(c.rows[0]).toMatchObject({ species: 'human', str: 12, user_id: userId })

      const join = await pool.query<{ count: string }>(
        `SELECT count(*)::text AS count FROM campaign_characters
         WHERE campaign_id = $1 AND character_id = $2 AND user_id = $3`,
        [campaignId, characterId, userId],
      )
      expect(join.rows[0]?.count).toBe('1')

      const skills = await pool.query(
        `SELECT skill_name, proficiency_level FROM character_skills WHERE character_id = $1`,
        [characterId],
      )
      expect(skills.rows).toHaveLength(1)
      expect(skills.rows[0]).toMatchObject({ skill_name: 'Insight', proficiency_level: 'proficient' })

      const features = await pool.query(
        `SELECT feature_name, feature_source FROM character_features WHERE character_id = $1`,
        [characterId],
      )
      expect(features.rows[0]).toMatchObject({ feature_name: 'Divine Domain', feature_source: 'cleric' })

      const equipment = await pool.query(
        `SELECT item_name, quantity, equipped FROM character_equipment WHERE character_id = $1`,
        [characterId],
      )
      expect(equipment.rows[0]).toMatchObject({ item_name: 'Mace', quantity: 1, equipped: false })

      const spells = await pool.query(
        `SELECT spell_name, spell_level, prepared FROM character_spells WHERE character_id = $1`,
        [characterId],
      )
      expect(spells.rows[0]).toMatchObject({ spell_name: 'Cure Wounds', spell_level: 1, prepared: true })
    })

    it('re-run: UPDATEs the same characters row + DELETEs/re-INSERTs sub-tables (idempotent)', async () => {
      const characters = createCharactersRepo(pool)
      const first = await characters.replaceSubTables(sheetInput())

      const second = await characters.replaceSubTables(
        sheetInput({
          str: 18,
          hitPoints: 12,
          maxHitPoints: 12,
          skills: [
            { name: 'Religion', proficiencyLevel: 'expertise' },
            { name: 'Acrobatics', proficiencyLevel: 'none' },
          ],
        }),
      )
      expect(second).toBe(first)

      const c = await pool.query<{ str: number; hit_points: number }>(
        `SELECT str, hit_points FROM characters WHERE id = $1`,
        [first],
      )
      expect(c.rows[0]).toMatchObject({ str: 18, hit_points: 12 })

      // Exactly one join row (no second INSERT).
      const join = await pool.query<{ count: string }>(
        `SELECT count(*)::text AS count FROM campaign_characters WHERE character_id = $1`,
        [first],
      )
      expect(join.rows[0]?.count).toBe('1')

      // Sub-tables replaced, not appended.
      const skills = await pool.query<{ skill_name: string; proficiency_level: string }>(
        `SELECT skill_name, proficiency_level FROM character_skills
         WHERE character_id = $1 ORDER BY skill_name`,
        [first],
      )
      expect(skills.rows).toHaveLength(2)
      expect(skills.rows[0]).toMatchObject({ skill_name: 'Acrobatics', proficiency_level: 'none' })
      expect(skills.rows[1]).toMatchObject({ skill_name: 'Religion', proficiency_level: 'expertise' })
    })

    it('composes inside repo.transaction (tx.characters.replaceSubTables)', async () => {
      const { createRepo } = await import('../index.js')
      const repo = createRepo(pool)
      const characterId = await repo.transaction((tx) => tx.characters.replaceSubTables(sheetInput()))
      const c = await pool.query<{ id: string }>(`SELECT id FROM characters WHERE id = $1`, [
        characterId as string,
      ])
      expect(c.rows).toHaveLength(1)
    })
  })

  // myth-gp2c Cluster C: character-integration pass-4 link. Resolves the
  // characters row via campaign_characters and stamps entity_id.
  describe('linkEntityForCampaignUser', () => {
    it('sets characters.entity_id via the (campaign, user) → character_id sub-SELECT', async () => {
      const characters = createCharactersRepo(pool)
      const characterId = await characters.replaceSubTables({
        campaignId,
        userId,
        name: 'Linkable',
        level: 1,
        class: 'cleric',
        species: 'human',
        background: 'acolyte',
        str: 10, dex: 10, con: 10, int: 10, wis: 10, cha: 10,
        hitPoints: 8, maxHitPoints: 8, armorClass: 12, proficiencyBonus: 2,
        skills: [], features: [], equipment: [], spells: [],
      })

      // Seed a PC entity to link to (entities.world_id FK → the campaign's world).
      const worldRow = await pool.query<{ world_id: string }>(
        `SELECT world_id FROM campaigns WHERE id = $1`,
        [campaignId],
      )
      const worldId = worldRow.rows[0]?.world_id ?? ''
      const entityId = (await import('../uuidv7.js')).uuidv7()
      await pool.query(
        `INSERT INTO entities (id, world_id, entity_type, name, access_level)
         VALUES ($1, $2, 'pc', 'PC Link', 'known')`,
        [entityId, worldId],
      )

      await characters.linkEntityForCampaignUser({ entityId, campaignId, userId })

      const c = await pool.query<{ entity_id: string | null }>(
        `SELECT entity_id FROM characters WHERE id = $1`,
        [characterId],
      )
      expect(c.rows[0]?.entity_id).toBe(entityId)
    })
  })

  // data-layer unification: the T18 ownership check (isInCampaign), the T18
  // full-character read (getFullCharacter), and the campaign-details
  // finalized-PC list (listCampaignCharacters) absorbed from the inline reads
  // in campaign-characters.ts / campaigns.ts.
  const sheetInput = {
    name: 'Roster PC',
    level: 3,
    class: 'wizard',
    species: 'elf',
    background: 'sage',
    str: 8,
    dex: 14,
    con: 12,
    int: 17,
    wis: 11,
    cha: 10,
    hitPoints: 18,
    maxHitPoints: 18,
    armorClass: 12,
    proficiencyBonus: 2,
    skills: [{ name: 'Arcana', proficiencyLevel: 'proficient' as const }],
    features: [{ name: 'Spellcasting', source: 'class', description: 'casts spells' }],
    equipment: [{ name: 'Spellbook', quantity: 1 }],
    spells: [{ name: 'Magic Missile', level: 1, prepared: true }],
  }

  describe('isInCampaign', () => {
    it('true when the character is linked to the campaign, false otherwise', async () => {
      const characters = createCharactersRepo(pool)
      const characterId = await characters.replaceSubTables({ campaignId, userId, ...sheetInput })

      expect(await characters.isInCampaign(campaignId, characterId)).toBe(true)
      // Unknown character id → false.
      expect(
        await characters.isInCampaign(campaignId, '019dccef-0000-7000-8000-000000000000'),
      ).toBe(false)
    })
  })

  describe('getFullCharacter', () => {
    it('returns the character row + all four sub-tables', async () => {
      const characters = createCharactersRepo(pool)
      const characterId = await characters.replaceSubTables({ campaignId, userId, ...sheetInput })

      const full = await characters.getFullCharacter(characterId)
      expect(full.character?.id).toBe(characterId)
      expect(full.character?.name).toBe('Roster PC')
      expect(full.skills).toEqual([{ skill_name: 'Arcana', proficiency_level: 'proficient' }])
      expect(full.features).toEqual([
        { feature_name: 'Spellcasting', feature_source: 'class', description: 'casts spells' },
      ])
      expect(full.equipment).toEqual([{ item_name: 'Spellbook', quantity: 1, equipped: false }])
      expect(full.spells).toEqual([{ spell_name: 'Magic Missile', spell_level: 1, prepared: true }])
    })

    it('returns undefined character + empty sub-tables for an unknown id', async () => {
      const characters = createCharactersRepo(pool)
      const full = await characters.getFullCharacter('019dccef-0000-7000-8000-000000000000')
      expect(full.character).toBeUndefined()
      expect(full.skills).toEqual([])
      expect(full.features).toEqual([])
      expect(full.equipment).toEqual([])
      expect(full.spells).toEqual([])
    })
  })

  describe('listCampaignCharacters', () => {
    it('lists finalized PCs (completed/integrated concept) and excludes other statuses', async () => {
      const characters = createCharactersRepo(pool)
      const characterId = await characters.replaceSubTables({ campaignId, userId, ...sheetInput })
      // character_concepts has a composite FK (campaign_id, user_id) →
      // campaign_members; seed the membership before inserting the concept.
      const { uuidv7 } = await import('../uuidv7.js')
      await pool.query(
        `INSERT INTO campaign_members (id, campaign_id, user_id, role, invite_accepted)
         VALUES ($1, $2, $3, 'owner', true)`,
        [uuidv7(), campaignId, userId],
      )
      // The concept must be 'completed' or 'integrated' for the row to surface.
      await pool.query(
        `INSERT INTO character_concepts
           (id, campaign_id, user_id, situation_grounding_text, status)
         VALUES ($1, $2, $3, 'grounding text long enough to satisfy', 'completed')`,
        [uuidv7(), campaignId, userId],
      )

      const rows = await characters.listCampaignCharacters(campaignId)
      expect(rows).toEqual([
        {
          user_id: userId,
          character_id: characterId,
          name: 'Roster PC',
          class: 'wizard',
          level: 3,
        },
      ])

      // Flip the concept to 'submitted' — the PC should disappear from the list.
      await pool.query(
        `UPDATE character_concepts SET status = 'submitted'
         WHERE campaign_id = $1 AND user_id = $2`,
        [campaignId, userId],
      )
      expect(await characters.listCampaignCharacters(campaignId)).toEqual([])
    })
  })

  // MYT-68 Task 9 (spec §3.5 step 1): resolve a skill-check roller from the
  // SESSION roster (session_participants), exact match on normalized name.
  // A campaign member who never joined the session isn't rollable; matches
  // are session-scoped; duplicate normalized names resolve to 'ambiguous'.
  describe('findSessionParticipantCharacterByName', () => {
    // Helper: create a named character owned by `ownerId`, join it to a
    // session as a participant. Mirrors how session-participants.test.ts seeds
    // a roster (replaceSubTables to integrate the PC, then a participant row).
    // We insert the participant directly because sessionParticipants.join
    // resolves the character via campaign_characters (one PC per user per
    // campaign) — for the duplicate-name case we need two characters in one
    // session, which the direct insert allows.
    async function seedRosterCharacter(opts: {
      ownerId: string
      campaignId: string
      sessionId: string
      name: string
      skills?: readonly { name: string; proficiencyLevel: 'expertise' | 'proficient' | 'none' }[]
    }): Promise<string> {
      const characters = createCharactersRepo(pool)
      const { uuidv7 } = await import('../uuidv7.js')
      const characterId = await characters.replaceSubTables({
        campaignId: opts.campaignId,
        userId: opts.ownerId,
        name: opts.name,
        level: 2,
        class: 'rogue',
        species: 'human',
        background: 'criminal',
        str: 10,
        dex: 16,
        con: 12,
        int: 13,
        wis: 11,
        cha: 14,
        hitPoints: 14,
        maxHitPoints: 14,
        armorClass: 13,
        proficiencyBonus: 2,
        skills: (opts.skills ?? []).map((s) => ({ name: s.name, proficiencyLevel: s.proficiencyLevel })),
        features: [],
        equipment: [],
        spells: [],
      })
      await pool.query(
        `INSERT INTO session_participants (id, session_id, user_id, character_id)
         VALUES ($1, $2, $3, $4)`,
        [uuidv7(), opts.sessionId, opts.ownerId, characterId],
      )
      return characterId
    }

    it("resolves a joined participant's character by messy casing/whitespace, with skills", async () => {
      const sessions = createSessionsRepo(pool)
      const characters = createCharactersRepo(pool)
      const session = await sessions.create({ campaignId, sessionNumber: 1 })

      const arinId = await seedRosterCharacter({
        ownerId: userId,
        campaignId,
        sessionId: session.id,
        name: 'Arin',
        skills: [
          { name: 'Stealth', proficiencyLevel: 'expertise' },
          { name: 'Perception', proficiencyLevel: 'proficient' },
        ],
      })

      const result = await characters.findSessionParticipantCharacterByName(session.id, '  aRiN ')
      expect(result.outcome).toBe('found')
      if (result.outcome !== 'found') throw new Error('expected found')
      expect(result.character.id).toBe(arinId)
      expect(result.character.name).toBe('Arin')
      expect([...result.skills].sort((a, b) => a.skill_name.localeCompare(b.skill_name))).toEqual([
        { skill_name: 'Perception', proficiency_level: 'proficient' },
        { skill_name: 'Stealth', proficiency_level: 'expertise' },
      ])
    })

    it('returns not_found for a campaign member whose character never joined the session', async () => {
      const sessions = createSessionsRepo(pool)
      const characters = createCharactersRepo(pool)
      const session = await sessions.create({ campaignId, sessionNumber: 1 })

      // Integrate a PC for the campaign member but DON'T add a participant row.
      const client = await pool.connect()
      try {
        await client.query('BEGIN')
        await characters.create(client, { userId, ...baseCharacterInput, name: 'Ghost' })
        await client.query('COMMIT')
      } finally {
        client.release()
      }

      const result = await characters.findSessionParticipantCharacterByName(session.id, 'Ghost')
      expect(result).toEqual({ outcome: 'not_found' })
    })

    it("returns ambiguous when two participants' characters share a normalized name", async () => {
      const users = createUsersRepo(pool)
      const sessions = createSessionsRepo(pool)
      const characters = createCharactersRepo(pool)
      const session = await sessions.create({ campaignId, sessionNumber: 1 })

      const second = await users.create(pool, {
        cognitoSub: scope.userSub(1),
        username: scope.username(1),
        displayName: scope.displayName(1),
      })

      await seedRosterCharacter({ ownerId: userId, campaignId, sessionId: session.id, name: 'Arin' })
      await seedRosterCharacter({
        ownerId: second.id,
        campaignId,
        sessionId: session.id,
        name: 'arin ',
      })

      const result = await characters.findSessionParticipantCharacterByName(session.id, 'Arin')
      expect(result).toEqual({ outcome: 'ambiguous' })
    })

    it('is session-scoped — a participant in a different session does not match', async () => {
      const sessions = createSessionsRepo(pool)
      const characters = createCharactersRepo(pool)
      // idx_sessions_one_active permits at most one 'active' session per
      // campaign; make sessionB 'ended' so both can coexist. Session status
      // is irrelevant to roster resolution — the join is purely on session_id.
      const sessionA = await sessions.create({ campaignId, sessionNumber: 1 })
      const sessionB = await sessions.create({ campaignId, sessionNumber: 2, status: 'ended' })

      await seedRosterCharacter({ ownerId: userId, campaignId, sessionId: sessionA.id, name: 'Arin' })

      const result = await characters.findSessionParticipantCharacterByName(sessionB.id, 'Arin')
      expect(result).toEqual({ outcome: 'not_found' })
    })

    it('returns found with an empty skills array when the character has no skills', async () => {
      const sessions = createSessionsRepo(pool)
      const characters = createCharactersRepo(pool)
      const session = await sessions.create({ campaignId, sessionNumber: 1 })

      const id = await seedRosterCharacter({
        ownerId: userId,
        campaignId,
        sessionId: session.id,
        name: 'Skilless',
      })

      const result = await characters.findSessionParticipantCharacterByName(session.id, 'Skilless')
      expect(result.outcome).toBe('found')
      if (result.outcome !== 'found') throw new Error('expected found')
      expect(result.character.id).toBe(id)
      expect(result.skills).toEqual([])
    })
  })
})
