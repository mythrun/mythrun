# Coherence Pass — Full Patch Vocabulary Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Extend the coherence pass with 3 new patch kinds (`add_relationship_by_name`, `add_fact_by_name`, `delete_fact_by_name`), let `fix_relationship_by_name` rewrite endpoints, persist relationship synthKeys so myth-p4sz's wire-event drop is fixed, and add `fact-added`/`fact-removed`/`fact-updated` SSE events.

**Architecture:** Schema migration adds a nullable `synth_key` column on `relationships`. Stages 4 and 4b populate it at insert time using the same shape they already emit on wire events. Stage 7 loads it via `loadWorldInventory`, populates a new `synthKeyByRelationshipId` map on `ApplyContext`, and replaces the broken `synthKeyByEntityId[relationshipId]` lookups with it. Three new patch kinds land on `CoherenceOutputSchema`'s discriminated union. Apply functions in `coherence-pass.ts` resolve names → INSERT/DELETE rows → emit per-row SSE events. Three new event types extend `PipelineEvent` + `PIPELINE_SSE_EVENTS`; dev-tool drawer / live-events-panel render them. Prompt is rewritten to teach the model when to add vs. fix vs. delete. Live smoke per spec §7.4 verifies vocabulary uptake, myth-p4sz regression, and aggregate tier-balance.

**Tech Stack:** TypeScript (strict), Postgres (migrations 020), Zod, Vercel AI SDK, pg, Vitest.

**Beads:**
- `myth-imxg` — coherence patch-vocabulary gap (parent for T6–T24).
- `myth-p4sz` — relationship synthKey persistence + map split (T1–T5, T14, T15).

Decompose the tasks below into beads after the plan is reviewed. T1–T5 form a precondition chain (each unblocks the next); the rest sequence per the dependency notes inside each task.

---

## File Structure

**New files**
- `backend/migrations/020_relationships_synth_key.sql` — schema migration.
- `backend/src/llm/schemas/__tests__/coherence-output.test.ts` — schema tests (currently no such file).

**Modified files (backend)**
- `backend/migrations/MIGRATIONS.md` (or whatever the migration runner reads — see step in T1).
- `backend/src/repo/relationships.ts` — `InsertRelationshipInput` + `Relationship` + `RelationshipRow` gain `synthKey`. `insertMany` parameterizes + writes the new column. `listByWorld` + `listAmong` SELECT and return it.
- `backend/src/llm/prep/world-dump.ts` — `WorldInventory.relationshipsById` map values gain `synthKey: string`. `loadWorldInventory`'s `listByWorld` result already carries `synthKey` after the repo change; just pipe it through.
- `backend/src/llm/prep/stages/entity-relationships.ts` — stage-4 `insertMany` call site passes `synthKey: \`entity_relationships/relationships/${sourceIndex}\``.
- `backend/src/llm/prep/stages/entity-consolidation.ts` — stage-4b `insertMany` call site passes `synthKey: \`entity_consolidation/relationships/${i}\``.
- `backend/src/llm/schemas/coherence-output.ts` — extend `fix_relationship_by_name`; add `add_relationship_by_name`, `add_fact_by_name`, `delete_fact_by_name`; refresh the discriminated union to 8 arms.
- `backend/src/llm/prep/name-resolution.ts` — add `resolveAddRelationship`.
- `backend/src/llm/prep/__tests__/name-resolution.test.ts` — tests for the new resolver.
- `backend/src/contract/pipeline-events.ts` — add `fact-added`, `fact-removed`, `fact-updated` to `PipelineEvent` + `PIPELINE_SSE_EVENTS`.
- `backend/src/contract/__tests__/pipeline-contracts.test.ts` — update expected event list.
- `backend/src/llm/prep/stages/coherence-pass.ts` — `ApplyContext` gains `synthKeyByRelationshipId`; new apply helpers; existing apply helpers swap maps + accept new fields; dispatcher gains 3 cases; stage handler populates the new map from inventory.
- `backend/src/llm/prep/stages/__tests__/coherence-pass.test.ts` — new test cases; fixture rows gain `synth_key`.
- `backend/src/llm/prep/world-gen-processor.ts` — pass `synthKeyByRelationshipId` to `runCoherencePassStage` (no longer hardcoded `{}`).
- `backend/src/llm/prompts/prep/coherence-pass.txt` — rewrite per spec §5.

**Modified files (dev-tool, for the new wire events)**
- `backend/dev-tool/coverage.json` — add `fact-added`, `fact-removed`, `fact-updated` to `events[]`.
- `backend/dev-tool/src/components/live-events-panel.ts` — extend `PipelineEvent` union + `KNOWN_EVENT_TYPES` array; render rows for the new event types.
- `backend/dev-tool/src/components/world-snapshot-types.ts` — extend `PipelineEvent` union.
- `backend/dev-tool/src/shell/drawer/drawer.ts` — render handler arms for the 3 new event types.
- `backend/dev-tool/src/shell/drawer/__tests__/drawer.test.ts` — drawer-rendering tests for the new arms.

---

## Task 1: Migration 020 — `relationships.synth_key`

**Files:**
- Create: `backend/migrations/020_relationships_synth_key.sql`
- Modify (if applicable — see Step 1): `backend/migrations/MIGRATIONS.md` or equivalent index.

Beads: `myth-p4sz`. No predecessor.

- [ ] **Step 1: Verify the migration discovery mechanism**

Run: `ls backend/migrations/ | tail -5`
Expected: `019_starting_situation_titles.sql` is the latest. Next file is `020_*.sql`. The migration runner picks up files by name in lexical order (verify by reading `backend/src/db/migrate.ts` or wherever migrations are run — likely glob-based on numeric prefix). If a `MIGRATIONS.md` or similar index requires manual entry, note it.

Confirm with: `grep -rn "020\|migrations.*\*" backend/src/db/ backend/scripts/ 2>/dev/null | head`. If migrations are auto-discovered (glob), no index update is needed.

- [ ] **Step 2: Write the failing migration test**

A migration "test" here is an integration test in the existing migration test suite (look for one with `globalSetup` driving `pnpm db:migrate`). If there is no dedicated migration test, add the assertion to `backend/src/repo/__tests__/relationships.test.ts` (creating it if absent) using the existing test pool factory:

```typescript
// backend/src/repo/__tests__/relationships.test.ts
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { createTestPool } from '../../__tests__/createTestPool.js'
import type { Pool } from 'pg'

describe('relationships table — synth_key column', () => {
  let pool: Pool
  beforeAll(async () => { pool = await createTestPool() })
  afterAll(async () => { await pool.end() })

  it('has a nullable text synth_key column', async () => {
    const { rows } = await pool.query<{ data_type: string; is_nullable: 'YES' | 'NO' }>(
      `SELECT data_type, is_nullable
         FROM information_schema.columns
        WHERE table_name = 'relationships' AND column_name = 'synth_key'`,
    )
    expect(rows).toHaveLength(1)
    expect(rows[0]?.data_type).toBe('text')
    expect(rows[0]?.is_nullable).toBe('YES')
  })
})
```

Run: `pnpm vitest run backend/src/repo/__tests__/relationships.test.ts -t synth_key`
Expected: FAIL — column doesn't exist yet.

- [ ] **Step 3: Write the migration**

```sql
-- backend/migrations/020_relationships_synth_key.sql
--
-- myth-p4sz: persist a synth_key on relationships so stage 7 can look up
-- the wire-format identity of an existing row when emitting edge-removed
-- events (previously broken by a misnamed map; see coherence-pass.ts).
--
-- Nullable + best-effort backfill: existing rows lose the original
-- sourceIndex, so we synthesize a placeholder per row keyed by lexical
-- order. Future rows (stages 4 / 4b / 7) carry the real synthKey.

ALTER TABLE relationships
  ADD COLUMN synth_key TEXT NULL;

-- Backfill: deterministic placeholder for existing rows. row_number() over
-- a stable ordering (id ASC) gives a per-relationship sequence; stage 7
-- doesn't care about the value's exact shape, only that the lookup
-- succeeds.
WITH numbered AS (
  SELECT id, row_number() OVER (ORDER BY id) - 1 AS seq
    FROM relationships
)
UPDATE relationships r
   SET synth_key = 'entity_relationships/relationships/' || numbered.seq
  FROM numbered
 WHERE numbered.id = r.id;
```

No index needed; lookups are by primary key (`id`), and `synth_key` is read on inventory load (`SELECT ...`) once per stage-7 invocation.

- [ ] **Step 4: Run the migration + re-run the test**

Run: `pnpm db:migrate && pnpm vitest run backend/src/repo/__tests__/relationships.test.ts -t synth_key`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add backend/migrations/020_relationships_synth_key.sql backend/src/repo/__tests__/relationships.test.ts
git commit -m "feat(myth-p4sz): persist relationships.synth_key for stage-7 lookup"
```

---

## Task 2: Repo layer carries `synthKey`

**Files:**
- Modify: `backend/src/repo/relationships.ts` (lines 11–55, 80–98, 100–129)
- Test: `backend/src/repo/__tests__/relationships.test.ts`

Predecessor: T1.

- [ ] **Step 1: Write the failing test**

Append to `backend/src/repo/__tests__/relationships.test.ts`:

```typescript
import { relationships } from '../relationships.js'
import { entities } from '../entities.js'
import { uuidv7 } from '../uuidv7.js'

describe('relationships.insertMany — writes synth_key', () => {
  let pool: Pool
  beforeAll(async () => { pool = await createTestPool() })
  afterAll(async () => { await pool.end() })

  it('persists the supplied synth_key and listByWorld returns it', async () => {
    const client = await pool.connect()
    try {
      // Seed a minimal world with two entities the relationship can connect.
      const worldId = uuidv7()
      await client.query(
        `INSERT INTO worlds (id, name, dev_bypass_access_filter)
         VALUES ($1, 'test', false)`,
        [worldId],
      )
      const aId = uuidv7()
      const bId = uuidv7()
      await entities.insertMany(client, [
        { id: aId, worldId, name: 'A', entityType: 'location', accessLevel: 'known', createdIn: 'stage:test' },
        { id: bId, worldId, name: 'B', entityType: 'location', accessLevel: 'known', createdIn: 'stage:test' },
      ])

      const [relId] = await relationships.insertMany(client, [{
        sourceEntityId: aId,
        targetEntityId: bId,
        relationshipType: 'adjacent_to',
        description: 'Test edge.',
        synthKey: 'entity_relationships/relationships/0',
      }])

      const rows = await relationships.listByWorld(client, worldId)
      const row = rows.find((r) => r.id === relId)
      expect(row?.synthKey).toBe('entity_relationships/relationships/0')
    } finally {
      client.release()
    }
  })
})
```

Run: `pnpm vitest run backend/src/repo/__tests__/relationships.test.ts -t synth_key`
Expected: FAIL — `synthKey` field doesn't exist on `InsertRelationshipInput`.

- [ ] **Step 2: Extend the repo types and SQL**

Edit `backend/src/repo/relationships.ts`:

```typescript
export interface InsertRelationshipInput {
  readonly sourceEntityId: string
  readonly targetEntityId: string
  readonly relationshipType: string
  readonly description: string
  readonly synthKey: string  // NEW: required so stage 7 can address the row on the wire.
}

export interface Relationship {
  readonly id: string
  readonly sourceEntityId: string
  readonly targetEntityId: string
  readonly relationshipType: string
  readonly description: string
  readonly synthKey: string  // NEW
}

interface RelationshipListByWorldDbRow {
  readonly id: string
  readonly source_entity_id: string
  readonly target_entity_id: string
  readonly relationship_type: string
  readonly description: string
  readonly synth_key: string  // NEW
}

function toRelationship(row: RelationshipListByWorldDbRow): Relationship {
  return {
    id: row.id,
    sourceEntityId: row.source_entity_id,
    targetEntityId: row.target_entity_id,
    relationshipType: row.relationship_type,
    description: row.description,
    synthKey: row.synth_key,  // NEW
  }
}
```

Update `insertMany` to write the new column:

```typescript
async function insertMany(client: ClientLike, rows: readonly InsertRelationshipInput[]): Promise<readonly string[]> {
  if (rows.length === 0) return []
  const values: string[] = []
  const params: unknown[] = []
  const ids: string[] = []
  let p = 1
  for (const row of rows) {
    const id = uuidv7()
    ids.push(id)
    values.push(`($${String(p++)}, $${String(p++)}, $${String(p++)}, $${String(p++)}, $${String(p++)}, $${String(p++)})`)
    params.push(id, row.sourceEntityId, row.targetEntityId, row.relationshipType, row.description, row.synthKey)
  }
  await client.query(
    `INSERT INTO relationships (id, source_entity_id, target_entity_id, relationship_type, description, synth_key)
     VALUES ${values.join(', ')}`,
    params,
  )
  return ids
}
```

Update `listByWorld` to SELECT the column:

```typescript
async function listByWorld(client: ClientLike, worldId: string): Promise<Relationship[]> {
  const result = await client.query<RelationshipListByWorldDbRow>(
    `SELECT r.id, r.source_entity_id, r.target_entity_id, r.relationship_type, r.description, r.synth_key
       FROM relationships r
       JOIN entities e ON e.id = r.source_entity_id
       WHERE e.world_id = $1`,
    [worldId],
  )
  return result.rows.map(toRelationship)
}
```

Also extend `RelationshipRow` + `RelationshipDbRow` + `toRelationshipRow` + the `listAmong` SELECT to include `synth_key` / `synthKey`. Snapshot-view consumers benefit from the field too.

- [ ] **Step 3: Run the test**

Run: `pnpm vitest run backend/src/repo/__tests__/relationships.test.ts`
Expected: PASS. The wider repo test will now likely fail-compile in callers; that's fixed in T4–T5.

- [ ] **Step 4: Typecheck — confirm the only compile breakage is the planned callers**

Run: `pnpm typecheck`
Expected: errors only at `entity-relationships.ts:452-460` and `entity-consolidation.ts:295` (the two `insertMany` callers that don't supply `synthKey` yet). Resolved in T4–T5. Any OTHER failures: stop and report — they signal a missed consumer.

- [ ] **Step 5: Commit**

```bash
git add backend/src/repo/relationships.ts backend/src/repo/__tests__/relationships.test.ts
git commit -m "feat(myth-p4sz): plumb synth_key through relationships repo layer"
```

Note: typecheck is RED at this commit because the two callers don't supply `synthKey`. That's intentional — T4 and T5 close the gap, and the WIP commit is fine because we're not pushing yet (pushes batched per push discipline).

---

## Task 3: `WorldInventory` exposes relationship `synthKey`

**Files:**
- Modify: `backend/src/llm/prep/world-dump.ts:34-43`, `97-98`
- Test: `backend/src/llm/prep/__tests__/world-dump.test.ts`

Predecessor: T2.

- [ ] **Step 1: Write the failing test**

Locate or add to `backend/src/llm/prep/__tests__/world-dump.test.ts`. Verify against a seeded world that `loadWorldInventory` surfaces `synthKey` on each relationship value:

```typescript
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { createTestPool } from '../../../__tests__/createTestPool.js'
import { loadWorldInventory } from '../world-dump.js'
import { entities } from '../../../repo/entities.js'
import { relationships } from '../../../repo/relationships.js'
import { uuidv7 } from '../../../repo/uuidv7.js'
import type { Pool } from 'pg'

describe('loadWorldInventory — synthKey on relationships', () => {
  let pool: Pool
  beforeAll(async () => { pool = await createTestPool() })
  afterAll(async () => { await pool.end() })

  it('returns synthKey per relationship', async () => {
    const client = await pool.connect()
    try {
      const worldId = uuidv7()
      await client.query(
        `INSERT INTO worlds (id, name, dev_bypass_access_filter) VALUES ($1, 'wd', false)`,
        [worldId],
      )
      const aId = uuidv7()
      const bId = uuidv7()
      await entities.insertMany(client, [
        { id: aId, worldId, name: 'A', entityType: 'location', accessLevel: 'known', createdIn: 'stage:test' },
        { id: bId, worldId, name: 'B', entityType: 'location', accessLevel: 'known', createdIn: 'stage:test' },
      ])
      const [relId] = await relationships.insertMany(client, [{
        sourceEntityId: aId,
        targetEntityId: bId,
        relationshipType: 'borders',
        description: '.',
        synthKey: 'entity_relationships/relationships/3',
      }])

      const inv = await loadWorldInventory(client, worldId)
      expect(inv.relationshipsById.get(relId)?.synthKey).toBe('entity_relationships/relationships/3')
    } finally {
      client.release()
    }
  })
})
```

Run: `pnpm vitest run backend/src/llm/prep/__tests__/world-dump.test.ts -t synthKey`
Expected: FAIL — `WorldInventory.relationshipsById` value type doesn't include `synthKey`.

- [ ] **Step 2: Extend `WorldInventory`**

Edit `backend/src/llm/prep/world-dump.ts:34-43`:

```typescript
readonly relationshipsById: Map<
  string,
  {
    id: string
    sourceEntityId: string
    targetEntityId: string
    relationshipType: string
    description: string
    synthKey: string  // NEW
  }
>
```

`loadWorldInventory` already calls `relationships.listByWorld`, which now returns `synthKey` (from T2). The `new Map(relRows.map((r) => [r.id, r]))` construction at line 98 propagates the field as-is. No code change beyond the type declaration.

- [ ] **Step 3: Run the test**

Run: `pnpm vitest run backend/src/llm/prep/__tests__/world-dump.test.ts -t synthKey && pnpm typecheck`
Expected: world-dump test PASSES. typecheck STILL RED on entity-relationships.ts:452 and entity-consolidation.ts:295 — fixed by T4 and T5.

- [ ] **Step 4: Commit**

```bash
git add backend/src/llm/prep/world-dump.ts backend/src/llm/prep/__tests__/world-dump.test.ts
git commit -m "feat(myth-p4sz): WorldInventory exposes relationship synthKey"
```

---

## Task 4: Stage 4 (entity_relationships) passes `synthKey` on insert

**Files:**
- Modify: `backend/src/llm/prep/stages/entity-relationships.ts:452-460`
- Test: `backend/src/llm/prep/stages/__tests__/entity-relationships.test.ts`

Predecessor: T2.

- [ ] **Step 1: Write the failing assertion**

Inside an existing stage-4 happy-path test (or add a new one) that already seeds a world and runs the stage with a mocked LLM output, append an assertion that the persisted relationship rows carry the expected synth_key. Find an integration test (not a mock-only unit test) in `entity-relationships.test.ts`. After running the stage, query the `relationships` table directly:

```typescript
const { rows } = await client.query<{ synth_key: string }>(
  `SELECT synth_key FROM relationships
     WHERE source_entity_id IN (SELECT id FROM entities WHERE world_id = $1)
     ORDER BY synth_key`,
  [worldId],
)
expect(rows.map((r) => r.synth_key)).toEqual([
  'entity_relationships/relationships/0',
  'entity_relationships/relationships/1',
  // … one per accepted row, indexed by the LLM emit order
])
```

Run: `pnpm vitest run backend/src/llm/prep/stages/__tests__/entity-relationships.test.ts -t synth_key`
Expected: FAIL — column is currently the backfilled placeholder, not the live stage-4 synthKey (or, depending on test fixture, `null`-from-default).

- [ ] **Step 2: Wire `synthKey` into `insertMany`**

Edit `backend/src/llm/prep/stages/entity-relationships.ts:452-460`:

```typescript
const relationshipIds = await relationships.insertMany(
  client,
  accepted.map((a) => ({
    sourceEntityId: a.sourceEntityId,
    targetEntityId: a.targetEntityId,
    relationshipType: a.relationshipType,
    description: a.description,
    synthKey: `entity_relationships/relationships/${String(a.sourceIndex)}`,  // NEW
  })),
)
```

This is the same string the post-commit `finalized` event uses at line 496 (`synthKey: \`entity_relationships/relationships/${String(row.sourceIndex)}\``). Keeping them identical means stage 7 can address the row by the same string the wire feed already established at stage 4.

- [ ] **Step 3: Run the test + the broader suite**

Run: `pnpm vitest run backend/src/llm/prep/stages/__tests__/entity-relationships.test.ts`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add backend/src/llm/prep/stages/entity-relationships.ts backend/src/llm/prep/stages/__tests__/entity-relationships.test.ts
git commit -m "feat(myth-p4sz): stage 4 persists relationship synth_key"
```

---

## Task 5: Stage 4b (entity_consolidation) passes `synthKey` on insert

**Files:**
- Modify: `backend/src/llm/prep/stages/entity-consolidation.ts:295`
- Test: `backend/src/llm/prep/stages/__tests__/entity-consolidation.test.ts`

Predecessor: T2.

- [ ] **Step 1: Write the failing assertion**

Add to a stage-4b integration test in `entity-consolidation.test.ts`. After running the stage with phantom-relationship reconciliation, query the new `synth_key` column:

```typescript
const { rows } = await client.query<{ synth_key: string }>(
  `SELECT synth_key FROM relationships
     WHERE source_entity_id IN (SELECT id FROM entities WHERE world_id = $1 AND created_in = 'stage:entity_consolidation')
     ORDER BY synth_key`,
  [worldId],
)
expect(rows.map((r) => r.synth_key)).toEqual(
  expect.arrayContaining(['entity_consolidation/relationships/0']),
)
```

Run: `pnpm vitest run backend/src/llm/prep/stages/__tests__/entity-consolidation.test.ts -t synth_key`
Expected: FAIL.

- [ ] **Step 2: Wire `synthKey` into stage 4b's `insertMany`**

Read `backend/src/llm/prep/stages/entity-consolidation.ts:280-310` (the `resolvedRels` build + `insertMany` call). The current code (line 295) is:

```typescript
await relationships.insertMany(client, resolvedRels)
```

`resolvedRels` is an array of `InsertRelationshipInput`-shaped objects, indexed in the same order as the `edge-added` events emitted at line 305 (`synthKey: \`entity_consolidation/relationships/${String(i)}\``). Build the synthKey at construction time:

```typescript
const resolvedRelsWithKeys = resolvedRels.map((rel, i) => ({
  ...rel,
  synthKey: `entity_consolidation/relationships/${String(i)}`,
}))
await relationships.insertMany(client, resolvedRelsWithKeys)
```

(If the existing `resolvedRels` construction is inside a `.map` callback that already knows the index, fold the `synthKey` into that map and skip the second pass.)

- [ ] **Step 3: Run the test**

Run: `pnpm vitest run backend/src/llm/prep/stages/__tests__/entity-consolidation.test.ts && pnpm typecheck`
Expected: PASS on both. T2's predicted typecheck-red state is now resolved.

- [ ] **Step 4: Commit**

```bash
git add backend/src/llm/prep/stages/entity-consolidation.ts backend/src/llm/prep/stages/__tests__/entity-consolidation.test.ts
git commit -m "feat(myth-p4sz): stage 4b persists relationship synth_key"
```

---

## Task 6: Create `coherence-output.test.ts` covering existing 5 kinds

**Files:**
- Create: `backend/src/llm/schemas/__tests__/coherence-output.test.ts`

Predecessor: none (parallel-safe with T1–T5).

This task establishes the regression net before extending the schema in T7–T10.

- [ ] **Step 1: Write the test file**

```typescript
// backend/src/llm/schemas/__tests__/coherence-output.test.ts
import { describe, it, expect } from 'vitest'
import { CoherencePatchSchema, CoherenceOutputSchema } from '../coherence-output.js'

describe('CoherencePatchSchema — existing kinds', () => {
  it('accepts a valid fix_fact_by_name patch', () => {
    expect(() =>
      CoherencePatchSchema.parse({
        kind: 'fix_fact_by_name',
        entity_name: 'Old Eredil',
        fact_topic: 'history',
        new_content: 'The village burned a generation ago.',
        rationale: 'Existing fact contradicted the prose.',
      }),
    ).not.toThrow()
  })

  it('accepts a valid fix_prose_by_name patch', () => {
    expect(() =>
      CoherencePatchSchema.parse({
        kind: 'fix_prose_by_name',
        entity_name: 'Old Eredil',
        new_prose: 'A weathered fishing village, half rebuilt after the fire that took the upper quarter generations ago.',
        rationale: 'Prose contradicted historical timeline.',
      }),
    ).not.toThrow()
  })

  it('accepts a valid fix_relationship_by_name patch with newType only', () => {
    expect(() =>
      CoherencePatchSchema.parse({
        kind: 'fix_relationship_by_name',
        source_name: 'Old Eredil',
        target_name: 'Mara',
        current_type: 'rivalry',
        newType: 'distrusts',
        rationale: 'Type rivalry too strong for the prose.',
      }),
    ).not.toThrow()
  })

  it('accepts a valid rename_entity_by_name patch', () => {
    expect(() =>
      CoherencePatchSchema.parse({
        kind: 'rename_entity_by_name',
        old_name: 'Mara',
        new_name: 'Mara Salt-Hand',
        rationale: 'Other prose references the longer form.',
      }),
    ).not.toThrow()
  })

  it('accepts a valid delete_relationship_by_name patch', () => {
    expect(() =>
      CoherencePatchSchema.parse({
        kind: 'delete_relationship_by_name',
        source_name: 'Mara',
        target_name: 'The Wharf',
        current_type: 'employed_by',
        rationale: 'Redundant with another relationship after the prior fix.',
      }),
    ).not.toThrow()
  })

  it('rejects unknown kind', () => {
    expect(() =>
      CoherencePatchSchema.parse({
        kind: 'invent_entity',
        entity_name: 'X',
        rationale: 'too short for nothing',
      }),
    ).toThrow()
  })
})

describe('CoherenceOutputSchema', () => {
  it('caps patches at 40', () => {
    const patches = Array.from({ length: 41 }).map(() => ({
      kind: 'fix_fact_by_name',
      entity_name: 'X',
      fact_topic: 'y',
      new_content: 'aaaaaaaaaa',
      rationale: 'this is a long enough rationale for the test',
    }))
    expect(() => CoherenceOutputSchema.parse({ patches })).toThrow()
  })
})
```

- [ ] **Step 2: Run the tests**

Run: `pnpm vitest run backend/src/llm/schemas/__tests__/coherence-output.test.ts`
Expected: PASS (existing schema covers these cases).

- [ ] **Step 3: Commit**

```bash
git add backend/src/llm/schemas/__tests__/coherence-output.test.ts
git commit -m "test(coherence): cover existing schema kinds before extending"
```

---

## Task 7: Extend `fix_relationship_by_name` schema with `newSource`/`newTarget` + refine

**Files:**
- Modify: `backend/src/llm/schemas/coherence-output.ts:37-45`
- Test: `backend/src/llm/schemas/__tests__/coherence-output.test.ts`

Predecessor: T6.

- [ ] **Step 1: Write failing tests for the new shape**

Append to `coherence-output.test.ts`:

```typescript
describe('fix_relationship_by_name — newSource / newTarget', () => {
  it('accepts newSource alone', () => {
    expect(() =>
      CoherencePatchSchema.parse({
        kind: 'fix_relationship_by_name',
        source_name: 'A',
        target_name: 'B',
        current_type: 'allied_with',
        newSource: 'A-prime',
        rationale: 'The original source was the wrong entity; correcting.',
      }),
    ).not.toThrow()
  })

  it('accepts newTarget alone', () => {
    expect(() =>
      CoherencePatchSchema.parse({
        kind: 'fix_relationship_by_name',
        source_name: 'A',
        target_name: 'B',
        current_type: 'allied_with',
        newTarget: 'B-prime',
        rationale: 'Wrong target — relationship should land on B-prime.',
      }),
    ).not.toThrow()
  })

  it('accepts newSource + newTarget together', () => {
    expect(() =>
      CoherencePatchSchema.parse({
        kind: 'fix_relationship_by_name',
        source_name: 'A',
        target_name: 'B',
        current_type: 'allied_with',
        newSource: 'A-prime',
        newTarget: 'B-prime',
        rationale: 'Both endpoints were wrong; redirect both.',
      }),
    ).not.toThrow()
  })

  it('rejects a patch with NO new* fields (.refine no-op guard)', () => {
    expect(() =>
      CoherencePatchSchema.parse({
        kind: 'fix_relationship_by_name',
        source_name: 'A',
        target_name: 'B',
        current_type: 'allied_with',
        rationale: 'Reviewer flagged this but supplied no actual change.',
      }),
    ).toThrow(/at least one of newSource, newTarget, newType, newDescription/)
  })
})
```

Run: `pnpm vitest run backend/src/llm/schemas/__tests__/coherence-output.test.ts -t fix_relationship_by_name`
Expected: FAIL on each new test — newSource/newTarget not recognized, and the no-op patch is accepted.

- [ ] **Step 2: Extend the schema**

Edit `backend/src/llm/schemas/coherence-output.ts:37-45`:

```typescript
const fixRelationshipPatch = z.object({
  kind: z.literal('fix_relationship_by_name'),
  source_name: z.string().min(1).max(200),
  target_name: z.string().min(1).max(200),
  current_type: z.string().min(2).max(60),
  newSource: z.string().min(1).max(200).optional(),       // NEW
  newTarget: z.string().min(1).max(200).optional(),       // NEW
  newType: z.string().min(2).max(60).optional(),
  newDescription: z.string().min(10).max(600).optional(),
  rationale: z.string().min(20).max(400),
}).refine(
  (p) => p.newSource !== undefined
    || p.newTarget !== undefined
    || p.newType !== undefined
    || p.newDescription !== undefined,
  { message: 'fix_relationship_by_name requires at least one of newSource, newTarget, newType, newDescription' },
)
```

- [ ] **Step 3: Run the tests**

Run: `pnpm vitest run backend/src/llm/schemas/__tests__/coherence-output.test.ts`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add backend/src/llm/schemas/coherence-output.ts backend/src/llm/schemas/__tests__/coherence-output.test.ts
git commit -m "feat(myth-imxg): fix_relationship_by_name accepts newSource / newTarget"
```

---

## Task 8: Add `add_relationship_by_name` schema

**Files:**
- Modify: `backend/src/llm/schemas/coherence-output.ts`
- Test: `backend/src/llm/schemas/__tests__/coherence-output.test.ts`

Predecessor: T6.

- [ ] **Step 1: Write failing tests**

Append to `coherence-output.test.ts`:

```typescript
describe('add_relationship_by_name', () => {
  it('accepts a valid patch', () => {
    expect(() =>
      CoherencePatchSchema.parse({
        kind: 'add_relationship_by_name',
        source_name: 'Brother Anselm',
        target_name: 'Stillwater Monastery',
        relationship: 'keeper_of',
        description: 'Anselm serves as the Keeper of the Order at Stillwater.',
        rationale: 'Prose explicitly states this; structured stage missed it.',
      }),
    ).not.toThrow()
  })

  it('rejects short description', () => {
    expect(() =>
      CoherencePatchSchema.parse({
        kind: 'add_relationship_by_name',
        source_name: 'A',
        target_name: 'B',
        relationship: 'allied_with',
        description: 'short',
        rationale: 'Reasonable length but description fails the floor.',
      }),
    ).toThrow()
  })
})
```

Run: `pnpm vitest run backend/src/llm/schemas/__tests__/coherence-output.test.ts -t add_relationship_by_name`
Expected: FAIL.

- [ ] **Step 2: Add the schema**

Edit `backend/src/llm/schemas/coherence-output.ts` — insert between `fixRelationshipPatch` and `renameEntityPatch`:

```typescript
const addRelationshipPatch = z.object({
  kind: z.literal('add_relationship_by_name'),
  source_name: z.string().min(1).max(200),
  target_name: z.string().min(1).max(200),
  relationship: z.string().min(2).max(60),
  description: z.string().min(10).max(600),
  rationale: z.string().min(20).max(400),
})
```

Add `addRelationshipPatch` to the `z.discriminatedUnion('kind', [...])` array.

- [ ] **Step 3: Run the tests**

Run: `pnpm vitest run backend/src/llm/schemas/__tests__/coherence-output.test.ts`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add backend/src/llm/schemas/coherence-output.ts backend/src/llm/schemas/__tests__/coherence-output.test.ts
git commit -m "feat(myth-imxg): add_relationship_by_name patch kind"
```

---

## Task 9: Add `add_fact_by_name` schema

**Files:**
- Modify: `backend/src/llm/schemas/coherence-output.ts`
- Test: `backend/src/llm/schemas/__tests__/coherence-output.test.ts`

Predecessor: T6.

- [ ] **Step 1: Write failing tests**

Append:

```typescript
describe('add_fact_by_name', () => {
  it('accepts a valid patch with each access_level', () => {
    for (const access_level of ['known', 'discoverable', 'secret'] as const) {
      expect(() =>
        CoherencePatchSchema.parse({
          kind: 'add_fact_by_name',
          entity_name: 'Brother Anselm',
          topic: 'duties',
          content: 'Walks the cloister every dawn to inspect the offering candles.',
          access_level,
          rationale: `Prose strongly implies this; not yet structured. Tier ${access_level}.`,
        }),
      ).not.toThrow()
    }
  })

  it('rejects unknown access_level', () => {
    expect(() =>
      CoherencePatchSchema.parse({
        kind: 'add_fact_by_name',
        entity_name: 'A',
        topic: 'x',
        content: 'short but legal length',
        access_level: 'public',
        rationale: 'Reasonable length here for the test.',
      }),
    ).toThrow()
  })
})
```

Run: expected FAIL.

- [ ] **Step 2: Add the schema**

```typescript
const addFactPatch = z.object({
  kind: z.literal('add_fact_by_name'),
  entity_name: z.string().min(1).max(200),
  topic: z.string().min(1).max(120),
  content: z.string().min(10).max(2000),
  access_level: z.enum(['known', 'discoverable', 'secret']),
  rationale: z.string().min(20).max(400),
})
```

Add to the discriminated union.

- [ ] **Step 3: Run + commit**

Run: `pnpm vitest run backend/src/llm/schemas/__tests__/coherence-output.test.ts` (PASS).

```bash
git add backend/src/llm/schemas/coherence-output.ts backend/src/llm/schemas/__tests__/coherence-output.test.ts
git commit -m "feat(myth-imxg): add_fact_by_name patch kind"
```

---

## Task 10: Add `delete_fact_by_name` schema

**Files:**
- Modify: `backend/src/llm/schemas/coherence-output.ts`
- Test: `backend/src/llm/schemas/__tests__/coherence-output.test.ts`

Predecessor: T6.

- [ ] **Step 1: Write failing tests**

```typescript
describe('delete_fact_by_name', () => {
  it('accepts a valid patch with a 60+ char rationale', () => {
    expect(() =>
      CoherencePatchSchema.parse({
        kind: 'delete_fact_by_name',
        entity_name: 'Brother Anselm',
        fact_topic: 'pet_dog',
        rationale: 'The fact says Anselm keeps a dog, but the prose explicitly says the monastery forbids animals; delete since no fix preserves the fact.',
      }),
    ).not.toThrow()
  })

  it('rejects rationale shorter than 60 chars (irreversible delete floor)', () => {
    expect(() =>
      CoherencePatchSchema.parse({
        kind: 'delete_fact_by_name',
        entity_name: 'X',
        fact_topic: 'y',
        rationale: 'too short for delete',
      }),
    ).toThrow()
  })
})
```

Run: expected FAIL.

- [ ] **Step 2: Add the schema**

```typescript
const deleteFactPatch = z.object({
  kind: z.literal('delete_fact_by_name'),
  entity_name: z.string().min(1).max(200),
  fact_topic: z.string().min(1).max(120),
  rationale: z.string().min(60).max(400),  // higher floor — deletes are irreversible
})
```

Add to the discriminated union; final array becomes 8 arms (`fixFactPatch`, `fixProsePatch`, `fixRelationshipPatch`, `renameEntityPatch`, `deleteRelationshipPatch`, `addRelationshipPatch`, `addFactPatch`, `deleteFactPatch`).

Update the file's header comment block (lines 9–18) to enumerate the 8 patch kinds.

- [ ] **Step 3: Run + commit**

Run: `pnpm vitest run backend/src/llm/schemas/__tests__/coherence-output.test.ts && pnpm typecheck`
Expected: schema tests PASS; typecheck will reveal exhaustive-switch errors at `coherence-pass.ts:339` — the dispatcher must handle the three new kinds. Those are addressed in T21.

```bash
git add backend/src/llm/schemas/coherence-output.ts backend/src/llm/schemas/__tests__/coherence-output.test.ts
git commit -m "feat(myth-imxg): delete_fact_by_name patch kind + extend discriminated union to 8 arms"
```

---

## Task 11: Add `resolveAddRelationship` resolver + tests

**Files:**
- Modify: `backend/src/llm/prep/name-resolution.ts:280-313`
- Modify: `backend/src/llm/prep/__tests__/name-resolution.test.ts`

Predecessor: none (parallel-safe with T1–T10).

- [ ] **Step 1: Write failing resolver tests**

Append to `backend/src/llm/prep/__tests__/name-resolution.test.ts`:

```typescript
describe('resolveAddRelationship', () => {
  // Reuse the existing buildInventory / buildResolutionContext helpers in
  // this test file (the patterns for resolveFixRelationship show the
  // fixture shape).

  it('returns resolved with both entity ids when both names match', () => {
    const inv = buildInventory({
      entities: [
        { id: 'E1', name: 'Alpha' },
        { id: 'E2', name: 'Beta' },
      ],
    })
    const ctx = buildResolutionContext(inv)
    const res = resolveAddRelationship(ctx, { source_name: 'Alpha', target_name: 'Beta' })
    expect(res).toEqual({ kind: 'resolved', sourceEntityId: 'E1', targetEntityId: 'E2' })
  })

  it('returns dropped/unknown_source when source name does not exist', () => {
    const inv = buildInventory({ entities: [{ id: 'E2', name: 'Beta' }] })
    const ctx = buildResolutionContext(inv)
    const res = resolveAddRelationship(ctx, { source_name: 'Alpha', target_name: 'Beta' })
    expect(res).toEqual({ kind: 'dropped', reason: 'unknown_source' })
  })

  it('returns dropped/unknown_target when target name does not exist', () => {
    const inv = buildInventory({ entities: [{ id: 'E1', name: 'Alpha' }] })
    const ctx = buildResolutionContext(inv)
    const res = resolveAddRelationship(ctx, { source_name: 'Alpha', target_name: 'Beta' })
    expect(res).toEqual({ kind: 'dropped', reason: 'unknown_target' })
  })

  it('returns dropped/ambiguous_source when source name is duplicated', () => {
    const inv = buildInventory({
      entities: [
        { id: 'E1', name: 'Alpha' },
        { id: 'E1b', name: 'Alpha' },
        { id: 'E2', name: 'Beta' },
      ],
    })
    const ctx = buildResolutionContext(inv)
    const res = resolveAddRelationship(ctx, { source_name: 'Alpha', target_name: 'Beta' })
    expect(res).toEqual({ kind: 'dropped', reason: 'ambiguous_source' })
  })

  it('returns dropped/ambiguous_target when target name is duplicated', () => {
    const inv = buildInventory({
      entities: [
        { id: 'E1', name: 'Alpha' },
        { id: 'E2', name: 'Beta' },
        { id: 'E2b', name: 'Beta' },
      ],
    })
    const ctx = buildResolutionContext(inv)
    const res = resolveAddRelationship(ctx, { source_name: 'Alpha', target_name: 'Beta' })
    expect(res).toEqual({ kind: 'dropped', reason: 'ambiguous_target' })
  })
})
```

Import `resolveAddRelationship` at the top of the test file.

Run: `pnpm vitest run backend/src/llm/prep/__tests__/name-resolution.test.ts -t resolveAddRelationship`
Expected: FAIL — function doesn't exist.

- [ ] **Step 2: Implement the resolver**

Append to `backend/src/llm/prep/name-resolution.ts`:

```typescript
export type AddRelationshipResolution =
  | { kind: 'resolved'; sourceEntityId: string; targetEntityId: string }
  | { kind: 'dropped'; reason: 'unknown_source' | 'unknown_target' | 'ambiguous_source' | 'ambiguous_target' }

export function resolveAddRelationship(
  ctx: NameResolutionContext,
  emitted: { source_name: string; target_name: string },
): AddRelationshipResolution {
  const src = normalizeName(emitted.source_name)
  const tgt = normalizeName(emitted.target_name)
  if (ctx.ambiguousEntityNames.has(src)) return { kind: 'dropped', reason: 'ambiguous_source' }
  if (ctx.ambiguousEntityNames.has(tgt)) return { kind: 'dropped', reason: 'ambiguous_target' }
  const sourceEntityId = ctx.entityIdByName.get(src)
  if (sourceEntityId === undefined) return { kind: 'dropped', reason: 'unknown_source' }
  const targetEntityId = ctx.entityIdByName.get(tgt)
  if (targetEntityId === undefined) return { kind: 'dropped', reason: 'unknown_target' }
  return { kind: 'resolved', sourceEntityId, targetEntityId }
}
```

Resolution order matches `resolveRelationship` (ambiguity wins over unknown) so logs read consistently.

- [ ] **Step 3: Run the tests**

Run: `pnpm vitest run backend/src/llm/prep/__tests__/name-resolution.test.ts`
Expected: PASS (all 5 new + existing tests).

- [ ] **Step 4: Commit**

```bash
git add backend/src/llm/prep/name-resolution.ts backend/src/llm/prep/__tests__/name-resolution.test.ts
git commit -m "feat(myth-imxg): add resolveAddRelationship for two-endpoint name lookup"
```

---

## Task 12: Add `fact-added` / `fact-removed` / `fact-updated` to the pipeline contract

**Files:**
- Modify: `backend/src/contract/pipeline-events.ts`
- Modify: `backend/src/contract/__tests__/pipeline-contracts.test.ts`

Predecessor: none.

- [ ] **Step 1: Update the expected-events test**

Edit `backend/src/contract/__tests__/pipeline-contracts.test.ts:42-57` to include the three new strings in the `expected` array:

```typescript
const expected: readonly PipelineSseEvent[] = [
  'phase',
  'stage-started',
  'stage-completed',
  'stage-failed',
  'cost-update',
  'job-failed',
  'stage-reset',
  'entity-added',
  'entity-updated',
  'entity-removed',
  'edge-added',
  'edge-removed',
  'fact-added',
  'fact-removed',
  'fact-updated',
  'finalized',
]
```

Run: `pnpm vitest run backend/src/contract/__tests__/pipeline-contracts.test.ts`
Expected: FAIL — `PipelineSseEvent` union doesn't include the new strings.

- [ ] **Step 2: Extend `PIPELINE_SSE_EVENTS` and `PipelineEvent`**

Edit `backend/src/contract/pipeline-events.ts`:

```typescript
export const PIPELINE_SSE_EVENTS: readonly string[] = [
  'phase',
  'stage-started',
  'stage-completed',
  'stage-failed',
  'cost-update',
  'job-failed',
  'stage-reset',
  'entity-added',
  'entity-updated',
  'entity-removed',
  'edge-added',
  'edge-removed',
  'fact-added',     // NEW
  'fact-removed',   // NEW
  'fact-updated',   // NEW
  'finalized',
] as const
```

Append to the `PipelineEvent` discriminated union (after the `edge-removed` arm):

```typescript
  // myth-imxg: per-fact wire events. Symmetric with entity/edge add/remove.
  // entitySynthKey is the owning entity's synthKey (same map the
  // entity-updated event uses); factId is the row's UUID; topic/content/
  // accessLevel snapshot the new shape. fact-updated carries the new
  // content + topic; the FE replaces its prior fact row of the same id.
  | {
      type: 'fact-added'
      entitySynthKey: string
      factId: string
      topic: string
      content: string
      accessLevel: 'known' | 'discoverable' | 'secret'
    }
  | { type: 'fact-removed'; entitySynthKey: string; factId: string }
  | {
      type: 'fact-updated'
      entitySynthKey: string
      factId: string
      topic: string
      content: string
      accessLevel: 'known' | 'discoverable' | 'secret'
    }
```

- [ ] **Step 3: Run the tests**

Run: `pnpm vitest run backend/src/contract/__tests__/pipeline-contracts.test.ts`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add backend/src/contract/pipeline-events.ts backend/src/contract/__tests__/pipeline-contracts.test.ts
git commit -m "feat(myth-imxg): pipeline contract gains fact-added / fact-removed / fact-updated"
```

---

## Task 13: Dev-tool coverage for new events

**Files:**
- Modify: `backend/dev-tool/coverage.json`
- Modify: `backend/dev-tool/src/components/world-snapshot-types.ts`
- Modify: `backend/dev-tool/src/components/live-events-panel.ts`
- Modify: `backend/dev-tool/src/shell/drawer/drawer.ts`
- Modify: `backend/dev-tool/src/shell/drawer/__tests__/drawer.test.ts`

Predecessor: T12.

- [ ] **Step 1: Decide coverage vs. exempt**

The dev-tool ship-gate (`backend/src/dev-tool-check/check-coverage.ts:32-91`) demands every event in `PIPELINE_SSE_EVENTS` either appear in `coverage.events[]` (with a renderer wired) OR in `coverage.exempt.events` with a `>=20`-char justification. Fact events are observable end-to-end — make them covered, not exempt. (Coverage is the gate that catches drift in T26's smoke; exempting them would hide the smoke's signal.)

- [ ] **Step 2: Write failing drawer test**

Append to `backend/dev-tool/src/shell/drawer/__tests__/drawer.test.ts`:

```typescript
it('renders fact-added events with topic + content fragment', () => {
  const rendered = renderDrawerRow({
    type: 'fact-added',
    entitySynthKey: 'locations_and_npcs/npcs/0',
    factId: '44444444-4444-4444-4444-444444444444',
    topic: 'duties',
    content: 'Walks the cloister at dawn.',
    accessLevel: 'known',
  })
  expect(rendered.text).toContain('+ fact')
  expect(rendered.text).toContain('duties')
  expect(rendered.text).toContain('Walks the cloister')
})

it('renders fact-removed events with topic if available', () => {
  const rendered = renderDrawerRow({
    type: 'fact-removed',
    entitySynthKey: 'locations_and_npcs/npcs/0',
    factId: '55555555-5555-5555-5555-555555555555',
  })
  expect(rendered.text).toContain('− fact')
})

it('renders fact-updated events with the new content fragment', () => {
  const rendered = renderDrawerRow({
    type: 'fact-updated',
    entitySynthKey: 'locations_and_npcs/npcs/0',
    factId: '66666666-6666-6666-6666-666666666666',
    topic: 'duties',
    content: 'Walks the cloister and inspects the candles.',
    accessLevel: 'known',
  })
  expect(rendered.text).toContain('~ fact')
  expect(rendered.text).toContain('Walks the cloister')
})
```

(The exact function under test — `renderDrawerRow` — is whichever helper the existing drawer tests call. Match the existing pattern in `drawer.test.ts:154+`.)

Run: `pnpm --filter=dev-tool vitest run src/shell/drawer/__tests__/drawer.test.ts -t fact-`
Expected: FAIL.

- [ ] **Step 3: Extend dev-tool types**

In `backend/dev-tool/src/components/world-snapshot-types.ts:150-159`, append:

```typescript
  | {
      type: 'fact-added'
      entitySynthKey: string
      factId: string
      topic: string
      content: string
      accessLevel: 'known' | 'discoverable' | 'secret'
    }
  | { type: 'fact-removed'; entitySynthKey: string; factId: string }
  | {
      type: 'fact-updated'
      entitySynthKey: string
      factId: string
      topic: string
      content: string
      accessLevel: 'known' | 'discoverable' | 'secret'
    }
```

In `backend/dev-tool/src/components/live-events-panel.ts:68-83` (the local `PipelineEvent` union) make the same addition; and append to `KNOWN_EVENT_TYPES` (around line 119–122):

```typescript
  'fact-added',
  'fact-removed',
  'fact-updated',
```

- [ ] **Step 4: Wire drawer render arms**

Edit `backend/dev-tool/src/shell/drawer/drawer.ts:98-111` (the switch with `entity-updated` / `edge-added` / `edge-removed` arms). Add three new arms following the same pattern. Sample structure (match the existing one-liner shape):

```typescript
    case 'fact-added': {
      return formatRow(`+ fact [${e.topic}] ${shortenContent(e.content)}`)
    }
    case 'fact-removed': {
      return formatRow(`− fact (id ${shortId(e.factId)})`)
    }
    case 'fact-updated': {
      return formatRow(`~ fact [${e.topic}] ${shortenContent(e.content)}`)
    }
```

(Adapt to the actual helper names in `drawer.ts`. The pattern is: prefix glyph + event label + summary fragment.)

- [ ] **Step 5: Add to coverage.json**

Edit `backend/dev-tool/coverage.json`'s `events[]` to add `"fact-added"`, `"fact-removed"`, `"fact-updated"` (positionally next to the other entity/edge events).

- [ ] **Step 6: Run the tests + dev-tool-check**

Run: `pnpm --filter=dev-tool vitest run && pnpm dev-tool:check`
Expected: PASS on both. (The dev-tool:check script reads `coverage.json` against `PIPELINE_SSE_EVENTS`.)

- [ ] **Step 7: Commit**

```bash
git add backend/dev-tool/coverage.json backend/dev-tool/src/components/world-snapshot-types.ts backend/dev-tool/src/components/live-events-panel.ts backend/dev-tool/src/shell/drawer/drawer.ts backend/dev-tool/src/shell/drawer/__tests__/drawer.test.ts
git commit -m "feat(myth-imxg): dev-tool renders fact-added / fact-removed / fact-updated"
```

---

## Task 14: `ApplyContext` gains `synthKeyByRelationshipId`; stage handler populates it from inventory

**Files:**
- Modify: `backend/src/llm/prep/stages/coherence-pass.ts:113-124`, `496-528`
- Modify: `backend/src/llm/prep/stages/__tests__/coherence-pass.test.ts` (`makeClient` fixture rows)

Predecessor: T3, T10.

- [ ] **Step 1: Extend fixture rows in `coherence-pass.test.ts`'s `makeClient`**

Edit `backend/src/llm/prep/stages/__tests__/coherence-pass.test.ts:116-131` — the `relRows` fixture array. Add a `synth_key` to each row:

```typescript
const relRows = [
  {
    id: REL_R,
    source_entity_id: ENTITY_A,
    target_entity_id: ENTITY_B,
    relationship_type: 'rivalry',
    description: 'Mara distrusts the village elders.',
    synth_key: 'entity_relationships/relationships/0',   // NEW
  },
  {
    id: REL_S,
    source_entity_id: ENTITY_B,
    target_entity_id: ENTITY_C,
    relationship_type: 'employed_by',
    description: 'Mara works the wharf.',
    synth_key: 'entity_relationships/relationships/1',   // NEW
  },
]
```

This is data-only; existing test bodies won't care yet.

- [ ] **Step 2: Write the failing test**

Append a test that demands the handler populate `synthKeyByRelationshipId` from inventory and use it on a `delete_relationship_by_name` patch. The test scenario:

```typescript
it('uses synthKeyByRelationshipId from inventory when emitting edge-removed (myth-p4sz)', async () => {
  mockGenerateText.mockResolvedValueOnce({
    output: {
      patches: [{
        kind: 'delete_relationship_by_name',
        source_name: 'Mara',
        target_name: 'The Wharf',
        current_type: 'employed_by',
        rationale: 'Duplicate / unsupported by prose; remove this edge.',
      }],
    },
    usage: { inputTokens: 100, outputTokens: 100, totalTokens: 200 },
  } as unknown as Awaited<ReturnType<typeof generateText>>)

  // CRITICAL: synthKeyByEntityId map is empty for relationships (myth-p4sz
  // bug). The handler should still emit edge-removed by reading the
  // synthKey from the inventory load (via the new relationship column),
  // not from synthKeyByEntityId.
  const client = makeClient({})
  const logger = makeLogger()
  const result = await runCoherencePassStage(asClient(client), {
    logger: asLogger(logger),
    worldId: WORLD_ID,
    vocabularyRegistry: EMPTY_REGISTRY,
    synthKeyByEntityId: {
      [ENTITY_A]: SYNTH[ENTITY_A],
      [ENTITY_B]: SYNTH[ENTITY_B],
      [ENTITY_C]: SYNTH[ENTITY_C],
      // NOTE: deliberately NO REL_S / REL_R entries here — the entity
      // synthKey map should NOT cover relationships (that was the bug).
    },
    bypassAccessFilter: true,
  })

  const removed = eventsOfType(result.finalizedEvents, 'edge-removed')
  expect(removed).toHaveLength(1)
  expect(removed[0]?.synthKey).toBe('entity_relationships/relationships/1')  // from inventory
})
```

Run: expected FAIL — today the lookup uses `synthKeyByEntityId[REL_S]`, which is undefined → event suppressed.

- [ ] **Step 3: Add `synthKeyByRelationshipId` to `ApplyContext`**

Edit `backend/src/llm/prep/stages/coherence-pass.ts:113-124`:

```typescript
interface ApplyContext {
  readonly inv: WorldInventory
  readonly resolver: NameResolutionContext
  readonly logger: Pick<pino.Logger, 'warn' | 'info'>
  readonly stage: 'coherence_pass'
  readonly bypassAccessFilter: boolean
  // myth-p4sz: relationship UUID → stage-4/4b synthKey. Populated once
  // at stage start from the inventory's relationships (whose `synthKey`
  // column is persisted by migration 020). Replaces the misnamed lookup
  // into synthKeyByEntityId[relationshipId].
  readonly synthKeyByRelationshipId: Readonly<Record<string, string>>
}
```

- [ ] **Step 4: Populate the new map in `runCoherencePassStage`**

Edit `backend/src/llm/prep/stages/coherence-pass.ts:497-507`:

```typescript
const synthKeyByRelationshipId: Record<string, string> = {}
for (const rel of inventory.relationshipsById.values()) {
  synthKeyByRelationshipId[rel.id] = rel.synthKey
}

const applyCtx: ApplyContext = {
  inv: inventory,
  resolver: buildResolutionContext(inventory),
  logger: args.logger,
  stage: 'coherence_pass',
  bypassAccessFilter: args.bypassAccessFilter,
  synthKeyByRelationshipId,  // NEW
}
```

Step 5 (T15) consumes this; the test in step 2 still fails until then.

- [ ] **Step 5: Commit**

```bash
git add backend/src/llm/prep/stages/coherence-pass.ts backend/src/llm/prep/stages/__tests__/coherence-pass.test.ts
git commit -m "feat(myth-p4sz): ApplyContext exposes synthKeyByRelationshipId from inventory"
```

The test stays RED at this commit — the apply functions still read from `synthKeyByEntityId`. T15 closes the loop.

---

## Task 15: myth-p4sz fix — `applyFixRelationship` + `applyDeleteRelationship` read the new map

**Files:**
- Modify: `backend/src/llm/prep/stages/coherence-pass.ts:236-327`

Predecessor: T14.

- [ ] **Step 1: Update `applyFixRelationship` and `applyDeleteRelationship` to use `ctx.synthKeyByRelationshipId`**

Edit `backend/src/llm/prep/stages/coherence-pass.ts:274` — in `applyFixRelationship`, replace:

```typescript
const oldSynthKey = synthKeyByEntityId[relationshipId]
```

with:

```typescript
const oldSynthKey = ctx.synthKeyByRelationshipId[relationshipId]
```

Edit `backend/src/llm/prep/stages/coherence-pass.ts:317` — in `applyDeleteRelationship`, replace:

```typescript
const synthKey = synthKeyByEntityId[relationshipId]
```

with:

```typescript
const synthKey = ctx.synthKeyByRelationshipId[relationshipId]
```

The `synthKeyByEntityId` parameter is still threaded for fix_prose / rename — leave those callers untouched (they continue to use the entity map, broken or not; entity-side synthKey wiring is a separate followup).

- [ ] **Step 2: Update the defense-in-depth comments**

The `/* c8 ignore */` block around the old `else { warnUnknown }` arm (line 279) is now genuinely defensive: a relationship row exists in `inv.relationshipsById` but not in `synthKeyByRelationshipId` only if the stage handler failed to populate the map. Update the comment text accordingly:

```typescript
/* c8 ignore start — defense-in-depth: synthKeyByRelationshipId is built
 * from inv.relationshipsById exhaustively (each rel's synth_key is
 * persisted by migration 020 + backfilled). A miss here means the
 * stage handler failed to populate the map — a code bug, not a
 * data condition. */
```

- [ ] **Step 3: Run the targeted test from T14**

Run: `pnpm vitest run backend/src/llm/prep/stages/__tests__/coherence-pass.test.ts -t synthKeyByRelationshipId`
Expected: PASS.

- [ ] **Step 4: Run the full coherence-pass suite + typecheck**

Run: `pnpm vitest run backend/src/llm/prep/stages/__tests__/coherence-pass.test.ts && pnpm typecheck`
Expected: every existing coherence-pass test PASSES (the `synthKeyByEntityId` parameter still exists, untouched for entity events). Typecheck PASSES.

- [ ] **Step 5: Commit**

```bash
git add backend/src/llm/prep/stages/coherence-pass.ts
git commit -m "fix(myth-p4sz): applyFixRelationship + applyDeleteRelationship use synthKeyByRelationshipId"
```

---

## Task 16: `applyFixRelationship` accepts `newSource` / `newTarget`

**Files:**
- Modify: `backend/src/llm/prep/stages/coherence-pass.ts:236-294`, `389-405` (dispatcher arm)
- Modify: `backend/src/llm/prep/stages/__tests__/coherence-pass.test.ts`

Predecessor: T15.

- [ ] **Step 1: Write failing tests**

Append to `coherence-pass.test.ts`:

```typescript
it('fix_relationship with newSource rewrites the source endpoint', async () => {
  mockGenerateText.mockResolvedValueOnce({
    output: {
      patches: [{
        kind: 'fix_relationship_by_name',
        source_name: 'Mara',
        target_name: 'The Wharf',
        current_type: 'employed_by',
        newSource: 'Old Eredil',
        rationale: 'Description correctly says the village employs the wharf, not Mara.',
      }],
    },
    usage: { inputTokens: 100, outputTokens: 100, totalTokens: 200 },
  } as unknown as Awaited<ReturnType<typeof generateText>>)

  const { client, result } = await runStage({ bypassAccessFilter: true })

  // DB write: old row deleted, new row inserted with source = ENTITY_A.
  const inserts = client.query.mock.calls.filter(([sql]) =>
    typeof sql === 'string' && sql.includes('INSERT INTO relationships'),
  )
  expect(inserts).toHaveLength(1)
  const insertParams = inserts[0]?.[1] as unknown[]
  expect(insertParams[1]).toBe(ENTITY_A)  // source_entity_id is now ENTITY_A
  expect(insertParams[2]).toBe(ENTITY_C)  // target preserved

  // SSE: edge-removed + edge-added with the new endpoints.
  const removed = eventsOfType(result.finalizedEvents, 'edge-removed')
  const added = eventsOfType(result.finalizedEvents, 'edge-added')
  expect(removed).toHaveLength(1)
  expect(added).toHaveLength(1)
  expect(added[0]?.from).toBe(ENTITY_A)
  expect(added[0]?.to).toBe(ENTITY_C)
})

it('fix_relationship with newTarget rewrites the target endpoint', async () => {
  // Same shape, swap newSource → newTarget; assert insertParams[2] is the new target.
  // ... (see above pattern)
})

it('fix_relationship drops with WARN when newSource is unresolvable', async () => {
  mockGenerateText.mockResolvedValueOnce({
    output: {
      patches: [{
        kind: 'fix_relationship_by_name',
        source_name: 'Mara',
        target_name: 'The Wharf',
        current_type: 'employed_by',
        newSource: 'Nobody Such',
        rationale: 'Trying to move the edge to an entity that does not exist.',
      }],
    },
    usage: { inputTokens: 100, outputTokens: 100, totalTokens: 200 },
  } as unknown as Awaited<ReturnType<typeof generateText>>)

  const { client, logger, result } = await runStage({ bypassAccessFilter: true })

  expect(result.finalizedEvents.filter((e) => e.type === 'edge-removed' || e.type === 'edge-added')).toHaveLength(0)
  const inserts = client.query.mock.calls.filter(([sql]) =>
    typeof sql === 'string' && sql.includes('INSERT INTO relationships'),
  )
  expect(inserts).toHaveLength(0)  // patch dropped entirely
  expect(logger.warn).toHaveBeenCalledWith(
    expect.objectContaining({ stage: 'coherence_pass', kind: 'fix_relationship_by_name' }),
    expect.stringMatching(/newSource|new_source|unresolvable/i),
  )
})
```

Run: expected FAIL — the apply function ignores newSource/newTarget today.

- [ ] **Step 2: Extend `applyFixRelationship`**

Replace `applyFixRelationship`'s signature and body (lines 236–294) with a version that takes resolved newSource/newTarget IDs from the dispatcher. The signature gains two optional params:

```typescript
async function applyFixRelationship(
  client: PoolClient,
  patch: Extract<CoherencePatch, { kind: 'fix_relationship_by_name' }>,
  relationshipId: string,
  newSourceEntityId: string | undefined,   // NEW — resolved by dispatcher
  newTargetEntityId: string | undefined,   // NEW — resolved by dispatcher
  ctx: ApplyContext,
): Promise<ApplyResult> {
  const existing = ctx.inv.relationshipsById.get(relationshipId)
  /* c8 ignore start — see existing comment */
  if (existing === undefined) {
    warnUnknown(ctx, patch.kind, 'relationshipId', relationshipId)
    return { events: [] }
  }
  /* c8 ignore stop */
  await relationships.deleteById(client, relationshipId)
  const finalSourceId = newSourceEntityId ?? existing.sourceEntityId
  const finalTargetId = newTargetEntityId ?? existing.targetEntityId
  const newRelationshipType = patch.newType ?? existing.relationshipType
  const newDescription = patch.newDescription ?? existing.description
  const newId = uuidv7()
  const newSynthKey = `coherence_pass/edges/${newId}`
  await client.query(
    `INSERT INTO relationships
       (id, source_entity_id, target_entity_id, relationship_type, description, synth_key)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [newId, finalSourceId, finalTargetId, newRelationshipType, newDescription, newSynthKey],
  )

  // myth-exac T16 + §6 gate: emit only when BOTH old endpoints AND new
  // endpoints are known-tier (or bypass). Asymmetric cases (e.g. old
  // known, new not) suppress both edge-removed and edge-added — the
  // FE can't render an edge that crosses a tier boundary mid-flight.
  const oldVisible = shouldEmitEdgeEvent(ctx, existing.sourceEntityId, existing.targetEntityId)
  const newVisible = shouldEmitEdgeEvent(ctx, finalSourceId, finalTargetId)
  if (!oldVisible || !newVisible) return { events: [] }

  const oldSynthKey = ctx.synthKeyByRelationshipId[relationshipId]
  const events: PipelineEvent[] = []
  if (oldSynthKey !== undefined) {
    events.push({ type: 'edge-removed', synthKey: oldSynthKey, reason: 'coherence_deleted' })
    /* c8 ignore start — defense-in-depth: see T15 comment update. */
  } else {
    warnUnknown(ctx, patch.kind, 'relationshipId', relationshipId)
  }
  /* c8 ignore stop */
  events.push({
    type: 'edge-added',
    synthKey: newSynthKey,
    from: finalSourceId,
    to: finalTargetId,
    relationship: newRelationshipType,
  })
  return { events }
}
```

Note: `synthKeyByEntityId` is no longer passed (the function previously took it as a parameter only for the broken lookup; the new logic reads `ctx.synthKeyByRelationshipId`). Remove the parameter from the signature and from the call site at line 405.

- [ ] **Step 3: Update the dispatcher arm**

Edit `backend/src/llm/prep/stages/coherence-pass.ts:389-406` — the `case 'fix_relationship_by_name'` block. Resolve newSource/newTarget if present; drop the patch entirely on unresolvable:

```typescript
case 'fix_relationship_by_name': {
  const res = resolveFixRelationship(ctx.resolver, patch)
  if (res.kind === 'dropped') {
    ctx.logger.warn(
      {
        stage: ctx.stage,
        kind: patch.kind,
        reason: res.reason,
        source: patch.source_name,
        target: patch.target_name,
        type: patch.current_type,
      },
      'coherence_pass: patch references unknown relationship triple; skipping',
    )
    return { events: [] }
  }
  let newSourceEntityId: string | undefined
  if (patch.newSource !== undefined) {
    const r = resolveProseTarget(ctx.resolver, { entity_name: patch.newSource })
    if (r.kind === 'dropped') {
      ctx.logger.warn(
        { stage: ctx.stage, kind: patch.kind, reason: r.reason, newSource: patch.newSource },
        'coherence_pass: fix_relationship newSource unresolvable; dropping patch entirely',
      )
      return { events: [] }
    }
    newSourceEntityId = r.entityId
  }
  let newTargetEntityId: string | undefined
  if (patch.newTarget !== undefined) {
    const r = resolveProseTarget(ctx.resolver, { entity_name: patch.newTarget })
    if (r.kind === 'dropped') {
      ctx.logger.warn(
        { stage: ctx.stage, kind: patch.kind, reason: r.reason, newTarget: patch.newTarget },
        'coherence_pass: fix_relationship newTarget unresolvable; dropping patch entirely',
      )
      return { events: [] }
    }
    newTargetEntityId = r.entityId
  }
  return applyFixRelationship(client, patch, res.relationshipId, newSourceEntityId, newTargetEntityId, ctx)
}
```

- [ ] **Step 4: Update the existing `fix_relationship` no-endpoint-change tests**

The tests at `coherence-pass.test.ts:430-477` and `:606-...` pass through the existing `applyFixRelationship` shape — they don't supply newSource/newTarget so the new params default to `undefined` and behavior is unchanged. Verify by running the suite.

- [ ] **Step 5: Run the tests**

Run: `pnpm vitest run backend/src/llm/prep/stages/__tests__/coherence-pass.test.ts`
Expected: PASS — all tests including new and pre-existing.

- [ ] **Step 6: Commit**

```bash
git add backend/src/llm/prep/stages/coherence-pass.ts backend/src/llm/prep/stages/__tests__/coherence-pass.test.ts
git commit -m "feat(myth-imxg): fix_relationship_by_name rewrites endpoints via newSource / newTarget"
```

---

## Task 17: `applyAddRelationship` + duplicate-triple guard

**Files:**
- Modify: `backend/src/llm/prep/stages/coherence-pass.ts`
- Modify: `backend/src/llm/prep/stages/__tests__/coherence-pass.test.ts`

Predecessor: T11 (resolver), T15.

- [ ] **Step 1: Write failing tests**

```typescript
it('add_relationship_by_name inserts a row + emits edge-added', async () => {
  mockGenerateText.mockResolvedValueOnce({
    output: {
      patches: [{
        kind: 'add_relationship_by_name',
        source_name: 'Old Eredil',
        target_name: 'Mara',
        relationship: 'home_of',
        description: 'Mara was born and raised in Old Eredil.',
        rationale: 'Prose explicitly says Mara grew up here; relation was missed at stage 4.',
      }],
    },
    usage: { inputTokens: 100, outputTokens: 100, totalTokens: 200 },
  } as unknown as Awaited<ReturnType<typeof generateText>>)

  const { client, result } = await runStage({ bypassAccessFilter: true })

  const inserts = client.query.mock.calls.filter(([sql]) =>
    typeof sql === 'string' && sql.includes('INSERT INTO relationships'),
  )
  expect(inserts).toHaveLength(1)
  expect((inserts[0]?.[1] as unknown[])[1]).toBe(ENTITY_A)  // source
  expect((inserts[0]?.[1] as unknown[])[2]).toBe(ENTITY_B)  // target

  const added = eventsOfType(result.finalizedEvents, 'edge-added')
  expect(added).toHaveLength(1)
  expect(added[0]?.relationship).toBe('home_of')
})

it('add_relationship_by_name drops with WARN when source name unresolvable', async () => {
  mockGenerateText.mockResolvedValueOnce({
    output: {
      patches: [{
        kind: 'add_relationship_by_name',
        source_name: 'Nobody',
        target_name: 'Mara',
        relationship: 'home_of',
        description: 'This relationship cannot land; source does not exist.',
        rationale: 'The model thought Nobody existed but no entity by that name.',
      }],
    },
    usage: { inputTokens: 100, outputTokens: 100, totalTokens: 200 },
  } as unknown as Awaited<ReturnType<typeof generateText>>)

  const { client, logger, result } = await runStage({})
  const inserts = client.query.mock.calls.filter(([sql]) =>
    typeof sql === 'string' && sql.includes('INSERT INTO relationships'),
  )
  expect(inserts).toHaveLength(0)
  expect(logger.warn).toHaveBeenCalledWith(
    expect.objectContaining({ stage: 'coherence_pass', kind: 'add_relationship_by_name' }),
    expect.any(String),
  )
  expect(result.finalizedEvents.filter((e) => e.type === 'edge-added')).toHaveLength(0)
})

it('add_relationship_by_name drops with WARN when (source, target, type) already exists', async () => {
  mockGenerateText.mockResolvedValueOnce({
    output: {
      patches: [{
        // ENTITY_A → ENTITY_B with type 'rivalry' is REL_R in the fixture.
        kind: 'add_relationship_by_name',
        source_name: 'Old Eredil',
        target_name: 'Mara',
        relationship: 'rivalry',
        description: 'Duplicate of an existing relationship.',
        rationale: 'The model emitted an add for a triple that already exists.',
      }],
    },
    usage: { inputTokens: 100, outputTokens: 100, totalTokens: 200 },
  } as unknown as Awaited<ReturnType<typeof generateText>>)

  const { client, logger } = await runStage({})
  const inserts = client.query.mock.calls.filter(([sql]) =>
    typeof sql === 'string' && sql.includes('INSERT INTO relationships'),
  )
  expect(inserts).toHaveLength(0)
  expect(logger.warn).toHaveBeenCalledWith(
    expect.objectContaining({ reason: 'would_be_duplicate' }),
    expect.any(String),
  )
})
```

Run: FAIL.

- [ ] **Step 2: Implement `applyAddRelationship`**

Insert into `coherence-pass.ts` (after `applyDeleteRelationship`):

```typescript
async function applyAddRelationship(
  client: PoolClient,
  patch: Extract<CoherencePatch, { kind: 'add_relationship_by_name' }>,
  sourceEntityId: string,
  targetEntityId: string,
  ctx: ApplyContext,
): Promise<ApplyResult> {
  // §10 guard: duplicate-triple check. If the exact (src, tgt, type)
  // already exists, drop with WARN — avoids near-duplicates from
  // over-emission.
  const existingByType = ctx.resolver.relIdByTriple
    .get(ctx.inv.entitiesById.get(sourceEntityId)?.name ?? '')
    ?.get(ctx.inv.entitiesById.get(targetEntityId)?.name ?? '')
    ?.get(patch.relationship)
  if (existingByType !== undefined && existingByType.length > 0) {
    ctx.logger.warn(
      {
        stage: ctx.stage,
        kind: patch.kind,
        reason: 'would_be_duplicate',
        source: patch.source_name,
        target: patch.target_name,
        relationship: patch.relationship,
      },
      'coherence_pass: add_relationship triple already exists; skipping',
    )
    return { events: [] }
  }

  const newId = uuidv7()
  const newSynthKey = `coherence_pass/edges/${newId}`
  await client.query(
    `INSERT INTO relationships
       (id, source_entity_id, target_entity_id, relationship_type, description, synth_key)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [newId, sourceEntityId, targetEntityId, patch.relationship, patch.description, newSynthKey],
  )
  if (!shouldEmitEdgeEvent(ctx, sourceEntityId, targetEntityId)) return { events: [] }
  return {
    events: [{
      type: 'edge-added',
      synthKey: newSynthKey,
      from: sourceEntityId,
      to: targetEntityId,
      relationship: patch.relationship,
    }],
  }
}
```

Note the resolver field reference: `ctx.resolver.relIdByTriple` is the existing `Map<string, Map<string, Map<string, string[]>>>` built by `buildResolutionContext` keyed by normalized entity NAMES. Use the normalized names from the inventory.

A cleaner version is to add a helper on `name-resolution.ts` (`relationshipExists(ctx, srcName, tgtName, type) → boolean`) and call it here. Either works; pick the version that doesn't leak resolver internals across files. (If you take the helper route, add a one-line test for the helper.)

- [ ] **Step 3: Dispatcher arm**

Add to the `switch (patch.kind)` in `applyPatch`:

```typescript
case 'add_relationship_by_name': {
  const res = resolveAddRelationship(ctx.resolver, patch)
  if (res.kind === 'dropped') {
    ctx.logger.warn(
      {
        stage: ctx.stage,
        kind: patch.kind,
        reason: res.reason,
        source: patch.source_name,
        target: patch.target_name,
      },
      'coherence_pass: add_relationship patch endpoint unresolvable; skipping',
    )
    return { events: [] }
  }
  return applyAddRelationship(client, patch, res.sourceEntityId, res.targetEntityId, ctx)
}
```

- [ ] **Step 4: Run the tests**

Run: `pnpm vitest run backend/src/llm/prep/stages/__tests__/coherence-pass.test.ts -t add_relationship_by_name`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add backend/src/llm/prep/stages/coherence-pass.ts backend/src/llm/prep/stages/__tests__/coherence-pass.test.ts
git commit -m "feat(myth-imxg): applyAddRelationship + duplicate-triple guard"
```

---

## Task 18: `applyAddFact` + topic-collision guard

**Files:**
- Modify: `backend/src/llm/prep/stages/coherence-pass.ts`
- Modify: `backend/src/llm/prep/stages/__tests__/coherence-pass.test.ts`

Predecessor: T12, T15.

- [ ] **Step 1: Failing tests**

```typescript
it('add_fact_by_name inserts a fact + emits fact-added', async () => {
  mockGenerateText.mockResolvedValueOnce({
    output: {
      patches: [{
        kind: 'add_fact_by_name',
        entity_name: 'Old Eredil',
        topic: 'governance',
        content: 'Old Eredil is administered by the harbor council.',
        access_level: 'known',
        rationale: 'Prose explicitly references the council; structured fact was missed.',
      }],
    },
    usage: { inputTokens: 100, outputTokens: 100, totalTokens: 200 },
  } as unknown as Awaited<ReturnType<typeof generateText>>)

  const { client, result } = await runStage({ bypassAccessFilter: true })

  const inserts = client.query.mock.calls.filter(([sql]) =>
    typeof sql === 'string' && sql.includes('INSERT INTO facts'),
  )
  expect(inserts).toHaveLength(1)

  const added = eventsOfType(result.finalizedEvents, 'fact-added')
  expect(added).toHaveLength(1)
  expect(added[0]?.topic).toBe('governance')
  expect(added[0]?.accessLevel).toBe('known')
})

it('add_fact_by_name drops with WARN when (entity, topic) already exists', async () => {
  // Fixture has Old Eredil / topic='history'. Try to add another with same topic.
  mockGenerateText.mockResolvedValueOnce({
    output: {
      patches: [{
        kind: 'add_fact_by_name',
        entity_name: 'Old Eredil',
        topic: 'history',
        content: 'A different angle on the village history.',
        access_level: 'known',
        rationale: 'The model emitted an add for a topic that already has a fact.',
      }],
    },
    usage: { inputTokens: 100, outputTokens: 100, totalTokens: 200 },
  } as unknown as Awaited<ReturnType<typeof generateText>>)

  const { client, logger } = await runStage({})
  const inserts = client.query.mock.calls.filter(([sql]) =>
    typeof sql === 'string' && sql.includes('INSERT INTO facts'),
  )
  expect(inserts).toHaveLength(0)
  expect(logger.warn).toHaveBeenCalledWith(
    expect.objectContaining({ reason: 'would_be_duplicate_topic' }),
    expect.any(String),
  )
})

it('add_fact_by_name drops with WARN when entity name unresolvable', async () => {
  // ... analogous to add_relationship_by_name's unresolvable test
})
```

- [ ] **Step 2: Implement `applyAddFact`**

```typescript
async function applyAddFact(
  client: PoolClient,
  patch: Extract<CoherencePatch, { kind: 'add_fact_by_name' }>,
  entityId: string,
  ctx: ApplyContext,
  synthKeyByEntityId: SynthKeyMap,
): Promise<ApplyResult> {
  // §10 guard: topic-collision check.
  const entityName = ctx.inv.entitiesById.get(entityId)?.name ?? ''
  const existingByTopic = ctx.resolver.factIdByPair
    .get(entityName)  // already normalized via buildResolutionContext
    ?.get(patch.topic) ?? []
  if (existingByTopic.length > 0) {
    ctx.logger.warn(
      {
        stage: ctx.stage,
        kind: patch.kind,
        reason: 'would_be_duplicate_topic',
        entity: patch.entity_name,
        topic: patch.topic,
      },
      'coherence_pass: add_fact (entity, topic) collides with existing fact; skipping',
    )
    return { events: [] }
  }

  const newId = uuidv7()
  await client.query(
    `INSERT INTO facts (id, entity_id, topic, content, access_level)
     VALUES ($1, $2, $3, $4, $5)`,
    [newId, entityId, patch.topic, patch.content, patch.access_level],
  )
  if (!shouldEmitEntityEvent(ctx, entityId)) return { events: [] }
  const entitySynthKey = synthKeyByEntityId[entityId]
  /* c8 ignore start — defense-in-depth: entity synthKey map is empty in
   * world-gen-processor today (MYT-52-followup); this branch fires
   * unconditionally in prod until that wiring lands. */
  if (entitySynthKey === undefined) {
    warnUnknown(ctx, patch.kind, 'entityId', entityId)
    return { events: [] }
  }
  /* c8 ignore stop */
  return {
    events: [{
      type: 'fact-added',
      entitySynthKey,
      factId: newId,
      topic: patch.topic,
      content: patch.content,
      accessLevel: patch.access_level,
    }],
  }
}
```

Note the normalization of `entityName` for `factIdByPair` lookup — confirm with `name-resolution.ts:60-62` (the key is `normalizeName(ent.name)`). Apply `normalizeName(entityName)` if needed.

- [ ] **Step 3: Dispatcher arm**

```typescript
case 'add_fact_by_name': {
  const res = resolveProseTarget(ctx.resolver, patch)
  if (res.kind === 'dropped') {
    ctx.logger.warn(
      {
        stage: ctx.stage,
        kind: patch.kind,
        reason: res.reason,
        entity_name: patch.entity_name,
      },
      'coherence_pass: add_fact patch entity unresolvable; skipping',
    )
    return { events: [] }
  }
  return applyAddFact(client, patch, res.entityId, ctx, synthKeyByEntityId)
}
```

- [ ] **Step 4: Run tests + commit**

Run: `pnpm vitest run backend/src/llm/prep/stages/__tests__/coherence-pass.test.ts -t add_fact_by_name`
Expected: PASS.

```bash
git add backend/src/llm/prep/stages/coherence-pass.ts backend/src/llm/prep/stages/__tests__/coherence-pass.test.ts
git commit -m "feat(myth-imxg): applyAddFact + topic-collision guard + fact-added emission"
```

---

## Task 19: `applyDeleteFact`

**Files:**
- Modify: `backend/src/llm/prep/stages/coherence-pass.ts`
- Modify: `backend/src/llm/prep/stages/__tests__/coherence-pass.test.ts`

Predecessor: T12, T15.

- [ ] **Step 1: Failing tests**

```typescript
it('delete_fact_by_name removes the fact + emits fact-removed', async () => {
  mockGenerateText.mockResolvedValueOnce({
    output: {
      patches: [{
        kind: 'delete_fact_by_name',
        entity_name: 'Old Eredil',
        fact_topic: 'history',
        rationale: 'Prose explicitly says the village burned generations ago; the history fact is wrong AND no content edit could fix the contradiction.',
      }],
    },
    usage: { inputTokens: 100, outputTokens: 100, totalTokens: 200 },
  } as unknown as Awaited<ReturnType<typeof generateText>>)

  const { client, result } = await runStage({ bypassAccessFilter: true })

  const deletes = client.query.mock.calls.filter(([sql]) =>
    typeof sql === 'string' && sql.includes('DELETE FROM facts'),
  )
  expect(deletes).toHaveLength(1)
  const removed = eventsOfType(result.finalizedEvents, 'fact-removed')
  expect(removed).toHaveLength(1)
  expect(removed[0]?.factId).toBe(FACT_X)
})

it('delete_fact_by_name drops with WARN when (entity, topic) unresolvable', async () => {
  // ... analogous to other unresolvable tests
})
```

- [ ] **Step 2: Implement**

```typescript
async function applyDeleteFact(
  client: PoolClient,
  patch: Extract<CoherencePatch, { kind: 'delete_fact_by_name' }>,
  factId: string,
  entityId: string,
  ctx: ApplyContext,
  synthKeyByEntityId: SynthKeyMap,
): Promise<ApplyResult> {
  await facts.deleteById(client, factId)
  if (!shouldEmitEntityEvent(ctx, entityId)) return { events: [] }
  const entitySynthKey = synthKeyByEntityId[entityId]
  /* c8 ignore start — defense-in-depth: see applyAddFact comment. */
  if (entitySynthKey === undefined) {
    warnUnknown(ctx, patch.kind, 'entityId', entityId)
    return { events: [] }
  }
  /* c8 ignore stop */
  return {
    events: [{ type: 'fact-removed', entitySynthKey, factId }],
  }
}
```

If `facts.deleteById` doesn't exist, add it to `backend/src/repo/facts.ts` (mirror `relationships.deleteById`). Single-line SQL: `DELETE FROM facts WHERE id = $1`.

- [ ] **Step 3: Dispatcher arm**

```typescript
case 'delete_fact_by_name': {
  const res = resolveFact(ctx.resolver, patch)
  if (res.kind === 'dropped') {
    ctx.logger.warn(
      {
        stage: ctx.stage,
        kind: patch.kind,
        reason: res.reason,
        entity_name: patch.entity_name,
        fact_topic: patch.fact_topic,
      },
      'coherence_pass: delete_fact patch references unknown entity+topic; skipping',
    )
    return { events: [] }
  }
  return applyDeleteFact(client, patch, res.factId, res.entityId, ctx, synthKeyByEntityId)
}
```

- [ ] **Step 4: Run + commit**

```bash
git add backend/src/llm/prep/stages/coherence-pass.ts backend/src/llm/prep/stages/__tests__/coherence-pass.test.ts backend/src/repo/facts.ts
git commit -m "feat(myth-imxg): applyDeleteFact emits fact-removed"
```

---

## Task 20: `applyFixFact` emits `fact-updated`

**Files:**
- Modify: `backend/src/llm/prep/stages/coherence-pass.ts:167-177` (applyFixFact)
- Modify: `backend/src/llm/prep/stages/__tests__/coherence-pass.test.ts`

Predecessor: T12.

- [ ] **Step 1: Failing test**

```typescript
it('fix_fact_by_name emits fact-updated (previously silent)', async () => {
  mockGenerateText.mockResolvedValueOnce({
    output: {
      patches: [{
        kind: 'fix_fact_by_name',
        entity_name: 'Old Eredil',
        fact_topic: 'history',
        new_content: 'The village survived the fire and rebuilt within a generation.',
        rationale: 'Existing fact contradicted prose; tighten the timeline.',
      }],
    },
    usage: { inputTokens: 100, outputTokens: 100, totalTokens: 200 },
  } as unknown as Awaited<ReturnType<typeof generateText>>)

  const { result } = await runStage({ bypassAccessFilter: true })
  const updated = eventsOfType(result.finalizedEvents, 'fact-updated')
  expect(updated).toHaveLength(1)
  expect(updated[0]?.topic).toBe('history')
  expect(updated[0]?.content).toContain('rebuilt')
  expect(updated[0]?.factId).toBe(FACT_X)
})
```

Expected: FAIL (current behavior emits no events).

- [ ] **Step 2: Update `applyFixFact`**

```typescript
async function applyFixFact(
  client: PoolClient,
  patch: Extract<CoherencePatch, { kind: 'fix_fact_by_name' }>,
  factId: string,
  entityId: string,
  ctx: ApplyContext,
  synthKeyByEntityId: SynthKeyMap,
): Promise<ApplyResult> {
  await facts.updateContentById(client, factId, { content: patch.new_content })
  if (!shouldEmitEntityEvent(ctx, entityId)) return { events: [] }
  const entitySynthKey = synthKeyByEntityId[entityId]
  /* c8 ignore start — defense-in-depth: see applyAddFact comment. */
  if (entitySynthKey === undefined) {
    warnUnknown(ctx, patch.kind, 'entityId', entityId)
    return { events: [] }
  }
  /* c8 ignore stop */
  const fact = ctx.inv.factsById.get(factId)
  /* c8 ignore start — defense-in-depth: resolver returns resolved only when the fact exists. */
  if (fact === undefined) {
    warnUnknown(ctx, patch.kind, 'factId', factId)
    return { events: [] }
  }
  /* c8 ignore stop */
  return {
    events: [{
      type: 'fact-updated',
      entitySynthKey,
      factId,
      topic: fact.topic,  // topic unchanged by fix_fact
      content: patch.new_content,
      accessLevel: fact.accessLevel as 'known' | 'discoverable' | 'secret',
    }],
  }
}
```

Update the dispatcher arm at line 340 to pass `entityId` + `ctx` + `synthKeyByEntityId`:

```typescript
case 'fix_fact_by_name': {
  const res = resolveFact(ctx.resolver, patch)
  if (res.kind === 'dropped') {
    // ... (unchanged warn)
    return { events: [] }
  }
  return applyFixFact(client, patch, res.factId, res.entityId, ctx, synthKeyByEntityId)
}
```

- [ ] **Step 3: Update the file header comment**

The block at `coherence-pass.ts:167-176` says `// fix_fact emits NO SSE event per §3.6 — facts are not exposed ...`. Replace with:

```typescript
// fix_fact emits a `fact-updated` SSE event (myth-imxg §6). The FE
// applies the patch to its prior fact row identified by factId.
```

- [ ] **Step 4: Run + commit**

Run: `pnpm vitest run backend/src/llm/prep/stages/__tests__/coherence-pass.test.ts -t fix_fact`
Expected: PASS — but check the `applies one of each patch kind` integration test at line 195+; its assertion `expect(result.finalizedEvents).toHaveLength(5)` will now equal **6** (the original 5 + the new fact-updated). Update that assertion accordingly.

```bash
git add backend/src/llm/prep/stages/coherence-pass.ts backend/src/llm/prep/stages/__tests__/coherence-pass.test.ts
git commit -m "feat(myth-imxg): applyFixFact emits fact-updated"
```

---

## Task 21: `applyPatch` exhaustive switch — confirm no remaining gaps

**Files:**
- Modify: `backend/src/llm/prep/stages/coherence-pass.ts:333-426` (the switch body)

Predecessor: T17, T18, T19.

This is a verification task — if T17–T19 added all three case arms correctly, the switch is exhaustive and typecheck is green.

- [ ] **Step 1: Typecheck**

Run: `pnpm typecheck`
Expected: PASS. If the switch is missing an arm (e.g. forgotten `default` removal), TS will surface "Type 'never' is not assignable" at the function tail.

- [ ] **Step 2: Run the full coherence-pass suite**

Run: `pnpm vitest run backend/src/llm/prep/stages/__tests__/coherence-pass.test.ts`
Expected: PASS.

- [ ] **Step 3: Verify lint**

Run: `pnpm lint`
Expected: PASS (no unused imports, no `any`, etc.).

If T17–T19 left a TODO or partial commit, this task captures the followup. Otherwise it's a no-op verification gate before T22.

---

## Task 22: World-gen-processor passes `synthKeyByRelationshipId` to stage 7

**Files:**
- Modify: `backend/src/llm/prep/world-gen-processor.ts:798-815`
- Modify: `backend/src/llm/prep/__tests__/world-gen-processor.test.ts` (if there's a stage-7 wiring test)

Predecessor: T14.

The `synthKeyByRelationshipId` is built inside `runCoherencePassStage` (T14) from the loaded inventory, so the processor doesn't need to construct it externally — it's an internal detail of the handler. **However**: the processor's stage-7 call site comment block at lines 798–802 needs updating to reflect that relationship synthKeys are NO LONGER empty, only entity synthKeys.

- [ ] **Step 1: Update the call-site comment + verify the field still passes `{}` for synthKeyByEntityId**

Edit `backend/src/llm/prep/world-gen-processor.ts:798-815`:

```typescript
  // Exhaustive: stage is narrowed to 'coherence_pass' here.
  //
  // synthKeyByEntityId is the ENTITY-side wire map; still empty at the
  // processor boundary pending MYT-52-followup that re-derives it from
  // prior-stage finalized events. The RELATIONSHIP side is no longer
  // empty: stage 7 reads `synthKey` per row from the inventory load
  // (migration 020 persists the column at insert time in stages 4/4b).
  return runCoherencePassStage(client, {
    logger: deps.logger,
    worldId: ctx.world.id,
    vocabularyRegistry: ctx.world.vocabularyRegistry,
    synthKeyByEntityId: {},
    bypassAccessFilter: ctx.world.devBypassAccessFilter,
  })
```

- [ ] **Step 2: Verify**

Run: `pnpm typecheck && pnpm lint`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add backend/src/llm/prep/world-gen-processor.ts
git commit -m "docs(myth-p4sz): clarify stage-7 synthKey wiring after relationship persistence"
```

---

## Task 23: Rewrite `coherence-pass.txt` per spec §5

**Files:**
- Modify: `backend/src/llm/prompts/prep/coherence-pass.txt`

Predecessor: T7, T8, T9, T10.

- [ ] **Step 1: Sketch the new sections (no test — prompt edits are validated via smoke in T24)**

Edit the prompt to add three new sections + extend the existing list:

After the "What you are looking for" block, add **before** "What you should NOT do":

```
## How to fix wrong-endpoint relationships

A relationship's description may correctly identify the right entities while the type or endpoints disagree (e.g., the description says "He serves Lorrendale, not the Merchant Concord," but the relationship is `serves` → The Merchant Concord). For these cases, use `fix_relationship_by_name` with `newSource` and/or `newTarget` set to the correct entity name(s). You may rewrite source, target, type, and description in one patch — any subset of the four `new*` fields is valid, but at least one is required.

Worked example: a relationship `Bevin Threll --serves--> The Merchant Concord` whose description reads "He serves Lorrendale's governing body, not the Merchant Concord" should be patched with `newTarget: 'Lorrendale Town Council'` (or whichever entity the prose names) AND `newDescription: 'Threll keeps the Council's daily ledger and signs warrants under the Council seal.'` — clearing the negation entirely.

## How to add missing relationships and facts

If the prose of an existing entity directly states a relationship or fact that is NOT present in the structured output, emit `add_relationship_by_name` or `add_fact_by_name`. Only do this when:

  - The prose explicitly states the relationship/fact (not implied, not speculated).
  - The relationship/fact is NOT already in the world dump's structured listings for that entity.

Worked example 1: `add_relationship_by_name` — Anselm's prose says "He serves as the Keeper of the Order at Stillwater Monastery." The relationships section for Anselm shows no `keeper_of` edge to the monastery. Emit `add_relationship_by_name { source_name: 'Anselm', target_name: 'Stillwater Monastery', relationship: 'keeper_of', description: 'Anselm holds the Keeper's office at Stillwater, ringing the dawn bell daily.', rationale: 'Prose explicitly names the role; structured stage missed the edge.' }`.

Worked example 2: `add_fact_by_name` — Old Eredil's prose mentions a "harbor council" but no fact captures the governance. Emit `add_fact_by_name { entity_name: 'Old Eredil', topic: 'governance', content: 'Old Eredil is administered by a harbor council elected annually from senior fishing families.', access_level: 'known', rationale: 'Prose references the council without a structured fact to ground future references.' }`.

DO NOT use `add_*` for plot speculation, world-expansion, or "this would be cool." The rule is: it's in the prose AND not yet structured.

## How to delete a contradicted fact

If a fact's content is factually wrong AND there is no plausible content edit that would fix it (i.e., the fact should not exist at all — not "the wording is bad" but "this is the wrong fact for this entity"), use `delete_fact_by_name`. Spell out in the rationale (60+ chars) why the fact is unfixable rather than just inaccurate. Most contradicted facts can be repaired via `fix_fact_by_name` instead.
```

Update the "Patch kinds available" list (line 50+ in the current file) to enumerate all 8 kinds:

```
- `fix_fact_by_name` — UPDATE a single fact's content. Requires `entity_name`, `fact_topic`, `new_content`, `rationale`.
- `fix_prose_by_name` — UPDATE a single entity's prose kernel. Requires `entity_name`, `new_prose`, `rationale`.
- `fix_relationship_by_name` — UPDATE a relationship's source, target, type, and/or description. Requires `source_name`, `target_name`, `current_type`; optional `newSource`, `newTarget`, `newType` (a short verb-phrase predicate, ≤30 chars), `newDescription`; at least one new* field is required. The patch is rejected if all four optional fields are absent.
- `rename_entity_by_name` — UPDATE an entity's name. Requires `old_name`, `new_name`, `rationale`.
- `delete_relationship_by_name` — DELETE a relationship row. Requires `source_name`, `target_name`, `current_type`, `rationale`.
- `add_relationship_by_name` — INSERT a relationship between two existing entities. Requires `source_name`, `target_name`, `relationship`, `description`, `rationale`. Both endpoints must already exist in the world.
- `add_fact_by_name` — INSERT a fact on an existing entity. Requires `entity_name`, `topic`, `content`, `access_level` (`known` | `discoverable` | `secret`), `rationale`.
- `delete_fact_by_name` — DELETE a fact. Requires `entity_name`, `fact_topic`, `rationale` (60+ chars — deletes are irreversible).
```

Update the "What you should NOT do" block to soften the "do NOT invent new entities or relationships" line: keep "do NOT invent new entities," but rewrite the relationships side to say "only add relationships/facts the prose directly states (see 'How to add missing relationships and facts' above)."

- [ ] **Step 2: Sanity-check the prompt renders**

The prompt has `{{worldDump}}` and `{{vocabularyRegistry}}` placeholders. Verify those still exist after the edit. The handler at `coherence-pass.ts:480-482` does `.replaceAll('{{worldDump}}', worldDump).replace('{{vocabularyRegistry}}', renderVocabularyRegistry(...))` — both placeholders must remain.

Run: `grep -c '{{worldDump}}\|{{vocabularyRegistry}}' backend/src/llm/prompts/prep/coherence-pass.txt`
Expected: 2 (or more if the placeholders happen to be repeated).

- [ ] **Step 3: Run existing prompt-related tests**

Run: `pnpm vitest run backend/src/llm/prep/stages/__tests__/coherence-pass.test.ts -t "{{worldDump}}\|{{vocabularyRegistry}}"`
Expected: PASS (the existing prompt-render assertions at `coherence-pass.test.ts:478-510` confirm placeholder substitution).

- [ ] **Step 4: Commit**

```bash
git add backend/src/llm/prompts/prep/coherence-pass.txt
git commit -m "feat(myth-imxg): coherence-pass prompt teaches add_* / extended fix_relationship / delete_fact"
```

---

## Task 24: Live smoke + spec §7.4 metrics

**Files:**
- New: `tmp/coherence-smoke-YYYY-MM-DD.md` (ephemeral; gitignored)

Predecessor: every prior task.

This task is the dev-tool-driven E2E smoke required per the dev-tool E2E memory rule. Run a real coherence pass on a real world; assert the four §7.4 metrics; record results.

- [ ] **Step 1: Pre-smoke verification gate**

Run: `pnpm typecheck && pnpm lint && pnpm test && pnpm dev-tool:check`
Expected: ALL GREEN. (If any fail, fix before smoke.)

- [ ] **Step 2: Smoke run — generate a new world end-to-end**

The dev tool's start-campaign flow exercises the full pipeline. Pick a one-paragraph seed concept distinct from the prior "Narrowing Path" smoke world (so the comparison isn't biased). Suggestion: a tone-different concept (e.g., a haunted carnival, a mountaintop monastery, a market town under bardic rule). Note the world UUID.

Drive via `curl` + SSE per the dev-tool E2E memory rule. The wire-log smoke must observe:
- `fact-added` events (count ≥ 0; ≥1 if the prompt is teaching uptake).
- `fact-removed` events (count ≥ 0).
- `fact-updated` events (count ≥ 0 when coherence fires fix_fact).
- `edge-removed` events from `delete_relationship_by_name` patches — these MUST appear if the model emits any deletions (the myth-p4sz regression check).
- `edge-removed` + `edge-added` pairs from `fix_relationship_by_name` patches that change endpoints.

- [ ] **Step 3: Apply rate check**

Query: `SELECT COUNT(*) FROM pipeline_runs WHERE world_id = '<uuid>' AND stage = 'coherence_pass'`. Expect a single completed row. Then query the per-patch results from the worker logs (or from a coverage-style query against the worker's structured logs, depending on what's in place).

Target per spec §7.4: ≥80% apply rate. Document the actual rate.

- [ ] **Step 4: Lexical self-flagging check**

Run against the new world (replace `<uuid>` with the live worldId):

```sql
SELECT description
  FROM relationships
 WHERE source_entity_id IN (SELECT id FROM entities WHERE world_id = '<uuid>')
   AND (
     description ~* 'not at the' OR
     description ~* 'is not' OR
     description ~* 'does not' OR
     description ~* 'not a ' OR
     description ~* 'incorrectly' OR
     description ~* 'is wrong' OR
     description ~* 'actually' OR
     description ~* 'not really'
   );
```

Manually audit hits: separate true self-flagging ("She does not serve the Concord — the description is wrong") from legitimate negations ("She is not yet bound by formal treaty"). Target: ≤1 true self-flagging per 76 relationships, scaled to the actual relationship count.

- [ ] **Step 5: Vocabulary-uptake check**

From worker logs (or a dedicated query against per-patch stats), aggregate patch-kind emit counts. Expected (post-rewrite):
- ≥1 `add_relationship_by_name` OR `add_fact_by_name` (proof of vocabulary uptake).
- ≥1 `fix_relationship_by_name` carrying `newSource` or `newTarget` (proof the model knows the extended capability).
- Some non-zero `delete_relationship_by_name` count (the original behavior, preserved).

Zero of the new kinds = prompt failed to teach. Iterate on prompt or worked examples and re-run.

- [ ] **Step 6: myth-p4sz regression check**

Confirm `edge-removed` events appeared on the SSE feed (count > 0 if the model emitted any `delete_relationship_by_name` or `fix_relationship_by_name`). Pre-fix, these events were always suppressed. The dev-tool drawer should show non-zero rows; the wire log should record them.

- [ ] **Step 7: Aggregate tier-balance check**

Pre-coherence and post-coherence fact-tier counts. Pre-coherence is the inventory at stage 7 start; post-coherence is the inventory after stage 7. Compute:

```sql
SELECT access_level, COUNT(*) AS n
  FROM facts
 WHERE entity_id IN (SELECT id FROM entities WHERE world_id = '<uuid>')
 GROUP BY access_level;
```

Snapshot to a temp note pre-coherence (instrument briefly in the smoke flow, OR rely on a coherence-pass intermediate log if one already records the inventory shape). Compare to post-coherence. Target per spec §7.4: `discoverable` and `secret` counts preserved within ±20% or ≤2 absolute fact drop (whichever is more generous).

- [ ] **Step 8: Record findings**

Write the smoke results to `tmp/coherence-smoke-YYYY-MM-DD.md` (gitignored):

```
# Coherence Full-Vocabulary Smoke — YYYY-MM-DD

World: <uuid> (<name>)
Concept: <one-line summary>

## Apply rate
- Emitted: N patches
- Applied: M (M/N = X%)
- Dropped: K — broken down by reason

## Lexical self-flagging
- Regex hits: H
- True positives after audit: T (target: ≤1 per 76 rels = ~T_max)
- Verdict: PASS / FAIL

## Vocabulary uptake
- fix_relationship (endpoint change): A
- add_relationship: B
- add_fact: C
- delete_fact: D
- Verdict: PASS (≥1 in A, B, or C) / FAIL

## myth-p4sz regression
- edge-removed events on wire: E (pre-fix: always 0)
- Verdict: PASS / FAIL

## Tier balance
- Pre: known=P_k discoverable=P_d secret=P_s
- Post: known=Q_k discoverable=Q_d secret=Q_s
- Verdict: PASS (within ±20%) / FAIL

## Decision
SHIP / ITERATE
```

- [ ] **Step 9: Push gate**

If all four smoke metrics pass: stage the close-the-loop sequence:

1. `pnpm typecheck && pnpm lint && pnpm test && pnpm wiki:check && pnpm dev-tool:check` (final pre-push verification).
2. Dispatch the wiki-update subagent per `docs/wiki/AUTHORING.md` — the coherence-pass narrative in `world-gen.html` lists 5 patch kinds and must be updated to 8 plus the extended fix_relationship semantics + the three new SSE events.
3. After the wiki subagent commits locally, `git push origin main`.
4. Close beads: `bd close myth-imxg myth-p4sz`.

If any smoke metric fails, file an inline iteration: typically a prompt edit + re-run T24 from Step 2. Do not push until all metrics pass.

---

## Self-Review Notes

**1. Spec coverage**

- §1a (wrong-endpoint relationships) → T7, T16, T23.
- §1b (missing relationships/facts) → T8, T9, T17, T18, T23.
- §1c (myth-p4sz wire event drop) → T1–T5, T14, T15, T22.
- §2.1 (vocabulary surface table) → T7–T10, T17–T20.
- §2.4 (synthKey persistence + map split) → T1, T2, T3, T4, T5, T14, T15.
- §2.5 (patch ordering invariants) → existing `renamePatches`/`otherPatches` partition is unchanged; the new `add_*` and `delete_fact` patches join `otherPatches` automatically (covered by the `[...otherPatches, ...renamePatches]` iteration at line 522). No task needed; reaffirmed in §2.5.
- §3.1–§3.5 (schemas) → T7–T10.
- §4.1 (resolver additions) → T11. `add_fact_by_name` and `delete_fact_by_name` reuse `resolveProseTarget` / `resolveFact` per the spec; no new resolvers needed for them.
- §4.2 (apply functions) → T16–T20.
- §4.3 (myth-p4sz fix) → T14, T15.
- §4.4 (dispatcher) → T17, T18, T19, T21.
- §5 (prompt rewrite) → T23.
- §6 (SSE event emission) → T12, T13, T16 (tier gate for endpoint changes), T18–T20 (emission paths).
- §7.1 (resolver unit tests) → T11.
- §7.2 (apply-step tests) → T14, T16–T20.
- §7.3 (schema tests) → T6–T10.
- §7.4 (live smoke) → T24.
- §8 (migration of existing worlds) → No data migration. T1's backfill places placeholder synthKeys on existing rows; future coherence runs work against them.
- §9 (rollout) → T24 step 9.
- §10 (degradation surfaces) — duplicate-triple + topic-collision guards → T17, T18. Stage 4b interaction → preserved by T5 (4b persists its own synthKeys). Cost monitoring → T24 step 5 reports the per-world cost.
- §11 (non-goals) — no `add_entity_by_name`; confirmed in T6–T10's schema (only 3 new kinds, all non-entity-creating).

**2. Placeholder scan**

No "TBD", "TODO", "implement later" in any task body. Each step contains either explicit code, an explicit command, or an explicit file:line pointer.

One soft area: T13 step 4's "Adapt to the actual helper names in `drawer.ts`" — this is a deliberate concession to file-internals the planner can't fully see without reading the entire file. The implementer reads `drawer.ts:98-111` (cited explicitly) and follows the existing pattern; not a placeholder, but a directed lookup.

T17 step 2's "A cleaner version is to add a helper on `name-resolution.ts`" — offered as an option, not a requirement. The inline lookup works as written; the helper is a quality refactor the implementer can take or leave.

**3. Type consistency**

- `InsertRelationshipInput.synthKey` is `string` (required) across T2 and consumers T4, T5, T16, T17.
- `WorldInventory.relationshipsById` value type's `synthKey: string` matches the repo's `Relationship.synthKey: string` (T2 + T3).
- `ApplyContext.synthKeyByRelationshipId: Readonly<Record<string, string>>` (T14) matches the existing `synthKeyByEntityId` shape in CoherencePassArgs (line 102).
- New PipelineEvent arms use `entitySynthKey` (not `synthKey`) — distinguished from entity-updated's `synthKey: string` so the FE consumer can route to its fact collection vs entity collection.
- `applyAddFact` and `applyDeleteFact` both take `synthKeyByEntityId: SynthKeyMap` (T18, T19), matching the existing `applyFixProse` signature.
- The `applyFixRelationship` signature change in T16 drops `synthKeyByEntityId` (the rel side reads from `ctx.synthKeyByRelationshipId`); the change cascades to its dispatcher arm. No accidental shadowing.

Plan is self-consistent. Ready for handoff.

---

## Execution Handoff

Plan complete and saved to `docs/superpowers/plans/2026-05-26-coherence-pass-full-vocabulary.md`. Two execution options:

1. **Subagent-Driven (recommended)** — controller dispatches a fresh subagent per task, reviews between tasks, fast iteration. Use `superpowers:subagent-driven-development`. T1→T2→T3→T4→T5 serial chain; T6 parallel-safe with T1–T5; T7–T11 parallel-safe with each other after T6 (each touches a distinct schema arm or the resolver file); T12 parallel-safe with T1–T11; T13 after T12; T14→T15 serial; T16→T17→T18→T19→T20→T21 serial (all touch `coherence-pass.ts`); T22 after T15; T23 after T7–T10; T24 last. Per CLAUDE.md, implementers must NOT `git add`/`commit`/`push`; the controller stages and commits each task's files.

2. **Inline Execution** — execute tasks in this session using `superpowers:executing-plans`, batch execution with checkpoints.

Which approach?
