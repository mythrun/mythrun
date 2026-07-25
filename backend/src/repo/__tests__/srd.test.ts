// backend/src/repo/__tests__/srd.test.ts
//
// myth-5nb. The SRD reference tables (migration 003) are GLOBAL — not scoped by
// world/campaign/user — and are EMPTY until the content loader runs, so this
// suite seeds its own rows and deletes them by a per-run id prefix. Every name
// carries the scope tag too, so the search assertions can't see a parallel
// fork's rows. `makeTestScope` is imported for that prefix (and to satisfy the
// mutating-test lint rule); `cleanupTestScope` cannot help here — it knows
// nothing about the srd_* tables.

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import type { Pool } from 'pg'
import { guardTestDatabase } from '../../db/__tests__/guard-db.js'
import { createRepo } from '../index.js'
import { makeTestScope, type TestScope } from './_helpers/test-scope.js'
import { createTestPool } from './_helpers/test-pool.js'

const databaseUrl = process.env.DATABASE_URL ?? ''

describe('srd repo', () => {
  let pool: Pool
  let scope: TestScope
  let tag: string

  async function deleteScopeRows(): Promise<void> {
    const like = `${scope.id}%`
    await pool.query('DELETE FROM srd_monsters WHERE id LIKE $1', [like])
    await pool.query('DELETE FROM srd_spells WHERE id LIKE $1', [like])
    await pool.query('DELETE FROM srd_conditions WHERE id LIKE $1', [like])
  }

  beforeAll(async () => {
    await guardTestDatabase(databaseUrl)
    pool = createTestPool(databaseUrl)
    scope = makeTestScope('srd')
    tag = scope.id
  })

  afterAll(async () => {
    await deleteScopeRows()
    await pool.end()
  })

  beforeEach(async () => {
    await deleteScopeRows()
    await pool.query(
      `INSERT INTO srd_monsters
         (id, name, size, type, alignment, ac, ac_type, hp, hit_dice, speed,
          str, dex, con, int, wis, cha, saving_throws, skills,
          damage_resistances, damage_immunities, damage_vulnerabilities,
          condition_immunities, senses, languages, cr, xp,
          special_abilities, actions, legendary_actions, reactions, data)
       VALUES
         ($1, $2, 'Small', 'humanoid', 'neutral evil', 15, 'leather armor', 7, '2d6',
          '{"walk":30}'::jsonb, 8, 14, 10, 10, 8, 8, NULL, '{"stealth":6}'::jsonb,
          NULL, NULL, NULL, NULL, '{"darkvision":60}'::jsonb, ARRAY['Common'],
          '1/4', 50, NULL, '[]'::jsonb, NULL, NULL, '{"src":"srd"}'::jsonb),
         ($3, $4, 'Huge', 'giant', 'chaotic evil', 13, 'natural armor', 105, '10d12',
          '{"walk":40}'::jsonb, 21, 8, 19, 5, 9, 6, NULL, NULL,
          NULL, NULL, NULL, NULL, NULL, ARRAY['Giant'],
          '5', 1800, NULL, '[]'::jsonb, NULL, NULL, NULL)`,
      [`${scope.id}-goblin`, `${tag} Goblin`, `${scope.id}-hillgiant`, `${tag} Hill Giant`],
    )
    await pool.query(
      `INSERT INTO srd_spells
         (id, name, level, school, casting_time, range, components, duration,
          concentration, description, higher_levels, damage, area_of_effect,
          save, classes, data)
       VALUES
         ($1, $2, 3, 'evocation', '1 action', '150 feet', 'V, S, M', 'Instantaneous',
          false, 'A bright streak flashes.', 'One extra d6 per slot level above 3rd.',
          '{"dice":"8d6"}'::jsonb, '{"type":"sphere","size":20}'::jsonb,
          '{"ability":"dex"}'::jsonb, ARRAY['Sorcerer','Wizard'], '{"src":"srd"}'::jsonb),
         ($3, $4, 0, 'evocation', '1 action', '120 feet', 'V, S', 'Instantaneous',
          false, 'A mote of fire.', NULL, '{"dice":"1d10"}'::jsonb, NULL, NULL,
          ARRAY['Wizard'], NULL)`,
      [`${scope.id}-fireball`, `${tag} Fireball`, `${scope.id}-acidsplash`, `${tag} Acid Splash`],
    )
    await pool.query(
      `INSERT INTO srd_conditions (id, name, description, mechanical_effects)
       VALUES ($1, $2, 'A prone creature is on the ground.', '{"speed":0}'::jsonb)`,
      [`${scope.id}-prone`, `${tag} Prone`],
    )
  })

  it('getMonster returns the full row, JSONB and array columns intact', async () => {
    const repo = createRepo(pool)
    const monster = await repo.srd.getMonster(`${scope.id}-goblin`)
    expect(monster?.name).toBe(`${tag} Goblin`)
    expect(monster?.ac).toBe(15)
    expect(monster?.hp).toBe(7)
    expect(monster?.cr).toBe('1/4')
    expect(monster?.xp).toBe(50)
    expect(monster?.speed).toEqual({ walk: 30 })
    expect(monster?.skills).toEqual({ stealth: 6 })
    expect(monster?.languages).toEqual(['Common'])
    // Nullable columns come back as null, not undefined.
    expect(monster?.savingThrows).toBeNull()
    expect(monster?.damageResistances).toBeNull()
    expect(monster?.legendaryActions).toBeNull()
  })

  it('getSpell returns the full row', async () => {
    const repo = createRepo(pool)
    const spell = await repo.srd.getSpell(`${scope.id}-fireball`)
    expect(spell?.name).toBe(`${tag} Fireball`)
    expect(spell?.level).toBe(3)
    expect(spell?.school).toBe('evocation')
    expect(spell?.concentration).toBe(false)
    expect(spell?.higherLevels).toContain('One extra d6')
    expect(spell?.areaOfEffect).toEqual({ type: 'sphere', size: 20 })
    expect(spell?.classes).toEqual(['Sorcerer', 'Wizard'])
  })

  it('getCondition returns the full row', async () => {
    const repo = createRepo(pool)
    const condition = await repo.srd.getCondition(`${scope.id}-prone`)
    expect(condition?.name).toBe(`${tag} Prone`)
    expect(condition?.description).toContain('on the ground')
    expect(condition?.mechanicalEffects).toEqual({ speed: 0 })
  })

  it('each getter returns null for an unknown id', async () => {
    const repo = createRepo(pool)
    await expect(repo.srd.getMonster('no-such-monster')).resolves.toBeNull()
    await expect(repo.srd.getSpell('no-such-spell')).resolves.toBeNull()
    await expect(repo.srd.getCondition('no-such-condition')).resolves.toBeNull()
  })

  it('searchMonsters matches a name substring, ordered by name', async () => {
    const repo = createRepo(pool)
    const found = await repo.srd.searchMonsters(tag)
    expect(found.map((m) => m.name)).toEqual([`${tag} Goblin`, `${tag} Hill Giant`])
  })

  // The fixture names differ at their FIRST letter on purpose: `ORDER BY name`
  // sorts under the DATABASE COLLATION, and a locale-aware collation ranks
  // "Fireball" before "Fire Bolt" (the space carries less weight) while C
  // collation ranks them the other way. Asserting on a first-letter difference
  // keeps this test true on any collation the dev/CI databases are built with.
  it('searchSpells matches a name substring, ordered by name', async () => {
    const repo = createRepo(pool)
    const found = await repo.srd.searchSpells(tag)
    expect(found.map((s) => s.name)).toEqual([`${tag} Acid Splash`, `${tag} Fireball`])
  })

  it('search is case-insensitive on both sides', async () => {
    const repo = createRepo(pool)
    await expect(repo.srd.searchMonsters(tag.toUpperCase())).resolves.toHaveLength(2)
    await expect(repo.srd.searchSpells(tag.toUpperCase())).resolves.toHaveLength(2)
  })

  it('search treats LIKE metacharacters as literal text, not wildcards', async () => {
    // The match is a plain substring test (strpos), so a query carrying `%`
    // finds nothing rather than silently matching everything — the failure mode
    // an `ILIKE '%' || $1 || '%'` formulation would have.
    const repo = createRepo(pool)
    await expect(repo.srd.searchMonsters('%')).resolves.toEqual([])
    await expect(repo.srd.searchSpells('_')).resolves.toEqual([])
  })

  it('search returns [] when nothing matches', async () => {
    const repo = createRepo(pool)
    await expect(repo.srd.searchMonsters(`${tag}-nope`)).resolves.toEqual([])
    await expect(repo.srd.searchSpells(`${tag}-nope`)).resolves.toEqual([])
  })

  it('search honors an explicit limit', async () => {
    const repo = createRepo(pool)
    await expect(repo.srd.searchMonsters(tag, 1)).resolves.toHaveLength(1)
    await expect(repo.srd.searchSpells(tag, 1)).resolves.toHaveLength(1)
  })
})
