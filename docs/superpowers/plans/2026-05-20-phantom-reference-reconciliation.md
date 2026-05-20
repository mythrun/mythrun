# Phantom-Reference Reconciliation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Spec:** `docs/superpowers/specs/2026-05-20-phantom-reference-reconciliation-design.md`
**Beads:** `myth-tt2g` (entity_relationships hallucination), `myth-449j` (streamObject resilience), plus a new bead for the entity_consolidation stage itself.

**Goal:** New world-gen stage `entity_consolidation` that resolves phantom references (entities name-dropped in stages 2-3 prose but never instantiated) into first-class ghost entities. Stage 4 emits placeholder IDs; stage 4b generates ghosts; the streaming-extractor gains per-entity drop-on-fail validation so single-row LLM failures no longer kill the whole stream.

**Architecture:** Six phases. Migration + provenance foundation; per-item schema exports + streaming-extractor rework; stage 4 extensions (placeholder declarations + partition + pending state); new stage 4b handler; wire-protocol + frontend reconciliation; smoke test + ship. Each phase ends in a committable state; each task is bead-sized.

**Tech Stack:** Node 24 + TypeScript (strict), Postgres 16, Vercel AI SDK (`generateObject` / `streamObject`), Zod, BullMQ, pino. Vitest for unit/integration tests. Real Anthropic API for smoke.

---

## File Structure

**New files:**
- `backend/migrations/017_entity_consolidation.sql`
- `backend/src/llm/prep/stages/entity-consolidation.ts` — stage 4b handler
- `backend/src/llm/prep/stages/__tests__/entity-consolidation.test.ts`
- `backend/src/llm/schemas/entity-consolidation.ts` — stage 4b schema
- `backend/src/llm/prompts/prep/entity-consolidation.txt` — stage 4b prompt
- `backend/scripts/smoke/phantom-reconciliation.ts` — real-LLM smoke

**Modified files:**
- `backend/src/llm/schemas/entity-relationships.ts` — export item schemas; add `new_entity_declarations`; widen endpoints
- `backend/src/llm/schemas/locations-and-npcs.ts` — export item schemas
- `backend/src/llm/schemas/world-and-factions.ts` — export item schemas
- `backend/src/llm/prep/streaming-extractor.ts` — per-entity validation + drop semantics
- `backend/src/llm/prep/__tests__/streaming-extractor.test.ts` — per-entity drop tests
- `backend/src/llm/prep/stages/entity-relationships.ts` — partition with placeholders; pending-state write; cascade-clear ghosts on retry
- `backend/src/llm/prep/stages/__tests__/entity-relationships.test.ts` — placeholder routing tests
- `backend/src/llm/prompts/prep/entity-relationships.txt` — placeholder mechanism instructions
- `backend/src/llm/prep/world-gen-processor.ts` — add `entity_consolidation` stage; move `world_snapshot_ready` emit
- `backend/src/llm/prep/__tests__/world-gen-processor.test.ts` — stage 4b dispatch tests
- `backend/src/contract/pipeline-events.ts` — `placeholderId?` on `entity-added`; widened `from`/`to` on `edge-added`
- `backend/src/repo/entities.ts` — `createdIn` field on insert
- `backend/src/llm/prep/stages/world-and-factions.ts` — pass `createdIn: 'stage:world_and_factions'` to entity inserts
- `backend/src/llm/prep/stages/locations-and-npcs.ts` — pass `createdIn: 'stage:locations_and_npcs'`
- `backend/dev-tool/src/components/live-events-panel.ts` — placeholder buffer + reconciliation
- `backend/dev-tool/src/components/__tests__/live-events-panel.test.ts` — buffer reconciliation tests
- `backend/package.json` — `smoke:phantom-reconciliation` script

**Deleted files:** none.

---

## Phase 1 — Migration + provenance foundation

End state: `entities.created_in` column exists with backfill; `worlds.entity_consolidation_pending` column exists with shape-CHECK; existing stages 2-3 set `created_in` to their respective stage names.

### Task 1.1: Write migration 017

**Files:**
- Create: `backend/migrations/017_entity_consolidation.sql`

- [ ] **Step 1: Verify 016 is the latest migration**

Run: `ls backend/migrations/ | sort | tail -5`
Expected: shows up through `016_character_concepts.sql` — confirms 017 is the next number.

- [ ] **Step 2: Write the migration file**

```sql
-- backend/migrations/017_entity_consolidation.sql
--
-- myth-tt2g / entity_consolidation stage (spec: 2026-05-20-phantom-
-- reference-reconciliation-design.md §2).
--
-- 1. entities.created_in — generic provenance column for entity
--    creation source. Stages 2-3 set 'stage:<name>'; stage 4b sets
--    'stage:entity_consolidation'; future Scribe creation during
--    play sets 'session:<uuid>'. The DEFAULT clause backfills every
--    existing row to 'stage:legacy' during ALTER — no separate
--    UPDATE statement needed.
--
-- 2. worlds.entity_consolidation_pending — inter-stage handoff
--    between stage 4 (entity_relationships) and stage 4b
--    (entity_consolidation). Stage 4 writes the pending phantom
--    declarations + relationships; stage 4b reads, processes, then
--    clears back to the populated-shape default. Pattern mirrors
--    worlds.starting_situation_entries from migration 016.

ALTER TABLE entities
  ADD COLUMN created_in TEXT NOT NULL DEFAULT 'stage:legacy';

ALTER TABLE worlds
  ADD COLUMN entity_consolidation_pending JSONB NOT NULL
    DEFAULT '{"declarations": [], "relationships": []}'::jsonb;

ALTER TABLE worlds
  ADD CONSTRAINT worlds_entity_consolidation_pending_shape
  CHECK (
    jsonb_typeof(entity_consolidation_pending) = 'object'
    AND jsonb_typeof(entity_consolidation_pending->'declarations') = 'array'
    AND jsonb_typeof(entity_consolidation_pending->'relationships') = 'array'
  );
```

- [ ] **Step 3: Apply migration to mythrun_dev**

Run: `cd backend && pnpm db:migrate`
Expected output: log line `migrate.applied  version: "017_entity_consolidation.sql"`.

- [ ] **Step 4: Apply migration to mythrun_test**

Run: `cd backend && pnpm db:migrate:test`
Expected: same applied log line.

- [ ] **Step 5: Verify in both DBs**

Run: `docker compose exec -T postgres psql -U mythrun -d mythrun_dev -c "\d entities" | grep created_in`
Expected: `created_in | text | | not null | 'stage:legacy'::text`

Run: `docker compose exec -T postgres psql -U mythrun -d mythrun_dev -c "\d worlds" | grep entity_consolidation`
Expected: shows `entity_consolidation_pending` jsonb NOT NULL with default.

### Task 1.2: Extend `entities.insert` repo to accept `createdIn`

**Files:**
- Modify: `backend/src/repo/entities.ts`
- Modify: `backend/src/repo/__tests__/entities.test.ts`

- [ ] **Step 1: Write the failing test**

Append to `backend/src/repo/__tests__/entities.test.ts`:

```typescript
it('writes created_in when provided', async () => {
  await cleanupTestScope(pool, scope)
  const userId = uuidv7()
  const worldId = uuidv7()
  await pool.query(
    `INSERT INTO users (id, cognito_sub, display_name, username) VALUES ($1, $2, $3, $4)`,
    [userId, scope.userSub(0), scope.displayName(0), scope.username(0)],
  )
  await pool.query(
    `INSERT INTO worlds (id, created_by, name, concept, status) VALUES ($1, $2, $3, 'concept', 'generating')`,
    [worldId, userId, scope.worldName(0)],
  )
  const id = uuidv7()
  await entities.insert(pool, {
    id,
    worldId,
    entityType: 'faction',
    name: 'Test Faction',
    accessLevel: 'known',
    createdIn: 'stage:test',
  })
  const row = await pool.query<{ created_in: string }>(
    `SELECT created_in FROM entities WHERE id = $1`,
    [id],
  )
  expect(row.rows[0]?.created_in).toBe('stage:test')
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd backend && pnpm vitest run src/repo/__tests__/entities.test.ts -t "writes created_in"`
Expected: FAIL (`createdIn` not recognized; SQL column not set).

- [ ] **Step 3: Update the `InsertEntityInput` type + insert function**

In `backend/src/repo/entities.ts`, find the `InsertEntityInput` interface and add `createdIn` field. Update the SQL accordingly:

```typescript
export interface InsertEntityInput {
  readonly id: string
  readonly worldId: string
  readonly entityType: 'faction' | 'location' | 'npc'
  readonly name: string
  readonly accessLevel: AccessLevel
  readonly statBlockId?: string | null
  /** Provenance marker. Format: 'stage:<stage_name>' for world-gen-created
   *  entities; 'session:<uuid>' for Scribe-created entities during play. */
  readonly createdIn: string
}

async function insert(client: ClientLike, input: InsertEntityInput): Promise<void> {
  await client.query(
    `INSERT INTO entities (id, world_id, entity_type, name, access_level, stat_block_id, created_in)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [
      input.id,
      input.worldId,
      input.entityType,
      input.name,
      input.accessLevel,
      input.statBlockId ?? null,
      input.createdIn,
    ],
  )
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd backend && pnpm vitest run src/repo/__tests__/entities.test.ts -t "writes created_in"`
Expected: PASS.

- [ ] **Step 5: Typecheck — should fail because existing call sites don't pass `createdIn`**

Run: `cd backend && pnpm typecheck 2>&1 | head -30`
Expected: errors at every existing `entities.insert` call site. Note the file paths; they get fixed in Task 1.3.

### Task 1.3: Update stages 2 + 3 (+ tests) to pass `createdIn`

**Files:**
- Modify: `backend/src/llm/prep/stages/world-and-factions.ts`
- Modify: `backend/src/llm/prep/stages/locations-and-npcs.ts`
- Verify: any test fixture helpers that call `entities.insert`

- [ ] **Step 1: Find every `entities.insert(` call site**

Run: `grep -rn "entities.insert(" backend/src --include='*.ts'`
Expected: lists files in `stages/world-and-factions.ts`, `stages/locations-and-npcs.ts`, and possibly test files.

- [ ] **Step 2: Update world-and-factions.ts call sites**

For each `entities.insert(client, { ... })` call in `world-and-factions.ts`, add `createdIn: 'stage:world_and_factions'` to the input object.

- [ ] **Step 3: Update locations-and-npcs.ts call sites**

For each `entities.insert(client, { ... })` call in `locations-and-npcs.ts`, add `createdIn: 'stage:locations_and_npcs'` to the input object.

- [ ] **Step 4: Update any test-fixture `entities.insert` call**

For test files that directly call `entities.insert` for seeding (e.g., `relationships.test.ts`, `entity-hierarchy.test.ts`), add `createdIn: 'stage:test'` to each call.

- [ ] **Step 5: Run typecheck — should be clean**

Run: `cd backend && pnpm typecheck 2>&1 | tail -5`
Expected: no errors.

- [ ] **Step 6: Run stage 2 + 3 + repo tests**

Run: `cd backend && pnpm vitest run src/llm/prep/stages/__tests__/world-and-factions.test.ts src/llm/prep/stages/__tests__/locations-and-npcs.test.ts src/repo/__tests__/entities.test.ts src/repo/__tests__/relationships.test.ts src/repo/__tests__/entity-hierarchy.test.ts`
Expected: all green.

### Task 1.4: Phase 1 verification + commit

**Files:** none — verification only.

- [ ] **Step 1: Full backend test suite**

Run: `cd backend && pnpm test 2>&1 | tail -5`
Expected: all green (~1405+ tests).

- [ ] **Step 2: Verify `created_in` is set on freshly-created entities**

In a separate terminal, create a fresh campaign via the dev tool (or via `pnpm dev` + a curl POST). Once world-gen completes, run:

```bash
docker compose exec -T postgres psql -U mythrun -d mythrun_dev -c "
  SELECT entity_type, created_in, COUNT(*)
  FROM entities
  WHERE world_id IN (SELECT world_id FROM campaigns ORDER BY created_at DESC LIMIT 1)
  GROUP BY entity_type, created_in
  ORDER BY entity_type;
"
```
Expected: entities grouped by `created_in='stage:world_and_factions'` and `'stage:locations_and_npcs'`, none `'stage:legacy'`.

- [ ] **Step 3: Commit Phase 1**

```bash
git add backend/migrations/017_entity_consolidation.sql \
        backend/src/repo/entities.ts \
        backend/src/repo/__tests__/entities.test.ts \
        backend/src/llm/prep/stages/world-and-factions.ts \
        backend/src/llm/prep/stages/locations-and-npcs.ts \
        $(grep -rl "entities.insert(" backend/src --include='*.test.ts')
git commit -m "feat(world-gen): add entities.created_in + pending-state column

Phase 1 of myth-tt2g. Migration 017 adds entities.created_in (TEXT)
and worlds.entity_consolidation_pending (JSONB) with shape-CHECK.
Repos and stages 2-3 updated to set created_in to their stage names.
Foundation for the upcoming entity_consolidation stage."
```

---

## Phase 2 — Per-item schema exports + streaming-extractor rework

End state: every streaming-stage schema exports its inner item schema as a named export; `runStreamingStage`'s `arrays` config gains `sub_schema`; per-entity validation drops bad items from the wire feed without killing the stream; end-of-stream full-tree validation + repair chain still fire as a safety net.

### Task 2.1: Export item schemas from stage 4

**Files:**
- Modify: `backend/src/llm/schemas/entity-relationships.ts`

- [ ] **Step 1: Read current schema**

Run: `cat backend/src/llm/schemas/entity-relationships.ts`

- [ ] **Step 2: Extract the inline item schemas as named exports**

```typescript
export const relationshipItemSchema = z.object({
  from: z.uuid(),
  to: z.uuid(),
  relationship: z.enum(RELATIONSHIP_TYPES),
  description: z.string().min(10).max(600),
})

export const hierarchyStragglerItemSchema = z.object({
  parent_entity_id: z.uuid(),
  child_entity_id: z.uuid(),
})

export const EntityRelationshipsSchema = z.object({
  relationships: z.array(relationshipItemSchema).min(5).max(80),
  hierarchy_stragglers: z.array(hierarchyStragglerItemSchema).max(20),
})

export type RelationshipItem = z.infer<typeof relationshipItemSchema>
export type HierarchyStragglerItem = z.infer<typeof hierarchyStragglerItemSchema>
```

(The `new_entity_declarations` field gets added in Task 3.1.)

- [ ] **Step 3: Typecheck**

Run: `cd backend && pnpm typecheck 2>&1 | tail -5`
Expected: clean.

### Task 2.2: Export item schemas from stages 2 + 3

**Files:**
- Modify: `backend/src/llm/schemas/world-and-factions.ts`
- Modify: `backend/src/llm/schemas/locations-and-npcs.ts`

- [ ] **Step 1: Extract inner item schemas in `world-and-factions.ts`**

Find the inline `z.object({...})` definitions inside the `regions` / `factions` arrays. Hoist each one out as a named export:

```typescript
export const regionItemSchema = z.object({
  name: z.string().min(1).max(200),
  access_level: ACCESS_LEVEL,
  prose: z.string().min(40).max(2400),
  facts: z.array(factSchema).min(2).max(12),
})

export const factionItemSchema = z.object({
  name: z.string().min(1).max(200),
  access_level: ACCESS_LEVEL,
  prose: z.string().min(40).max(2400),
  facts: z.array(factSchema).min(2).max(12),
})

export const WorldAndFactionsSchema = z.object({
  world_overview: z.string().min(40).max(800),
  regions: z.array(regionItemSchema).min(3).max(8),
  factions: z.array(factionItemSchema).min(3).max(8),
})
```

(Use the exact shape currently in the file; the above is illustrative.)

- [ ] **Step 2: Extract inner item schemas in `locations-and-npcs.ts`**

Same shape. Existing `locationSchema` and `npcSchema` may already be top-level. If they are, export them. If they're inline, hoist them.

- [ ] **Step 3: Typecheck**

Run: `cd backend && pnpm typecheck 2>&1 | tail -5`
Expected: clean.

- [ ] **Step 4: Run the existing stage tests**

Run: `cd backend && pnpm vitest run src/llm/prep/stages/__tests__/world-and-factions.test.ts src/llm/prep/stages/__tests__/locations-and-npcs.test.ts`
Expected: all green (the refactor is pure renaming + structural — no behavior change).

### Task 2.3: Extend `ArrayConfig` to accept `sub_schema`

**Files:**
- Modify: `backend/src/llm/prep/streaming-extractor.ts`

- [ ] **Step 1: Read current `ArrayConfig` type**

Run: `grep -nA6 "ArrayConfig\|interface ArrayConfig\|type ArrayConfig" backend/src/llm/prep/streaming-extractor.ts | head -15`

- [ ] **Step 2: Add `sub_schema` to the type**

In the `ArrayConfig` definition (or whatever it's named), add:

```typescript
import type { ZodTypeAny } from 'zod'

export interface ArrayConfig {
  readonly path: string
  readonly kind: string
  readonly role: 'entity' | 'edge'
  /** Per-item Zod schema. When set, each completed item is validated
   *  against this schema before its wire event is emitted. Failed items
   *  are dropped from the wire feed (logged via pino.warn) and removed
   *  from the survivor set the handler reads at end-of-stream. */
  readonly sub_schema?: ZodTypeAny
}
```

- [ ] **Step 3: Typecheck**

Run: `cd backend && pnpm typecheck 2>&1 | tail -5`
Expected: clean (no consumer required sub_schema yet — it's optional).

### Task 2.4: Wire per-entity validation in the mid-stream loop

**Files:**
- Modify: `backend/src/llm/prep/streaming-extractor.ts`
- Test: `backend/src/llm/prep/__tests__/streaming-extractor.test.ts`

- [ ] **Step 1: Write the failing test**

Append to `backend/src/llm/prep/__tests__/streaming-extractor.test.ts`:

```typescript
it('drops items that fail sub_schema validation; survivors still emit', async () => {
  const itemSchema = z.object({
    name: z.string().min(5),
    access_level: z.enum(['known', 'discoverable', 'secret']),
  })
  const partials = [
    { entities: [{ name: 'Aelmoor', access_level: 'known' }] },
    { entities: [{ name: 'Aelmoor', access_level: 'known' }, { name: 'X', access_level: 'known' }] },
    { entities: [
      { name: 'Aelmoor', access_level: 'known' },
      { name: 'X', access_level: 'known' },
      { name: 'Thornwood', access_level: 'discoverable' },
    ] },
  ]
  const emitted: PipelineEvent[] = []
  await runStreamingStage(asyncIterable(partials), {
    stage: 'test_stage',
    campaignId: 'test-c',
    job: { updateProgress: vi.fn() },
    redisRealtime: { publish: vi.fn() },
    keyPrefix: 'p',
    bypassAccessFilter: true,
    arrays: [{ path: 'entities', kind: 'location', role: 'entity', sub_schema: itemSchema }],
    endpointTierMap: new Map(),
    logger: silentLogger(),
    onEmit: (e) => emitted.push(e),
  })
  // The 'X' entity (name too short) should be dropped; Aelmoor + Thornwood emit.
  const names = emitted.filter(e => e.type === 'entity-added').map(e => e.name)
  expect(names).toEqual(['Aelmoor', 'Thornwood'])
})
```

(If the test harness's `runStreamingStage` shim doesn't expose `onEmit`, add it via the existing publishEvent spy pattern in the file.)

- [ ] **Step 2: Run test to verify it fails**

Run: `cd backend && pnpm vitest run src/llm/prep/__tests__/streaming-extractor.test.ts -t "drops items"`
Expected: FAIL — sub_schema isn't being consulted; 'X' currently emits.

- [ ] **Step 3: Implement the validation gate inside `maybeEmit`**

Find the `maybeEmit` function in `streaming-extractor.ts`. Before publishing the event, if `arrayCfg.sub_schema` is set, run it:

```typescript
async function maybeEmit(
  config: StageConfig,
  arrayCfg: ArrayConfig,
  entry: Record<string, unknown>,
  synthKey: string,
  emitted: Set<string>,
): Promise<void> {
  if (emitted.has(synthKey)) {
    throw new Error(
      `streaming-extractor: synthKey ${synthKey} already emitted (invariant violation)`,
    )
  }
  if (arrayCfg.sub_schema !== undefined) {
    const parsed = arrayCfg.sub_schema.safeParse(entry)
    if (!parsed.success) {
      config.logger.warn(
        {
          event: 'llm.stream_item_dropped',
          stage: config.stage,
          path: arrayCfg.path,
          synthKey,
          partial_json: entry,
          zod_errors: parsed.error.issues,
          campaignId: config.campaignId,
        },
        'streaming-extractor: dropped item failing sub_schema validation',
      )
      emitted.add(synthKey)  // prevent re-emit attempt on same synthKey
      return
    }
  }
  if (arrayCfg.role === 'entity') {
    if (shouldEmitEntity(entry, config.bypassAccessFilter, config.logger, synthKey)) {
      await publishEntityAdded(config, synthKey, arrayCfg, entry)
    }
  } else {
    if (shouldEmitEdge(entry, config.bypassAccessFilter, config.endpointTierMap)) {
      await publishEdgeAdded(config, synthKey, entry)
    }
  }
  emitted.add(synthKey)
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd backend && pnpm vitest run src/llm/prep/__tests__/streaming-extractor.test.ts -t "drops items"`
Expected: PASS.

### Task 2.5: Wire trailing-entry validation (end-of-stream)

**Files:**
- Modify: `backend/src/llm/prep/streaming-extractor.ts`
- Test: `backend/src/llm/prep/__tests__/streaming-extractor.test.ts`

- [ ] **Step 1: Write the failing test (trailing entry case)**

Append:

```typescript
it('drops a trailing item that fails sub_schema (no successor to trigger mid-stream boundary)', async () => {
  const itemSchema = z.object({
    name: z.string().min(5),
    access_level: z.enum(['known', 'discoverable', 'secret']),
  })
  const partials = [
    { entities: [{ name: 'Aelmoor', access_level: 'known' }] },
    { entities: [
      { name: 'Aelmoor', access_level: 'known' },
      { name: 'X', access_level: 'known' },
    ] },
    // stream ends here; 'X' is the trailing entry
  ]
  const emitted: PipelineEvent[] = []
  await runStreamingStage(asyncIterable(partials), {
    stage: 'test_stage',
    campaignId: 'test-c',
    job: { updateProgress: vi.fn() },
    redisRealtime: { publish: vi.fn() },
    keyPrefix: 'p',
    bypassAccessFilter: true,
    arrays: [{ path: 'entities', kind: 'location', role: 'entity', sub_schema: itemSchema }],
    endpointTierMap: new Map(),
    logger: silentLogger(),
    onEmit: (e) => emitted.push(e),
  })
  // Trailing 'X' validated at end-of-stream, dropped.
  const names = emitted.filter(e => e.type === 'entity-added').map(e => e.name)
  expect(names).toEqual(['Aelmoor'])
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd backend && pnpm vitest run src/llm/prep/__tests__/streaming-extractor.test.ts -t "trailing item"`
Expected: FAIL — the trailing entry currently emits because the existing post-loop pass uses the looser `hasSubstantiveContent` check, not the sub_schema.

- [ ] **Step 3: Wire sub_schema check into the post-loop pass**

Find the post-loop pass (the for-loop after the partial-object-stream completes that emits any not-yet-emitted last items — `streaming-extractor.ts:244-269`). The pass currently emits if `hasSubstantiveContent` passes. The fix: also run sub_schema validation here.

The cleanest factoring: the post-loop pass should call the same `maybeEmit` function the mid-stream loop uses. That way the sub_schema gate fires uniformly. If `maybeEmit` is already factored that way, this step is a no-op; if not, refactor the post-loop pass to delegate to `maybeEmit`.

- [ ] **Step 4: Run test to verify it passes**

Run: `cd backend && pnpm vitest run src/llm/prep/__tests__/streaming-extractor.test.ts -t "trailing item"`
Expected: PASS.

### Task 2.6: Wire sub_schema into existing stage handlers

**Files:**
- Modify: `backend/src/llm/prep/stages/entity-relationships.ts`
- Modify: `backend/src/llm/prep/stages/locations-and-npcs.ts`
- Modify: `backend/src/llm/prep/stages/world-and-factions.ts`

- [ ] **Step 1: Pass `sub_schema` in entity-relationships' arrays config**

Find the `runStreamingStage` call in `entity-relationships.ts`. Add `sub_schema: relationshipItemSchema` to the `relationships` array config:

```typescript
arrays: [
  {
    path: 'relationships',
    kind: 'edge',
    role: 'edge',
    sub_schema: relationshipItemSchema,
  },
],
```

(The `hierarchy_stragglers` array isn't surfaced via runStreamingStage — its items are processed at end-of-stream in `persistStragglers`. No change here.)

- [ ] **Step 2: Pass `sub_schema` in locations-and-npcs**

Find the `runStreamingStage` call. Add sub_schemas:

```typescript
arrays: [
  { path: 'locations', kind: 'location', role: 'entity', sub_schema: locationItemSchema },
  { path: 'npcs', kind: 'npc', role: 'entity', sub_schema: npcItemSchema },
],
```

- [ ] **Step 3: Pass `sub_schema` in world-and-factions**

Same pattern:

```typescript
arrays: [
  { path: 'regions', kind: 'location', role: 'entity', sub_schema: regionItemSchema },
  { path: 'factions', kind: 'faction', role: 'entity', sub_schema: factionItemSchema },
],
```

- [ ] **Step 4: Run all stage tests**

Run: `cd backend && pnpm vitest run src/llm/prep/stages/__tests__/`
Expected: all green. The sub_schema is now active for stages 2-4; existing test fixtures should pass because they emit structurally-valid items.

### Task 2.7: Phase 2 commit

- [ ] **Step 1: Full backend test suite**

Run: `cd backend && pnpm test 2>&1 | tail -5`
Expected: all green.

- [ ] **Step 2: Commit Phase 2**

```bash
git add backend/src/llm/schemas/entity-relationships.ts \
        backend/src/llm/schemas/locations-and-npcs.ts \
        backend/src/llm/schemas/world-and-factions.ts \
        backend/src/llm/prep/streaming-extractor.ts \
        backend/src/llm/prep/__tests__/streaming-extractor.test.ts \
        backend/src/llm/prep/stages/entity-relationships.ts \
        backend/src/llm/prep/stages/locations-and-npcs.ts \
        backend/src/llm/prep/stages/world-and-factions.ts
git commit -m "feat(streaming): per-entity drop-on-fail validation

Phase 2 of myth-tt2g. runStreamingStage gains an optional per-array
sub_schema; failed items are dropped from the wire feed (logged via
structured pino warn) and removed from the survivor set without
killing the stream. End-of-stream Zod + repair chain still fire as
the catastrophic-failure safety net.

Item schemas exported as named members from each stage's schema file
(relationshipItemSchema, locationItemSchema, etc.) for re-use as
sub_schemas. Stages 2-4 wired to pass sub_schemas into runStreamingStage.

Resolves the MYT-53-shape streamObject hang + the entity_relationships
UUID crash class. One bad row no longer poisons the whole stream."
```

---

## Phase 3 — Stage 4 extensions (placeholder support)

End state: stage 4's schema accepts placeholder IDs in relationship endpoints and a `new_entity_declarations` array; the handler partitions output and writes the pending state column; stage 4's idempotency wipe cascades to clear any prior stage-4b ghosts.

### Task 3.1: Extend stage 4 schema with placeholder support

**Files:**
- Modify: `backend/src/llm/schemas/entity-relationships.ts`

- [ ] **Step 1: Add placeholder + endpoint widening**

```typescript
const PLACEHOLDER_ID_PATTERN = /^new-\d{3}$/

export const placeholderIdSchema = z.string().regex(PLACEHOLDER_ID_PATTERN)

export const endpointSchema = z.union([z.uuid(), placeholderIdSchema])

export const declarationItemSchema = z.object({
  placeholder_id: placeholderIdSchema,
  name: z.string().min(1).max(200),
  entity_type: z.enum(['faction', 'location', 'npc']),
})

export const relationshipItemSchema = z.object({
  from: endpointSchema,
  to: endpointSchema,
  relationship: z.enum(RELATIONSHIP_TYPES),
  description: z.string().min(10).max(600),
})

export const hierarchyStragglerItemSchema = z.object({
  parent_entity_id: endpointSchema,
  child_entity_id: endpointSchema,
})

export const EntityRelationshipsSchema = z.object({
  relationships: z.array(relationshipItemSchema).min(5).max(80),
  hierarchy_stragglers: z.array(hierarchyStragglerItemSchema).max(20),
  new_entity_declarations: z.array(declarationItemSchema).max(15),
})

export type DeclarationItem = z.infer<typeof declarationItemSchema>
```

- [ ] **Step 2: Typecheck**

Run: `cd backend && pnpm typecheck 2>&1 | tail -5`
Expected: errors in `entity-relationships.ts` handler (the partitioner doesn't yet know about declarations) and likely test mocks. Will be addressed in subsequent tasks.

### Task 3.2: Update stage 4 prompt template

**Files:**
- Modify: `backend/src/llm/prompts/prep/entity-relationships.txt`

- [ ] **Step 1: Add the placeholder mechanism section**

After the existing "Your Task" section, before "## Guidance", add:

```
## Declaring missing entities

Sometimes the prose above references an entity that doesn't appear in the inventory — a faction the regions name-drop but that wasn't generated as a structured entity. If you need to express a relationship with such an entity, you may declare it as a phantom and the system will create the real entity in a subsequent step.

To declare a phantom:
1. Use a placeholder ID of the form `new-001`, `new-002`, etc. in the relationship's `from` or `to` field instead of a UUID.
2. Add a matching entry to the `new_entity_declarations` array with the placeholder ID, the entity's intended name, and its type (`faction`, `location`, or `npc`).

Example:
{
  "relationships": [
    {
      "from": "<real-uuid-of-The-Long-Vigil>",
      "to": "new-001",
      "relationship": "rival_of",
      "description": "The Long Vigil and the Ironjaw contest territory in the Bone Reach."
    }
  ],
  "new_entity_declarations": [
    { "placeholder_id": "new-001", "name": "The Ironjaw", "entity_type": "faction" }
  ]
}

Do this only when an entity is clearly named in the prose and structurally needed for a relationship. Don't invent new entities to bulk up the world.
```

- [ ] **Step 2: Verify the prompt loads cleanly**

Run: `cd backend && pnpm typecheck 2>&1 | tail -3`
Expected: no prompt-load errors (TypeScript imports the file via `readFileSync`).

### Task 3.3: Implement `partitionWithPlaceholders` + pending-state write

**Files:**
- Modify: `backend/src/llm/prep/stages/entity-relationships.ts`
- Test: `backend/src/llm/prep/stages/__tests__/entity-relationships.test.ts`

- [ ] **Step 1: Write the failing test**

Append a test that exercises the placeholder routing:

```typescript
it('routes placeholder-endpoint relationships to pending state column', async () => {
  const { worldId, campaignId, factionId } = await seedUserWorldCampaign(pool, scope)
  // Mock LLM output: 1 real-endpoint relationship + 1 placeholder-endpoint + matching declaration.
  pushEntityRelationshipsResponses({
    relationships: [
      { from: factionId, to: factionId, relationship: 'rival_of', description: 'Self-rival' },
      { from: factionId, to: 'new-001', relationship: 'opposed_to', description: 'Opposes phantom faction' },
    ],
    hierarchy_stragglers: [],
    new_entity_declarations: [
      { placeholder_id: 'new-001', name: 'The Ironjaw', entity_type: 'faction' },
    ],
  })

  await withTxn(pool, (client) =>
    runEntityRelationshipsStage(client, makeArgs({ worldId, campaignId, factionId })),
  )

  // Real-endpoint relationship persists; placeholder one does not.
  const rels = await pool.query<{ source_entity_id: string; target_entity_id: string }>(
    `SELECT source_entity_id, target_entity_id FROM relationships
       WHERE source_entity_id = $1 OR target_entity_id = $1`,
    [factionId],
  )
  expect(rels.rows).toHaveLength(1)
  expect(rels.rows[0]?.target_entity_id).toBe(factionId)

  // Pending state column holds the placeholder declaration + relationship.
  const pending = await pool.query<{ entity_consolidation_pending: { declarations: unknown[]; relationships: unknown[] } }>(
    `SELECT entity_consolidation_pending FROM worlds WHERE id = $1`,
    [worldId],
  )
  expect(pending.rows[0]?.entity_consolidation_pending.declarations).toHaveLength(1)
  expect(pending.rows[0]?.entity_consolidation_pending.relationships).toHaveLength(1)
})
```

(`pushEntityRelationshipsResponses` and `makeArgs` may need analogues — use the existing test file's helper patterns.)

- [ ] **Step 2: Run test to verify it fails**

Run: `cd backend && pnpm vitest run src/llm/prep/stages/__tests__/entity-relationships.test.ts -t "routes placeholder"`
Expected: FAIL — current handler drops placeholder-endpoint relationships entirely.

- [ ] **Step 3: Implement `partitionWithPlaceholders` and the pending-state write**

In `backend/src/llm/prep/stages/entity-relationships.ts`, after the existing `partitionRelationships`, add:

```typescript
interface PartitionedWithPlaceholders {
  readonly realRelationships: AcceptedRow[]
  readonly placeholderRelationships: ReadonlyArray<{
    from: string
    to: string
    relationship: string
    description: string
  }>
  readonly validDeclarations: ReadonlyArray<{
    placeholderId: string
    name: string
    entityType: 'faction' | 'location' | 'npc'
  }>
  readonly droppedHallucinatedCount: number
  readonly droppedOrphanPlaceholderCount: number
}

function partitionWithPlaceholders(
  tree: EntityRelationshipsOutput,
  entityIds: ReadonlySet<string>,
): PartitionedWithPlaceholders {
  const declarationMap = new Map(
    tree.new_entity_declarations.map((d) => [d.placeholder_id, d]),
  )
  const realRelationships: AcceptedRow[] = []
  const placeholderRelationships: PartitionedWithPlaceholders['placeholderRelationships'][number][] = []
  let droppedHallucinatedCount = 0
  let droppedOrphanPlaceholderCount = 0

  for (const [i, r] of tree.relationships.entries()) {
    const fromIsPlaceholder = r.from.startsWith('new-')
    const toIsPlaceholder = r.to.startsWith('new-')
    if (fromIsPlaceholder || toIsPlaceholder) {
      // Orphan check: every placeholder must have a matching declaration.
      const fromOrphan = fromIsPlaceholder && !declarationMap.has(r.from)
      const toOrphan = toIsPlaceholder && !declarationMap.has(r.to)
      if (fromOrphan || toOrphan) {
        droppedOrphanPlaceholderCount++
        continue
      }
      // If real endpoint exists, validate it's in inventory.
      if (!fromIsPlaceholder && !entityIds.has(r.from)) {
        droppedHallucinatedCount++
        continue
      }
      if (!toIsPlaceholder && !entityIds.has(r.to)) {
        droppedHallucinatedCount++
        continue
      }
      placeholderRelationships.push({
        from: r.from,
        to: r.to,
        relationship: r.relationship,
        description: r.description,
      })
      continue
    }
    // Both endpoints are UUIDs — preserve existing behavior.
    if (!entityIds.has(r.from) || !entityIds.has(r.to)) {
      droppedHallucinatedCount++
      continue
    }
    realRelationships.push({
      sourceEntityId: r.from,
      targetEntityId: r.to,
      relationshipType: r.relationship,
      description: r.description,
      sourceIndex: i,
    })
  }

  const validDeclarations = tree.new_entity_declarations.map((d) => ({
    placeholderId: d.placeholder_id,
    name: d.name,
    entityType: d.entity_type,
  }))

  return {
    realRelationships,
    placeholderRelationships,
    validDeclarations,
    droppedHallucinatedCount,
    droppedOrphanPlaceholderCount,
  }
}
```

Then update the handler to call this new partitioner and persist the pending state:

```typescript
const partitioned = partitionWithPlaceholders(validatedTree, entityIds)

if (partitioned.droppedHallucinatedCount > 0) {
  logger.warn({ stage: 'entity_relationships', worldId, dropped: partitioned.droppedHallucinatedCount, reason: 'unknown_entity_uuid' },
    'entity_relationships: dropped LLM-emitted rows referencing unknown entity UUIDs')
}
if (partitioned.droppedOrphanPlaceholderCount > 0) {
  logger.warn({ stage: 'entity_relationships', worldId, dropped: partitioned.droppedOrphanPlaceholderCount, reason: 'orphan_placeholder' },
    'entity_relationships: dropped LLM-emitted rows referencing placeholders not in new_entity_declarations')
}

const relationshipIds = await relationships.insertMany(client, partitioned.realRelationships.map(a => ({
  sourceEntityId: a.sourceEntityId,
  targetEntityId: a.targetEntityId,
  relationshipType: a.relationshipType,
  description: a.description,
})))

// Write the pending state (always overwrite, even if empty).
await client.query(
  `UPDATE worlds SET entity_consolidation_pending = $1::jsonb WHERE id = $2`,
  [
    JSON.stringify({
      declarations: partitioned.validDeclarations,
      relationships: partitioned.placeholderRelationships,
    }),
    args.worldId,
  ],
)
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd backend && pnpm vitest run src/llm/prep/stages/__tests__/entity-relationships.test.ts -t "routes placeholder"`
Expected: PASS.

- [ ] **Step 5: Run all entity-relationships tests**

Run: `cd backend && pnpm vitest run src/llm/prep/stages/__tests__/entity-relationships.test.ts`
Expected: all green (existing tests still pass; placeholder test now passes too).

### Task 3.4: Extend stage 4 idempotency wipe to cascade-clear ghosts

**Files:**
- Modify: `backend/src/llm/prep/stages/entity-relationships.ts`
- Test: `backend/src/llm/prep/stages/__tests__/entity-relationships.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
it('cascade-clears prior stage_consolidation ghosts on stage-4 retry', async () => {
  const { worldId, campaignId, factionId } = await seedUserWorldCampaign(pool, scope)
  // Simulate a prior stage-4b run by inserting a ghost entity + a relationship to it.
  const ghostId = uuidv7()
  await pool.query(
    `INSERT INTO entities (id, world_id, entity_type, name, access_level, created_in)
     VALUES ($1, $2, 'faction', 'Stale Ghost', 'known', 'stage:entity_consolidation')`,
    [ghostId, worldId],
  )
  await pool.query(
    `INSERT INTO relationships (id, source_entity_id, target_entity_id, relationship_type, description)
     VALUES ($1, $2, $3, 'rival_of', 'Stale rel')`,
    [uuidv7(), factionId, ghostId],
  )

  // Re-run stage 4 (mock fresh LLM output).
  pushEntityRelationshipsResponses({
    relationships: [
      { from: factionId, to: factionId, relationship: 'rival_of', description: 'Fresh rel' },
    ],
    hierarchy_stragglers: [],
    new_entity_declarations: [],
  })
  await withTxn(pool, (client) =>
    runEntityRelationshipsStage(client, makeArgs({ worldId, campaignId, factionId })),
  )

  // Ghost is gone; its relationship is cascade-deleted.
  const ghostRow = await pool.query(`SELECT 1 FROM entities WHERE id = $1`, [ghostId])
  expect(ghostRow.rows).toHaveLength(0)
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd backend && pnpm vitest run src/llm/prep/stages/__tests__/entity-relationships.test.ts -t "cascade-clears prior"`
Expected: FAIL — the ghost still exists after stage 4 re-runs.

- [ ] **Step 3: Add the cascade wipe to the handler**

In `runEntityRelationshipsStage`, right after the existing `relationships.deleteByWorld(client, args.worldId)`:

```typescript
// myth-tt2g: stage 4 retry must also cascade-clear prior stage-4b
// ghosts. Otherwise a stage-4 retry leaves orphan ghosts whose
// declarations the new stage-4 attempt may not match. Stage 4 + 4b
// are a single retry unit from the durability standpoint.
await client.query(
  `DELETE FROM entities WHERE world_id = $1 AND created_in = 'stage:entity_consolidation'`,
  [args.worldId],
)
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd backend && pnpm vitest run src/llm/prep/stages/__tests__/entity-relationships.test.ts -t "cascade-clears prior"`
Expected: PASS.

### Task 3.5: Phase 3 commit

- [ ] **Step 1: Full backend test suite**

Run: `cd backend && pnpm test 2>&1 | tail -5`
Expected: all green.

- [ ] **Step 2: Commit Phase 3**

```bash
git add backend/src/llm/schemas/entity-relationships.ts \
        backend/src/llm/prompts/prep/entity-relationships.txt \
        backend/src/llm/prep/stages/entity-relationships.ts \
        backend/src/llm/prep/stages/__tests__/entity-relationships.test.ts
git commit -m "feat(stage 4): placeholder declarations for phantom entities

Phase 3 of myth-tt2g. Stage 4's Zod schema accepts placeholder IDs
(/^new-\d{3}$/) in relationship endpoints + a new_entity_declarations
array. Handler partitions output: real-endpoint relationships persist
to relationships table; placeholder-endpoint ones land in
worlds.entity_consolidation_pending JSONB for stage 4b to process.

Stage 4's idempotency wipe extended to cascade-clear any prior
stage-4b ghosts (created_in='stage:entity_consolidation') so a stage-4
retry doesn't leave orphan ghosts paired with a new declaration set.

Prompt updated with placeholder mechanism instructions + worked example."
```

---

## Phase 4 — Stage 4b new stage

End state: `entity_consolidation` is a wired stage in `WORLD_GEN_STAGES`; its handler skips when there are no phantoms, generates ghosts via Sonnet when there are, persists with cascading idempotency wipe + clears the pending column; `world_snapshot_ready` emits after this stage rather than stage 4.

### Task 4.1: Write stage 4b schema

**Files:**
- Create: `backend/src/llm/schemas/entity-consolidation.ts`

- [ ] **Step 1: Write the schema file**

```typescript
// backend/src/llm/schemas/entity-consolidation.ts
//
// Stage 4b (entity_consolidation) schema. Each ghost entity has the
// same depth as stage 2-3 entities: prose (40-2400 chars), 2-12 facts,
// access_level, optional parent_location_id for locations.

import { z } from 'zod'
import { placeholderIdSchema } from './entity-relationships.js'

const ACCESS_LEVEL = z.enum(['known', 'discoverable', 'secret'])

const factSchema = z.object({
  topic: z.string().min(1).max(120),
  content: z.string().min(20).max(800),
  access_level: ACCESS_LEVEL,
})

export const ghostEntitySchema = z.object({
  placeholder_id: placeholderIdSchema,
  name: z.string().min(1).max(200),
  entity_type: z.enum(['faction', 'location', 'npc']),
  access_level: ACCESS_LEVEL,
  parent_location_id: z.string().uuid().nullable(),
  prose: z.string().min(40).max(2400),
  facts: z.array(factSchema).min(2).max(12),
})

export const EntityConsolidationSchema = z.object({
  ghost_entities: z.array(ghostEntitySchema).max(15),
})

export type GhostEntity = z.infer<typeof ghostEntitySchema>
export type EntityConsolidationOutput = z.infer<typeof EntityConsolidationSchema>
```

- [ ] **Step 2: Typecheck**

Run: `cd backend && pnpm typecheck 2>&1 | tail -5`
Expected: clean.

### Task 4.2: Write stage 4b prompt template

**Files:**
- Create: `backend/src/llm/prompts/prep/entity-consolidation.txt`

- [ ] **Step 1: Write the prompt**

```
{# Stage 4b (entity_consolidation). Inputs: world summary +
   vocabulary registry + existing entity inventory + phantom
   declarations from stage 4 + per-phantom relationship context.
   Outputs: full prose + facts for each declared phantom. #}

You are formalizing a small group of entities that were referenced during stage 4 of world generation but didn't exist yet as full entities. For each one, write the entity into existence with the same depth as the other entities of this world: a few paragraphs of prose, several structured facts, an access level, and (for locations) a parent location.

## World Vocabulary

{{vocabularyRegistry}}

## World Summary

- **Name:** {{worldName}}
- **Tone:** {{tone}}
- **Themes:** {{themes}}
- **Key tensions:** {{keyTensions}}

## Existing Entity Inventory

Every entity below is part of the established world. Reference these by name in your prose when relevant — they are the load-bearing characters, places, and factions the players already know about.

{{entityInventory}}

## Phantoms to Resolve

The entities below were declared during stage 4 but don't yet have prose or facts. Write each one into existence. Each entry below is followed by the relationships that referenced this phantom — use those relationships as the structural anchor for what this entity is and does.

{{phantomBlock}}

## Your Task

For each phantom above, produce a `ghost_entities` entry with:

- `placeholder_id` — copy verbatim from the declaration above.
- `name` — copy verbatim from the declaration.
- `entity_type` — copy verbatim from the declaration.
- `access_level` — pick `known`, `discoverable`, or `secret`. Default to `known` unless the relationships suggest the entity is rumored or hidden.
- `parent_location_id` — UUID of the parent location from the existing inventory if this is a location with a clear parent, else `null`. Factions and NPCs always set this to `null`.
- `prose` — 40-2400 characters. Write in the same register as the existing world. Ground it in the relationships above: if relationships say this entity "rivals X" or "operates in Y," write prose that explains how and why.
- `facts` — 2-12 structured facts. Each fact is `{topic, content, access_level}`. Facts should be concrete and grounded.

## Guidance

- Where possible, ground your prose and facts in entities and concepts that already exist in this world — the entity inventory above, the vocabulary registry, the other phantoms you're declaring in this response. The prose reads more coherent when it references things the players have already met.
- If you must mention something new in passing, keep it light and atmospheric rather than load-bearing.
- Each entity gets a tight, story-shaped paragraph — no info-dumps, no bullet lists in prose.
- Do not narrate. The facts should read like structured notes, not story snippets.

Respond with ONLY the JSON object, no markdown fences or commentary.
```

### Task 4.3: Write stage 4b handler skeleton (skip path + signature)

**Files:**
- Create: `backend/src/llm/prep/stages/entity-consolidation.ts`
- Create: `backend/src/llm/prep/stages/__tests__/entity-consolidation.test.ts`

- [ ] **Step 1: Write the failing test for the skip path**

```typescript
// backend/src/llm/prep/stages/__tests__/entity-consolidation.test.ts
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Pool } from 'pg'
import { runEntityConsolidationStage } from '../entity-consolidation.js'
import { cleanupTestScope, makeTestScope, type TestScope } from '../../../repo/__tests__/_helpers/test-scope.js'
import { createTestPool } from '../../../repo/__tests__/_helpers/test-pool.js'
// ... mock setup as in entity-relationships.test.ts pattern

describe('runEntityConsolidationStage', () => {
  let pool: Pool
  const scope = makeTestScope('econ')
  beforeAll(() => { pool = createTestPool(process.env.DATABASE_URL ?? '') })
  afterAll(async () => { await cleanupTestScope(pool, scope); await pool.end() })

  it('skip path: empty pending state → zero-cost stage result, no LLM call', async () => {
    const { worldId, campaignId } = await seedUserWorldCampaign(pool, scope)
    // No need to set entity_consolidation_pending — default is { declarations: [], relationships: [] }.
    const result = await withTxn(pool, (client) =>
      runEntityConsolidationStage(client, makeArgs({ worldId, campaignId })),
    )
    expect(result.costUsd).toBe(0)
    expect(result.inputTokens).toBe(0)
    expect(result.outputTokens).toBe(0)
    // No ghost entities created.
    const ghosts = await pool.query(
      `SELECT id FROM entities WHERE world_id = $1 AND created_in = 'stage:entity_consolidation'`,
      [worldId],
    )
    expect(ghosts.rows).toHaveLength(0)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd backend && pnpm vitest run src/llm/prep/stages/__tests__/entity-consolidation.test.ts`
Expected: FAIL — `entity-consolidation.ts` doesn't exist yet.

- [ ] **Step 3: Write the handler with the skip path implemented**

```typescript
// backend/src/llm/prep/stages/entity-consolidation.ts
//
// Stage 4b (entity_consolidation). Reads worlds.entity_consolidation_pending
// written by stage 4. If empty: skip path (zero-cost result). Otherwise:
// generates ghost entities via Sonnet generateObject, persists with
// created_in='stage:entity_consolidation', resolves pending placeholder
// relationships to real UUIDs, clears the pending column.

import type { PoolClient } from 'pg'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { resolve, dirname } from 'node:path'
import { generateObject } from '../../ai.js'
import { SONNET } from '../../models.js'
import { uuidv7 } from '../../../repo/uuidv7.js'
import { entities } from '../../../repo/entities.js'
import { facts } from '../../../repo/facts.js'
import { proseKernels } from '../../../repo/prose-kernels.js'
import { entityHierarchy } from '../../../repo/entity-hierarchy.js'
import { relationships } from '../../../repo/relationships.js'
import {
  EntityConsolidationSchema,
  type EntityConsolidationOutput,
  type GhostEntity,
} from '../../schemas/entity-consolidation.js'
import { renderVocabularyRegistry } from '../vocabulary-renderer.js'
import type { VocabularyRegistry } from '../../schemas/vocabulary-registry.js'
import type { PipelineEvent } from '../../../contract/pipeline-events.js'
import type { StageDispatchResult } from '../world-gen-processor.js'

const PROMPT_TEMPLATE = readFileSync(
  resolve(dirname(fileURLToPath(import.meta.url)), '../../prompts/prep/entity-consolidation.txt'),
  'utf8',
)

const SONNET_INPUT_PER_MTOK = 3.0
const SONNET_OUTPUT_PER_MTOK = 15.0

function computeCostUsd(usage: { inputTokens: number; outputTokens: number }): number {
  return (
    (usage.inputTokens / 1_000_000) * SONNET_INPUT_PER_MTOK +
    (usage.outputTokens / 1_000_000) * SONNET_OUTPUT_PER_MTOK
  )
}

export interface EntityConsolidationArgs {
  readonly campaignId: string
  readonly worldId: string
  readonly worldName: string
  readonly tone: string
  readonly themes: string
  readonly keyTensions: string
  readonly vocabularyRegistry: VocabularyRegistry
  readonly bypassAccessFilter: boolean
}

interface PendingState {
  readonly declarations: ReadonlyArray<{
    placeholderId: string
    name: string
    entityType: 'faction' | 'location' | 'npc'
  }>
  readonly relationships: ReadonlyArray<{
    from: string
    to: string
    relationship: string
    description: string
  }>
}

export async function runEntityConsolidationStage(
  client: PoolClient,
  args: EntityConsolidationArgs,
): Promise<StageDispatchResult> {
  // 1. Read pending state.
  const pendingRes = await client.query<{ entity_consolidation_pending: PendingState }>(
    `SELECT entity_consolidation_pending FROM worlds WHERE id = $1`,
    [args.worldId],
  )
  const pending = pendingRes.rows[0]?.entity_consolidation_pending ?? { declarations: [], relationships: [] }

  // 2. Skip path: no phantoms declared.
  if (pending.declarations.length === 0) {
    return {
      costUsd: 0,
      inputTokens: 0,
      outputTokens: 0,
      finalizedEvents: [],
      capExhausted: false,
    }
  }

  // TODO Task 4.4: idempotency wipe + LLM call + persist
  throw new Error('not yet implemented (Task 4.4)')
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd backend && pnpm vitest run src/llm/prep/stages/__tests__/entity-consolidation.test.ts -t "skip path"`
Expected: PASS.

### Task 4.4: Implement the LLM call + persist path

**Files:**
- Modify: `backend/src/llm/prep/stages/entity-consolidation.ts`
- Modify: `backend/src/llm/prep/stages/__tests__/entity-consolidation.test.ts`

- [ ] **Step 1: Write the failing happy-path test**

```typescript
it('happy path: pending declarations → ghosts persist, relationships resolve, state clears', async () => {
  const { worldId, campaignId, factionId } = await seedUserWorldCampaign(pool, scope)
  // Seed pending state as stage 4 would.
  await pool.query(
    `UPDATE worlds SET entity_consolidation_pending = $1::jsonb WHERE id = $2`,
    [
      JSON.stringify({
        declarations: [{ placeholderId: 'new-001', name: 'The Ironjaw', entityType: 'faction' }],
        relationships: [{
          from: factionId,
          to: 'new-001',
          relationship: 'rival_of',
          description: 'Long Vigil rivals the Ironjaw over Bone Reach territory.',
        }],
      }),
      worldId,
    ],
  )
  // Mock the Sonnet response.
  mockGenerateObject.mockResolvedValueOnce({
    output: {
      ghost_entities: [{
        placeholder_id: 'new-001',
        name: 'The Ironjaw',
        entity_type: 'faction',
        access_level: 'known',
        parent_location_id: null,
        prose: 'The Ironjaw is one of the four hunting bands of the Bone Reach, contesting territory with the Long Vigil.',
        facts: [
          { topic: 'territory', content: 'Ranges the eastern Bone Reach canyons.', access_level: 'known' },
          { topic: 'rivalry', content: 'Long Vigil disputes their Boneright claims.', access_level: 'known' },
        ],
      }],
    },
    usage: { inputTokens: 500, outputTokens: 800 },
  } as never)

  await withTxn(pool, (client) =>
    runEntityConsolidationStage(client, makeArgs({ worldId, campaignId })),
  )

  // Ghost persisted with correct created_in.
  const ghost = await pool.query<{ id: string; name: string; created_in: string }>(
    `SELECT id, name, created_in FROM entities WHERE world_id = $1 AND name = 'The Ironjaw'`,
    [worldId],
  )
  expect(ghost.rows).toHaveLength(1)
  expect(ghost.rows[0]?.created_in).toBe('stage:entity_consolidation')

  // Pending relationship resolved to real UUID and persisted.
  const rel = await pool.query<{ source_entity_id: string; target_entity_id: string }>(
    `SELECT source_entity_id, target_entity_id FROM relationships
       WHERE source_entity_id = $1 AND target_entity_id = $2`,
    [factionId, ghost.rows[0]?.id],
  )
  expect(rel.rows).toHaveLength(1)

  // Pending state cleared.
  const pending = await pool.query<{ entity_consolidation_pending: PendingState }>(
    `SELECT entity_consolidation_pending FROM worlds WHERE id = $1`,
    [worldId],
  )
  expect(pending.rows[0]?.entity_consolidation_pending.declarations).toHaveLength(0)
  expect(pending.rows[0]?.entity_consolidation_pending.relationships).toHaveLength(0)
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd backend && pnpm vitest run src/llm/prep/stages/__tests__/entity-consolidation.test.ts -t "happy path"`
Expected: FAIL — handler throws "not yet implemented."

- [ ] **Step 3: Replace the TODO in the handler with the full implementation**

After the skip-path check:

```typescript
// 3. Idempotency wipe — clear any prior stage-4b ghosts (cascade FKs
//    delete their facts, prose_kernels, relationships).
await client.query(
  `DELETE FROM entities WHERE world_id = $1 AND created_in = 'stage:entity_consolidation'`,
  [args.worldId],
)

// 4. Assemble context.
const inventory = await entities.listByWorld(client, args.worldId)
const inventoryBlock = inventory.map(e => `- ${e.id}  [${e.entityType}]  ${e.name}`).join('\n')

const phantomBlock = pending.declarations.map(d => {
  const relsForPhantom = pending.relationships.filter(r => r.from === d.placeholderId || r.to === d.placeholderId)
  const relsRendered = relsForPhantom.map(r =>
    `  - ${r.from}  ${r.relationship}  ${r.to}: ${r.description}`
  ).join('\n')
  return `### ${d.placeholderId}  [${d.entityType}]  ${d.name}\n${relsRendered || '  (no incoming relationships)'}\n`
}).join('\n')

const prompt = PROMPT_TEMPLATE
  .replace('{{worldName}}', args.worldName)
  .replace('{{tone}}', args.tone)
  .replace('{{themes}}', args.themes)
  .replace('{{keyTensions}}', args.keyTensions)
  .replace('{{vocabularyRegistry}}', renderVocabularyRegistry(args.vocabularyRegistry))
  .replace('{{entityInventory}}', inventoryBlock)
  .replace('{{phantomBlock}}', phantomBlock)

// 5. Generate ghosts.
const result = await generateObject({
  model: SONNET,
  schema: EntityConsolidationSchema,
  prompt,
  temperature: 0.4,
  maxRetries: 0,
  callSite: 'entity-consolidation',
  schemaName: 'EntityConsolidationSchema',
  repairStrategy: 'haiku-then-sonnet',
  providerOptions: { mythrun: { stage: 'entity_consolidation' } },
})

const validatedTree: EntityConsolidationOutput = result.output

// 6. Reconcile output vs declarations.
const declarationMap = new Map(pending.declarations.map(d => [d.placeholderId, d]))
const surviving: ReadonlyArray<GhostEntity> = validatedTree.ghost_entities.filter(g =>
  declarationMap.has(g.placeholder_id)
)
// Extras (output for placeholderIds not declared) are dropped here; missing
// declarations get logged below.
const declaredIds = new Set(pending.declarations.map(d => d.placeholderId))
const generatedIds = new Set(surviving.map(g => g.placeholder_id))
const missingIds = [...declaredIds].filter(id => !generatedIds.has(id))
if (missingIds.length > 0 || validatedTree.ghost_entities.length !== surviving.length) {
  // Note: caller's logger isn't on args; use console.warn or thread logger through args
  // (depending on existing handler-arg pattern; align with entity-relationships).
}

// 7. Persist surviving ghosts.
const placeholderToUuid = new Map<string, string>()
for (const ghost of surviving) {
  const ghostId = uuidv7()
  placeholderToUuid.set(ghost.placeholder_id, ghostId)
  await entities.insert(client, {
    id: ghostId,
    worldId: args.worldId,
    entityType: ghost.entity_type,
    name: ghost.name,
    accessLevel: ghost.access_level,
    createdIn: 'stage:entity_consolidation',
  })
  await proseKernels.insert(client, { entityId: ghostId, content: ghost.prose })
  for (const fact of ghost.facts) {
    await facts.insert(client, {
      entityId: ghostId,
      topic: fact.topic,
      content: fact.content,
      accessLevel: fact.access_level,
    })
  }
  if (ghost.entity_type === 'location' && ghost.parent_location_id !== null) {
    await entityHierarchy.insert(client, {
      parentEntityId: ghost.parent_location_id,
      childEntityId: ghostId,
    })
  }
}

// 8. Persist pending relationships with placeholder endpoints resolved.
const resolvableRels = pending.relationships.filter(r => {
  const fromOk = r.from.startsWith('new-') ? placeholderToUuid.has(r.from) : true
  const toOk = r.to.startsWith('new-') ? placeholderToUuid.has(r.to) : true
  return fromOk && toOk
})
await relationships.insertMany(client, resolvableRels.map(r => ({
  sourceEntityId: r.from.startsWith('new-') ? placeholderToUuid.get(r.from)! : r.from,
  targetEntityId: r.to.startsWith('new-') ? placeholderToUuid.get(r.to)! : r.to,
  relationshipType: r.relationship,
  description: r.description,
})))

// 9. Clear state column.
await client.query(
  `UPDATE worlds SET entity_consolidation_pending = '{"declarations": [], "relationships": []}'::jsonb WHERE id = $1`,
  [args.worldId],
)

// 10. Return.
return {
  costUsd: computeCostUsd({ inputTokens: result.usage.inputTokens ?? 0, outputTokens: result.usage.outputTokens ?? 0 }),
  inputTokens: result.usage.inputTokens ?? 0,
  outputTokens: result.usage.outputTokens ?? 0,
  finalizedEvents: [], // wire events emitted by world-gen-processor wrapper
  capExhausted: false,
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd backend && pnpm vitest run src/llm/prep/stages/__tests__/entity-consolidation.test.ts -t "happy path"`
Expected: PASS.

### Task 4.5: Wire stage 4b into the world-gen processor

**Files:**
- Modify: `backend/src/llm/prep/world-gen-processor.ts`
- Test: `backend/src/llm/prep/__tests__/world-gen-processor.test.ts`

- [ ] **Step 1: Add `entity_consolidation` to `WORLD_GEN_STAGES`**

```typescript
export const WORLD_GEN_STAGES = [
  'concept_intake',
  'vocabulary_intake',
  'world_and_factions',
  'locations_and_npcs',
  'entity_relationships',
  'entity_consolidation',  // NEW
  'starting_situation',
  'random_tables',
  'coherence_pass',
] as const
```

- [ ] **Step 2: Dispatch the stage in the stage loop**

In `world-gen-processor.ts`, find the stage-dispatch switch. Add an arm for `entity_consolidation`:

```typescript
case 'entity_consolidation': {
  const result = await runEntityConsolidationStage(client, {
    campaignId: ctx.campaign.id,
    worldId: ctx.world.id,
    worldName: ctx.world.name,
    tone: ctx.world.tone ?? '',
    themes: ctx.world.themes ?? '',
    keyTensions: ctx.world.keyTensions ?? '',
    vocabularyRegistry: ctx.world.vocabularyRegistry,
    bypassAccessFilter: ctx.world.devBypassAccessFilter,
  })
  return result
}
```

(Import `runEntityConsolidationStage` at the top of the file.)

- [ ] **Step 3: Move `world_snapshot_ready` emit**

Find the two emit sites in `world-gen-processor.ts` (one in the idempotent re-entry path, one in the live-emit path). They currently fire when `stage === 'entity_relationships'`. Change to `stage === 'entity_consolidation'`:

```typescript
// Before:
if (stage === 'entity_relationships' && claim === 'completed') { ... publish phase=world_snapshot_ready ... }
// After:
if (stage === 'entity_consolidation' && claim === 'completed') { ... publish phase=world_snapshot_ready ... }
```

Same for the live emit path.

- [ ] **Step 4: Run world-gen-processor tests**

Run: `cd backend && pnpm vitest run src/llm/prep/__tests__/world-gen-processor.test.ts`
Expected: all green. (The existing tests halt early at stage_not_implemented for unimplemented stages; entity_consolidation's skip-path makes it pass through cleanly when there are no phantoms.)

### Task 4.6: Phase 4 commit

- [ ] **Step 1: Full backend test suite**

Run: `cd backend && pnpm test 2>&1 | tail -5`
Expected: all green.

- [ ] **Step 2: Commit Phase 4**

```bash
git add backend/src/llm/schemas/entity-consolidation.ts \
        backend/src/llm/prompts/prep/entity-consolidation.txt \
        backend/src/llm/prep/stages/entity-consolidation.ts \
        backend/src/llm/prep/stages/__tests__/entity-consolidation.test.ts \
        backend/src/llm/prep/world-gen-processor.ts \
        backend/src/llm/prep/__tests__/world-gen-processor.test.ts
git commit -m "feat(stage 4b): entity_consolidation stage

Phase 4 of myth-tt2g. New stage entity_consolidation between
entity_relationships and starting_situation. Reads worlds.
entity_consolidation_pending (written by stage 4); if empty, skip
path with zero cost. Otherwise: idempotency-wipes prior ghosts,
generates ghost entities via Sonnet generateObject, persists each
with created_in='stage:entity_consolidation' + facts + prose +
hierarchy, resolves pending placeholder relationships to real UUIDs,
clears the pending column.

world_snapshot_ready phase emit moves from after entity_relationships
to after entity_consolidation so the snapshot view's 'ready' signal
aligns with the actually-complete entity graph including ghosts.

No semantic audit on ghost prose: dropped per the spec's reasoning
that downstream stages don't recurse on prose-only references."
```

---

## Phase 5 — Wire protocol + frontend reconciliation

End state: `pipeline-events.ts` contract widens `from`/`to` and adds optional `placeholderId`; stage 4b emits per-ghost `entity-added` events with `placeholderId`; dev-tool's renderer buffers placeholder-endpoint edges and patches them when matching ghosts arrive.

### Task 5.1: Update `pipeline-events.ts` contract

**Files:**
- Modify: `backend/src/contract/pipeline-events.ts`

- [ ] **Step 1: Add the optional fields**

Find the `EntityAdded` and `EdgeAdded` types. Update:

```typescript
| {
    type: 'entity-added'
    synthKey: string
    entityKind: string
    name: string
    /** Stage 4b ghost entity reconciliation key. The frontend's buffered
     *  placeholder edges resolve via this field. Absent for stages 2-3
     *  entities (they have no placeholder antecedent). */
    placeholderId?: string
  }

| {
    type: 'edge-added'
    synthKey: string
    /** Real UUID or placeholder ID `new-NNN`. Edges with placeholder
     *  endpoints buffer client-side until the matching entity-added
     *  arrives carrying the same placeholderId. */
    from: string
    to: string
    relationship: string
    description?: string
  }
```

- [ ] **Step 2: Typecheck**

Run: `cd backend && pnpm typecheck 2>&1 | tail -5`
Expected: clean.

### Task 5.2: Emit `entity-added` events from stage 4b

**Files:**
- Modify: `backend/src/llm/prep/stages/entity-consolidation.ts`

- [ ] **Step 1: Wire up event publishing inside the persist loop**

The handler currently has access to a `publishEvent` mechanism via the args; thread it through (mirroring entity-relationships' pattern). In step 7 of the handler (where ghosts persist), after each insert:

```typescript
// Inside the for-loop persisting ghosts, after the entity + prose + facts inserts:
await publishEvent(ctx, args.campaignId, {
  type: 'entity-added',
  synthKey: `entity_consolidation/ghosts/${i}`,
  entityKind: ghost.entity_type,
  name: ghost.name,
  placeholderId: ghost.placeholder_id,
})
```

(The publish helper signature should match the world-gen-processor's wrapper. If `publishEvent` isn't in `EntityConsolidationArgs`, add it — mirror entity-relationships' shape.)

- [ ] **Step 2: Also emit `edge-added` for the resolved relationships in step 8**

```typescript
// Inside the resolvableRels loop, after relationships.insertMany:
for (const [i, rel] of resolvableRels.entries()) {
  await publishEvent(ctx, args.campaignId, {
    type: 'edge-added',
    synthKey: `entity_consolidation/relationships/${i}`,
    from: rel.from.startsWith('new-') ? placeholderToUuid.get(rel.from)! : rel.from,
    to: rel.to.startsWith('new-') ? placeholderToUuid.get(rel.to)! : rel.to,
    relationship: rel.relationship,
    description: rel.description,
  })
}
```

- [ ] **Step 3: Update the happy-path test to assert on the events**

Augment the existing happy-path test in `entity-consolidation.test.ts`:

```typescript
const publishSpy = vi.fn()
const args = makeArgs({ worldId, campaignId, publishEvent: publishSpy })
await withTxn(pool, (client) => runEntityConsolidationStage(client, args))
// ...existing assertions...
const entityAddedEvents = publishSpy.mock.calls
  .map(c => c[1])
  .filter(e => e.type === 'entity-added')
expect(entityAddedEvents).toHaveLength(1)
expect(entityAddedEvents[0]?.placeholderId).toBe('new-001')
expect(entityAddedEvents[0]?.name).toBe('The Ironjaw')
```

- [ ] **Step 4: Run the test**

Run: `cd backend && pnpm vitest run src/llm/prep/stages/__tests__/entity-consolidation.test.ts`
Expected: PASS.

### Task 5.3: Dev-tool placeholder buffer + reconciliation

**Files:**
- Modify: `backend/dev-tool/src/components/live-events-panel.ts` (or whichever file consumes entity-added / edge-added events)
- Test: `backend/dev-tool/src/components/__tests__/live-events-panel.test.ts`

- [ ] **Step 1: Find the existing event handler**

Run: `grep -nA10 "entity-added\|edge-added" backend/dev-tool/src/components/live-events-panel.ts | head -40`

- [ ] **Step 2: Write the failing test**

```typescript
it('buffers placeholder-endpoint edges; resolves them on entity-added with placeholderId', async () => {
  const panel = createLiveEventsPanel(/* harness */)
  // Edge with a placeholder endpoint — buffered, not rendered.
  panel.onEvent({
    type: 'edge-added',
    synthKey: 'entity_relationships/relationships/0',
    from: 'real-uuid-1',
    to: 'new-001',
    relationship: 'rival_of',
  })
  expect(panel.renderedEdges()).toHaveLength(0)
  expect(panel.bufferedPlaceholderCount()).toBe(1)
  // Entity arrives with matching placeholderId — buffered edge renders.
  panel.onEvent({
    type: 'entity-added',
    synthKey: 'entity_consolidation/ghosts/0',
    entityKind: 'faction',
    name: 'The Ironjaw',
    placeholderId: 'new-001',
  })
  expect(panel.renderedEdges()).toHaveLength(1)
  expect(panel.renderedEdges()[0]).toMatchObject({
    from: 'real-uuid-1',
    to: expect.not.stringMatching(/^new-/), // resolved to real UUID
  })
  expect(panel.bufferedPlaceholderCount()).toBe(0)
})
```

- [ ] **Step 3: Implement the buffer in the panel**

Inside the live-events-panel, add a Map<placeholderId, EdgeAdded[]>. Modify the edge-added handler to buffer when an endpoint starts with `new-`; modify the entity-added handler to drain the buffer when `placeholderId` is set.

- [ ] **Step 4: Run test to verify it passes**

Run: `cd backend && pnpm vitest run backend/dev-tool/src/components/__tests__/live-events-panel.test.ts -t "buffers placeholder"`
Expected: PASS.

### Task 5.4: Phase 5 commit

- [ ] **Step 1: Full backend + dev-tool test suite**

Run: `cd backend && pnpm test 2>&1 | tail -5`
Expected: all green.

- [ ] **Step 2: Commit Phase 5**

```bash
git add backend/src/contract/pipeline-events.ts \
        backend/src/llm/prep/stages/entity-consolidation.ts \
        backend/src/llm/prep/stages/__tests__/entity-consolidation.test.ts \
        backend/dev-tool/src/components/live-events-panel.ts \
        backend/dev-tool/src/components/__tests__/live-events-panel.test.ts
git commit -m "feat(wire): placeholder endpoint reconciliation

Phase 5 of myth-tt2g. pipeline-events contract widens edge-added's
from/to to accept placeholder strings ('new-NNN'); entity-added gains
optional placeholderId set by stage 4b ghost emissions. Existing
consumers' event shapes preserved (synthKey/entityKind/name unchanged).

Stage 4b emits entity-added per ghost (with placeholderId) and
edge-added per resolved relationship (with synthKey under
entity_consolidation/...).

Dev-tool live-events panel buffers any edge whose from or to is a
placeholder; on entity-added carrying matching placeholderId, the
buffered edges' endpoints are patched to the real UUID and rendered.
End-of-world-gen snapshot push reconciles any stragglers."
```

---

## Phase 6 — Smoke test + ship

End state: a real-LLM smoke script lives at `backend/scripts/smoke/phantom-reconciliation.ts`; smoke gate passes (at least one of up to 3 runs exercises the phantom path with all structural assertions met); Layer 3 manual dev-tool walkthrough confirms the wire UX.

### Task 6.1: Write the smoke script

**Files:**
- Create: `backend/scripts/smoke/phantom-reconciliation.ts`
- Modify: `backend/package.json` (add script)

- [ ] **Step 1: Write the smoke script**

```typescript
// backend/scripts/smoke/phantom-reconciliation.ts
//
// Real-LLM smoke. Drives a fresh world-gen against a running backend
// + real Anthropic API. Tails SSE, polls DB until status='complete'.
// Asserts the structural state matches the spec's Layer 2 acceptance.
// Runs up to 3 times; passes if at least one run exercises the
// phantom path.

import { Pool } from 'pg'
import EventSource from 'eventsource'
import { writeFileSync, mkdirSync } from 'node:fs'
import { resolve } from 'node:path'

const BACKEND_URL = process.env.SMOKE_BACKEND_URL ?? 'http://localhost:3030'
const DEV_USER_SUB = 'dev-user-1'
const CONCEPT = `A floating sky city above a harsh desert. The sky-dwellers possess magic; the desert-dwellers hunt megafauna. Tension between the elites in the city and the underclass below, with named hunting bands (Ironjaw, Long Vigil, Ash-and-Salt, Stoneback) and named magic institutions (Magisterium, Aetheric Conservatory, Procurement Office).`
const MAX_RUNS = 3

interface RunResult {
  campaignId: string
  worldId: string
  status: string
  events: unknown[]
  exercisedPhantomPath: boolean
}

async function runOnce(pool: Pool, runIdx: number): Promise<RunResult> {
  console.log(`[run ${runIdx}] creating campaign...`)
  const createRes = await fetch(`${BACKEND_URL}/api/campaigns`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-mythrun-dev-sub': DEV_USER_SUB },
    body: JSON.stringify({ kind: 'freeform', concept: CONCEPT, devBypassAccessFilter: true }),
  })
  if (!createRes.ok) throw new Error(`create failed: ${createRes.status} ${await createRes.text()}`)
  const { campaignId } = await createRes.json() as { campaignId: string }
  console.log(`[run ${runIdx}] campaignId=${campaignId}`)

  // Tail SSE.
  const events: unknown[] = []
  const sse = new EventSource(`${BACKEND_URL}/api/campaigns/${campaignId}/events`, {
    headers: { 'x-mythrun-dev-sub': DEV_USER_SUB },
  })
  sse.onmessage = (e) => { try { events.push(JSON.parse(e.data)) } catch {} }

  // Poll until done.
  const deadline = Date.now() + 15 * 60_000 // 15 min
  let world: { id: string; status: string } | null = null
  while (Date.now() < deadline) {
    await new Promise(r => setTimeout(r, 5_000))
    const detail = await fetch(`${BACKEND_URL}/api/campaigns/${campaignId}`, {
      headers: { 'x-mythrun-dev-sub': DEV_USER_SUB },
    })
    const body = await detail.json() as { world: { id: string; status: string } }
    world = body.world
    if (world.status === 'complete' || world.status === 'failed') break
  }
  sse.close()

  if (!world) throw new Error(`[run ${runIdx}] never observed world row`)
  console.log(`[run ${runIdx}] final world.status=${world.status}`)

  const eventLogDir = resolve('tmp', 'smoke', `${campaignId}`)
  mkdirSync(eventLogDir, { recursive: true })
  writeFileSync(resolve(eventLogDir, 'events.jsonl'), events.map(e => JSON.stringify(e)).join('\n'))

  const exercisedPhantomPath = events.some(
    (e: any) => e.type === 'edge-added' && (typeof e.from === 'string' && e.from.startsWith('new-') || typeof e.to === 'string' && e.to.startsWith('new-'))
  )
  return { campaignId, worldId: world.id, status: world.status, events, exercisedPhantomPath }
}

async function assertStructural(pool: Pool, result: RunResult): Promise<void> {
  if (result.status !== 'complete') throw new Error(`world status=${result.status}, expected complete`)
  const pr = await pool.query<{ stage: string; status: string }>(
    `SELECT stage, status FROM pipeline_runs WHERE world_id = $1 AND user_id IS NULL ORDER BY started_at`,
    [result.worldId],
  )
  const stagesByName = new Map(pr.rows.map(r => [r.stage, r.status]))
  for (const stage of ['concept_intake', 'vocabulary_intake', 'world_and_factions', 'locations_and_npcs', 'entity_relationships', 'entity_consolidation', 'starting_situation', 'random_tables', 'coherence_pass']) {
    if (stagesByName.get(stage) !== 'completed') {
      throw new Error(`stage ${stage}: status=${stagesByName.get(stage) ?? 'missing'}, expected completed`)
    }
  }
  const counts = await pool.query<{ created_in: string; n: string }>(
    `SELECT created_in, COUNT(*)::text AS n FROM entities WHERE world_id = $1 GROUP BY created_in`,
    [result.worldId],
  )
  const byOrigin = new Map(counts.rows.map(r => [r.created_in, Number(r.n)]))
  if ((byOrigin.get('stage:world_and_factions') ?? 0) < 1) throw new Error('no stage:world_and_factions entities')
  if ((byOrigin.get('stage:locations_and_npcs') ?? 0) < 1) throw new Error('no stage:locations_and_npcs entities')
  const total = [...byOrigin.values()].reduce((s, n) => s + n, 0)
  if (total < 30) throw new Error(`total entities=${total}, expected ≥30`)
  if (result.exercisedPhantomPath) {
    if ((byOrigin.get('stage:entity_consolidation') ?? 0) < 1) {
      throw new Error('events showed placeholder endpoints but no stage:entity_consolidation entities persisted')
    }
  }
}

async function main(): Promise<void> {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL })
  let exercisedAny = false
  let lastResult: RunResult | null = null
  for (let i = 1; i <= MAX_RUNS; i++) {
    const result = await runOnce(pool, i)
    await assertStructural(pool, result)
    lastResult = result
    if (result.exercisedPhantomPath) {
      exercisedAny = true
      console.log(`[run ${i}] exercised phantom path ✓`)
      break
    } else {
      console.log(`[run ${i}] no phantoms produced; retrying`)
    }
  }
  if (!exercisedAny) {
    throw new Error(`phantom path not exercised after ${MAX_RUNS} attempts; increase retry budget or use a more phantom-prone concept`)
  }
  console.log(`SMOKE PASSED. Final run: ${lastResult?.campaignId}`)
  await pool.end()
}

main().catch(err => { console.error(err); process.exit(1) })
```

- [ ] **Step 2: Add the package.json script**

In `backend/package.json` add to scripts:
```json
"smoke:phantom-reconciliation": "tsx --env-file=.env.development scripts/smoke/phantom-reconciliation.ts"
```

### Task 6.2: Run the smoke (real LLM)

**Files:** none — verification only.

- [ ] **Step 1: Start the backend**

In one terminal: `cd backend && pnpm dev`. Wait for boot to complete.

- [ ] **Step 2: Run the smoke**

In another terminal: `cd backend && pnpm smoke:phantom-reconciliation`
Expected: at least one of up to 3 runs exercises the phantom path; all structural assertions pass; final line "SMOKE PASSED."

If the smoke fails on a transient issue (Anthropic rate limit, etc.), re-run. If it fails on a structural assertion, triage as a real bug.

### Task 6.3: Layer 3 manual gate

**Files:** none — verification only.

- [ ] **Step 1: Start backend + dev-tool**

`cd backend && pnpm dev` in one terminal, `cd backend/dev-tool && pnpm dev` in another.

- [ ] **Step 2: Create a campaign via the dev-tool**

In the browser, use a phantom-prone concept (e.g., the Skybound and Starving shape from the smoke script). Submit.

- [ ] **Step 3: Watch the live event feed**

Verify the wire UX:
- Entities populate the graph as stages 2/3 run (entity-added events visible — myth-uqhy fix).
- During stage 4: edges appear with placeholder endpoints; placeholder-endpoint edges are buffered (not rendered) per the dev-tool patch.
- During stage 4b (entity_consolidation): ghost entities pop in, and the buffered edges resolve and render simultaneously.
- World completes; snapshot panel shows final structure including ghosts.

- [ ] **Step 4: Inspect a ghost entity**

Open one ghost entity's detail panel. Verify it has prose + facts that read alive and grounded in the world; verify any name-drops are sane (not jarring sci-fi names in a fantasy world).

### Task 6.4: Push + close beads

- [ ] **Step 1: Final verification**

Run: `cd backend && pnpm typecheck && pnpm lint && pnpm test 2>&1 | tail -10`
Expected: all green.

- [ ] **Step 2: Commit smoke + push**

```bash
git add backend/scripts/smoke/phantom-reconciliation.ts backend/package.json
git commit -m "test(smoke): real-LLM smoke for phantom-reconciliation

Phase 6 of myth-tt2g. Layer 2 gate per the spec. Drives a fresh
world-gen against the running backend + real Anthropic API; runs up
to 3 times; passes if at least one run exercises the phantom path
(edge-added with placeholder endpoint + stage:entity_consolidation
entities persist). Structural assertions on world status, stage
completion, entity counts, and placeholder-resolution invariants."
git push origin main
```

- [ ] **Step 3: Close beads**

```bash
bd close myth-tt2g
bd close myth-449j
# Plus the new entity_consolidation bead if filed separately.
```

---

## Self-Review

**Spec coverage check:**
- §1 Stage architecture (new entity_consolidation stage, world_snapshot_ready emit moves) → Task 4.5 ✓
- §2 Migration changes (created_in + entity_consolidation_pending) → Task 1.1 ✓
- §2 Zod schema changes (placeholders + declarations + endpoint widening) → Task 3.1 ✓
- §3 Streaming-extractor rework (per-entity validation + sub_schema) → Tasks 2.1-2.6 ✓
- §3 Snapshot canonical / wire best-effort → covered implicitly by no compensating events (Task 5.x) ✓
- §3 Cross-validation for orphan placeholders → Task 3.3 ✓
- §3 Wire-protocol changes → Task 5.1 ✓
- §4 Stage 4b handler (10-step flow → 9 after audit removal) → Tasks 4.3, 4.4 ✓
- §4 Prompt structure → Task 4.2 ✓
- §5 Stage 4 prompt + handler changes (partition + pending state + idempotency wipe) → Tasks 3.2, 3.3, 3.4 ✓
- §6 Frontend renderer changes → Task 5.3 ✓
- §7 What doesn't change → no implementation, just confirmation ✓
- Testing strategy Layer 1 → Tasks 2.4, 2.5, 3.3, 3.4, 4.3, 4.4, 5.3 ✓
- Testing strategy Layer 2 → Tasks 6.1, 6.2 ✓
- Testing strategy Layer 3 → Task 6.3 ✓

**Placeholder scan:** no TBD/TODO/"implement later"/etc. in the plan. Code blocks complete in each step.

**Type consistency:** `EntityConsolidationArgs`, `GhostEntity`, `PendingState`, `placeholderToUuid` map all named consistently across tasks. `created_in='stage:entity_consolidation'` is the canonical provenance value. `placeholder_id` (snake) for schema; `placeholderId` (camel) for TS types. Schema-to-type mapping follows existing Mythrun convention.

**Scope check:** single implementation plan, six phases, each phase committable. No sub-project decomposition needed.
