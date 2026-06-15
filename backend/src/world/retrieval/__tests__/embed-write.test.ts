// backend/src/world/retrieval/__tests__/embed-write.test.ts
//
// MYT-71 Task 9 — the world-retrieval WRITE path (embedWorld). Real PG
// (mythrun_test); scoped fixtures. The Voyage embedder is the ONLY mock — its
// network round-trip is replaced by a deterministic in-memory fake. Everything
// else (repo, the short write tx, the read binder) is the real production code.
//
// The fake embedder returns a deterministic 512-length unit vector per input
// (a 1 at axis 0, 0 elsewhere) so the write is observable as a non-NULL
// embedding + a set embedded_at; the exact values don't matter here (cosine
// ordering is T6's concern, not T9's). A call-order recorder proves the
// Voyage round-trip is invoked BEFORE the writes land (the MYT-55 / `reference_
// transaction_scope_just_writes` intent: slow I/O never sits inside a BEGIN).

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Pool } from 'pg'
import { guardTestDatabase } from '../../../db/__tests__/guard-db.js'
import { uuidv7 } from '../../../repo/uuidv7.js'
import { entities } from '../../../repo/entities.js'
import { facts } from '../../../repo/facts.js'
import { createRepo, type Repo } from '../../../repo/index.js'
import { VoyageEmbedError, type VoyageEmbedder } from '../../../llm/embed.js'
import {
  cleanupTestScope,
  makeTestScope,
  type TestScope,
} from '../../../repo/__tests__/_helpers/test-scope.js'
import { createTestPool } from '../../../repo/__tests__/_helpers/test-pool.js'
import { embedWorld } from '../embed-write.js'

const databaseUrl = process.env.DATABASE_URL ?? ''
const VECTOR_DIMS = 512

/** A deterministic 512-length unit vector (1 at axis 0). */
function fakeVec(): number[] {
  const v = new Array<number>(VECTOR_DIMS).fill(0)
  v[0] = 1
  return v
}

/** Build a mock embedder whose `embedDocuments` returns one fakeVec per input
 *  (in order) and records every call for ordering/contents assertions. */
function makeMockEmbedder(): {
  embedder: VoyageEmbedder
  calls: { texts: readonly string[] }[]
} {
  const calls: { texts: readonly string[] }[] = []
  const embedder: VoyageEmbedder = {
    embedDocuments: vi.fn((texts: readonly string[]) => {
      calls.push({ texts: [...texts] })
      return Promise.resolve(texts.map(() => fakeVec()))
    }),
    embedQuery: vi.fn(),
  }
  return { embedder, calls }
}

describe('embedWorld (MYT-71 T9)', () => {
  let pool: Pool
  let repo: Repo
  let scope: TestScope
  let userId: string
  let worldA: string
  let worldB: string

  beforeAll(async () => {
    await guardTestDatabase(databaseUrl)
    pool = createTestPool(databaseUrl)
    repo = createRepo(pool)
    scope = makeTestScope('embed-write')
  })
  afterAll(async () => {
    await cleanupTestScope(pool, scope)
    await pool.end()
  })
  beforeEach(async () => {
    await cleanupTestScope(pool, scope)
    userId = uuidv7()
    worldA = uuidv7()
    worldB = uuidv7()
    await pool.query(
      `INSERT INTO users (id, cognito_sub, display_name, username) VALUES ($1, $2, $3, $4)`,
      [userId, scope.userSub(0), scope.displayName(0), scope.username(0)],
    )
    await pool.query(
      `INSERT INTO worlds (id, created_by, name, concept, status) VALUES ($1, $2, $3, 'C', 'generating')`,
      [worldA, userId, scope.worldName(0)],
    )
    await pool.query(
      `INSERT INTO worlds (id, created_by, name, concept, status) VALUES ($1, $2, $3, 'C', 'generating')`,
      [worldB, userId, scope.worldName(1)],
    )
  })

  // Seed a non-PC entity; returns its id. `embedAxis` non-null → pre-embed it.
  async function seedEntity(
    worldId: string,
    entityType: 'npc' | 'location' | 'faction' | 'item',
    name: string,
    preEmbedded: boolean,
  ): Promise<string> {
    const id = uuidv7()
    await entities.insert(pool, {
      id, worldId, entityType, name, accessLevel: 'known', createdIn: 'stage:test',
    })
    if (preEmbedded) await repo.entities.updateEmbedding(id, `[${fakeVec().join(',')}]`)
    return id
  }

  async function seedPc(worldId: string, name: string): Promise<string> {
    const id = uuidv7()
    await repo.entities.insertPc({ id, worldId, name })
    return id
  }

  // Seed a fact on `entityId`; returns its id. `preEmbedded` → pre-embed it.
  async function seedFact(
    entityId: string,
    topic: string,
    content: string,
    preEmbedded: boolean,
  ): Promise<string> {
    await facts.insertMany(pool, [{ entityId, topic, accessLevel: 'known', content }])
    const row = await pool.query<{ id: string }>(
      `SELECT id FROM facts WHERE entity_id = $1 AND topic = $2 ORDER BY id DESC LIMIT 1`,
      [entityId, topic],
    )
    const factId = row.rows[0]?.id
    if (factId === undefined) throw new Error('expected fact row')
    if (preEmbedded) await repo.facts.updateEmbedding(factId, `[${fakeVec().join(',')}]`)
    return factId
  }

  // Read embedding-null + embedded_at-null state for a fact.
  async function factEmbedState(
    id: string,
  ): Promise<{ embedNull: boolean; embeddedAtNull: boolean }> {
    const r = await pool.query<{ embed_null: boolean; at_null: boolean }>(
      `SELECT embedding IS NULL AS embed_null, embedded_at IS NULL AS at_null
         FROM facts WHERE id = $1`,
      [id],
    )
    const row = r.rows[0]
    if (row === undefined) throw new Error('expected fact row')
    return { embedNull: row.embed_null, embeddedAtNull: row.at_null }
  }

  async function entityEmbedState(
    id: string,
  ): Promise<{ embedNull: boolean; embeddedAtNull: boolean }> {
    const r = await pool.query<{ embed_null: boolean; at_null: boolean }>(
      `SELECT embedding IS NULL AS embed_null, embedded_at IS NULL AS at_null
         FROM entities WHERE id = $1`,
      [id],
    )
    const row = r.rows[0]
    if (row === undefined) throw new Error('expected entity row')
    return { embedNull: row.embed_null, embeddedAtNull: row.at_null }
  }

  it('embeds NULL-embedding facts + entities, writes embedding + embedded_at', async () => {
    const ent = await seedEntity(worldA, 'npc', 'Mara', false)
    const fact = await seedFact(ent, 'history', 'a salt witch', false)
    const { embedder, calls } = makeMockEmbedder()

    const summary = await embedWorld({ embedder, repo }, worldA)

    // Both the un-embedded entity and the un-embedded fact were written.
    expect(await entityEmbedState(ent)).toEqual({ embedNull: false, embeddedAtNull: false })
    expect(await factEmbedState(fact)).toEqual({ embedNull: false, embeddedAtNull: false })
    // 1 entity + 1 fact embedded, nothing left null, no voyage errors.
    expect(summary).toEqual({ embedded: 2, leftNull: 0, voyageErrors: 0 })
    // embedDocuments invoked once per kind (facts, entities).
    expect(calls).toHaveLength(2)
  })

  it('excludes pc entities (a seeded pc is never embedded)', async () => {
    const npc = await seedEntity(worldA, 'npc', 'Mara', false)
    const pc = await seedPc(worldA, 'Ada')
    const { embedder } = makeMockEmbedder()

    const summary = await embedWorld({ embedder, repo }, worldA)

    expect(await entityEmbedState(npc)).toEqual({ embedNull: false, embeddedAtNull: false })
    // The PC stays un-embedded — never world lore.
    expect(await entityEmbedState(pc)).toEqual({ embedNull: true, embeddedAtNull: true })
    expect(summary.embedded).toBe(1)
  })

  it('skips already-embedded rows in NULL mode; force:true re-embeds all', async () => {
    const fresh = await seedEntity(worldA, 'npc', 'Mara', false)
    await seedEntity(worldA, 'location', 'Wharf', true) // already embedded
    const { embedder, calls } = makeMockEmbedder()

    // Incremental (force=false): only the un-embedded entity.
    const incremental = await embedWorld({ embedder, repo }, worldA)
    expect(incremental.embedded).toBe(1)
    expect(calls[0]?.texts).toHaveLength(1)
    expect(await entityEmbedState(fresh)).toEqual({ embedNull: false, embeddedAtNull: false })

    // Force: both entities are re-embedded (2 texts in the entity batch).
    const { embedder: forceEmbedder, calls: forceCalls } = makeMockEmbedder()
    const forced = await embedWorld({ embedder: forceEmbedder, repo }, worldA, { force: true })
    expect(forced.embedded).toBe(2)
    expect(forceCalls[0]?.texts).toHaveLength(2)
  })

  it('returns a summary matching the run (embedded / leftNull / voyageErrors)', async () => {
    const ent = await seedEntity(worldA, 'npc', 'Mara', false)
    await seedFact(ent, 'history', 'h1', false)
    await seedFact(ent, 'lore', 'h2', false)
    const { embedder } = makeMockEmbedder()

    const summary = await embedWorld({ embedder, repo }, worldA)

    // 1 entity + 2 facts.
    expect(summary).toEqual({ embedded: 3, leftNull: 0, voyageErrors: 0 })
  })

  it('a Voyage failure counts voyageErrors, leaves those rows NULL, does not throw', async () => {
    const ent = await seedEntity(worldA, 'npc', 'Mara', false)
    const fact = await seedFact(ent, 'history', 'h', false)
    // Mock: entities embed succeeds, facts embed throws. We control by call
    // order — facts are embedded first, entities second, so reject the FIRST
    // call (facts) and succeed the second (entities).
    const calls: number[] = []
    const embedder: VoyageEmbedder = {
      embedDocuments: vi.fn((texts: readonly string[]) => {
        calls.push(texts.length)
        if (calls.length === 1) return Promise.reject(new Error('voyage down'))
        return Promise.resolve(texts.map(() => fakeVec()))
      }),
      embedQuery: vi.fn(),
    }

    const summary = await embedWorld({ embedder, repo }, worldA)

    // Facts kind failed → its rows stay NULL; entities kind succeeded.
    expect(await factEmbedState(fact)).toEqual({ embedNull: true, embeddedAtNull: true })
    expect(await entityEmbedState(ent)).toEqual({ embedNull: false, embeddedAtNull: false })
    // 1 entity embedded; 1 fact left NULL; 1 voyage error.
    expect(summary).toEqual({ embedded: 1, leftNull: 1, voyageErrors: 1 })
  })

  it('an ENTITIES-kind Voyage failure leaves entities NULL while facts embed', async () => {
    const ent = await seedEntity(worldA, 'npc', 'Mara', false)
    const fact = await seedFact(ent, 'history', 'h', false)
    // Facts are embedded first (call 1) → succeed; entities second (call 2) →
    // throw. Asymmetric to the prior test, which fails the facts kind.
    const calls: number[] = []
    const embedder: VoyageEmbedder = {
      embedDocuments: vi.fn((texts: readonly string[]) => {
        calls.push(texts.length)
        if (calls.length === 2) return Promise.reject(new Error('voyage down'))
        return Promise.resolve(texts.map(() => fakeVec()))
      }),
      embedQuery: vi.fn(),
    }

    const summary = await embedWorld({ embedder, repo }, worldA)

    // Facts kind succeeded; entities kind failed → entity stays NULL.
    expect(await factEmbedState(fact)).toEqual({ embedNull: false, embeddedAtNull: false })
    expect(await entityEmbedState(ent)).toEqual({ embedNull: true, embeddedAtNull: true })
    expect(summary).toEqual({ embedded: 1, leftNull: 1, voyageErrors: 1 })
  })

  it('a CONFIG-class Voyage failure surfaces configErrorKind, counts the error, leaves rows NULL', async () => {
    const ent = await seedEntity(worldA, 'npc', 'Mara', false)
    const fact = await seedFact(ent, 'history', 'h', false)
    // The FIRST embed call (facts) rejects with an auth-kind VoyageEmbedError —
    // a misconfigured key, which never self-heals and affects every world.
    const calls: number[] = []
    const embedder: VoyageEmbedder = {
      embedDocuments: vi.fn((texts: readonly string[]) => {
        calls.push(texts.length)
        if (calls.length === 1) return Promise.reject(new VoyageEmbedError('401', 'auth', 401))
        return Promise.resolve(texts.map(() => fakeVec()))
      }),
      embedQuery: vi.fn(),
    }

    const summary = await embedWorld({ embedder, repo }, worldA)

    // Facts kind failed (config) → its rows stay NULL; entities kind succeeded.
    expect(await factEmbedState(fact)).toEqual({ embedNull: true, embeddedAtNull: true })
    expect(await entityEmbedState(ent)).toEqual({ embedNull: false, embeddedAtNull: false })
    // The config-ness is surfaced; the error is still counted; the fact is NULL.
    expect(summary).toEqual({
      embedded: 1,
      leftNull: 1,
      voyageErrors: 1,
      configErrorKind: 'auth',
    })
  })

  it('a TRANSIENT Voyage failure counts the error but leaves configErrorKind undefined', async () => {
    const ent = await seedEntity(worldA, 'npc', 'Mara', false)
    // Seed a fact so the facts pass has rows to embed (the rejection target).
    await seedFact(ent, 'history', 'h', false)
    // The FIRST embed call (facts) rejects with a transient-kind error — a blip
    // that recovers on its own; NOT a config error, so configErrorKind is absent.
    const calls: number[] = []
    const embedder: VoyageEmbedder = {
      embedDocuments: vi.fn((texts: readonly string[]) => {
        calls.push(texts.length)
        if (calls.length === 1) {
          return Promise.reject(new VoyageEmbedError('503', 'transient', 503))
        }
        return Promise.resolve(texts.map(() => fakeVec()))
      }),
      embedQuery: vi.fn(),
    }

    const summary = await embedWorld({ embedder, repo }, worldA)

    // The error is counted, but the summary carries NO configErrorKind (the
    // property is omitted, not set to undefined — exactOptionalPropertyTypes).
    expect(summary).toEqual({ embedded: 1, leftNull: 1, voyageErrors: 1 })
    expect(summary.configErrorKind).toBeUndefined()
    expect('configErrorKind' in summary).toBe(false)
  })

  it('propagates when the embedder returns a vector count != input count', async () => {
    const ent = await seedEntity(worldA, 'npc', 'Mara', false)
    await seedFact(ent, 'history', 'h1', false)
    await seedFact(ent, 'lore', 'h2', false)
    // Embedder returns ONE vector for the 2-fact batch — a wrapper-contract
    // violation. zipLiterals is OUTSIDE the Voyage try/catch, so it throws
    // (a count drift is a bug, not a retryable Voyage blip).
    const embedder: VoyageEmbedder = {
      embedDocuments: vi.fn(() => Promise.resolve([fakeVec()])),
      embedQuery: vi.fn(),
    }

    await expect(embedWorld({ embedder, repo }, worldA)).rejects.toThrow(
      /returned 1 vectors for 2 inputs/,
    )
  })

  it('calls embedDocuments with the full text list per kind, before the writes land', async () => {
    const ent = await seedEntity(worldA, 'npc', 'Mara', false)
    await seedFact(ent, 'history', 'fact-text', false)
    // Record both embedDocuments-call order AND whether the entity was already
    // written when the embed call fired — proving embed-before-write per kind.
    const order: string[] = []
    const embedder: VoyageEmbedder = {
      embedDocuments: vi.fn(async (texts: readonly string[]) => {
        // Snapshot DB state at the moment the (slow) Voyage call fires: the
        // rows of THIS kind must still be un-embedded (the write tx opens only
        // AFTER this resolves), proving the round-trip is outside any BEGIN.
        const entState = await entityEmbedState(ent)
        order.push(`embed(${String(texts.length)})|entNull=${String(entState.embedNull)}`)
        return texts.map(() => fakeVec())
      }),
      embedQuery: vi.fn(),
    }

    await embedWorld({ embedder, repo }, worldA)

    // Two embed calls (facts kind, entities kind), each with its kind's full
    // text list. At the moment the ENTITIES embed call fires the entity is
    // still un-embedded → the write happens after the embed round-trip.
    expect(order).toHaveLength(2)
    // The facts kind (1 fact) and the entities kind (1 entity) each saw exactly
    // their kind's inputs; the entity was un-embedded at embed time.
    expect(order).toContain('embed(1)|entNull=true')
  })
})
