// llm-outage-resilience Task 5 — pins the migration-038 llm_resume_stamps SQL
// and the resumeStamps binder against the real schema: composite PK, ladder
// climb held at the top rung, budget accounting (consume:false adds nothing),
// and the claim-vs-completion clear split (spec §3.1).
//
// DEVIATION from scoped fixtures (CONVENTIONS.md): llm_resume_stamps has no
// scope-matchable column — the key is (pipeline, bare-uuid entity_id) with no
// FK, so cleanupTestScope can't reach it. Isolation comes from fresh uuidv7
// entity ids per test; afterAll deletes exactly the tracked ids. listArmed
// asserts intersect with the tracked ids so leftover or parallel rows can't
// flake them.
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { Pool } from 'pg'
import { guardTestDatabase } from '../../db/__tests__/guard-db.js'
import { uuidv7 } from '../uuidv7.js'
import { createRepo, type Repo } from '../index.js'
import { createTestPool } from './_helpers/test-pool.js'
import {
  PARK_BUDGET_MS,
  PARK_LADDER_MS,
  isParkExhausted,
  nextParkDelayMs,
  type ResumeStamp,
} from '../resume-stamps.js'

const databaseUrl = process.env.DATABASE_URL ?? ''

describe('resumeStamps repo', () => {
  let pool: Pool
  let repo: Repo
  const trackedIds: string[] = []

  function newEntityId(): string {
    const id = uuidv7()
    trackedIds.push(id)
    return id
  }

  // DB-clock reference for nextResumeAt asserts — same clock source as the
  // upsert's now(), so the tolerance only covers query latency, not host↔
  // container skew.
  async function dbNowMs(): Promise<number> {
    const r = await pool.query<{ now: Date }>('SELECT now() AS now')
    return r.rows[0]?.now.getTime() ?? 0
  }

  beforeAll(async () => {
    await guardTestDatabase(databaseUrl)
    pool = createTestPool(databaseUrl)
    repo = createRepo(pool)
  })

  afterAll(async () => {
    await pool.query(`DELETE FROM llm_resume_stamps WHERE entity_id = ANY($1::uuid[])`, [
      trackedIds,
    ])
    await pool.end()
  })

  it('first park inserts attempt 1, arms nextResumeAt ≈ now+delay, consumes the delay', async () => {
    const entityId = newEntityId()
    const before = await dbNowMs()
    const stamp = await repo.resumeStamps.upsertPark({
      pipeline: 'world_gen',
      entityId,
      delayMs: 30_000,
      consume: true,
      errorClass: 'connectivity',
    })
    const after = await dbNowMs()

    expect(stamp.pipeline).toBe('world_gen')
    expect(stamp.entityId).toBe(entityId)
    expect(stamp.resumeAttempt).toBe(1)
    // ::float8 cast pins the bigint-as-string pg quirk to a JS number.
    expect(typeof stamp.parkConsumedMs).toBe('number')
    expect(stamp.parkConsumedMs).toBe(30_000)
    expect(stamp.lastErrorClass).toBe('connectivity')
    const at = stamp.nextResumeAt?.getTime() ?? 0
    expect(at).toBeGreaterThanOrEqual(before + 30_000 - 1_000)
    expect(at).toBeLessThanOrEqual(after + 30_000 + 1_000)

    const got = await repo.resumeStamps.get('world_gen', entityId)
    expect(got).toEqual(stamp)
  })

  it('repeated parks climb the ladder, hold at the top rung, and accumulate the budget', async () => {
    const entityId = newEntityId()
    const attempts: number[] = []
    const delays: number[] = []
    let consumed = 0
    let stamp: ResumeStamp | null = null
    for (let park = 0; park < 6; park++) {
      const delayMs = nextParkDelayMs(stamp?.resumeAttempt ?? 0)
      delays.push(delayMs)
      consumed += delayMs
      stamp = await repo.resumeStamps.upsertPark({
        pipeline: 'session_prep',
        entityId,
        delayMs,
        consume: true,
        errorClass: 'connectivity',
      })
      attempts.push(stamp.resumeAttempt)
    }
    expect(delays).toEqual([30_000, 120_000, 300_000, 900_000, 900_000, 900_000])
    expect(attempts).toEqual([1, 2, 3, 4, 4, 4])
    expect(stamp?.parkConsumedMs).toBe(consumed)
  })

  it('consume:false re-arms and climbs without adding to parkConsumedMs; error class updates', async () => {
    const entityId = newEntityId()
    await repo.resumeStamps.upsertPark({
      pipeline: 'character_creation',
      entityId,
      delayMs: 30_000,
      consume: true,
      errorClass: 'connectivity',
    })
    const degraded = await repo.resumeStamps.upsertPark({
      pipeline: 'character_creation',
      entityId,
      delayMs: 120_000,
      consume: false,
      errorClass: 'rate-limit',
    })
    expect(degraded.resumeAttempt).toBe(2)
    expect(degraded.parkConsumedMs).toBe(30_000)
    expect(degraded.lastErrorClass).toBe('rate-limit')
    expect(degraded.nextResumeAt).not.toBeNull()
  })

  it('clearNextResumeAt disarms the stamp; attempt, budget, and error class survive the claim', async () => {
    const entityId = newEntityId()
    await repo.resumeStamps.upsertPark({
      pipeline: 'world_gen',
      entityId,
      delayMs: 30_000,
      consume: true,
      errorClass: 'connectivity',
    })
    await repo.resumeStamps.upsertPark({
      pipeline: 'world_gen',
      entityId,
      delayMs: 120_000,
      consume: true,
      errorClass: 'connectivity',
    })
    await repo.resumeStamps.clearNextResumeAt('world_gen', entityId)
    const got = await repo.resumeStamps.get('world_gen', entityId)
    expect(got?.nextResumeAt).toBeNull()
    expect(got?.resumeAttempt).toBe(2)
    expect(got?.parkConsumedMs).toBe(150_000)
    expect(got?.lastErrorClass).toBe('connectivity')
  })

  it('clearStamp removes the row; get returns null for a missing stamp', async () => {
    const entityId = newEntityId()
    await repo.resumeStamps.upsertPark({
      pipeline: 'world_gen',
      entityId,
      delayMs: 30_000,
      consume: true,
      errorClass: 'connectivity',
    })
    await repo.resumeStamps.clearStamp('world_gen', entityId)
    expect(await repo.resumeStamps.get('world_gen', entityId)).toBeNull()
  })

  it('listArmed returns armed stamps only, optionally filtered by pipeline', async () => {
    const armedWorld = newEntityId()
    const armedPrep = newEntityId()
    const claimed = newEntityId()
    for (const [pipeline, entityId] of [
      ['world_gen', armedWorld],
      ['session_prep', armedPrep],
      ['world_gen', claimed],
    ] as const) {
      await repo.resumeStamps.upsertPark({
        pipeline,
        entityId,
        delayMs: 30_000,
        consume: true,
        errorClass: 'connectivity',
      })
    }
    await repo.resumeStamps.clearNextResumeAt('world_gen', claimed)

    const mine = new Set([armedWorld, armedPrep, claimed])
    const all = (await repo.resumeStamps.listArmed()).filter((s) => mine.has(s.entityId))
    expect(all.map((s) => s.entityId).sort()).toEqual([armedWorld, armedPrep].sort())

    const worldOnly = (await repo.resumeStamps.listArmed('world_gen')).filter((s) =>
      mine.has(s.entityId),
    )
    expect(worldOnly.map((s) => s.entityId)).toEqual([armedWorld])
  })

  it('the same entity id parks independently per pipeline (composite PK)', async () => {
    const entityId = newEntityId()
    await repo.resumeStamps.upsertPark({
      pipeline: 'world_gen',
      entityId,
      delayMs: 30_000,
      consume: true,
      errorClass: 'connectivity',
    })
    await repo.resumeStamps.upsertPark({
      pipeline: 'world_gen',
      entityId,
      delayMs: 120_000,
      consume: true,
      errorClass: 'connectivity',
    })
    const prep = await repo.resumeStamps.upsertPark({
      pipeline: 'session_prep',
      entityId,
      delayMs: 30_000,
      consume: true,
      errorClass: 'rate-limit',
    })
    expect(prep.resumeAttempt).toBe(1)
    expect((await repo.resumeStamps.get('world_gen', entityId))?.resumeAttempt).toBe(2)

    await repo.resumeStamps.clearStamp('world_gen', entityId)
    expect(await repo.resumeStamps.get('world_gen', entityId)).toBeNull()
    expect((await repo.resumeStamps.get('session_prep', entityId))?.resumeAttempt).toBe(1)
  })
})

describe('park ladder + budget helpers', () => {
  it('nextParkDelayMs indexes the ladder and holds at the top', () => {
    expect([...PARK_LADDER_MS]).toEqual([30_000, 120_000, 300_000, 900_000])
    expect(nextParkDelayMs(0)).toBe(30_000)
    expect(nextParkDelayMs(1)).toBe(120_000)
    expect(nextParkDelayMs(2)).toBe(300_000)
    expect(nextParkDelayMs(3)).toBe(900_000)
    expect(nextParkDelayMs(4)).toBe(900_000)
    expect(nextParkDelayMs(42)).toBe(900_000)
    expect(nextParkDelayMs(-1)).toBe(30_000)
  })

  it('isParkExhausted flips exactly at the 6-hour budget', () => {
    const base: ResumeStamp = {
      pipeline: 'world_gen',
      entityId: uuidv7(),
      resumeAttempt: 4,
      nextResumeAt: null,
      parkConsumedMs: 0,
      lastErrorClass: 'connectivity',
    }
    expect(PARK_BUDGET_MS).toBe(6 * 60 * 60 * 1000)
    expect(isParkExhausted({ ...base, parkConsumedMs: PARK_BUDGET_MS - 1 })).toBe(false)
    expect(isParkExhausted({ ...base, parkConsumedMs: PARK_BUDGET_MS })).toBe(true)
    expect(isParkExhausted({ ...base, parkConsumedMs: PARK_BUDGET_MS + 900_000 })).toBe(true)
  })
})
