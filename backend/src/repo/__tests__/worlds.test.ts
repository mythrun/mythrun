import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import type { Pool } from 'pg'
import { guardTestDatabase } from '../../db/__tests__/guard-db.js'
import { createUsersRepo } from '../users.js'
import { createWorldsRepo } from '../worlds.js'
import { cleanupTestScope, makeTestScope, type TestScope } from './_helpers/test-scope.js'
import { createTestPool } from './_helpers/test-pool.js'

const databaseUrl = process.env.DATABASE_URL ?? ''

// myth-oehx wave 4e: resetData removed. The seeded demo world
// (019700e0-0000-7000-8000-000000000002, owned by the system user
// "system:mythrun") is NOT touched by cleanupTestScope — its cognito_sub
// doesn't match our scope prefix. The getDemo tests that mutate
// worlds.is_demo on the seeded row already wrap the mutation in a
// try/finally that restores the flag.

describe('worlds repo (integration)', () => {
  let pool: Pool
  let scope: TestScope
  let baseUserInput: { cognitoSub: string; displayName: string; username: string }

  beforeAll(async () => {
    await guardTestDatabase(databaseUrl)
    pool = createTestPool(databaseUrl)
    scope = makeTestScope('worlds')
    baseUserInput = {
      cognitoSub: scope.userSub(0),
      displayName: scope.displayName(0),
      username: scope.username(0),
    }
  })

  afterAll(async () => {
    await cleanupTestScope(pool, scope)
    await pool.end()
  })

  beforeEach(async () => {
    // myth-oehx wave 4e: scoped cleanup replaces resetData. The seeded
    // demo world + system user persist across tests; only our scope's
    // rows are removed between iterations.
    await cleanupTestScope(pool, scope)
  })

  it('create returns a populated world with default status=generating', async () => {
    const users = createUsersRepo(pool)
    const worlds = createWorldsRepo(pool)
    const owner = await users.create(pool, baseUserInput)
    const w = await worlds.create({
      createdBy: owner.id,
      name: scope.worldName(0),
      concept: 'A grim world.',
    })
    expect(w.id).toMatch(/^[0-9a-f-]{36}$/)
    expect(w.createdBy).toBe(owner.id)
    expect(w.name).toBe(scope.worldName(0))
    expect(w.status).toBe('generating')
    expect(w.forkCount).toBe(0)
    expect(w.isPublic).toBe(false)
    expect(w.language).toBe('en')
    expect(w.moderationStatus).toBe('unreviewed')
  })

  it('getById returns null for unknown world', async () => {
    const worlds = createWorldsRepo(pool)
    expect(await worlds.getById('019dccef-0000-7000-8000-000000000000')).toBeNull()
  })

  it('getById returns the world when present', async () => {
    const users = createUsersRepo(pool)
    const worlds = createWorldsRepo(pool)
    const owner = await users.create(pool, baseUserInput)
    const w = await worlds.create({ createdBy: owner.id, name: scope.worldName(0), concept: 'c' })
    const found = await worlds.getById(w.id)
    expect(found?.id).toBe(w.id)
  })

  it('update with empty patch is a no-op on every nullable field (covers ?? null=null branches)', async () => {
    const users = createUsersRepo(pool)
    const worlds = createWorldsRepo(pool)
    const owner = await users.create(pool, baseUserInput)
    const w = await worlds.create({ createdBy: owner.id, name: scope.worldName(0), concept: 'c' })
    const updated = await worlds.update(w.id, {})
    expect(updated.name).toBe(scope.worldName(0))
    expect(updated.concept).toBe('c')
  })

  it('create defensively throws when INSERT returns no row (fake pool)', async () => {
    const fakePool = {
      query: () => Promise.resolve({ rows: [], rowCount: 0 }),
    } as unknown as Pool
    const worlds = createWorldsRepo(fakePool)
    await expect(
      worlds.create({
        createdBy: '019dccef-0000-7000-8000-000000000001',
        name: 'X',
        concept: 'c',
      }),
    ).rejects.toThrow(/INSERT returned no row/)
  })

  it('listByUser returns DESC by createdAt', async () => {
    const users = createUsersRepo(pool)
    const worlds = createWorldsRepo(pool)
    const owner = await users.create(pool, baseUserInput)
    const a = await worlds.create({
      createdBy: owner.id,
      name: scope.worldName(0),
      concept: 'first',
    })
    await new Promise((r) => setTimeout(r, 5))
    const b = await worlds.create({
      createdBy: owner.id,
      name: scope.worldName(1),
      concept: 'second',
    })
    const list = await worlds.listByUser(owner.id)
    expect(list.map((w) => w.id)).toEqual([b.id, a.id])
  })

  it('listByUser returns empty array for user with no worlds', async () => {
    const users = createUsersRepo(pool)
    const worlds = createWorldsRepo(pool)
    const owner = await users.create(pool, baseUserInput)
    expect(await worlds.listByUser(owner.id)).toEqual([])
  })

  it('update bumps updatedAt and mutates supplied fields', async () => {
    const users = createUsersRepo(pool)
    const worlds = createWorldsRepo(pool)
    const owner = await users.create(pool, baseUserInput)
    const w = await worlds.create({ createdBy: owner.id, name: scope.worldName(0), concept: 'c' })
    await new Promise((r) => setTimeout(r, 5))
    const updated = await worlds.update(w.id, { name: scope.worldName(1), isPublic: true })
    expect(updated.name).toBe(scope.worldName(1))
    expect(updated.isPublic).toBe(true)
    expect(updated.concept).toBe('c')
    expect(updated.updatedAt.getTime()).toBeGreaterThan(w.updatedAt.getTime())
  })

  it('update with every patch field defined hits all COALESCE branches', async () => {
    const users = createUsersRepo(pool)
    const worlds = createWorldsRepo(pool)
    const owner = await users.create(pool, baseUserInput)
    const w = await worlds.create({ createdBy: owner.id, name: scope.worldName(0), concept: 'c' })
    const updated = await worlds.update(w.id, {
      name: scope.worldName(1),
      concept: 'new concept',
      tone: 'grim',
      themes: 'isolation',
      geographySummary: 'mountains',
      politicalSummary: 'fractured',
      era: 'twilight',
      keyTensions: 'guild vs crown',
      worldOverview: 'overview text',
      followUpQuestions: 'q1\nq2',
      startingSituations: 'opening situations',
      isPublic: true,
      moderationStatus: 'approved',
      language: 'en',
    })
    expect(updated.name).toBe(scope.worldName(1))
    expect(updated.tone).toBe('grim')
    expect(updated.era).toBe('twilight')
    expect(updated.isPublic).toBe(true)
    expect(updated.moderationStatus).toBe('approved')
  })

  it('update throws when the world does not exist', async () => {
    const worlds = createWorldsRepo(pool)
    await expect(
      worlds.update('019dccef-0000-7000-8000-000000000000', { name: 'X' }),
    ).rejects.toThrow(/no world with id/)
  })

  it('updateStatus throws when the world does not exist', async () => {
    const worlds = createWorldsRepo(pool)
    await expect(
      worlds.updateStatus('019dccef-0000-7000-8000-000000000000', 'complete'),
    ).rejects.toThrow(/no world with id/)
  })

  it('incrementForkCount throws when the world does not exist', async () => {
    const worlds = createWorldsRepo(pool)
    await expect(
      worlds.incrementForkCount('019dccef-0000-7000-8000-000000000000'),
    ).rejects.toThrow(/no world with id/)
  })

  it('updateStatus moves a world through generating → complete', async () => {
    const users = createUsersRepo(pool)
    const worlds = createWorldsRepo(pool)
    const owner = await users.create(pool, baseUserInput)
    const w = await worlds.create({ createdBy: owner.id, name: scope.worldName(0), concept: 'c' })
    expect(w.status).toBe('generating')
    const completed = await worlds.updateStatus(w.id, 'complete')
    expect(completed.status).toBe('complete')
  })

  it('incrementForkCount adds 1 atomically', async () => {
    const users = createUsersRepo(pool)
    const worlds = createWorldsRepo(pool)
    const owner = await users.create(pool, baseUserInput)
    const w = await worlds.create({ createdBy: owner.id, name: scope.worldName(0), concept: 'c' })
    expect(w.forkCount).toBe(0)
    const bumped = await worlds.incrementForkCount(w.id)
    expect(bumped.forkCount).toBe(1)
    const bumped2 = await worlds.incrementForkCount(w.id)
    expect(bumped2.forkCount).toBe(2)
  })

  describe('getDemo (MYT-43)', () => {
    it('returns the seeded demo world', async () => {
      const worlds = createWorldsRepo(pool)
      const result = await worlds.getDemo()
      if (result === null) throw new Error('expected seeded demo world')
      expect(result.isDemo).toBe(true)
      expect(result.id).toBe('019700e0-0000-7000-8000-000000000002')
      expect(result.name).toBe('Demo Adventure')
    })

    it('returns null when no demo world exists', async () => {
      const worlds = createWorldsRepo(pool)
      // myth-oehx wave 4e: temporarily flip the demo flag off. The seeded
      // row is shared state across all worlds tests in this file — the
      // try/finally restore is required so subsequent tests still see
      // is_demo=true. cleanupTestScope does NOT touch this row (its
      // cognito_sub is 'system:mythrun', not our scope prefix).
      await pool.query(
        `UPDATE worlds SET is_demo = false WHERE id = '019700e0-0000-7000-8000-000000000002'`,
      )
      try {
        const result = await worlds.getDemo()
        expect(result).toBeNull()
      } finally {
        await pool.query(
          `UPDATE worlds SET is_demo = true WHERE id = '019700e0-0000-7000-8000-000000000002'`,
        )
      }
    })

    it('toWorld correctly maps is_demo', async () => {
      const worlds = createWorldsRepo(pool)
      const result = await worlds.getDemo()
      if (result === null) throw new Error('expected seeded demo world')
      expect(result.isDemo).toBe(true)
    })
  })

  // ── World-gen stage persist writers ─────────────────────────────────────
  // Focused single-purpose column writers the world-gen stages call inside
  // their persist transactions. Each test seeds a world then round-trips the
  // exact column the writer touches. SQL is byte-identical to the prior
  // stage-local statements (data-layer-repo-unification).
  describe('world-gen stage writers', () => {
    async function seedWorld(): Promise<string> {
      const users = createUsersRepo(pool)
      const worlds = createWorldsRepo(pool)
      const owner = await users.create(pool, baseUserInput)
      const w = await worlds.create({ createdBy: owner.id, name: scope.worldName(0), concept: 'c' })
      return w.id
    }

    it('applyConcept writes the concept-intake columns (stage 1)', async () => {
      const worlds = createWorldsRepo(pool)
      const id = await seedWorld()
      await worlds.applyConcept(id, {
        name: 'Aelmoor',
        tone: 'misted, melancholy',
        themes: 'guardianship, secrets',
        geographySummary: 'drowned coast',
        politicalSummary: 'fractured guilds',
        era: 'twilight age',
        keyTensions: 'spirits chafe in lanterns',
        followUpQuestions: 'what binds the lanterns?',
      })
      const row = await pool.query<{
        name: string; tone: string; themes: string; geography_summary: string
        political_summary: string; era: string; key_tensions: string; follow_up_questions: string
      }>(
        `SELECT name, tone, themes, geography_summary, political_summary, era,
                key_tensions, follow_up_questions FROM worlds WHERE id = $1`,
        [id],
      )
      expect(row.rows[0]).toEqual({
        name: 'Aelmoor',
        tone: 'misted, melancholy',
        themes: 'guardianship, secrets',
        geography_summary: 'drowned coast',
        political_summary: 'fractured guilds',
        era: 'twilight age',
        key_tensions: 'spirits chafe in lanterns',
        follow_up_questions: 'what binds the lanterns?',
      })
    })

    // MYT-87 (T7): the world-colour stage's idempotent SET of the two-stop
    // dither identity (color_from/color_to, migration 030). Authoritative SET,
    // not a delta — a worker + an in-turn path can both write.
    it('setColorPair writes color_from + color_to (idempotent SET)', async () => {
      const worlds = createWorldsRepo(pool)
      const id = await seedWorld()
      await worlds.setColorPair(id, { from: 'sienna-200', to: 'paper-100' })
      const row = await pool.query<{ color_from: string; color_to: string }>(
        `SELECT color_from, color_to FROM worlds WHERE id = $1`,
        [id],
      )
      expect(row.rows[0]).toEqual({ color_from: 'sienna-200', color_to: 'paper-100' })
      // Idempotent: a second SET with a different pair overwrites, not appends.
      await worlds.setColorPair(id, { from: 'moss-800', to: 'paper-50' })
      const after = await pool.query<{ color_from: string; color_to: string }>(
        `SELECT color_from, color_to FROM worlds WHERE id = $1`,
        [id],
      )
      expect(after.rows[0]).toEqual({ color_from: 'moss-800', color_to: 'paper-50' })
    })

    it('setVocabularyRegistry writes the registry jsonb (stage 1.5)', async () => {
      const worlds = createWorldsRepo(pool)
      const id = await seedWorld()
      const registry = {
        entries: [
          { term: 'the unwitched', definition: 'non-magical people', avoids: 'muggle', source: 'stage_1_5', access_level: 'known' },
        ],
        adjacent_franchises: ['Harry Potter'],
      }
      await worlds.setVocabularyRegistry(id, JSON.stringify(registry))
      const row = await pool.query<{ vocabulary_registry: unknown }>(
        `SELECT vocabulary_registry FROM worlds WHERE id = $1`,
        [id],
      )
      expect(row.rows[0]?.vocabulary_registry).toEqual(registry)
    })

    // myth-gp2c Cluster C: raw vocabulary read for character-integration's
    // prompt rendering (returns the column verbatim; null when no world).
    it('getVocabularyRegistryRaw returns the raw registry blob, or null for unknown world', async () => {
      const worlds = createWorldsRepo(pool)
      const id = await seedWorld()
      const registry = { entries: [{ term: 'kine', definition: 'cattle' }], adjacent_franchises: [] }
      await worlds.setVocabularyRegistry(id, JSON.stringify(registry))
      expect(await worlds.getVocabularyRegistryRaw(id)).toEqual(registry)
      expect(
        await worlds.getVocabularyRegistryRaw('019dccef-0000-7000-8000-000000000000'),
      ).toBeNull()
    })

    it('setWorldOverview writes the overview + bumps updated_at (stage 2)', async () => {
      const worlds = createWorldsRepo(pool)
      const id = await seedWorld()
      const before = await pool.query<{ updated_at: Date }>(
        `SELECT updated_at FROM worlds WHERE id = $1`, [id],
      )
      await new Promise((r) => setTimeout(r, 5))
      await worlds.setWorldOverview(id, 'A sweeping overview of the drowned coast.')
      const row = await pool.query<{ world_overview: string; updated_at: Date }>(
        `SELECT world_overview, updated_at FROM worlds WHERE id = $1`, [id],
      )
      expect(row.rows[0]?.world_overview).toBe('A sweeping overview of the drowned coast.')
      const beforeAt = before.rows[0]?.updated_at
      const afterAt = row.rows[0]?.updated_at
      if (!beforeAt || !afterAt) throw new Error('updated_at lookup failed')
      expect(afterAt.getTime()).toBeGreaterThan(beforeAt.getTime())
    })

    it('setEntityConsolidationPending then getEntityConsolidationPending round-trips the buffer (stage 4 ↔ 4b)', async () => {
      const worlds = createWorldsRepo(pool)
      const id = await seedWorld()
      const pending = {
        declarations: [{ placeholderId: 'new-001', name: 'The Ironjaw', entityType: 'faction' }],
        relationships: [{ from: 'new-001', to: 'ent-x', relationship: 'rival_of', description: 'd' }],
      }
      await worlds.setEntityConsolidationPending(id, JSON.stringify(pending))
      const got = await worlds.getEntityConsolidationPending(id)
      expect(got).toEqual(pending)
    })

    it('getEntityConsolidationPending returns the empty-arrays default for a fresh world', async () => {
      const worlds = createWorldsRepo(pool)
      const id = await seedWorld()
      // migration 017's column default is {"declarations": [], "relationships": []}.
      const got = await worlds.getEntityConsolidationPending(id)
      expect(got).toEqual({ declarations: [], relationships: [] })
    })

    it('getEntityConsolidationPending returns null for an unknown world', async () => {
      const worlds = createWorldsRepo(pool)
      const got = await worlds.getEntityConsolidationPending('019dccef-0000-7000-8000-000000000000')
      expect(got).toBeNull()
    })

    it('clearEntityConsolidationPending resets the buffer to empty arrays (stage 4b)', async () => {
      const worlds = createWorldsRepo(pool)
      const id = await seedWorld()
      await worlds.setEntityConsolidationPending(
        id,
        JSON.stringify({ declarations: [{ placeholderId: 'new-001', name: 'X', entityType: 'npc' }], relationships: [] }),
      )
      await worlds.clearEntityConsolidationPending(id)
      const got = await worlds.getEntityConsolidationPending(id)
      expect(got).toEqual({ declarations: [], relationships: [] })
    })

    it('setWorldIntroduction then getWorldIntroduction round-trips the intro (myth-zaqxh)', async () => {
      const worlds = createWorldsRepo(pool)
      const id = await seedWorld()
      const intro = {
        prose: 'Ashfall runs on debt and ash-glass, and the Ashen Court taxes every gate.',
        references: [{ entityId: '019dccef-0000-7000-8000-000000000abc', name: 'The Ashen Court' }],
      }
      await worlds.setWorldIntroduction(id, JSON.stringify(intro))
      const got = await worlds.getWorldIntroduction(id)
      expect(got).toEqual(intro)
    })

    it('getWorldIntroduction returns null for a fresh world (unset column) and an unknown world', async () => {
      const worlds = createWorldsRepo(pool)
      const id = await seedWorld()
      expect(await worlds.getWorldIntroduction(id)).toBeNull()
      expect(
        await worlds.getWorldIntroduction('019dccef-0000-7000-8000-000000000000'),
      ).toBeNull()
    })

    it('setStartingSituations writes the picker prose blob (stage 6, TEXT column)', async () => {
      const worlds = createWorldsRepo(pool)
      const id = await seedWorld()
      const situationsJson = JSON.stringify([{ title: 'The Drowned Bell', prose: 'You wake to bells.' }])
      await worlds.setStartingSituations(id, situationsJson)
      const row = await pool.query<{ starting_situations: string }>(
        `SELECT starting_situations FROM worlds WHERE id = $1`, [id],
      )
      expect(row.rows[0]?.starting_situations).toBe(situationsJson)
    })

    it('setStartingSituationEntries writes the resolved entries jsonb (stage 6)', async () => {
      const worlds = createWorldsRepo(pool)
      const id = await seedWorld()
      const entries = [{ index: 0, locationEntityId: '019dccef-0000-7000-8000-000000000abc' }]
      await worlds.setStartingSituationEntries(id, JSON.stringify(entries))
      const row = await pool.query<{ starting_situation_entries: unknown }>(
        `SELECT starting_situation_entries FROM worlds WHERE id = $1`, [id],
      )
      expect(row.rows[0]?.starting_situation_entries).toEqual(entries)
    })

    // ── world-gen processor status writers (data-layer unification) ──────────

    it('markComplete flips status to complete (no updated_at touch, no RETURNING)', async () => {
      const worlds = createWorldsRepo(pool)
      const id = await seedWorld()
      await worlds.markComplete(id)
      const row = await pool.query<{ status: string }>(`SELECT status FROM worlds WHERE id = $1`, [id])
      expect(row.rows[0]?.status).toBe('complete')
    })

    it('markFailed flips status to failed', async () => {
      const worlds = createWorldsRepo(pool)
      const id = await seedWorld()
      await worlds.markFailed(id)
      const row = await pool.query<{ status: string }>(`SELECT status FROM worlds WHERE id = $1`, [id])
      expect(row.rows[0]?.status).toBe('failed')
    })

    it('resetFailedToGenerating flips a failed world back to generating (guarded)', async () => {
      const worlds = createWorldsRepo(pool)
      const id = await seedWorld()
      await worlds.markFailed(id)
      await worlds.resetFailedToGenerating(id)
      const row = await pool.query<{ status: string }>(`SELECT status FROM worlds WHERE id = $1`, [id])
      expect(row.rows[0]?.status).toBe('generating')
    })

    it('resetFailedToGenerating is a no-op when status is not failed (AND status guard)', async () => {
      const worlds = createWorldsRepo(pool)
      const id = await seedWorld()
      await worlds.markComplete(id) // status='complete' — the guard rejects the reset
      await worlds.resetFailedToGenerating(id)
      const row = await pool.query<{ status: string }>(`SELECT status FROM worlds WHERE id = $1`, [id])
      expect(row.rows[0]?.status).toBe('complete') // unchanged
    })

    it('getWorldOverview returns the overview, or "" when null', async () => {
      const worlds = createWorldsRepo(pool)
      const id = await seedWorld()
      expect(await worlds.getWorldOverview(id)).toBe('') // fresh world: null → ''
      await worlds.setWorldOverview(id, 'A drowned coast under twilight.')
      expect(await worlds.getWorldOverview(id)).toBe('A drowned coast under twilight.')
    })

    it('getWorldOverview returns "" for an unknown world', async () => {
      const worlds = createWorldsRepo(pool)
      expect(await worlds.getWorldOverview('019dccef-0000-7000-8000-000000000000')).toBe('')
    })
  })

  // data-layer unification: focused reads/writes absorbed from inline SQL in
  // campaign-characters.ts / campaigns.ts / the character-creation processor.
  describe('route/processor read+write methods', () => {
    async function seedWorld(): Promise<string> {
      const users = createUsersRepo(pool)
      const worlds = createWorldsRepo(pool)
      const owner = await users.create(pool, baseUserInput)
      const w = await worlds.create({ createdBy: owner.id, name: scope.worldName(0), concept: 'c' })
      return w.id
    }

    it('getStatus returns the world status; null for unknown', async () => {
      const worlds = createWorldsRepo(pool)
      const id = await seedWorld()
      expect(await worlds.getStatus(id)).toBe('generating')
      await worlds.markComplete(id)
      expect(await worlds.getStatus(id)).toBe('complete')
      expect(await worlds.getStatus('019dccef-0000-7000-8000-000000000000')).toBeNull()
    })

    it('getStartingSituationEntries returns the JSONB; [] when unset/unknown', async () => {
      const worlds = createWorldsRepo(pool)
      const id = await seedWorld()
      // Fresh world: column defaults to '[]'.
      expect(await worlds.getStartingSituationEntries(id)).toEqual([])
      const entries = [{ index: 0, locationEntityId: 'e1', prose: 'A tavern.' }]
      await worlds.setStartingSituationEntries(id, JSON.stringify(entries))
      expect(await worlds.getStartingSituationEntries(id)).toEqual(entries)
      expect(
        await worlds.getStartingSituationEntries('019dccef-0000-7000-8000-000000000000'),
      ).toEqual([])
    })

    it('deleteById removes the world row', async () => {
      const worlds = createWorldsRepo(pool)
      const id = await seedWorld()
      await worlds.deleteById(id)
      expect(await worlds.getById(id)).toBeNull()
    })

    it('getCharacterConceptContext returns the prep columns + raw vocab; null for unknown', async () => {
      const worlds = createWorldsRepo(pool)
      const id = await seedWorld()
      await worlds.applyConcept(id, {
        name: 'Aelmoor',
        tone: 'misted',
        themes: 'secrets',
        geographySummary: 'drowned coast',
        politicalSummary: 'fractured guilds',
        era: 'twilight',
        keyTensions: 'spirits chafe',
        followUpQuestions: 'q?',
      })
      const ctx = await worlds.getCharacterConceptContext(id)
      expect(ctx?.name).toBe('Aelmoor')
      expect(ctx?.tone).toBe('misted')
      expect(ctx?.geography_summary).toBe('drowned coast')
      expect(ctx?.political_summary).toBe('fractured guilds')
      expect(ctx?.key_tensions).toBe('spirits chafe')
      // vocabulary_registry is the raw JSONB blob (default shape).
      expect(ctx?.vocabulary_registry).toBeDefined()
      expect(
        await worlds.getCharacterConceptContext('019dccef-0000-7000-8000-000000000000'),
      ).toBeNull()
    })

    it('getToneAndEra returns tone + era; null for unknown', async () => {
      const worlds = createWorldsRepo(pool)
      const id = await seedWorld()
      await worlds.applyConcept(id, {
        name: 'n',
        tone: 'grim',
        themes: 't',
        geographySummary: 'g',
        politicalSummary: 'p',
        era: 'late age',
        keyTensions: 'k',
        followUpQuestions: 'f',
      })
      expect(await worlds.getToneAndEra(id)).toEqual({ tone: 'grim', era: 'late age' })
      expect(await worlds.getToneAndEra('019dccef-0000-7000-8000-000000000000')).toBeNull()
    })
  })
})
