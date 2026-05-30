// Test helper: a recording fake `repo` for unit-testing world-gen stage
// handlers that persist via `repo.transaction`.
//
// Post data-layer-unification (myth-gp2c), the stage handlers no longer take a
// `PoolClient` + issue raw `client.query` — they take a `repo` and call
// pool-bound binder methods (reads) + `repo.transaction(tx => tx.X…)` (writes).
// These unit tests assert the stage's persistence CONTRACT at the binder-call
// level (which arguments reach which namespace method), not raw SQL — the SQL
// itself is covered by the per-namespace repo integration tests
// (src/repo/__tests__/*). This mirrors the keystone migration's testing shift.
//
// `transaction(fn)` runs the callback synchronously against the SAME recording
// namespace surface and returns its value (no real BEGIN/COMMIT — there is no
// DB here). A thrown callback propagates, matching `repo.transaction`'s
// rollback-and-rethrow contract from the caller's perspective.

import { vi } from 'vitest'

export interface FakeRepo {
  worlds: {
    applyConcept: ReturnType<typeof vi.fn>
    setVocabularyRegistry: ReturnType<typeof vi.fn>
    setWorldOverview: ReturnType<typeof vi.fn>
    setEntityConsolidationPending: ReturnType<typeof vi.fn>
    clearEntityConsolidationPending: ReturnType<typeof vi.fn>
    getEntityConsolidationPending: ReturnType<typeof vi.fn>
    setStartingSituations: ReturnType<typeof vi.fn>
    setStartingSituationEntries: ReturnType<typeof vi.fn>
  }
  campaigns: {
    setNameFromUntitled: ReturnType<typeof vi.fn>
  }
  entities: {
    listByWorld: ReturnType<typeof vi.fn>
    listLocationsByWorld: ReturnType<typeof vi.fn>
    deleteByWorldAndCreatedIn: ReturnType<typeof vi.fn>
    insert: ReturnType<typeof vi.fn>
  }
  facts: { insertMany: ReturnType<typeof vi.fn> }
  proseKernels: { insert: ReturnType<typeof vi.fn> }
  relationships: {
    insertMany: ReturnType<typeof vi.fn>
    deleteByWorld: ReturnType<typeof vi.fn>
  }
  entityHierarchy: {
    insert: ReturnType<typeof vi.fn>
    listExistingChildIds: ReturnType<typeof vi.fn>
  }
  randomTables: {
    deleteByWorld: ReturnType<typeof vi.fn>
    insertTable: ReturnType<typeof vi.fn>
    insertEntries: ReturnType<typeof vi.fn>
  }
  // Composite world-inventory read (repo.worldInventory.load). Stage 4
  // (entity_relationships) reads the full inventory through this binder on the
  // pool surface, OUTSIDE the persist tx. Defaults to an empty inventory; the
  // entity-relationships test seeds it per case.
  worldInventory: { load: ReturnType<typeof vi.fn> }
  transaction: ReturnType<typeof vi.fn>
}

/**
 * Build a recording fake repo. Every namespace method is a `vi.fn()`; reads
 * default to benign empty results, writes default to resolve. `transaction`
 * runs its callback against `self` and returns the value (callback throw →
 * propagates). Tests override individual method mocks as needed.
 */
export function makeFakeRepo(): FakeRepo {
  const self: FakeRepo = {
    worlds: {
      applyConcept: vi.fn().mockResolvedValue(undefined),
      setVocabularyRegistry: vi.fn().mockResolvedValue(undefined),
      setWorldOverview: vi.fn().mockResolvedValue(undefined),
      setEntityConsolidationPending: vi.fn().mockResolvedValue(undefined),
      clearEntityConsolidationPending: vi.fn().mockResolvedValue(undefined),
      getEntityConsolidationPending: vi.fn().mockResolvedValue(null),
      setStartingSituations: vi.fn().mockResolvedValue(undefined),
      setStartingSituationEntries: vi.fn().mockResolvedValue(undefined),
    },
    campaigns: {
      setNameFromUntitled: vi.fn().mockResolvedValue(undefined),
    },
    entities: {
      listByWorld: vi.fn().mockResolvedValue([]),
      listLocationsByWorld: vi.fn().mockResolvedValue([]),
      deleteByWorldAndCreatedIn: vi.fn().mockResolvedValue(undefined),
      insert: vi.fn().mockResolvedValue(undefined),
    },
    facts: { insertMany: vi.fn().mockResolvedValue(undefined) },
    proseKernels: { insert: vi.fn().mockResolvedValue(undefined) },
    relationships: {
      insertMany: vi.fn().mockImplementation((rows: readonly unknown[]) =>
        Promise.resolve(rows.map((_r, i) => `rel-${String(i)}`)),
      ),
      deleteByWorld: vi.fn().mockResolvedValue(undefined),
    },
    entityHierarchy: {
      insert: vi.fn().mockResolvedValue(undefined),
      listExistingChildIds: vi.fn().mockResolvedValue([]),
    },
    randomTables: {
      deleteByWorld: vi.fn().mockResolvedValue(undefined),
      insertTable: vi.fn().mockResolvedValue('table-0'),
      insertEntries: vi.fn().mockResolvedValue(undefined),
    },
    worldInventory: {
      load: vi.fn().mockResolvedValue({
        entitiesById: new Map(),
        proseByEntityId: new Map(),
        factsById: new Map(),
        relationshipsById: new Map(),
      }),
    },
    transaction: vi.fn(),
  }
  // transaction(fn) runs fn against the same recording surface and returns its
  // value; a throw propagates (matching the rollback-and-rethrow contract).
  self.transaction.mockImplementation((fn: (tx: FakeRepo) => Promise<unknown>) => fn(self))
  return self
}
