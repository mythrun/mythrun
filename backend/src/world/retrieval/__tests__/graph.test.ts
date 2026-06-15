// backend/src/world/retrieval/__tests__/graph.test.ts
//
// MYT-71 Task 8 — orchestration over the T6 world-retrieval binder
// (charactersKnownTo / factionTree). Real PG (mythrun_test); scoped fixtures.
//
// These tests exercise the ORCHESTRATION concerns graph.ts owns: depth defaulting
// + capping, the nameFilter JS post-filter, and the factionTree truncated flag.
// The deep graph semantics (both-direction walk, cycle-safety, diamond dedup,
// depth-bounding) are owned by the binder and re-asserted here end-to-end through
// the orchestration surface (the binder is the substrate, graph.ts is the seam
// the rest of the system calls).
//
// The seed mirrors src/repo/__tests__/world-retrieval.test.ts: raw inserts into
// relationships / entity_hierarchy, entities via the repo. No embeddings — the
// graph walks never touch the vector column.

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import type { Pool } from 'pg'
import { guardTestDatabase } from '../../../db/__tests__/guard-db.js'
import { uuidv7 } from '../../../repo/uuidv7.js'
import { entities } from '../../../repo/entities.js'
import { createRepo, type Repo } from '../../../repo/index.js'
import {
  cleanupTestScope,
  makeTestScope,
  type TestScope,
} from '../../../repo/__tests__/_helpers/test-scope.js'
import { createTestPool } from '../../../repo/__tests__/_helpers/test-pool.js'
import { GRAPH_DEFAULT_DEPTH, GRAPH_MAX_DEPTH } from '../config.js'
import { charactersKnownTo, factionTree } from '../graph.js'

const databaseUrl = process.env.DATABASE_URL ?? ''

describe('world-retrieval graph orchestration (MYT-71 T8)', () => {
  let pool: Pool
  let repo: Repo
  let deps: { repo: Pick<Repo, 'worldRetrieval'> }
  let scope: TestScope
  let userId: string
  let worldA: string

  beforeAll(async () => {
    await guardTestDatabase(databaseUrl)
    pool = createTestPool(databaseUrl)
    repo = createRepo(pool)
    deps = { repo }
    scope = makeTestScope('retrieval-graph')
  })
  afterAll(async () => {
    await cleanupTestScope(pool, scope)
    await pool.end()
  })
  beforeEach(async () => {
    await cleanupTestScope(pool, scope)
    userId = uuidv7()
    worldA = uuidv7()
    await pool.query(
      `INSERT INTO users (id, cognito_sub, display_name, username) VALUES ($1, $2, $3, $4)`,
      [userId, scope.userSub(0), scope.displayName(0), scope.username(0)],
    )
    await pool.query(
      `INSERT INTO worlds (id, created_by, name, concept, status) VALUES ($1, $2, $3, 'C', 'generating')`,
      [worldA, userId, scope.worldName(0)],
    )
  })

  // ── seed helpers (mirror T6's pattern) ─────────────────────────────────────

  async function seedEntity(
    entityType: 'npc' | 'location' | 'faction' | 'item' | 'pc',
    name: string,
    accessLevel: 'known' | 'discoverable' | 'secret' = 'known',
  ): Promise<string> {
    const id = uuidv7()
    if (entityType === 'pc') {
      await repo.entities.insertPc({ id, worldId: worldA, name })
    } else {
      await entities.insert(pool, {
        id, worldId: worldA, entityType, name, accessLevel, createdIn: 'stage:test',
      })
    }
    return id
  }

  async function rel(src: string, tgt: string): Promise<void> {
    await pool.query(
      `INSERT INTO relationships (id, source_entity_id, target_entity_id, relationship_type, description)
       VALUES ($1, $2, $3, 'knows', 'd')`,
      [uuidv7(), src, tgt],
    )
  }

  async function hier(parent: string, child: string): Promise<void> {
    await pool.query(
      `INSERT INTO entity_hierarchy (id, parent_entity_id, child_entity_id) VALUES ($1, $2, $3)`,
      [uuidv7(), parent, child],
    )
  }

  // ── charactersKnownTo ──────────────────────────────────────────────────────

  it('walks both directions — a target-side-only in-edge is reachable', async () => {
    const root = await seedEntity('npc', 'Root')
    const out = await seedEntity('npc', 'Out')
    const incoming = await seedEntity('npc', 'Incoming')
    await rel(root, out) // out-edge: root → out
    await rel(incoming, root) // in-edge: incoming → root (only reachable by reverse walk)

    const result = await charactersKnownTo(deps, root, {})
    const ids = result.map((r) => r.entityId)
    expect(ids).toContain(out)
    expect(ids).toContain(incoming)
  })

  it('defaults maxDepth to GRAPH_DEFAULT_DEPTH and excludes nodes beyond it', async () => {
    const root = await seedEntity('npc', 'Root')
    const a = await seedEntity('npc', 'A') // depth 1
    const b = await seedEntity('npc', 'B') // depth 2
    const c = await seedEntity('npc', 'C') // depth 3 — beyond default (2)
    await rel(root, a)
    await rel(a, b)
    await rel(b, c)

    const result = await charactersKnownTo(deps, root, {})
    const byId = new Map(result.map((r) => [r.entityId, r]))
    expect(GRAPH_DEFAULT_DEPTH).toBe(2)
    expect(byId.get(a)?.depth).toBe(1)
    expect(byId.get(b)?.depth).toBe(2)
    expect(byId.has(c)).toBe(false) // depth 3 > default 2
  })

  it('caps an over-large maxDepth at GRAPH_MAX_DEPTH', async () => {
    // Chain of GRAPH_MAX_DEPTH + 2 hops from the root. With maxDepth requested far
    // beyond the cap, the node at exactly GRAPH_MAX_DEPTH is present and the one
    // past it is absent — proving the request was clamped to GRAPH_MAX_DEPTH.
    const chain: string[] = []
    for (let i = 0; i <= GRAPH_MAX_DEPTH + 1; i++) {
      chain.push(await seedEntity('npc', `n${String(i)}`))
    }
    for (let i = 0; i < chain.length - 1; i++) {
      const a = chain[i]
      const b = chain[i + 1]
      if (a === undefined || b === undefined) throw new Error('seed gap')
      await rel(a, b)
    }
    const root = chain[0]
    if (root === undefined) throw new Error('no root')

    const result = await charactersKnownTo(deps, root, { maxDepth: GRAPH_MAX_DEPTH + 50 })
    const ids = new Set(result.map((r) => r.entityId))
    const atCap = chain[GRAPH_MAX_DEPTH]
    const pastCap = chain[GRAPH_MAX_DEPTH + 1]
    if (atCap === undefined || pastCap === undefined) throw new Error('chain gap')
    expect(ids.has(atCap)).toBe(true)
    expect(ids.has(pastCap)).toBe(false)
  })

  it('clamps a negative maxDepth to 0 (seed only, binder called with depth 0)', async () => {
    const root = await seedEntity('npc', 'Root')
    const neighbor = await seedEntity('npc', 'Neighbor')
    await rel(root, neighbor) // depth 1 — must be excluded once clamped to 0

    // Spy the binder to prove resolveDepth's `depth < 0` arm clamped to 0 before
    // the call (delegate to the real binder so the PG result is still asserted).
    const real = repo.worldRetrieval.charactersKnownTo.bind(repo.worldRetrieval)
    const seen: number[] = []
    const spyDeps: typeof deps = {
      repo: {
        worldRetrieval: {
          ...repo.worldRetrieval,
          charactersKnownTo: async (id: string, depth: number) => {
            seen.push(depth)
            return real(id, depth)
          },
        },
      },
    }

    const result = await charactersKnownTo(spyDeps, root, { maxDepth: -1 })
    expect(seen).toEqual([0]) // negative request clamped to 0
    const ids = result.map((r) => r.entityId)
    expect(ids).toEqual([root]) // only the seed; the depth-1 neighbor is excluded
    expect(ids).not.toContain(neighbor)
  })

  it('is cycle-safe — a deliberate cycle terminates without looping', async () => {
    const root = await seedEntity('npc', 'Root')
    const a = await seedEntity('npc', 'A')
    const b = await seedEntity('npc', 'B')
    await rel(root, a)
    await rel(a, b)
    await rel(b, root) // cycle: root → a → b → root

    const result = await charactersKnownTo(deps, root, { maxDepth: GRAPH_MAX_DEPTH })
    // Each node appears exactly once despite the cycle.
    const ids = result.map((r) => r.entityId)
    expect(new Set(ids).size).toBe(ids.length)
    expect(new Set(ids)).toEqual(new Set([root, a, b]))
  })

  it('dedups a diamond — the shared node appears once at its min depth', async () => {
    const root = await seedEntity('npc', 'Root')
    const a = await seedEntity('npc', 'A')
    const b = await seedEntity('npc', 'B')
    const shared = await seedEntity('npc', 'Shared')
    await rel(root, a) // depth 1
    await rel(root, b) // depth 1
    await rel(a, shared) // depth 2
    await rel(b, shared) // depth 2 (second path to shared)

    const result = await charactersKnownTo(deps, root, { maxDepth: GRAPH_MAX_DEPTH })
    const sharedRows = result.filter((r) => r.entityId === shared)
    expect(sharedRows).toHaveLength(1)
    expect(sharedRows[0]?.depth).toBe(2)
  })

  it('applies nameFilter case-insensitively and trimmed', async () => {
    const root = await seedEntity('npc', 'Root')
    const target = await seedEntity('npc', 'Mara')
    const other = await seedEntity('npc', 'Brennan')
    await rel(root, target)
    await rel(root, other)

    const result = await charactersKnownTo(deps, root, { nameFilter: '  mARA  ' })
    expect(result).toHaveLength(1)
    expect(result[0]?.entityId).toBe(target)
    expect(result[0]?.name).toBe('Mara')
  })

  it('includes PCs in the result (graph paths do not filter pc)', async () => {
    const root = await seedEntity('npc', 'Root')
    const pc = await seedEntity('pc', 'Ada')
    await rel(root, pc)

    const result = await charactersKnownTo(deps, root, {})
    const found = result.find((r) => r.entityId === pc)
    expect(found).toBeDefined()
    expect(found?.entityType).toBe('pc')
    expect(found?.name).toBe('Ada')
  })

  it('maps DB rows to the camelCase KnownCharacter shape', async () => {
    const root = await seedEntity('faction', 'Crown')
    const result = await charactersKnownTo(deps, root, {})
    const rootRow = result.find((r) => r.entityId === root)
    expect(rootRow).toEqual({
      entityId: root,
      name: 'Crown',
      entityType: 'faction',
      accessLevel: 'known',
      depth: 0,
    })
  })

  it('surfaces accessLevel on each KnownCharacter (MYT-72 T1)', async () => {
    const root = await seedEntity('npc', 'Open NPC', 'known')
    const secret = await seedEntity('npc', 'Hidden NPC', 'secret')
    await rel(root, secret)

    const result = await charactersKnownTo(deps, root, {})
    const byId = new Map(result.map((r) => [r.entityId, r]))
    expect(byId.get(root)?.accessLevel).toBe('known')
    expect(byId.get(secret)?.accessLevel).toBe('secret')
  })

  // ── factionTree ────────────────────────────────────────────────────────────

  it('returns the subtree with correct parentId + depth, not truncated', async () => {
    const root = await seedEntity('faction', 'Crown')
    const child1 = await seedEntity('faction', 'House A')
    const child2 = await seedEntity('faction', 'House B')
    const grandchild = await seedEntity('faction', 'Cadet Branch')
    await hier(root, child1)
    await hier(root, child2)
    await hier(child1, grandchild)

    const { nodes, truncated } = await factionTree(deps, root)
    const byId = new Map(nodes.map((n) => [n.entityId, n]))
    expect(byId.get(root)?.depth).toBe(0)
    expect(byId.get(root)?.parentId).toBeNull()
    expect(byId.get(child1)?.depth).toBe(1)
    expect(byId.get(child1)?.parentId).toBe(root)
    expect(byId.get(child2)?.parentId).toBe(root)
    expect(byId.get(grandchild)?.depth).toBe(2)
    expect(byId.get(grandchild)?.parentId).toBe(child1)
    expect(byId.get(grandchild)?.name).toBe('Cadet Branch')
    expect(byId.get(grandchild)?.entityType).toBe('faction')
    // Subtree is shallow (max depth 2 < GRAPH_MAX_DEPTH=5) — not truncated.
    expect(truncated).toBe(false)
  })

  it('surfaces accessLevel on each FactionNode (MYT-72 T1)', async () => {
    const root = await seedEntity('faction', 'Open Council', 'known')
    const secret = await seedEntity('faction', 'Hidden Cabal', 'secret')
    await hier(root, secret)

    const { nodes } = await factionTree(deps, root)
    const byId = new Map(nodes.map((n) => [n.entityId, n]))
    expect(byId.get(root)?.accessLevel).toBe('known')
    expect(byId.get(secret)?.accessLevel).toBe('secret')
  })

  it('flags truncated:true and drops over-depth nodes when the tree exceeds GRAPH_MAX_DEPTH', async () => {
    // Linear chain of length GRAPH_MAX_DEPTH + 1 hops below the root. The binder
    // (called at GRAPH_MAX_DEPTH) returns depths 0..GRAPH_MAX_DEPTH; the node one
    // hop deeper is dropped, and the presence of a depth==GRAPH_MAX_DEPTH node
    // flags truncated.
    const chain: string[] = []
    for (let i = 0; i <= GRAPH_MAX_DEPTH + 1; i++) {
      chain.push(await seedEntity('faction', `f${String(i)}`))
    }
    for (let i = 0; i < chain.length - 1; i++) {
      const p = chain[i]
      const c = chain[i + 1]
      if (p === undefined || c === undefined) throw new Error('seed gap')
      await hier(p, c)
    }
    const root = chain[0]
    const atCap = chain[GRAPH_MAX_DEPTH]
    const pastCap = chain[GRAPH_MAX_DEPTH + 1]
    if (root === undefined || atCap === undefined || pastCap === undefined) {
      throw new Error('chain gap')
    }

    const { nodes, truncated } = await factionTree(deps, root)
    const ids = new Set(nodes.map((n) => n.entityId))
    expect(truncated).toBe(true)
    expect(ids.has(atCap)).toBe(true)
    expect(ids.has(pastCap)).toBe(false)
    expect(nodes.find((n) => n.entityId === atCap)?.depth).toBe(GRAPH_MAX_DEPTH)
  })
})
