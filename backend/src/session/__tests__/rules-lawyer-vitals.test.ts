// backend/src/session/__tests__/rules-lawyer-vitals.test.ts
//
// MYT-70 Task 9 — adjust_hp / update_condition / take_rest resolvers against
// REAL PG (scoped fixtures per CONVENTIONS.md). The §5a HP↔unconscious
// invariant + the rest math (per-die floor 0, hit-dice clamp, exhaustion
// delete-at-1, pact restore) ARE the behavior under test, so a fake LedgerOps
// would re-implement and defeat them; we seed real rows and run real txns.

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
import { resolveAdjustHp, resolveUpdateCondition, resolveTakeRest } from '../rules-lawyer-vitals.js'
import type { RulesLawyerDeps, LedgerTxRunner } from '../rules-lawyer.js'
import type { Rng } from '../dice/engine.js'

const databaseUrl = process.env.DATABASE_URL ?? ''
const here = fileURLToPath(import.meta.url)
const REAL_MIGRATIONS_DIR = resolve(here, '../../../../migrations')

function silentLogger(): ReturnType<typeof pino> {
  const sink: DestinationStream = { write: () => undefined }
  return pino({ base: { component: 'rl-vitals-test' } }, sink)
}

/** A deterministic Rng that returns a fixed roll for every die. `rng(min, max)`
 *  is crypto.randomInt-compatible (max exclusive); the engine calls it as
 *  `rng(1, sides + 1)`, so a constant face is `() => face`. */
function fixedRng(face: number): Rng {
  return () => face
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

describe('rules-lawyer vitals (adjust_hp / update_condition / take_rest)', () => {
  let pool: Pool
  let scope: TestScope
  let userId: string
  let campaignId: string
  let sessionId: string

  beforeAll(async () => {
    await guardTestDatabase(databaseUrl)
    pool = createTestPool(databaseUrl)
    await runMigrations({ pool, migrationsDir: REAL_MIGRATIONS_DIR, logger: silentLogger() })
    scope = makeTestScope('rl-vitals')
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

  let userSeq = 0
  /** Seed a character + session participant. Each seed gets its own user so the
   *  party-wide rest can iterate multiple distinct participants. */
  async function seedCharacter(opts: {
    name: string
    level?: number
    con?: number
    hitDie?: 6 | 8 | 10 | 12
    hitDiceRemaining?: number
    hitPoints?: number
    maxHitPoints?: number
    progression?: 'full' | 'half' | 'third' | 'pact' | 'none'
    slotRows?: readonly { slotLevel: number; max: number }[]
    features?: readonly { name: string; maxUses: number | null; recharge: 'short_rest' | 'long_rest' | 'none' }[]
  }): Promise<string> {
    userSeq += 1
    const users = createUsersRepo(pool)
    const c = await pool.connect()
    let ownerId: string
    try {
      await c.query('BEGIN')
      const u = await users.create(c, {
        cognitoSub: scope.userSub(userSeq),
        username: scope.username(userSeq),
        displayName: scope.displayName(userSeq),
      })
      await c.query('COMMIT')
      ownerId = u.id
    } finally {
      c.release()
    }
    const characters = createCharactersRepo(pool)
    const level = opts.level ?? 5
    const max = opts.maxHitPoints ?? 20
    const characterId = await characters.replaceSubTables({
      campaignId,
      userId: ownerId,
      name: opts.name,
      level,
      class: 'fighter',
      species: 'human',
      background: 'soldier',
      str: 12,
      dex: 12,
      con: opts.con ?? 14,
      int: 10,
      wis: 11,
      cha: 9,
      hitPoints: opts.hitPoints ?? max,
      maxHitPoints: max,
      armorClass: 14,
      proficiencyBonus: 3,
      startingGold: 0,
      hitDie: opts.hitDie ?? 10,
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
      equipment: [],
      spells: [],
    })
    await pool.query(
      `INSERT INTO session_participants (id, session_id, user_id, character_id) VALUES ($1,$2,$3,$4)`,
      [uuidv7(), sessionId, ownerId, characterId],
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

  async function readHp(id: string): Promise<number> {
    const r = await pool.query<{ hit_points: number }>(
      `SELECT hit_points FROM characters WHERE id = $1`,
      [id],
    )
    return r.rows[0]?.hit_points ?? -1
  }
  async function readHitDice(id: string): Promise<number> {
    const r = await pool.query<{ hit_dice_remaining: number }>(
      `SELECT hit_dice_remaining FROM characters WHERE id = $1`,
      [id],
    )
    return r.rows[0]?.hit_dice_remaining ?? -1
  }
  async function readSlot(id: string, level: number): Promise<number> {
    const r = await pool.query<{ slots_remaining: number }>(
      `SELECT slots_remaining FROM character_spell_slots WHERE character_id = $1 AND slot_level = $2`,
      [id, level],
    )
    return r.rows[0]?.slots_remaining ?? -1
  }
  async function readFeatureUses(id: string, name: string): Promise<number> {
    const r = await pool.query<{ uses_remaining: number }>(
      `SELECT uses_remaining FROM character_features WHERE character_id = $1 AND lower(btrim(feature_name)) = lower(btrim($2))`,
      [id, name],
    )
    return r.rows[0]?.uses_remaining ?? -1
  }
  async function hasCondition(id: string, condition: string): Promise<boolean> {
    const r = await pool.query(
      `SELECT 1 FROM character_conditions WHERE character_id = $1 AND condition = $2`,
      [id, condition],
    )
    return r.rows.length > 0
  }
  async function conditionLevel(id: string, condition: string): Promise<number | null> {
    const r = await pool.query<{ level: number | null }>(
      `SELECT level FROM character_conditions WHERE character_id = $1 AND condition = $2`,
      [id, condition],
    )
    return r.rows.length > 0 ? r.rows[0]?.level ?? null : -1
  }
  async function applyConditionDirect(id: string, condition: string, level: number | null): Promise<void> {
    await pool.query(
      `INSERT INTO character_conditions (id, character_id, condition, level) VALUES ($1,$2,$3,$4)`,
      [uuidv7(), id, condition, level],
    )
  }
  async function countJournal(): Promise<number> {
    const r = await pool.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM ledger_events WHERE session_id = $1`,
      [sessionId],
    )
    return Number(r.rows[0]?.n ?? '0')
  }

  // ===== adjust_hp ===========================================================

  it('adjust_hp damage by amount: subtracts, reports hp/maxHp, journals', async () => {
    const id = await seedCharacter({ name: 'Tank', hitPoints: 20, maxHitPoints: 20 })
    const res = await resolveAdjustHp(makeDeps(), { character_name: 'Tank', kind: 'damage', amount: 7 })
    expect(res.ok).toBe(true)
    if (!res.ok) throw new Error('expected ok')
    expect(res.payload.kind).toBe('hp')
    expect(res.payload.hp).toBe(13)
    expect(res.payload.maxHp).toBe(20)
    expect(await readHp(id)).toBe(13)
    expect(await countJournal()).toBe(1)
  })

  it('adjust_hp heal by amount: clamps to maxHp', async () => {
    const id = await seedCharacter({ name: 'Cleric', hitPoints: 18, maxHitPoints: 20 })
    const res = await resolveAdjustHp(makeDeps(), { character_name: 'Cleric', kind: 'heal', amount: 50 })
    expect(res.ok).toBe(true)
    if (!res.ok) throw new Error('expected ok')
    expect(res.payload.hp).toBe(20)
    expect(await readHp(id)).toBe(20)
  })

  it('adjust_hp damage by dice: rolls in resolver (deterministic rng), reports diceRolled', async () => {
    const id = await seedCharacter({ name: 'Rogue', hitPoints: 20, maxHitPoints: 20 })
    // 2d4+2 with every face = 3 → 3+3+2 = 8 damage.
    const res = await resolveAdjustHp(makeDeps({ rng: fixedRng(3) }), {
      character_name: 'Rogue',
      kind: 'damage',
      dice: '2d4+2',
    })
    expect(res.ok).toBe(true)
    if (!res.ok) throw new Error('expected ok')
    expect(res.payload.diceRolled).toEqual([3, 3])
    expect(res.payload.hp).toBe(12)
    expect(await readHp(id)).toBe(12)
  })

  it('adjust_hp damage to 0: clamps at 0, auto-applies unconscious, payload says so', async () => {
    const id = await seedCharacter({ name: 'Downed', hitPoints: 5, maxHitPoints: 20 })
    const res = await resolveAdjustHp(makeDeps(), { character_name: 'Downed', kind: 'damage', amount: 99 })
    expect(res.ok).toBe(true)
    if (!res.ok) throw new Error('expected ok')
    expect(res.payload.hp).toBe(0)
    expect(res.payload.summary).toMatch(/unconscious|collapse/i)
    expect(await readHp(id)).toBe(0)
    expect(await hasCondition(id, 'unconscious')).toBe(true)
  })

  it('adjust_hp heal from 0: clears unconscious (HP-raising path #1)', async () => {
    const id = await seedCharacter({ name: 'Reviver', hitPoints: 0, maxHitPoints: 20 })
    await applyConditionDirect(id, 'unconscious', null)
    const res = await resolveAdjustHp(makeDeps(), { character_name: 'Reviver', kind: 'heal', amount: 6 })
    expect(res.ok).toBe(true)
    expect(await readHp(id)).toBe(6)
    expect(await hasCondition(id, 'unconscious')).toBe(false)
  })

  // ===== myth-hlydp: the authoritative activeConditions set ==================
  //
  // The whole point of carrying the FULL post-mutation set instead of a
  // per-frame add/remove flag: conditions move on frames whose `kind` is NOT
  // 'condition'. These four cases are the ones a direction flag provably could
  // not express.

  it('adjust_hp to 0: activeConditions reports the HP-DERIVED unconscious (no condition frame exists)', async () => {
    // `applyHpAndSyncUnconscious` applies the condition; the turn emits only a
    // kind:'hp' frame. If the set didn't ride that frame, a downed character
    // would render with no conditions at all.
    const id = await seedCharacter({ name: 'Dropped', hitPoints: 5, maxHitPoints: 20 })
    await applyConditionDirect(id, 'poisoned', null)
    const res = await resolveAdjustHp(makeDeps(), {
      character_name: 'Dropped',
      kind: 'damage',
      amount: 99,
    })
    expect(res.ok).toBe(true)
    if (!res.ok) throw new Error('expected ok')
    expect(res.payload.hp).toBe(0)
    // Authoritative and COMPLETE: the derived unconscious AND the pre-existing
    // poisoned, ordered by condition name.
    expect(res.payload.activeConditions).toEqual([
      { condition: 'poisoned', level: null },
      { condition: 'unconscious', level: null },
    ])
  })

  it('adjust_hp healing above 0: activeConditions drops the lifted unconscious', async () => {
    const id = await seedCharacter({ name: 'Roused', hitPoints: 0, maxHitPoints: 20 })
    await applyConditionDirect(id, 'unconscious', null)
    const res = await resolveAdjustHp(makeDeps(), {
      character_name: 'Roused',
      kind: 'heal',
      amount: 6,
    })
    expect(res.ok).toBe(true)
    if (!res.ok) throw new Error('expected ok')
    // Empty is a STATEMENT ("this character has none"), distinct from absent.
    expect(res.payload.activeConditions).toEqual([])
    expect(await hasCondition(id, 'unconscious')).toBe(false)
  })

  it('take_rest long: activeConditions reports BOTH the cleared unconscious and the decremented exhaustion', async () => {
    // The case that kills the direction-flag design: ONE long rest moves TWO
    // conditions per character (HP→max clears unconscious via the §5a owner;
    // exhaustion decrements), and emits ONE kind:'rest' frame per character.
    const id = await seedCharacter({
      name: 'Weary',
      level: 4,
      hitPoints: 0,
      maxHitPoints: 30,
    })
    await applyConditionDirect(id, 'unconscious', null)
    await applyConditionDirect(id, 'exhaustion', 3)
    await applyConditionDirect(id, 'poisoned', null) // a rest does not touch this

    const res = await resolveTakeRest(makeDeps(), { type: 'long' })
    expect(res.ok).toBe(true)
    if (!res.ok) throw new Error('expected ok')
    const entry = res.payload.find((p) => p.characterName === 'Weary')
    expect(entry).toBeDefined()
    // unconscious gone, exhaustion 3 → 2 WITH its level, poisoned untouched.
    expect(entry?.activeConditions).toEqual([
      { condition: 'exhaustion', level: 2 },
      { condition: 'poisoned', level: null },
    ])
    // The level is the reason the wire shape is {condition, level} pairs: a
    // bare-name set could not render "Exhaustion 2" without parsing prose.
    expect(await conditionLevel(id, 'exhaustion')).toBe(2)
    expect(await hasCondition(id, 'unconscious')).toBe(false)
  })

  it('update_condition apply: activeConditions is the FULL post-write set, not just the one that moved', async () => {
    const id = await seedCharacter({ name: 'Stacker', hitPoints: 20, maxHitPoints: 20 })
    await applyConditionDirect(id, 'blinded', null)
    const res = await resolveUpdateCondition(makeDeps(), {
      character_name: 'Stacker',
      condition: 'exhaustion',
      action: 'apply',
      level: 4,
    })
    expect(res.ok).toBe(true)
    if (!res.ok) throw new Error('expected ok')
    expect(res.payload.changed).toBe(true)
    expect(res.payload.activeConditions).toEqual([
      { condition: 'blinded', level: null },
      { condition: 'exhaustion', level: 4 },
    ])
  })

  it('update_condition idempotent no-op: still reports the current set', async () => {
    const id = await seedCharacter({ name: 'Unchanged', hitPoints: 20, maxHitPoints: 20 })
    await applyConditionDirect(id, 'prone', null)
    // Clearing a condition the character does not have → changed:false, no frame.
    const res = await resolveUpdateCondition(makeDeps(), {
      character_name: 'Unchanged',
      condition: 'charmed',
      action: 'clear',
    })
    expect(res.ok).toBe(true)
    if (!res.ok) throw new Error('expected ok')
    expect(res.payload.changed).toBe(false)
    expect(res.payload.activeConditions).toEqual([{ condition: 'prone', level: null }])
  })

  it('adjust_hp: neither amount nor dice → fail-soft UNRESOLVED', async () => {
    await seedCharacter({ name: 'Empty' })
    const res = await resolveAdjustHp(makeDeps(), { character_name: 'Empty', kind: 'damage' })
    expect(res.ok).toBe(false)
    if (res.ok) throw new Error('expected reject')
    expect(res.binding).toBe(false)
    expect(res.found).toBe(false)
  })

  it('adjust_hp: both amount and dice → fail-soft UNRESOLVED', async () => {
    await seedCharacter({ name: 'Both' })
    const res = await resolveAdjustHp(makeDeps(), {
      character_name: 'Both',
      kind: 'damage',
      amount: 3,
      dice: '1d6',
    })
    expect(res.ok).toBe(false)
    if (res.ok) throw new Error('expected reject')
    expect(res.binding).toBe(false)
  })

  it('adjust_hp: malformed dice expression → fail-soft UNRESOLVED', async () => {
    await seedCharacter({ name: 'Garbled' })
    const res = await resolveAdjustHp(makeDeps(), { character_name: 'Garbled', kind: 'damage', dice: 'notdice' })
    expect(res.ok).toBe(false)
    if (res.ok) throw new Error('expected reject')
    expect(res.constraint).toMatch(/could not be resolved/i)
  })

  it('adjust_hp: non-standard die (d7) → fail-soft UNRESOLVED', async () => {
    await seedCharacter({ name: 'Weird' })
    const res = await resolveAdjustHp(makeDeps(), { character_name: 'Weird', kind: 'damage', dice: '1d7' })
    expect(res.ok).toBe(false)
    if (res.ok) throw new Error('expected reject')
    expect(res.constraint).toMatch(/could not be resolved/i)
  })

  it('adjust_hp: idempotent replay (same toolCallId twice → one mutation, one row)', async () => {
    const id = await seedCharacter({ name: 'Replay', hitPoints: 20, maxHitPoints: 20 })
    const deps = makeDeps()
    const first = await resolveAdjustHp(deps, { character_name: 'Replay', kind: 'damage', amount: 5 })
    expect(first.ok).toBe(true)
    expect(await readHp(id)).toBe(15)
    const second = await resolveAdjustHp(deps, { character_name: 'Replay', kind: 'damage', amount: 5 })
    expect(second.ok).toBe(true)
    if (!second.ok) throw new Error('expected ok')
    expect(await readHp(id)).toBe(15) // NOT 10 — no double-apply
    expect(second.payload.hp).toBe(15)
    expect(await countJournal()).toBe(1)
  })

  // ===== update_condition ====================================================

  it('update_condition apply: sets condition, changed=true, journals', async () => {
    const id = await seedCharacter({ name: 'Frightful' })
    const res = await resolveUpdateCondition(makeDeps(), {
      character_name: 'Frightful',
      condition: 'frightened',
      action: 'apply',
    })
    expect(res.ok).toBe(true)
    if (!res.ok) throw new Error('expected ok')
    expect(res.payload.kind).toBe('condition')
    expect(res.payload.changed).toBe(true)
    expect(await hasCondition(id, 'frightened')).toBe(true)
    expect(await countJournal()).toBe(1)
  })

  it('update_condition apply identical: no-op, changed=false, NO journal row', async () => {
    const id = await seedCharacter({ name: 'AlreadyScared' })
    await applyConditionDirect(id, 'frightened', null)
    const res = await resolveUpdateCondition(makeDeps(), {
      character_name: 'AlreadyScared',
      condition: 'frightened',
      action: 'apply',
    })
    expect(res.ok).toBe(true)
    if (!res.ok) throw new Error('expected ok')
    expect(res.payload.changed).toBe(false)
    expect(await countJournal()).toBe(0)
  })

  it('update_condition clear when present: removes, changed=true', async () => {
    const id = await seedCharacter({ name: 'Freed' })
    await applyConditionDirect(id, 'restrained', null)
    const res = await resolveUpdateCondition(makeDeps(), {
      character_name: 'Freed',
      condition: 'restrained',
      action: 'clear',
    })
    expect(res.ok).toBe(true)
    if (!res.ok) throw new Error('expected ok')
    expect(res.payload.changed).toBe(true)
    expect(await hasCondition(id, 'restrained')).toBe(false)
  })

  it('update_condition clear when absent: no-op, changed=false, NO journal row', async () => {
    await seedCharacter({ name: 'Clean' })
    const res = await resolveUpdateCondition(makeDeps(), {
      character_name: 'Clean',
      condition: 'poisoned',
      action: 'clear',
    })
    expect(res.ok).toBe(true)
    if (!res.ok) throw new Error('expected ok')
    expect(res.payload.changed).toBe(false)
    expect(await countJournal()).toBe(0)
  })

  it('update_condition exhaustion: level required (missing → fail-soft)', async () => {
    await seedCharacter({ name: 'Tired' })
    const res = await resolveUpdateCondition(makeDeps(), {
      character_name: 'Tired',
      condition: 'exhaustion',
      action: 'apply',
    })
    expect(res.ok).toBe(false)
    if (res.ok) throw new Error('expected reject')
    expect(res.binding).toBe(false)
    expect(res.found).toBe(false)
  })

  it('update_condition: level on a non-exhaustion condition → fail-soft (structural mismatch)', async () => {
    await seedCharacter({ name: 'Bad' })
    const res = await resolveUpdateCondition(makeDeps(), {
      character_name: 'Bad',
      condition: 'prone',
      action: 'apply',
      level: 2,
    })
    expect(res.ok).toBe(false)
    if (res.ok) throw new Error('expected reject')
    expect(res.binding).toBe(false)
  })

  it('update_condition exhaustion: apply then raise level → changed=true updates row', async () => {
    const id = await seedCharacter({ name: 'Weary' })
    await resolveUpdateCondition(makeDeps(), {
      character_name: 'Weary',
      condition: 'exhaustion',
      action: 'apply',
      level: 1,
    })
    expect(await conditionLevel(id, 'exhaustion')).toBe(1)
    const res = await resolveUpdateCondition(makeDeps(), {
      character_name: 'Weary',
      condition: 'exhaustion',
      action: 'apply',
      level: 3,
    })
    expect(res.ok).toBe(true)
    if (!res.ok) throw new Error('expected ok')
    expect(res.payload.changed).toBe(true)
    expect(await conditionLevel(id, 'exhaustion')).toBe(3)
  })

  it('update_condition: clearing unconscious while HP is 0 → binding (heal first)', async () => {
    const id = await seedCharacter({ name: 'Out', hitPoints: 0, maxHitPoints: 20 })
    await applyConditionDirect(id, 'unconscious', null)
    const res = await resolveUpdateCondition(makeDeps(), {
      character_name: 'Out',
      condition: 'unconscious',
      action: 'clear',
    })
    expect(res.ok).toBe(false)
    if (res.ok) throw new Error('expected reject')
    expect(res.binding).toBe(true)
    expect(res.constraint).toMatch(/heal/i)
    expect(await hasCondition(id, 'unconscious')).toBe(true)
  })

  // ===== take_rest: short ====================================================

  it('take_rest short: spends hit dice, heals max(0, roll + CON mod), pact slots + short_rest features restore', async () => {
    // CON 14 → +2. d10 hit die. Roll every die = 5 → 5+2 = 7 per die, 2 dice = 14 heal.
    const id = await seedCharacter({
      name: 'Resting',
      con: 14,
      hitDie: 10,
      hitDiceRemaining: 5,
      hitPoints: 1,
      maxHitPoints: 30,
      progression: 'pact',
      slotRows: [{ slotLevel: 3, max: 2 }],
      features: [{ name: 'Second Wind', maxUses: 1, recharge: 'short_rest' }],
    })
    await pool.query(`UPDATE character_spell_slots SET slots_remaining = 0 WHERE character_id = $1`, [id])
    await pool.query(`UPDATE character_features SET uses_remaining = 0 WHERE character_id = $1`, [id])
    const res = await resolveTakeRest(makeDeps({ rng: fixedRng(5) }), {
      type: 'short',
      hit_dice: [{ character_name: 'Resting', count: 2 }],
    })
    expect(res.ok).toBe(true)
    if (!res.ok) throw new Error('expected ok')
    // payload itemizes per character (array) — one entry here.
    expect(res.payload).toHaveLength(1)
    expect(res.payload[0]?.kind).toBe('rest')
    expect(await readHp(id)).toBe(15) // 1 + 14
    expect(await readHitDice(id)).toBe(3) // 5 - 2
    expect(await readSlot(id, 3)).toBe(2) // pact restored
    expect(await readFeatureUses(id, 'Second Wind')).toBe(1) // short_rest feature restored
    expect(await countJournal()).toBe(1)
  })

  it('take_rest short: hit-dice count clamped to remaining (min(count, remaining))', async () => {
    const id = await seedCharacter({
      name: 'LowDice',
      con: 14,
      hitDie: 10,
      hitDiceRemaining: 1,
      hitPoints: 1,
      maxHitPoints: 30,
    })
    const res = await resolveTakeRest(makeDeps({ rng: fixedRng(5) }), {
      type: 'short',
      hit_dice: [{ character_name: 'LowDice', count: 5 }],
    })
    expect(res.ok).toBe(true)
    expect(await readHitDice(id)).toBe(0) // clamped: only 1 spent
    expect(await readHp(id)).toBe(8) // 1 + (5 + 2) = 8, one die
  })

  it('take_rest short: per-die heal floor 0 on a CON-2 character (no damage)', async () => {
    // CON 6 → -2 mod. d6 hit die, roll every die = 1 → 1 + (-2) = -1 → floor 0.
    const id = await seedCharacter({
      name: 'Frail',
      con: 6,
      hitDie: 6,
      hitDiceRemaining: 3,
      hitPoints: 10,
      maxHitPoints: 30,
    })
    const res = await resolveTakeRest(makeDeps({ rng: fixedRng(1) }), {
      type: 'short',
      hit_dice: [{ character_name: 'Frail', count: 3 }],
    })
    expect(res.ok).toBe(true)
    expect(await readHp(id)).toBe(10) // 10 + max(0,-1)*3 = 10, NOT damaged
    expect(await readHitDice(id)).toBe(0)
  })

  it('take_rest short: clears unconscious when healed above 0 (HP-raising path #2)', async () => {
    const id = await seedCharacter({
      name: 'KnockedOut',
      con: 14,
      hitDie: 10,
      hitDiceRemaining: 2,
      hitPoints: 0,
      maxHitPoints: 30,
    })
    await applyConditionDirect(id, 'unconscious', null)
    const res = await resolveTakeRest(makeDeps({ rng: fixedRng(5) }), {
      type: 'short',
      hit_dice: [{ character_name: 'KnockedOut', count: 1 }],
    })
    expect(res.ok).toBe(true)
    expect(await readHp(id)).toBe(7)
    expect(await hasCondition(id, 'unconscious')).toBe(false)
  })

  it('take_rest short: unknown character_name in hit_dice rejects WHOLE call, no state change', async () => {
    const id = await seedCharacter({
      name: 'Real',
      hitDiceRemaining: 5,
      hitPoints: 1,
      maxHitPoints: 30,
    })
    const res = await resolveTakeRest(makeDeps({ rng: fixedRng(5) }), {
      type: 'short',
      hit_dice: [
        { character_name: 'Real', count: 1 },
        { character_name: 'Ghost', count: 1 },
      ],
    })
    expect(res.ok).toBe(false)
    if (res.ok) throw new Error('expected reject')
    expect(res.binding).toBe(false)
    expect(res.found).toBe(false)
    expect(await readHp(id)).toBe(1) // untouched
    expect(await readHitDice(id)).toBe(5) // untouched
    expect(await countJournal()).toBe(0)
  })

  it('take_rest short: no hit_dice → restores pact slots + short_rest features only', async () => {
    const id = await seedCharacter({
      name: 'JustRest',
      hitPoints: 10,
      maxHitPoints: 30,
      progression: 'pact',
      slotRows: [{ slotLevel: 2, max: 1 }],
    })
    await pool.query(`UPDATE character_spell_slots SET slots_remaining = 0 WHERE character_id = $1`, [id])
    const res = await resolveTakeRest(makeDeps(), { type: 'short' })
    expect(res.ok).toBe(true)
    expect(await readHp(id)).toBe(10) // unchanged — no hit dice spent
    expect(await readSlot(id, 2)).toBe(1)
  })

  // ===== take_rest: long =====================================================

  it('take_rest long: HP→max (clears unconscious, path #3), hit-dice regain, slots + features restore', async () => {
    const id = await seedCharacter({
      name: 'LongRester',
      level: 8,
      hitDie: 10,
      hitDiceRemaining: 1,
      hitPoints: 0,
      maxHitPoints: 40,
      progression: 'full',
      slotRows: [{ slotLevel: 1, max: 2 }],
      features: [
        { name: 'Action Surge', maxUses: 1, recharge: 'short_rest' },
        { name: 'Indomitable', maxUses: 1, recharge: 'long_rest' },
      ],
    })
    await applyConditionDirect(id, 'unconscious', null)
    await pool.query(`UPDATE character_spell_slots SET slots_remaining = 0 WHERE character_id = $1`, [id])
    await pool.query(`UPDATE character_features SET uses_remaining = 0 WHERE character_id = $1`, [id])
    const res = await resolveTakeRest(makeDeps(), { type: 'long' })
    expect(res.ok).toBe(true)
    if (!res.ok) throw new Error('expected ok')
    expect(res.payload).toHaveLength(1)
    expect(await readHp(id)).toBe(40)
    expect(await hasCondition(id, 'unconscious')).toBe(false)
    // regain max(1, floor(8/2)) = 4, capped at level 8 → 1 + 4 = 5.
    expect(await readHitDice(id)).toBe(5)
    expect(await readSlot(id, 1)).toBe(2)
    expect(await readFeatureUses(id, 'Action Surge')).toBe(1)
    expect(await readFeatureUses(id, 'Indomitable')).toBe(1)
  })

  it('take_rest long: exhaustion level decrements, DELETEs at level 1; other conditions untouched', async () => {
    const idA = await seedCharacter({ name: 'Exhausted3', level: 4 })
    const idB = await seedCharacter({ name: 'Exhausted1', level: 4 })
    await applyConditionDirect(idA, 'exhaustion', 3)
    await applyConditionDirect(idA, 'poisoned', null) // not auto-cleared
    await applyConditionDirect(idB, 'exhaustion', 1)
    const res = await resolveTakeRest(makeDeps(), { type: 'long' })
    expect(res.ok).toBe(true)
    expect(await conditionLevel(idA, 'exhaustion')).toBe(2) // 3 → 2
    expect(await hasCondition(idA, 'poisoned')).toBe(true) // untouched
    expect(await hasCondition(idB, 'exhaustion')).toBe(false) // 1 → deleted
  })

  it('take_rest long: itemizes per character (one payload entry per participant)', async () => {
    await seedCharacter({ name: 'P1', hitPoints: 5, maxHitPoints: 10 })
    await seedCharacter({ name: 'P2', hitPoints: 5, maxHitPoints: 10 })
    const res = await resolveTakeRest(makeDeps(), { type: 'long' })
    expect(res.ok).toBe(true)
    if (!res.ok) throw new Error('expected ok')
    expect(res.payload).toHaveLength(2)
    const names = res.payload.map((p) => p.characterName).sort()
    expect(names).toEqual(['P1', 'P2'])
    expect(await countJournal()).toBe(2) // one journal row per character
  })

  it('take_rest long: idempotent replay (same toolCallId twice → restores once, journal stable)', async () => {
    const id = await seedCharacter({ name: 'LongReplay', level: 4, hitPoints: 5, maxHitPoints: 20 })
    const deps = makeDeps()
    const first = await resolveTakeRest(deps, { type: 'long' })
    expect(first.ok).toBe(true)
    expect(await readHp(id)).toBe(20)
    expect(await countJournal()).toBe(1)
    const second = await resolveTakeRest(deps, { type: 'long' })
    expect(second.ok).toBe(true)
    if (!second.ok) throw new Error('expected ok')
    expect(await readHp(id)).toBe(20)
    expect(await countJournal()).toBe(1) // no new rows
  })

  // ===== remaining fail-soft / replay arms ===================================

  it('adjust_hp: dice count beyond engine bounds (200d6) → fail-soft', async () => {
    await seedCharacter({ name: 'TooMany' })
    const res = await resolveAdjustHp(makeDeps(), { character_name: 'TooMany', kind: 'damage', dice: '200d6' })
    expect(res.ok).toBe(false)
    if (res.ok) throw new Error('expected reject')
    expect(res.constraint).toMatch(/could not be resolved/i)
  })

  it('update_condition: level on a clear → fail-soft (structural mismatch)', async () => {
    const id = await seedCharacter({ name: 'ClearLevel' })
    await applyConditionDirect(id, 'exhaustion', 2)
    const res = await resolveUpdateCondition(makeDeps(), {
      character_name: 'ClearLevel',
      condition: 'exhaustion',
      action: 'clear',
      level: 2,
    })
    expect(res.ok).toBe(false)
    if (res.ok) throw new Error('expected reject')
    expect(res.binding).toBe(false)
    expect(await conditionLevel(id, 'exhaustion')).toBe(2) // untouched
  })

  it('update_condition: idempotent replay (same toolCallId) → changed:false, journal stable', async () => {
    const id = await seedCharacter({ name: 'CondReplay' })
    const deps = makeDeps()
    const first = await resolveUpdateCondition(deps, {
      character_name: 'CondReplay',
      condition: 'poisoned',
      action: 'apply',
    })
    expect(first.ok).toBe(true)
    if (!first.ok) throw new Error('expected ok')
    expect(first.payload.changed).toBe(true)
    expect(await countJournal()).toBe(1)
    const second = await resolveUpdateCondition(deps, {
      character_name: 'CondReplay',
      condition: 'poisoned',
      action: 'apply',
    })
    expect(second.ok).toBe(true)
    if (!second.ok) throw new Error('expected ok')
    expect(second.payload.changed).toBe(false) // replay maps to NO frame
    expect(await hasCondition(id, 'poisoned')).toBe(true)
    expect(await countJournal()).toBe(1) // no second row
  })

  it('update_condition: tx throws → fail-soft UNRESOLVED', async () => {
    await seedCharacter({ name: 'CondTxDown' })
    const runInTx: LedgerTxRunner = () => Promise.reject(new Error('pg down'))
    const res = await resolveUpdateCondition(makeDeps({ runInTx }), {
      character_name: 'CondTxDown',
      condition: 'prone',
      action: 'apply',
    })
    expect(res.ok).toBe(false)
    if (res.ok) throw new Error('expected reject')
    expect(res.binding).toBe(false)
    expect(res.constraint).toMatch(/could not be resolved/i)
  })

  it('take_rest: readRestParticipants throws → fail-soft UNRESOLVED', async () => {
    await seedCharacter({ name: 'RestReadDown' })
    const throwing: LedgerOps = {
      ...charactersLedgerNs({ query: (t, v) => pool.query(t, v) }),
      readRestParticipants: () => Promise.reject(new Error('pg down')),
    }
    const res = await resolveTakeRest(makeDeps({ ledger: throwing }), { type: 'long' })
    expect(res.ok).toBe(false)
    if (res.ok) throw new Error('expected reject')
    expect(res.binding).toBe(false)
    expect(res.constraint).toMatch(/could not be resolved/i)
  })

  it('take_rest: tx throws → fail-soft UNRESOLVED, no state change', async () => {
    const id = await seedCharacter({ name: 'RestTxDown', hitPoints: 5, maxHitPoints: 20 })
    const runInTx: LedgerTxRunner = () => Promise.reject(new Error('pg down'))
    const res = await resolveTakeRest(makeDeps({ runInTx }), { type: 'long' })
    expect(res.ok).toBe(false)
    if (res.ok) throw new Error('expected reject')
    expect(res.constraint).toMatch(/could not be resolved/i)
    expect(await readHp(id)).toBe(5) // untouched
  })

  it('adjust_hp: amount 0 → fail-soft (magnitude must be >= 1)', async () => {
    await seedCharacter({ name: 'Zero' })
    const res = await resolveAdjustHp(makeDeps(), { character_name: 'Zero', kind: 'damage', amount: 0 })
    expect(res.ok).toBe(false)
    if (res.ok) throw new Error('expected reject')
    expect(res.constraint).toMatch(/could not be resolved/i)
  })

  it('adjust_hp: non-integer amount → fail-soft', async () => {
    await seedCharacter({ name: 'Fractional' })
    const res = await resolveAdjustHp(makeDeps(), { character_name: 'Fractional', kind: 'heal', amount: 2.5 })
    expect(res.ok).toBe(false)
    if (res.ok) throw new Error('expected reject')
    expect(res.constraint).toMatch(/could not be resolved/i)
  })

  it('adjust_hp: zero-count dice (0d6) → fail-soft', async () => {
    await seedCharacter({ name: 'NoDice' })
    const res = await resolveAdjustHp(makeDeps(), { character_name: 'NoDice', kind: 'damage', dice: '0d6' })
    expect(res.ok).toBe(false)
    if (res.ok) throw new Error('expected reject')
    expect(res.constraint).toMatch(/could not be resolved/i)
  })

  it('adjust_hp: unknown character → informational miss', async () => {
    const res = await resolveAdjustHp(makeDeps(), { character_name: 'Nobody', kind: 'damage', amount: 3 })
    expect(res.ok).toBe(false)
    if (res.ok) throw new Error('expected reject')
    expect(res.binding).toBe(false)
    expect(res.found).toBe(false)
  })

  it('update_condition: unknown character → informational miss', async () => {
    const res = await resolveUpdateCondition(makeDeps(), {
      character_name: 'Nobody',
      condition: 'prone',
      action: 'apply',
    })
    expect(res.ok).toBe(false)
    if (res.ok) throw new Error('expected reject')
    expect(res.found).toBe(false)
  })

  it('adjust_hp: snapshot row missing inside the mutate → fail-soft (defensive)', async () => {
    await seedCharacter({ name: 'GhostRow', hitPoints: 10, maxHitPoints: 20 })
    const real = charactersLedgerNs({ query: (t, v) => pool.query(t, v) })
    const fakeTx: LedgerOps = { ...real, readPartyLedgerSnapshot: () => Promise.resolve([]) }
    const runInTx: LedgerTxRunner = (fn) => fn(fakeTx)
    const res = await resolveAdjustHp(makeDeps({ runInTx }), { character_name: 'GhostRow', kind: 'damage', amount: 1 })
    expect(res.ok).toBe(false)
    if (res.ok) throw new Error('expected reject')
    expect(res.constraint).toMatch(/could not be resolved/i)
  })

  it('adjust_hp replay with vanished snapshot row → hpPayload reports zeros', async () => {
    await seedCharacter({ name: 'VanishedHp', hitPoints: 10, maxHitPoints: 20 })
    const real = charactersLedgerNs({ query: (t, v) => pool.query(t, v) })
    const fakeTx: LedgerOps = {
      ...real,
      findLedgerEvent: () => Promise.resolve(true),
      readPartyLedgerSnapshot: () => Promise.resolve([]),
    }
    const runInTx: LedgerTxRunner = (fn) => fn(fakeTx)
    const res = await resolveAdjustHp(makeDeps({ runInTx }), { character_name: 'VanishedHp', kind: 'heal', amount: 5 })
    expect(res.ok).toBe(true)
    if (!res.ok) throw new Error('expected ok')
    expect(res.payload.hp).toBe(0)
    expect(res.payload.maxHp).toBe(0)
    expect(res.payload.summary).toMatch(/no change/)
  })

  it('take_rest short: AMBIGUOUS character_name in hit_dice rejects WHOLE call', async () => {
    const idA = await seedCharacter({ name: 'TwinRest', hitDiceRemaining: 3, hitPoints: 5, maxHitPoints: 20 })
    await seedCharacter({ name: 'TwinRest', hitDiceRemaining: 3, hitPoints: 5, maxHitPoints: 20 })
    const res = await resolveTakeRest(makeDeps({ rng: fixedRng(5) }), {
      type: 'short',
      hit_dice: [{ character_name: 'TwinRest', count: 1 }],
    })
    expect(res.ok).toBe(false)
    if (res.ok) throw new Error('expected reject')
    expect(res.found).toBe(false)
    expect(await readHp(idA)).toBe(5) // untouched
    expect(await countJournal()).toBe(0)
  })
})
