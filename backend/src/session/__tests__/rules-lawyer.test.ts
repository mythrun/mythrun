// backend/src/session/__tests__/rules-lawyer.test.ts
//
// MYT-70 Task 8 — cast / spend / acquire resolvers against REAL PG (scoped
// fixtures per CONVENTIONS.md). The guard predicates in characters-ledger.ts
// ARE the behavior under test, so a fake LedgerOps would re-implement and
// defeat them; we seed real rows and run real transactions.

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import { fileURLToPath } from 'node:url'
import { resolve } from 'node:path'
import pino, { type DestinationStream } from 'pino'
import type { Pool } from 'pg'
import { runMigrations } from '../../db/migrate.js'
import { guardTestDatabase } from '../../db/__tests__/guard-db.js'
import { createUsersRepo } from '../../repo/users.js'
import { createWorldsRepo } from '../../repo/worlds.js'
import { createCampaignsRepo } from '../../repo/campaigns.js'
import { createCharactersRepo } from '../../repo/characters.js'
import { createSessionsRepo } from '../../repo/sessions.js'
import { charactersLedgerNs, type LedgerOps } from '../../repo/characters-ledger.js'
import { uuidv7 } from '../../repo/uuidv7.js'
import {
  cleanupTestScope,
  makeTestScope,
  type TestScope,
} from '../../repo/__tests__/_helpers/test-scope.js'
import { createTestPool } from '../../repo/__tests__/_helpers/test-pool.js'
import { resolveCastSpell, resolveSpendResource, resolveAcquireResource } from '../rules-lawyer-resources.js'
import type { RulesLawyerDeps, LedgerTxRunner } from '../rules-lawyer.js'

const databaseUrl = process.env.DATABASE_URL ?? ''
const here = fileURLToPath(import.meta.url)
const REAL_MIGRATIONS_DIR = resolve(here, '../../../../migrations')

function silentLogger(): ReturnType<typeof pino> {
  const sink: DestinationStream = { write: () => undefined }
  return pino({ base: { component: 'rl-test' } }, sink)
}

async function cleanupScope(p: Pool, scope: TestScope): Promise<void> {
  await p.query(
    `DELETE FROM session_participants
       WHERE character_id IN (
         SELECT id FROM characters
          WHERE user_id IN (SELECT id FROM users WHERE cognito_sub LIKE $1))`,
    [`${scope.id}%`],
  )
  await p.query(
    `DELETE FROM characters
       WHERE user_id IN (SELECT id FROM users WHERE cognito_sub LIKE $1)`,
    [`${scope.id}%`],
  )
  await cleanupTestScope(p, scope)
}

interface SeedSpell {
  name: string
  level: number
  prepared: boolean
  ritual: boolean
}
interface SeedItem {
  name: string
  quantity: number
  consumable: boolean
}
interface SeedFeature {
  name: string
  maxUses: number | null
  recharge: 'short_rest' | 'long_rest' | 'none'
}

describe('rules-lawyer resources (cast / spend / acquire)', () => {
  let pool: Pool
  let scope: TestScope
  let userId: string
  let campaignId: string
  let sessionId: string

  beforeAll(async () => {
    await guardTestDatabase(databaseUrl)
    pool = createTestPool(databaseUrl)
    await runMigrations({ pool, migrationsDir: REAL_MIGRATIONS_DIR, logger: silentLogger() })
    scope = makeTestScope('rules-lawyer')
  })

  afterAll(async () => {
    await cleanupScope(pool, scope)
    await pool.end()
  })

  beforeEach(async () => {
    await cleanupScope(pool, scope)
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
    const world = await createWorldsRepo(pool).create({
      createdBy: userId,
      name: scope.worldName(0),
      concept: 'A test world.',
    })
    const campaign = await createCampaignsRepo(pool).create({
      worldId: world.id,
      createdBy: userId,
      name: scope.campaignName(0),
    })
    campaignId = campaign.id
    const session = await createSessionsRepo(pool).create({ campaignId, sessionNumber: 1 })
    sessionId = session.id
  })

  async function seedCharacter(opts: {
    name: string
    level?: number
    gold?: number
    hitDie?: 6 | 8 | 10 | 12
    hitDiceRemaining?: number
    progression?: 'full' | 'half' | 'third' | 'pact' | 'none'
    slotRows?: readonly { slotLevel: number; max: number }[]
    spells?: readonly SeedSpell[]
    equipment?: readonly SeedItem[]
    features?: readonly SeedFeature[]
  }): Promise<string> {
    const characters = createCharactersRepo(pool)
    const level = opts.level ?? 5
    const characterId = await characters.replaceSubTables({
      campaignId,
      userId,
      name: opts.name,
      level,
      class: 'wizard',
      species: 'human',
      background: 'sage',
      str: 10,
      dex: 12,
      con: 14,
      int: 16,
      wis: 11,
      cha: 9,
      hitPoints: 20,
      maxHitPoints: 20,
      armorClass: 12,
      proficiencyBonus: 3,
      startingGold: opts.gold ?? 100,
      hitDie: opts.hitDie ?? 6,
      hitDiceRemaining: opts.hitDiceRemaining ?? level,
      spellcastingProgression: opts.progression ?? 'none',
      slotRows: opts.slotRows ?? [],
      skills: [],
      features: (opts.features ?? []).map((f) => ({
        name: f.name,
        source: 'class',
        description: 'x',
        maxUses: f.maxUses,
        recharge: f.recharge,
      })),
      equipment: (opts.equipment ?? []).map((e) => ({
        name: e.name,
        quantity: e.quantity,
        consumable: e.consumable,
      })),
      spells: (opts.spells ?? []).map((s) => ({
        name: s.name,
        level: s.level,
        prepared: s.prepared,
        ritual: s.ritual,
      })),
    })
    await pool.query(
      `INSERT INTO session_participants (id, session_id, user_id, character_id) VALUES ($1,$2,$3,$4)`,
      [uuidv7(), sessionId, userId, characterId],
    )
    return characterId
  }

  function makeRunInTx(): LedgerTxRunner {
    return async (fn) => {
      const c = await pool.connect()
      try {
        await c.query('BEGIN')
        const out = await fn(charactersLedgerNs({ query: (t, v) => c.query(t, v) }))
        await c.query('COMMIT')
        return out
      } catch (err) {
        await c.query('ROLLBACK').catch(() => undefined)
        throw err
      } finally {
        c.release()
      }
    }
  }

  function makeDeps(overrides?: Partial<RulesLawyerDeps>): RulesLawyerDeps {
    return {
      ledger: charactersLedgerNs({ query: (t, v) => pool.query(t, v) }),
      runInTx: makeRunInTx(),
      sessionId,
      turnId: 'turn-1',
      toolCallId: `call-${uuidv7()}`,
      // A real (silent) logger so the resolver's warn paths are exercised.
      logger: { warn: () => undefined },
      ...overrides,
    }
  }

  async function readGold(id: string): Promise<number> {
    const r = await pool.query<{ gold: number }>(`SELECT gold FROM characters WHERE id = $1`, [id])
    return r.rows[0]?.gold ?? -1
  }
  async function readSlot(id: string, level: number): Promise<number> {
    const r = await pool.query<{ slots_remaining: number }>(
      `SELECT slots_remaining FROM character_spell_slots WHERE character_id = $1 AND slot_level = $2`,
      [id, level],
    )
    return r.rows[0]?.slots_remaining ?? -1
  }
  async function readItemQty(id: string, name: string): Promise<number | null> {
    const r = await pool.query<{ quantity: number }>(
      `SELECT quantity FROM character_equipment WHERE character_id = $1 AND lower(btrim(item_name)) = lower(btrim($2))`,
      [id, name],
    )
    return r.rows[0]?.quantity ?? null
  }
  async function countJournal(): Promise<number> {
    const r = await pool.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM ledger_events WHERE session_id = $1`,
      [sessionId],
    )
    return Number(r.rows[0]?.n ?? '0')
  }

  // ---- character resolution -------------------------------------------------

  it('not_found character → informational miss (non-binding)', async () => {
    const res = await resolveSpendResource(makeDeps(), {
      kind: 'gold',
      character_name: 'Nobody',
      amount: 5,
    })
    expect(res.ok).toBe(false)
    if (res.ok) throw new Error('expected reject')
    expect(res.binding).toBe(false)
    expect(res.found).toBe(false)
    expect(res.constraint).toMatch(/Nobody/)
  })

  it('ambiguous character → informational miss', async () => {
    await seedCharacter({ name: 'Twin' })
    // Second participant with the same name (different user) → ambiguous.
    const users = createUsersRepo(pool)
    const c = await pool.connect()
    let otherUser: string
    try {
      await c.query('BEGIN')
      const u = await users.create(c, {
        cognitoSub: scope.userSub(1),
        username: scope.username(1),
        displayName: scope.displayName(1),
      })
      await c.query('COMMIT')
      otherUser = u.id
    } finally {
      c.release()
    }
    const characters = createCharactersRepo(pool)
    const twin2 = await characters.replaceSubTables({
      campaignId,
      userId: otherUser,
      name: 'Twin',
      level: 1,
      class: 'wizard',
      species: 'human',
      background: 'sage',
      str: 10, dex: 10, con: 10, int: 10, wis: 10, cha: 10,
      hitPoints: 8, maxHitPoints: 8, armorClass: 10, proficiencyBonus: 2,
      startingGold: 0, hitDie: 6, hitDiceRemaining: 1, spellcastingProgression: 'none',
      slotRows: [], skills: [], features: [], equipment: [], spells: [],
    })
    await pool.query(
      `INSERT INTO session_participants (id, session_id, user_id, character_id) VALUES ($1,$2,$3,$4)`,
      [uuidv7(), sessionId, otherUser, twin2],
    )
    const res = await resolveSpendResource(makeDeps(), { kind: 'gold', character_name: 'Twin', amount: 1 })
    expect(res.ok).toBe(false)
    if (res.ok) throw new Error('expected reject')
    expect(res.found).toBe(false)
  })

  // ---- spend_resource: gold -------------------------------------------------

  it('spend gold: success debits + journals', async () => {
    const id = await seedCharacter({ name: 'Spender', gold: 50 })
    const res = await resolveSpendResource(makeDeps(), { kind: 'gold', character_name: 'Spender', amount: 30 })
    expect(res.ok).toBe(true)
    if (!res.ok) throw new Error('expected ok')
    expect(res.payload.kind).toBe('gold')
    expect(res.payload.gold).toBe(20)
    expect(await readGold(id)).toBe(20)
    expect(await countJournal()).toBe(1)
  })

  it('spend gold: insufficient → binding with actual balance, no debit', async () => {
    const id = await seedCharacter({ name: 'Broke', gold: 5 })
    const res = await resolveSpendResource(makeDeps(), { kind: 'gold', character_name: 'Broke', amount: 30 })
    expect(res.ok).toBe(false)
    if (res.ok) throw new Error('expected reject')
    expect(res.binding).toBe(true)
    expect(res.constraint).toMatch(/5 gold/)
    expect(await readGold(id)).toBe(5)
    expect(await countJournal()).toBe(0)
  })

  // ---- spend_resource: item -------------------------------------------------

  it('spend item: success decrements + journals', async () => {
    const id = await seedCharacter({ name: 'Potter', equipment: [{ name: 'Healing Potion', quantity: 2, consumable: true }] })
    const res = await resolveSpendResource(makeDeps(), { kind: 'item', character_name: 'Potter', name: 'healing potion' })
    expect(res.ok).toBe(true)
    if (!res.ok) throw new Error('expected ok')
    expect(res.payload.quantity).toBe(1)
    expect(await readItemQty(id, 'Healing Potion')).toBe(1)
  })

  it('spend item: present-but-0 → binding (row retained), not a miss', async () => {
    const id = await seedCharacter({ name: 'Empty', equipment: [{ name: 'Torch', quantity: 0, consumable: true }] })
    const res = await resolveSpendResource(makeDeps(), { kind: 'item', character_name: 'Empty', name: 'Torch' })
    expect(res.ok).toBe(false)
    if (res.ok) throw new Error('expected reject')
    expect(res.binding).toBe(true)
    expect(await readItemQty(id, 'Torch')).toBe(0)
  })

  it('spend item: unknown item → informational miss (three-branch guidance)', async () => {
    await seedCharacter({ name: 'Rocky' })
    const res = await resolveSpendResource(makeDeps(), { kind: 'item', character_name: 'Rocky', name: 'a rock' })
    expect(res.ok).toBe(false)
    if (res.ok) throw new Error('expected reject')
    expect(res.binding).toBe(false)
    expect(res.found).toBe(false)
    expect(res.constraint).toMatch(/acquire_resource/)
  })

  // ---- spend_resource: feature ----------------------------------------------

  it('spend feature: tracked use decrements + journals', async () => {
    await seedCharacter({ name: 'Channeler', features: [{ name: 'Channel Divinity', maxUses: 2, recharge: 'short_rest' }] })
    const res = await resolveSpendResource(makeDeps(), { kind: 'feature', character_name: 'Channeler', name: 'Channel Divinity' })
    expect(res.ok).toBe(true)
    if (!res.ok) throw new Error('expected ok')
    expect(res.payload.usesRemaining).toBe(1)
  })

  it('spend feature: exhausted → binding naming recharge', async () => {
    await seedCharacter({ name: 'Drained' })
    // Seed a tracked feature already at 0 via direct write (replaceSubTables writes full).
    const idRow = await pool.query<{ id: string }>(
      `SELECT id FROM characters WHERE name = 'Drained' AND user_id = $1`, [userId],
    )
    const id = idRow.rows[0]?.id ?? ''
    await pool.query(
      `INSERT INTO character_features (id, character_id, feature_name, feature_source, description, max_uses, uses_remaining, recharge)
       VALUES ($1,$2,'Second Wind','class','x',1,0,'short_rest')`,
      [uuidv7(), id],
    )
    const res = await resolveSpendResource(makeDeps(), { kind: 'feature', character_name: 'Drained', name: 'Second Wind' })
    expect(res.ok).toBe(false)
    if (res.ok) throw new Error('expected reject')
    expect(res.binding).toBe(true)
    expect(res.constraint).toMatch(/short rest/)
  })

  it('spend feature: untracked (no counter) → success, no usesRemaining', async () => {
    await seedCharacter({ name: 'AtWill', features: [{ name: 'Darkvision', maxUses: null, recharge: 'none' }] })
    const res = await resolveSpendResource(makeDeps(), { kind: 'feature', character_name: 'AtWill', name: 'Darkvision' })
    expect(res.ok).toBe(true)
    if (!res.ok) throw new Error('expected ok')
    expect(res.payload.usesRemaining).toBeUndefined()
  })

  // ---- acquire_resource -----------------------------------------------------

  it('acquire gold: credits + journals', async () => {
    const id = await seedCharacter({ name: 'Earner', gold: 10 })
    const res = await resolveAcquireResource(makeDeps(), { kind: 'gold', character_name: 'Earner', amount: 40 })
    expect(res.ok).toBe(true)
    if (!res.ok) throw new Error('expected ok')
    expect(res.payload.gold).toBe(50)
    expect(await readGold(id)).toBe(50)
  })

  it('acquire item: upserts (new + stacking) + journals', async () => {
    const id = await seedCharacter({ name: 'Collector', equipment: [{ name: 'Arrow', quantity: 5, consumable: true }] })
    const res = await resolveAcquireResource(makeDeps(), { kind: 'item', character_name: 'Collector', name: 'arrow', amount: 10, consumable: true })
    expect(res.ok).toBe(true)
    if (!res.ok) throw new Error('expected ok')
    expect(res.payload.quantity).toBe(15)
    expect(await readItemQty(id, 'Arrow')).toBe(15)
  })

  // ---- cast_spell: slot selection -------------------------------------------

  it('cast: omitted slot → lowest available ≥ spell level', async () => {
    const id = await seedCharacter({
      name: 'Caster', progression: 'full',
      slotRows: [{ slotLevel: 1, max: 1 }, { slotLevel: 2, max: 1 }],
      spells: [{ name: 'Magic Missile', level: 1, prepared: true, ritual: false }],
    })
    // Empty the L1 slot so lowest-available is L2.
    await pool.query(`UPDATE character_spell_slots SET slots_remaining = 0 WHERE character_id = $1 AND slot_level = 1`, [id])
    const res = await resolveCastSpell(makeDeps(), { character_name: 'Caster', spell_name: 'Magic Missile' })
    expect(res.ok).toBe(true)
    if (!res.ok) throw new Error('expected ok')
    expect(res.payload.slotLevel).toBe(2)
    expect(await readSlot(id, 2)).toBe(0)
  })

  it('cast: explicit slot_level = exact upcast', async () => {
    const id = await seedCharacter({
      name: 'Upcaster', progression: 'full',
      slotRows: [{ slotLevel: 1, max: 2 }, { slotLevel: 3, max: 2 }],
      spells: [{ name: 'Magic Missile', level: 1, prepared: true, ritual: false }],
    })
    const res = await resolveCastSpell(makeDeps(), { character_name: 'Upcaster', spell_name: 'Magic Missile', slot_level: 3 })
    expect(res.ok).toBe(true)
    if (!res.ok) throw new Error('expected ok')
    expect(res.payload.slotLevel).toBe(3)
    expect(await readSlot(id, 3)).toBe(1)
    expect(await readSlot(id, 1)).toBe(2)
  })

  it('cast: pact-level slot casting (lowest available)', async () => {
    const id = await seedCharacter({
      name: 'Warlock', progression: 'pact',
      slotRows: [{ slotLevel: 3, max: 2 }],
      spells: [{ name: 'Eldritch Blast', level: 0, prepared: true, ritual: false }, { name: 'Hex', level: 1, prepared: true, ritual: false }],
    })
    const res = await resolveCastSpell(makeDeps(), { character_name: 'Warlock', spell_name: 'Hex' })
    expect(res.ok).toBe(true)
    if (!res.ok) throw new Error('expected ok')
    expect(res.payload.slotLevel).toBe(3)
    expect(await readSlot(id, 3)).toBe(1)
  })

  it('cast: no castable slot ≥ level → binding empty-set message, no debit', async () => {
    const id = await seedCharacter({
      name: 'Tapped', progression: 'full',
      slotRows: [{ slotLevel: 1, max: 1 }],
      spells: [{ name: 'Fireball', level: 3, prepared: true, ritual: false }],
    })
    const res = await resolveCastSpell(makeDeps(), { character_name: 'Tapped', spell_name: 'Fireball' })
    expect(res.ok).toBe(false)
    if (res.ok) throw new Error('expected reject')
    expect(res.binding).toBe(true)
    expect(res.constraint).toMatch(/level 3 or higher/)
    expect(await readSlot(id, 1)).toBe(1)
  })

  it('cast: known-but-unprepared → binding naming castable set', async () => {
    await seedCharacter({
      name: 'Unprepped', progression: 'full',
      slotRows: [{ slotLevel: 1, max: 2 }],
      spells: [
        { name: 'Shield', level: 1, prepared: false, ritual: false },
        { name: 'Mage Armor', level: 1, prepared: true, ritual: false },
      ],
    })
    const res = await resolveCastSpell(makeDeps(), { character_name: 'Unprepped', spell_name: 'Shield' })
    expect(res.ok).toBe(false)
    if (res.ok) throw new Error('expected reject')
    expect(res.binding).toBe(true)
    expect(res.constraint).toMatch(/Mage Armor/)
  })

  it('cast: unknown spell → informational branch-3 miss', async () => {
    await seedCharacter({ name: 'Novice', progression: 'full', slotRows: [{ slotLevel: 1, max: 1 }], spells: [] })
    const res = await resolveCastSpell(makeDeps(), { character_name: 'Novice', spell_name: 'Wish' })
    expect(res.ok).toBe(false)
    if (res.ok) throw new Error('expected reject')
    expect(res.binding).toBe(false)
    expect(res.found).toBe(false)
  })

  it('cast: cantrip → no slot consumed; spurious slot_level ignored + noted', async () => {
    const id = await seedCharacter({
      name: 'Cantriper', progression: 'full',
      slotRows: [{ slotLevel: 1, max: 2 }],
      spells: [{ name: 'Fire Bolt', level: 0, prepared: false, ritual: false }],
    })
    const res = await resolveCastSpell(makeDeps(), { character_name: 'Cantriper', spell_name: 'fire bolt', slot_level: 1 })
    expect(res.ok).toBe(true)
    if (!res.ok) throw new Error('expected ok')
    expect(res.payload.slotLevel).toBeUndefined()
    expect(res.payload.summary).toMatch(/ignored/)
    expect(await readSlot(id, 1)).toBe(2)
  })

  it('cast: ritual with ritual flag → no slot debit', async () => {
    const id = await seedCharacter({
      name: 'Ritualist', progression: 'full',
      slotRows: [{ slotLevel: 1, max: 2 }],
      spells: [{ name: 'Detect Magic', level: 1, prepared: true, ritual: true }],
    })
    const res = await resolveCastSpell(makeDeps(), { character_name: 'Ritualist', spell_name: 'Detect Magic', ritual: true })
    expect(res.ok).toBe(true)
    if (!res.ok) throw new Error('expected ok')
    expect(res.payload.slotLevel).toBeUndefined()
    expect(await readSlot(id, 1)).toBe(2)
  })

  it('cast: ritual:true on a non-ritual spell → informational correction', async () => {
    const id = await seedCharacter({
      name: 'Faker', progression: 'full',
      slotRows: [{ slotLevel: 1, max: 2 }],
      spells: [{ name: 'Magic Missile', level: 1, prepared: true, ritual: false }],
    })
    const res = await resolveCastSpell(makeDeps(), { character_name: 'Faker', spell_name: 'Magic Missile', ritual: true })
    expect(res.ok).toBe(false)
    if (res.ok) throw new Error('expected reject')
    expect(res.binding).toBe(false)
    expect(res.constraint).toMatch(/not a ritual/)
    expect(await readSlot(id, 1)).toBe(2)
  })

  // ---- journal idempotent replay --------------------------------------------

  it('journal: same toolCallId twice → one row, second returns journaled (idempotent) success', async () => {
    const id = await seedCharacter({ name: 'Replay', gold: 100 })
    const deps = makeDeps()
    const first = await resolveSpendResource(deps, { kind: 'gold', character_name: 'Replay', amount: 25 })
    expect(first.ok).toBe(true)
    expect(await readGold(id)).toBe(75)
    expect(await countJournal()).toBe(1)
    // Same turnId/toolCallId path: the runInTx writes the journal with the same
    // (turn, call, character) key, so the second apply must NOT debit again.
    const second = await resolveSpendResource(deps, { kind: 'gold', character_name: 'Replay', amount: 25 })
    expect(second.ok).toBe(true)
    if (!second.ok) throw new Error('expected ok')
    expect(await readGold(id)).toBe(75) // NOT 50 — no double-debit
    expect(await countJournal()).toBe(1) // ON CONFLICT DO NOTHING
    expect(second.payload.gold).toBe(75)
  })

  // ---- replay builders: same toolCallId re-resolve drives each builder ------

  it('cast replay: same toolCallId twice → one debit, slotPayload reports level + remaining', async () => {
    const id = await seedCharacter({
      name: 'CastTwice', progression: 'full',
      slotRows: [{ slotLevel: 2, max: 2 }],
      spells: [{ name: 'Scorching Ray', level: 2, prepared: true, ritual: false }],
    })
    const deps = makeDeps()
    const first = await resolveCastSpell(deps, { character_name: 'CastTwice', spell_name: 'Scorching Ray' })
    expect(first.ok).toBe(true)
    expect(await readSlot(id, 2)).toBe(1)
    const second = await resolveCastSpell(deps, { character_name: 'CastTwice', spell_name: 'Scorching Ray' })
    expect(second.ok).toBe(true)
    if (!second.ok) throw new Error('expected ok')
    expect(await readSlot(id, 2)).toBe(1) // NOT 0 — no double debit
    expect(second.payload.slotLevel).toBe(2)
    expect(second.payload.slotsRemaining).toBe(1)
    expect(second.payload.summary).toMatch(/already cast/)
    expect(await countJournal()).toBe(1)
  })

  it('spend item replay: same toolCallId twice → one decrement, itemPayload reports quantity', async () => {
    const id = await seedCharacter({ name: 'ItemTwice', equipment: [{ name: 'Potion', quantity: 3, consumable: true }] })
    const deps = makeDeps()
    const first = await resolveSpendResource(deps, { kind: 'item', character_name: 'ItemTwice', name: 'Potion' })
    expect(first.ok).toBe(true)
    const second = await resolveSpendResource(deps, { kind: 'item', character_name: 'ItemTwice', name: 'Potion' })
    expect(second.ok).toBe(true)
    if (!second.ok) throw new Error('expected ok')
    expect(await readItemQty(id, 'Potion')).toBe(2) // NOT 1 — no double decrement
    expect(second.payload.itemName).toBe('Potion')
    expect(second.payload.quantity).toBe(2)
    expect(second.payload.summary).toMatch(/already at 2/)
  })

  it('spend feature replay: same toolCallId twice → one decrement, featurePayload reports uses', async () => {
    await seedCharacter({ name: 'FeatTwice', features: [{ name: 'Rage', maxUses: 3, recharge: 'long_rest' }] })
    const deps = makeDeps()
    const first = await resolveSpendResource(deps, { kind: 'feature', character_name: 'FeatTwice', name: 'Rage' })
    expect(first.ok).toBe(true)
    const second = await resolveSpendResource(deps, { kind: 'feature', character_name: 'FeatTwice', name: 'Rage' })
    expect(second.ok).toBe(true)
    if (!second.ok) throw new Error('expected ok')
    expect(second.payload.featureName).toBe('Rage')
    expect(second.payload.usesRemaining).toBe(2) // decremented ONCE
    expect(second.payload.summary).toMatch(/already used/)
  })

  // ---- remaining game-rule arms ----------------------------------------------

  it('spend feature: absent (never on sheet) → informational miss', async () => {
    await seedCharacter({ name: 'NoFeat' })
    const res = await resolveSpendResource(makeDeps(), { kind: 'feature', character_name: 'NoFeat', name: 'Rage' })
    expect(res.ok).toBe(false)
    if (res.ok) throw new Error('expected reject')
    expect(res.binding).toBe(false)
    expect(res.found).toBe(false)
  })

  it('spend feature: exhausted with long_rest / none recharge → constraint names the label', async () => {
    const id = await seedCharacter({ name: 'AllOut' })
    await pool.query(
      `INSERT INTO character_features (id, character_id, feature_name, feature_source, description, max_uses, uses_remaining, recharge)
       VALUES ($1,$2,'Indomitable','class','x',1,0,'long_rest'), ($3,$2,'Luck Point','class','x',1,0,'none')`,
      [uuidv7(), id, uuidv7()],
    )
    const longRes = await resolveSpendResource(makeDeps(), { kind: 'feature', character_name: 'AllOut', name: 'Indomitable' })
    expect(longRes.ok).toBe(false)
    if (longRes.ok) throw new Error('expected reject')
    expect(longRes.constraint).toMatch(/long rest/)
    const noneRes = await resolveSpendResource(makeDeps(), { kind: 'feature', character_name: 'AllOut', name: 'Luck Point' })
    expect(noneRes.ok).toBe(false)
    if (noneRes.ok) throw new Error('expected reject')
    expect(noneRes.constraint).toMatch(/recharges on a rest/)
  })

  it('cast: explicit slot_level below spell level → binding, no debit', async () => {
    const id = await seedCharacter({
      name: 'BadUpcast', progression: 'full',
      slotRows: [{ slotLevel: 1, max: 2 }, { slotLevel: 3, max: 1 }],
      spells: [{ name: 'Fireball', level: 3, prepared: true, ritual: false }],
    })
    const res = await resolveCastSpell(makeDeps(), { character_name: 'BadUpcast', spell_name: 'Fireball', slot_level: 1 })
    expect(res.ok).toBe(false)
    if (res.ok) throw new Error('expected reject')
    expect(res.binding).toBe(true)
    expect(await readSlot(id, 1)).toBe(2)
    expect(await readSlot(id, 3)).toBe(1)
  })

  it('cast: cantrip without slot_level → plain no-slot note (no "ignored")', async () => {
    await seedCharacter({
      name: 'PureCantrip', progression: 'full', slotRows: [],
      spells: [{ name: 'Light', level: 0, prepared: false, ritual: false }],
    })
    const res = await resolveCastSpell(makeDeps(), { character_name: 'PureCantrip', spell_name: 'Light' })
    expect(res.ok).toBe(true)
    if (!res.ok) throw new Error('expected ok')
    expect(res.payload.summary).toMatch(/do not consume/)
    expect(res.payload.summary).not.toMatch(/ignored/)
  })

  it('cast: unknown character → informational miss', async () => {
    const res = await resolveCastSpell(makeDeps(), { character_name: 'Nobody', spell_name: 'Wish' })
    expect(res.ok).toBe(false)
    if (res.ok) throw new Error('expected reject')
    expect(res.binding).toBe(false)
    expect(res.found).toBe(false)
  })

  it('acquire: unknown character → informational miss', async () => {
    const res = await resolveAcquireResource(makeDeps(), { kind: 'gold', character_name: 'Nobody', amount: 5 })
    expect(res.ok).toBe(false)
    if (res.ok) throw new Error('expected reject')
    expect(res.found).toBe(false)
  })

  it('acquire item: defaults (no amount → 1, no consumable → false)', async () => {
    const id = await seedCharacter({ name: 'Defaulter' })
    const res = await resolveAcquireResource(makeDeps(), { kind: 'item', character_name: 'Defaulter', name: 'Map' })
    expect(res.ok).toBe(true)
    if (!res.ok) throw new Error('expected ok')
    expect(res.payload.quantity).toBe(1)
    const row = await pool.query<{ quantity: number; consumable: boolean }>(
      `SELECT quantity, consumable FROM character_equipment WHERE character_id = $1 AND lower(btrim(item_name)) = 'map'`,
      [id],
    )
    expect(row.rows[0]?.quantity).toBe(1)
    expect(row.rows[0]?.consumable).toBe(false)
  })

  it('cast: unprepared with an EMPTY castable set → constraint says "none"', async () => {
    await seedCharacter({
      name: 'NothingReady', progression: 'full',
      slotRows: [{ slotLevel: 1, max: 1 }],
      spells: [{ name: 'Shield', level: 1, prepared: false, ritual: false }],
    })
    const res = await resolveCastSpell(makeDeps(), { character_name: 'NothingReady', spell_name: 'Shield' })
    expect(res.ok).toBe(false)
    if (res.ok) throw new Error('expected reject')
    expect(res.binding).toBe(true)
    expect(res.constraint).toMatch(/Currently castable: none/)
  })

  it('replay with vanished rows: builders fall back to zeros / omit fields', async () => {
    // The replay builders read CURRENT state; if the row disappeared between
    // apply and replay (e.g. character left the session), they report zeros
    // rather than throwing. Forced via a tx fake that claims the journal row
    // exists but returns empty reads.
    await seedCharacter({
      name: 'Vanished', gold: 10, progression: 'full',
      slotRows: [{ slotLevel: 1, max: 2 }],
      spells: [{ name: 'Shield', level: 1, prepared: true, ritual: false }],
      equipment: [{ name: 'Rope', quantity: 2, consumable: false }],
      features: [{ name: 'Rage', maxUses: 2, recharge: 'long_rest' }],
    })
    const real = charactersLedgerNs({ query: (t, v) => pool.query(t, v) })
    const fakeTx: LedgerOps = {
      ...real,
      findLedgerEvent: () => Promise.resolve(true),
      findLedgerCharacterByName: () => Promise.resolve({ outcome: 'not_found' as const }),
      readPartyLedgerSnapshot: () => Promise.resolve([]),
      readSpellSlots: () => Promise.resolve([]),
    }
    const runInTx: LedgerTxRunner = (fn) => fn(fakeTx)

    const gold = await resolveSpendResource(makeDeps({ runInTx }), { kind: 'gold', character_name: 'Vanished', amount: 1 })
    expect(gold.ok).toBe(true)
    if (!gold.ok) throw new Error('expected ok')
    expect(gold.payload.gold).toBe(0)

    const item = await resolveSpendResource(makeDeps({ runInTx }), { kind: 'item', character_name: 'Vanished', name: 'Rope' })
    expect(item.ok).toBe(true)
    if (!item.ok) throw new Error('expected ok')
    expect(item.payload.quantity).toBe(0)

    const feat = await resolveSpendResource(makeDeps({ runInTx }), { kind: 'feature', character_name: 'Vanished', name: 'Rage' })
    expect(feat.ok).toBe(true)
    if (!feat.ok) throw new Error('expected ok')
    expect(feat.payload.usesRemaining).toBeUndefined()

    const cast = await resolveCastSpell(makeDeps({ runInTx }), { character_name: 'Vanished', spell_name: 'Shield' })
    expect(cast.ok).toBe(true)
    if (!cast.ok) throw new Error('expected ok')
    expect(cast.payload.slotsRemaining).toBe(0)
  })

  // ---- infra fail-soft arms (throwing fakes) ---------------------------------

  it('character resolution throws → fail-soft UNRESOLVED', async () => {
    const throwing: LedgerOps = {
      ...charactersLedgerNs({ query: (t, v) => pool.query(t, v) }),
      findLedgerCharacterByName: () => Promise.reject(new Error('pg down')),
    }
    const res = await resolveSpendResource(
      makeDeps({ ledger: throwing }),
      { kind: 'gold', character_name: 'Anyone', amount: 1 },
    )
    expect(res.ok).toBe(false)
    if (res.ok) throw new Error('expected reject')
    expect(res.binding).toBe(false)
    expect(res.constraint).toMatch(/could not be resolved/i)
  })

  it('readCharacterSpells throws → fail-soft', async () => {
    await seedCharacter({ name: 'SpellsDown' })
    const throwing: LedgerOps = {
      ...charactersLedgerNs({ query: (t, v) => pool.query(t, v) }),
      readCharacterSpells: () => Promise.reject(new Error('pg down')),
    }
    const res = await resolveCastSpell(makeDeps({ ledger: throwing }), {
      character_name: 'SpellsDown',
      spell_name: 'Anything',
    })
    expect(res.ok).toBe(false)
    if (res.ok) throw new Error('expected reject')
    expect(res.constraint).toMatch(/could not be resolved/i)
  })

  it('readSpellSlots throws → fail-soft', async () => {
    await seedCharacter({
      name: 'SlotsDown', progression: 'full',
      slotRows: [{ slotLevel: 1, max: 1 }],
      spells: [{ name: 'Shield', level: 1, prepared: true, ritual: false }],
    })
    const throwing: LedgerOps = {
      ...charactersLedgerNs({ query: (t, v) => pool.query(t, v) }),
      readSpellSlots: () => Promise.reject(new Error('pg down')),
    }
    const res = await resolveCastSpell(makeDeps({ ledger: throwing }), {
      character_name: 'SlotsDown',
      spell_name: 'Shield',
    })
    expect(res.ok).toBe(false)
    if (res.ok) throw new Error('expected reject')
    expect(res.constraint).toMatch(/could not be resolved/i)
  })

  it('cast: debitSpellSlot loses the read→debit race → binding, no journal', async () => {
    const id = await seedCharacter({
      name: 'Racer', progression: 'full',
      slotRows: [{ slotLevel: 1, max: 1 }],
      spells: [{ name: 'Shield', level: 1, prepared: true, ritual: false }],
    })
    // Reads see a slot available; the tx-bound debit reports insufficient
    // (another writer consumed it between read and debit).
    const real = charactersLedgerNs({ query: (t, v) => pool.query(t, v) })
    const fakeTx: LedgerOps = {
      ...real,
      debitSpellSlot: () => Promise.resolve({ outcome: 'insufficient' as const }),
    }
    const runInTx: LedgerTxRunner = (fn) => fn(fakeTx)
    const res = await resolveCastSpell(makeDeps({ runInTx }), {
      character_name: 'Racer',
      spell_name: 'Shield',
    })
    expect(res.ok).toBe(false)
    if (res.ok) throw new Error('expected reject')
    expect(res.binding).toBe(true)
    expect(res.constraint).toMatch(/level-1/)
    expect(await readSlot(id, 1)).toBe(1)
    expect(await countJournal()).toBe(0)
  })

  // ---- multi-row-match invariant fail-soft ----------------------------------

  it('multi-row item match (invariant violation) → fail-soft UNRESOLVED', async () => {
    // The §3.1 unique index normally prevents this; simulate the resolver's
    // fail-soft by injecting a ledger whose readCharacterSpells/debit throws.
    const id = await seedCharacter({ name: 'Glitch', equipment: [{ name: 'Rope', quantity: 1, consumable: false }] })
    const throwingLedger: LedgerOps = {
      ...charactersLedgerNs({ query: (t, v) => pool.query(t, v) }),
      findLedgerCharacterByName: () =>
        Promise.resolve({
          outcome: 'found' as const,
          projection: {
            character: {
              id, userId, entityId: null, name: 'Glitch', level: 1, class: 'w', species: 'h',
              background: 's', str: 10, dex: 10, con: 10, int: 10, wis: 10, cha: 10,
              hitPoints: 1, maxHitPoints: 1, armorClass: 10, proficiencyBonus: 2,
              createdAt: new Date(), updatedAt: new Date(),
            },
            gold: 0, hitDie: 6, hitDiceRemaining: 1, spellcastingProgression: 'none' as const, conMod: 0,
          },
        }),
    }
    const runInTx: LedgerTxRunner = () => Promise.reject(new Error('multi-row match'))
    const res = await resolveSpendResource(
      makeDeps({ ledger: throwingLedger, runInTx }),
      { kind: 'item', character_name: 'Glitch', name: 'Rope' },
    )
    expect(res.ok).toBe(false)
    if (res.ok) throw new Error('expected reject')
    expect(res.binding).toBe(false)
    expect(res.found).toBe(false)
    expect(res.constraint).toMatch(/could not be resolved/i)
  })
})
