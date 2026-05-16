# myth-exac: Narrow Streaming + Access-Tier-Aware World Snapshot Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Narrow the world-gen SSE event contract to identity-only payloads with closed-entry emit gates; rework access tiers to `known`/`discoverable`/`secret` on facts AND entities; ship `GET /api/campaigns/:campaignId/world-snapshot` returning the known-tier slice for a dev-tool wiki inspector; add a per-create dev-mode bypass that surfaces all tiers for inspection.

**Architecture:** Tier-aware filters at four sites — streaming-extractor (stages 2-4 live graph), `finalizedEvents` filter (stage persisters), coherence-pass (post-snapshot deltas), snapshot endpoint (read-time). New `world_snapshot_ready` pipeline phase fires after stage 4 commits, gating snapshot availability. Single new column on `entities`, enum-rename on `facts.access_level`, bypass flag on `worlds`. Wire payloads stay narrow (identity-only); tier classification governs whether events fire, not what's in them.

**Tech Stack:** Node.js 24 + Fastify + TypeScript strict; pg + ioredis + BullMQ for worker; Anthropic AI SDK (`streamObject`, `generateObject`) with `partialObjectStream`; Vitest co-located in `__tests__/`; sequential numbered SQL migrations; JSDOM dev-tool inspector with `data-state` lifecycle markers.

**Pre-flight:** Spec is at `docs/superpowers/specs/2026-05-16-myth-exac-streaming-narrow-snapshot-design.md`. Round-1 blind-review applied (commits `e1185ce` → `f9ae90e` → `28bdb3a`). Work on `main`. `pnpm db:up` must be running. `pnpm install` clean. Beads: `myth-exac` (this ticket), `myth-8iid` (per-character visibility future), `myth-rg09` (concept_intake → Opus future).

---

## File Structure

**Migrations (1 new):**
- `backend/migrations/014_access_tier_rework.sql` — tier rename, `entities.access_level`, `worlds.dev_bypass_access_filter`

**Backend `src/contract/` (3 modified):**
- `pipeline-events.ts` — narrow entity-added/edge-added shapes; add `world_snapshot_ready` to `PipelinePhase`
- `backend-routes.ts` — add the new route
- `pipeline-routes.ts` — add the new route

**Backend `src/repo/` (6 modified, 1 new):**
- `facts.ts` — `AccessLevel` rename, new `listByEntities`
- `entities.ts` — `InsertEntityInput.accessLevel`, `listByWorld` opts arg
- `relationships.ts` — new `listAmong`
- `prose-kernels.ts` — new `listByEntities`
- `entity-hierarchy.ts` — new `listForWorld`
- `stat-blocks.ts` — **new module** with `listByIds`
- `world-snapshot-view.ts` — **new module** composing the snapshot view

**Backend `src/llm/` (4 modified):**
- `schemas/world-and-factions.ts` — fact enum + entity `access_level` field-2
- `schemas/locations-and-npcs.ts` — same
- `prompts/prep/world-and-factions.txt` — tier semantics + field-order + prose-tier constraint
- `prompts/prep/locations-and-npcs.txt` — same + cross-stage note

**Backend `src/llm/prep/` (5 modified):**
- `streaming-extractor.ts` — closed-entry gate, post-loop pass, tier filter, `Set<synthKey>`, `bypassAccessFilter` arg, `endpointTierMap` arg
- `stages/world-and-factions.ts` — tier-aware persist, tier-filtered finalizedEvents
- `stages/locations-and-npcs.ts` — same
- `stages/entity-relationships.ts` — build `Map<entityId, AccessLevel>` for endpoint check
- `stages/coherence-pass.ts` — inventory loads access_level, world-dump renders it, emit filter

**Backend `src/sse/` (1 modified):**
- `derive-phase.ts` — return `world_snapshot_ready` for stage-4-done-but-7-pending

**Backend `src/llm/prep/` (1 modified):**
- `world-gen-processor.ts` — emit `phase: world_snapshot_ready` post-stage-4

**Backend `src/routes/` (1 modified):**
- `campaigns.ts` — add `GET /world-snapshot`; extend `CreateCampaignBodySchema` for `devBypassAccessFilter`; route handler gating + audit log

**Dev-tool (3 modified, 1 new):**
- `dev-tool/coverage.json` — register new route
- `dev-tool/verify-registry.ts` — register new panel
- `dev-tool/src/components/campaign-create-panel.ts` — bypass checkbox
- `dev-tool/src/components/world-snapshot-panel.ts` — **new**

**Wiki (3 modified):**
- `docs/wiki/content/runtime/world-gen.html`
- `docs/wiki/content/runtime/dev-tool.html`
- `docs/wiki/content/data/schema.html`

---

## Task ordering rationale

Migration first (Task 1) so every downstream task can rely on the columns. Contract files (Task 2-3) so type errors localize early. Repo layer (Tasks 4-10) so stages and snapshot endpoint compile. LLM schemas + prompts (Tasks 11-14) before stage handlers so the stages have the validated shapes. Streaming-extractor (Task 15) before stages. Stage handlers (Tasks 16-19). Lifecycle (Tasks 20-21). Snapshot endpoint (Tasks 22-24). Campaign-create bypass (Task 25). Dev-tool panels (Tasks 26-29). Wiki (Task 30). Final E2E smoke (Task 31).

---

## Task 1: Migration 014 — access tier rework

**Files:**
- Create: `backend/migrations/014_access_tier_rework.sql`
- Modify: `backend/src/repo/__tests__/migrate-schema.test.ts`

- [ ] **Step 1: Write the failing test**

Add to `backend/src/repo/__tests__/migrate-schema.test.ts` — find the `EXPECTED_MIGRATIONS` constant and add `'014_access_tier_rework.sql'`. Then add a new `describe` block:

```ts
describe('migration 014 — access tier rework', () => {
  it('rewrites facts.access_level CHECK to (known, discoverable, secret)', async () => {
    const pool = await openPool()
    try {
      await resetData(pool)
      // Insert a fact with the new vocabulary — should succeed
      await pool.query(
        `INSERT INTO entities (id, world_id, entity_type, name, access_level)
         VALUES ($1, $2, 'location', 'X', 'known')`,
        [uuidv7(), DEMO_WORLD_ID],
      )
      const entityRows = await pool.query(`SELECT id FROM entities WHERE name = 'X'`)
      const entityId = entityRows.rows[0].id as string
      await expect(
        pool.query(
          `INSERT INTO facts (id, entity_id, topic, access_level, content, narrative_status)
           VALUES ($1, $2, 't', 'discoverable', 'c', 'undelivered')`,
          [uuidv7(), entityId],
        ),
      ).resolves.toBeDefined()
      // Old vocabulary — should fail
      await expect(
        pool.query(
          `INSERT INTO facts (id, entity_id, topic, access_level, content, narrative_status)
           VALUES ($1, $2, 't', 'public', 'c', 'undelivered')`,
          [uuidv7(), entityId],
        ),
      ).rejects.toThrow(/facts_access_level_check/)
    } finally {
      await pool.end()
    }
  })

  it('adds entities.access_level NOT NULL DEFAULT known with CHECK', async () => {
    const pool = await openPool()
    try {
      const { rows } = await pool.query(
        `SELECT column_name, data_type, is_nullable, column_default
         FROM information_schema.columns
         WHERE table_name='entities' AND column_name='access_level'`,
      )
      expect(rows).toEqual([
        {
          column_name: 'access_level',
          data_type: 'text',
          is_nullable: 'NO',
          column_default: "'known'::text",
        },
      ])
    } finally {
      await pool.end()
    }
  })

  it('adds worlds.dev_bypass_access_filter NOT NULL DEFAULT false', async () => {
    const pool = await openPool()
    try {
      const { rows } = await pool.query(
        `SELECT column_name, data_type, is_nullable, column_default
         FROM information_schema.columns
         WHERE table_name='worlds' AND column_name='dev_bypass_access_filter'`,
      )
      expect(rows).toEqual([
        {
          column_name: 'dev_bypass_access_filter',
          data_type: 'boolean',
          is_nullable: 'NO',
          column_default: 'false',
        },
      ])
    } finally {
      await pool.end()
    }
  })

  it('creates idx_entities_world_access index', async () => {
    const pool = await openPool()
    try {
      const { rows } = await pool.query(
        `SELECT indexname FROM pg_indexes WHERE tablename='entities' AND indexname='idx_entities_world_access'`,
      )
      expect(rows).toHaveLength(1)
    } finally {
      await pool.end()
    }
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

```bash
pnpm --filter @mythrun/backend vitest run src/repo/__tests__/migrate-schema.test.ts
```

Expected: FAIL — migration 014 file does not exist (or new columns missing).

- [ ] **Step 3: Write the migration**

Create `backend/migrations/014_access_tier_rework.sql`:

```sql
-- backend/migrations/014_access_tier_rework.sql
-- myth-exac: rework access_level on facts from (public/private/secret) to
-- (known/discoverable/secret); add the same enum to entities; add the
-- dev-mode bypass flag to worlds.
--
-- Done in a single transaction (the migration runner wraps each file in
-- BEGIN/COMMIT). The DROP-then-ADD on facts_access_level_check is
-- non-concurrent — assumes no live writes during migrate (true for
-- production, and our test runner is single-threaded).

-- 1. Drop the existing facts CHECK; rename old enum values; re-add CHECK.
ALTER TABLE facts DROP CONSTRAINT facts_access_level_check;

UPDATE facts SET access_level = 'known' WHERE access_level = 'public';
UPDATE facts SET access_level = 'discoverable' WHERE access_level = 'private';
-- 'secret' is unchanged.

ALTER TABLE facts ADD CONSTRAINT facts_access_level_check
  CHECK (access_level IN ('known', 'discoverable', 'secret'));

-- 2. New column on entities. Default 'known' so any existing rows
--    (none in production yet, but defensive for dev fixtures) are
--    treated as visible by default.
ALTER TABLE entities ADD COLUMN access_level TEXT NOT NULL DEFAULT 'known'
  CHECK (access_level IN ('known', 'discoverable', 'secret'));

-- 3. Covering index for the snapshot endpoint's primary filter:
--    WHERE world_id = $1 AND access_level = ANY($2).
CREATE INDEX idx_entities_world_access ON entities(world_id, access_level);

-- 4. Dev-mode bypass flag. Defaults false; production code paths never
--    set this (gated at the create route by AUTH_MODE=bypass + dev/test
--    NODE_ENV). See myth-exac spec § "Dev-mode access tier bypass".
ALTER TABLE worlds ADD COLUMN dev_bypass_access_filter BOOLEAN NOT NULL DEFAULT false;
```

- [ ] **Step 4: Run test to verify it passes**

```bash
pnpm --filter @mythrun/backend db:migrate
pnpm --filter @mythrun/backend vitest run src/repo/__tests__/migrate-schema.test.ts
```

Expected: PASS, all four new assertions green.

- [ ] **Step 5: Commit**

```bash
git add backend/migrations/014_access_tier_rework.sql backend/src/repo/__tests__/migrate-schema.test.ts
git commit -m "feat(myth-exac): migration 014 — access tier rework + dev-bypass flag"
```

---

## Task 2: Pipeline-events contract — narrow shapes + new phase

**Files:**
- Modify: `backend/src/contract/pipeline-events.ts`
- Modify: `backend/src/contract/__tests__/pipeline-events.test.ts`

- [ ] **Step 1: Write the failing test**

Add to `backend/src/contract/__tests__/pipeline-events.test.ts` (create the file if it doesn't exist; check first with `ls backend/src/contract/__tests__/`):

```ts
import { describe, it, expect } from 'vitest'
import type { PipelineEvent, PipelinePhase } from '../pipeline-events.js'

describe('PipelineEvent contract — myth-exac narrow shapes', () => {
  it('entity-added carries name (not data)', () => {
    const ev: PipelineEvent = {
      type: 'entity-added',
      synthKey: 's',
      entityKind: 'location',
      name: 'X',
    }
    expect(ev).toMatchObject({ name: 'X' })
    // Type-level assertion: no `data` field allowed.
    // @ts-expect-error — data is removed from the contract
    const bad: PipelineEvent = {
      type: 'entity-added',
      synthKey: 's',
      entityKind: 'location',
      data: {},
    }
    void bad
  })

  it('edge-added carries no description', () => {
    const ev: PipelineEvent = {
      type: 'edge-added',
      synthKey: 's',
      from: 'a',
      to: 'b',
      relationship: 'r',
    }
    expect(ev.relationship).toBe('r')
    // @ts-expect-error — description is removed from the contract
    const bad: PipelineEvent = {
      type: 'edge-added',
      synthKey: 's',
      from: 'a',
      to: 'b',
      relationship: 'r',
      description: 'd',
    }
    void bad
  })

  it('PipelinePhase includes world_snapshot_ready', () => {
    const phase: PipelinePhase = 'world_snapshot_ready'
    expect(phase).toBe('world_snapshot_ready')
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

```bash
pnpm --filter @mythrun/backend typecheck
```

Expected: FAIL — the `@ts-expect-error` directives expect the old shape to be illegal, but it's currently legal.

- [ ] **Step 3: Update the contract**

Edit `backend/src/contract/pipeline-events.ts`:

```ts
// In PIPELINE_SSE_EVENTS — no change (the array tracks event-type names,
// not payload shape).

// PipelinePhase: insert world_snapshot_ready between world_gen and world_ready.
export type PipelinePhase =
  | 'not_started'
  | 'world_gen'
  | 'world_gen_failed'
  | 'world_snapshot_ready'  // myth-exac: stages 1-4 complete; stages 5-7 may still be running
  | 'world_ready'
  | 'character_creation'
  | 'post_creation'
  | 'complete'
  | 'failed'

// PipelineEvent: narrow entity-added (drop `data`, add `name`); narrow
// edge-added (drop `description`).
export type PipelineEvent =
  | { type: 'phase'; phase: PipelinePhase }
  | { type: 'stage-started'; stage: string; userId: string | null; startedAt: string }
  | {
      type: 'stage-completed'
      stage: string
      userId: string | null
      durationMs: number
      costUsd: number
    }
  | {
      type: 'stage-failed'
      stage: string
      userId: string | null
      errorCode: string
      willRetry: boolean
    }
  | { type: 'cost-update'; cumulativeUsd: number }
  | {
      type: 'job-failed'
      jobType: 'world-gen' | 'character-creation' | 'post-creation'
      errorCode: string
    }
  | { type: 'stage-reset'; stage: string }
  | { type: 'entity-added'; synthKey: string; entityKind: string; name: string }
  | { type: 'entity-updated'; synthKey: string; patch: Record<string, unknown> }
  | { type: 'entity-removed'; synthKey: string; reason: 'repair_dropped' | 'coherence_removed' }
  | {
      type: 'edge-added'
      synthKey: string
      from: string
      to: string
      relationship: string
    }
  | { type: 'edge-removed'; synthKey: string; reason: 'repair_dropped' | 'coherence_deleted' }
  | { type: 'finalized'; synthKey: string; entityId: string }
```

- [ ] **Step 4: Run test to verify it passes**

```bash
pnpm --filter @mythrun/backend vitest run src/contract/__tests__/pipeline-events.test.ts
pnpm --filter @mythrun/backend typecheck
```

Expected: test PASSES; typecheck likely FAILS now at downstream callsites that still reference `data` / `description` — those are subsequent tasks (15, 17). Note the failing callsites for traceability.

- [ ] **Step 5: Commit**

```bash
git add backend/src/contract/pipeline-events.ts backend/src/contract/__tests__/pipeline-events.test.ts
git commit -m "feat(myth-exac): narrow PipelineEvent contract + world_snapshot_ready phase"
```

---

## Task 3: Register snapshot route in contract files

**Files:**
- Modify: `backend/src/contract/backend-routes.ts`
- Modify: `backend/src/contract/pipeline-routes.ts`
- Modify: `backend/src/__tests__/backend-routes.test.ts` (if it asserts the list)
- Modify: `backend/src/__tests__/app-pipeline-contract.test.ts` (the mock list)

- [ ] **Step 1: Write the failing test**

Edit `backend/src/__tests__/app-pipeline-contract.test.ts` — extend the mock `PIPELINE_ROUTES` array to include the new route:

```ts
vi.mock('../contract/pipeline-routes.js', () => ({
  PIPELINE_ROUTES: [
    'GET /api/campaigns/:campaignId/status',
    'GET /api/campaigns/:campaignId/status/stream',
    'POST /api/campaigns',
    'GET /api/campaigns/:campaignId',
    'GET /api/campaigns/mine',
    'POST /api/campaigns/:campaignId/resume',
    'DELETE /api/campaigns/:campaignId',
    'PATCH /api/campaigns/:campaignId/name',
    'GET /api/campaigns/:campaignId/world-snapshot',  // myth-exac
    'GET /api/phantom-never-registered',
  ],
}))
```

- [ ] **Step 2: Update the contract files**

Edit `backend/src/contract/backend-routes.ts` — add to `BACKEND_ROUTES`:

```ts
// Campaigns (pipeline + non-pipeline)
{ method: 'POST', path: '/api/campaigns' },
{ method: 'GET', path: '/api/campaigns/mine' },
{ method: 'GET', path: '/api/campaigns/:campaignId' },
{ method: 'DELETE', path: '/api/campaigns/:campaignId' },
{ method: 'PATCH', path: '/api/campaigns/:campaignId/name' },
{ method: 'GET', path: '/api/campaigns/:campaignId/world-snapshot' },  // myth-exac
{ method: 'POST', path: '/api/campaigns/:campaignId/resume' },
{ method: 'GET', path: '/api/campaigns/:campaignId/status' },
{ method: 'GET', path: '/api/campaigns/:campaignId/status/stream' },
```

Edit `backend/src/contract/pipeline-routes.ts` — add to `PIPELINE_ROUTES`:

```ts
export const PIPELINE_ROUTES: readonly string[] = [
  'GET /api/campaigns/:campaignId/status',
  'GET /api/campaigns/:campaignId/status/stream',
  'POST /api/campaigns',
  'GET /api/campaigns/:campaignId',
  'GET /api/campaigns/mine',
  'POST /api/campaigns/:campaignId/resume',
  'DELETE /api/campaigns/:campaignId',
  'PATCH /api/campaigns/:campaignId/name',
  'GET /api/campaigns/:campaignId/world-snapshot',  // myth-exac
] as const
```

- [ ] **Step 3: Run test to verify it passes**

```bash
pnpm --filter @mythrun/backend vitest run src/__tests__/app-pipeline-contract.test.ts
```

Expected: PASS (the route still isn't registered in the live app, but the contract test only checks the reverse drift; the forward check fires when the route is added in Task 24).

- [ ] **Step 4: Commit**

```bash
git add backend/src/contract/backend-routes.ts backend/src/contract/pipeline-routes.ts backend/src/__tests__/app-pipeline-contract.test.ts
git commit -m "feat(myth-exac): register GET /world-snapshot in backend + pipeline route contracts"
```

---

## Task 4: facts repo — AccessLevel rename + listByEntities

**Files:**
- Modify: `backend/src/repo/facts.ts`
- Modify: `backend/src/repo/__tests__/facts.test.ts`

- [ ] **Step 1: Write the failing test**

Edit `backend/src/repo/__tests__/facts.test.ts` — find existing `'public'`/`'private'` references; rewrite to `'known'`/`'discoverable'`. Then add new tests:

```ts
describe('facts.listByEntities (myth-exac)', () => {
  it('returns facts for given entity IDs filtered by accessLevels', async () => {
    const pool = await openPool()
    try {
      const scope = makeTestScope('listByEntities')
      const worldId = uuidv7()
      const entityId1 = uuidv7()
      const entityId2 = uuidv7()
      // Seed world + 2 entities
      await pool.query(
        `INSERT INTO worlds (id, name, concept, tone, themes, status)
         VALUES ($1, $2, 'c', 't', 'th', 'generating')`,
        [worldId, scope.worldName(0)],
      )
      for (const id of [entityId1, entityId2]) {
        await pool.query(
          `INSERT INTO entities (id, world_id, entity_type, name, access_level)
           VALUES ($1, $2, 'location', $3, 'known')`,
          [id, worldId, `${scope.id}-e-${id.slice(0, 6)}`],
        )
      }
      // Seed facts at all three tiers
      await facts.insertMany(pool, [
        { entityId: entityId1, topic: 'a', accessLevel: 'known', content: 'k1' },
        { entityId: entityId1, topic: 'b', accessLevel: 'discoverable', content: 'd1' },
        { entityId: entityId2, topic: 'c', accessLevel: 'secret', content: 's2' },
      ])

      const knownOnly = await facts.listByEntities(pool, [entityId1, entityId2], {
        accessLevels: ['known'],
      })
      expect(knownOnly).toHaveLength(1)
      expect(knownOnly[0].content).toBe('k1')

      const all = await facts.listByEntities(pool, [entityId1, entityId2], {
        accessLevels: ['known', 'discoverable', 'secret'],
      })
      expect(all).toHaveLength(3)

      await cleanupTestScope(pool, scope)
    } finally {
      await pool.end()
    }
  })

  it('returns [] for empty entity ID list', async () => {
    const pool = await openPool()
    try {
      const rows = await facts.listByEntities(pool, [], { accessLevels: ['known'] })
      expect(rows).toEqual([])
    } finally {
      await pool.end()
    }
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

```bash
pnpm --filter @mythrun/backend vitest run src/repo/__tests__/facts.test.ts
```

Expected: FAIL — `facts.listByEntities` does not exist; existing `'public'`/`'private'` references in tests will now also fail.

- [ ] **Step 3: Update facts.ts**

Edit `backend/src/repo/facts.ts`:

```ts
import type { Pool, PoolClient } from 'pg'
import { uuidv7 } from './uuidv7.js'

// myth-exac: enum renamed from (public/private/secret) to
// (known/discoverable/secret). See migration 014.
export type AccessLevel = 'known' | 'discoverable' | 'secret'

export type NarrativeStatus = 'undelivered' | 'delivered' | 'developed' | 'resolved'

export interface InsertFactInput {
  readonly entityId: string
  readonly topic: string
  readonly accessLevel: AccessLevel
  readonly content: string
}

export interface FactRow {
  readonly id: string
  readonly entityId: string
  readonly topic: string
  readonly accessLevel: AccessLevel
  readonly narrativeStatus: NarrativeStatus
  readonly content: string
  readonly source: string
  readonly createdAt: Date
  readonly updatedAt: Date
}

interface ClientLike {
  query: Pool['query']
}

export const facts = {
  async insertMany(client: ClientLike, rows: InsertFactInput[]): Promise<void> {
    if (rows.length === 0) return
    const values: string[] = []
    const params: unknown[] = []
    let idx = 0
    for (const row of rows) {
      values.push(
        `($${++idx}, $${++idx}, $${++idx}, $${++idx}, $${++idx}, 'undelivered')`,
      )
      params.push(uuidv7(), row.entityId, row.topic, row.accessLevel, row.content)
    }
    await client.query(
      `INSERT INTO facts (id, entity_id, topic, access_level, content, narrative_status)
       VALUES ${values.join(', ')}`,
      params,
    )
  },

  async updateContentById(client: ClientLike, id: string, content: string): Promise<void> {
    await client.query(
      `UPDATE facts SET content = $2, updated_at = now() WHERE id = $1`,
      [id, content],
    )
  },

  async listByEntities(
    client: ClientLike,
    entityIds: readonly string[],
    opts: { readonly accessLevels: readonly AccessLevel[] },
  ): Promise<readonly FactRow[]> {
    if (entityIds.length === 0) return []
    const { rows } = await client.query<{
      id: string
      entity_id: string
      topic: string
      access_level: AccessLevel
      narrative_status: NarrativeStatus
      content: string
      source: string
      created_at: Date
      updated_at: Date
    }>(
      `SELECT id, entity_id, topic, access_level, narrative_status, content,
              source, created_at, updated_at
       FROM facts
       WHERE entity_id = ANY($1) AND access_level = ANY($2)
       ORDER BY entity_id, id`,
      [entityIds as string[], opts.accessLevels as string[]],
    )
    return rows.map((r) => ({
      id: r.id,
      entityId: r.entity_id,
      topic: r.topic,
      accessLevel: r.access_level,
      narrativeStatus: r.narrative_status,
      content: r.content,
      source: r.source,
      createdAt: r.created_at,
      updatedAt: r.updated_at,
    }))
  },
}
```

- [ ] **Step 4: Run test to verify it passes**

```bash
pnpm --filter @mythrun/backend vitest run src/repo/__tests__/facts.test.ts
```

Expected: PASS. Other tests that reference `'public'`/`'private'` will fail at typecheck — those are downstream tasks.

- [ ] **Step 5: Commit**

```bash
git add backend/src/repo/facts.ts backend/src/repo/__tests__/facts.test.ts
git commit -m "feat(myth-exac): facts.AccessLevel rename + listByEntities"
```

---

## Task 5: entities repo — access_level on insert + listByWorld options

**Files:**
- Modify: `backend/src/repo/entities.ts`
- Modify: `backend/src/repo/__tests__/entities.test.ts`

- [ ] **Step 1: Write the failing test**

Edit `backend/src/repo/__tests__/entities.test.ts` — update existing tests to set `accessLevel: 'known'` in inserts. Then add:

```ts
describe('entities — myth-exac', () => {
  it('insert writes access_level to the new column', async () => {
    const pool = await openPool()
    try {
      const scope = makeTestScope('entities-access')
      const worldId = uuidv7()
      await pool.query(
        `INSERT INTO worlds (id, name, concept, tone, themes, status)
         VALUES ($1, $2, 'c', 't', 'th', 'generating')`,
        [worldId, scope.worldName(0)],
      )
      const entityId = uuidv7()
      await entities.insert(pool, {
        id: entityId,
        worldId,
        entityType: 'location',
        name: `${scope.id}-loc`,
        accessLevel: 'discoverable',
      })
      const { rows } = await pool.query<{ access_level: string }>(
        `SELECT access_level FROM entities WHERE id = $1`,
        [entityId],
      )
      expect(rows[0].access_level).toBe('discoverable')
      await cleanupTestScope(pool, scope)
    } finally {
      await pool.end()
    }
  })

  it('listByWorld filters by accessLevels when provided', async () => {
    const pool = await openPool()
    try {
      const scope = makeTestScope('entities-list-tier')
      const worldId = uuidv7()
      await pool.query(
        `INSERT INTO worlds (id, name, concept, tone, themes, status)
         VALUES ($1, $2, 'c', 't', 'th', 'generating')`,
        [worldId, scope.worldName(0)],
      )
      for (const tier of ['known', 'discoverable', 'secret'] as const) {
        await entities.insert(pool, {
          id: uuidv7(),
          worldId,
          entityType: 'location',
          name: `${scope.id}-${tier}`,
          accessLevel: tier,
        })
      }
      const known = await entities.listByWorld(pool, worldId, { accessLevels: ['known'] })
      expect(known).toHaveLength(1)
      expect(known[0].accessLevel).toBe('known')

      const all = await entities.listByWorld(pool, worldId, {
        accessLevels: ['known', 'discoverable', 'secret'],
      })
      expect(all).toHaveLength(3)

      await cleanupTestScope(pool, scope)
    } finally {
      await pool.end()
    }
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

```bash
pnpm --filter @mythrun/backend vitest run src/repo/__tests__/entities.test.ts
```

Expected: FAIL — `accessLevel` not in `InsertEntityInput`; `listByWorld` doesn't accept opts.

- [ ] **Step 3: Update entities.ts**

Edit `backend/src/repo/entities.ts`:

```ts
import type { Pool, PoolClient } from 'pg'
import type { AccessLevel } from './facts.js'

export type EntityType = 'npc' | 'location' | 'faction' | 'item'

export interface InsertEntityInput {
  readonly id: string
  readonly worldId: string
  readonly entityType: EntityType
  readonly name: string
  readonly accessLevel: AccessLevel  // myth-exac: required at insert
  readonly statBlockId?: string | null
}

export interface EntityRow {
  readonly id: string
  readonly worldId: string
  readonly entityType: EntityType
  readonly name: string
  readonly accessLevel: AccessLevel
  readonly statBlockId: string | null
  readonly encountered: boolean
  readonly modifiedByPlay: boolean
  readonly createdAt: Date
  readonly updatedAt: Date
}

interface ClientLike {
  query: Pool['query']
}

export const entities = {
  async insert(client: ClientLike, input: InsertEntityInput): Promise<void> {
    await client.query(
      `INSERT INTO entities (id, world_id, entity_type, name, access_level, stat_block_id)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [
        input.id,
        input.worldId,
        input.entityType,
        input.name,
        input.accessLevel,
        input.statBlockId ?? null,
      ],
    )
  },

  async listByWorld(
    client: ClientLike,
    worldId: string,
    opts?: { readonly accessLevels?: readonly AccessLevel[] },
  ): Promise<readonly EntityRow[]> {
    const accessLevels = opts?.accessLevels
    const sql = accessLevels
      ? `SELECT id, world_id, entity_type, name, access_level, stat_block_id,
                encountered, modified_by_play, created_at, updated_at
         FROM entities WHERE world_id = $1 AND access_level = ANY($2)
         ORDER BY entity_type, name`
      : `SELECT id, world_id, entity_type, name, access_level, stat_block_id,
                encountered, modified_by_play, created_at, updated_at
         FROM entities WHERE world_id = $1
         ORDER BY entity_type, name`
    const params = accessLevels ? [worldId, accessLevels as string[]] : [worldId]
    const { rows } = await client.query<{
      id: string
      world_id: string
      entity_type: EntityType
      name: string
      access_level: AccessLevel
      stat_block_id: string | null
      encountered: boolean
      modified_by_play: boolean
      created_at: Date
      updated_at: Date
    }>(sql, params)
    return rows.map((r) => ({
      id: r.id,
      worldId: r.world_id,
      entityType: r.entity_type,
      name: r.name,
      accessLevel: r.access_level,
      statBlockId: r.stat_block_id,
      encountered: r.encountered,
      modifiedByPlay: r.modified_by_play,
      createdAt: r.created_at,
      updatedAt: r.updated_at,
    }))
  },
}
```

- [ ] **Step 4: Run test to verify it passes**

```bash
pnpm --filter @mythrun/backend vitest run src/repo/__tests__/entities.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add backend/src/repo/entities.ts backend/src/repo/__tests__/entities.test.ts
git commit -m "feat(myth-exac): entities.insert takes accessLevel; listByWorld opts"
```

---

## Task 6: relationships.listAmong + prose-kernels.listByEntities + entity-hierarchy.listForWorld

**Files:**
- Modify: `backend/src/repo/relationships.ts`
- Modify: `backend/src/repo/prose-kernels.ts`
- Modify: `backend/src/repo/entity-hierarchy.ts`
- Modify: `backend/src/repo/__tests__/relationships.test.ts`
- Modify: `backend/src/repo/__tests__/prose-kernels.test.ts`
- Modify: `backend/src/repo/__tests__/entity-hierarchy.test.ts`

- [ ] **Step 1: Write the failing tests (all three)**

For `relationships.test.ts`, add:

```ts
describe('relationships.listAmong (myth-exac)', () => {
  it('returns only relationships where both endpoints are in the given set', async () => {
    const pool = await openPool()
    try {
      const scope = makeTestScope('rel-listAmong')
      const worldId = uuidv7()
      await pool.query(
        `INSERT INTO worlds (id, name, concept, tone, themes, status)
         VALUES ($1, $2, 'c', 't', 'th', 'generating')`,
        [worldId, scope.worldName(0)],
      )
      const a = uuidv7()
      const b = uuidv7()
      const c = uuidv7()
      for (const id of [a, b, c]) {
        await pool.query(
          `INSERT INTO entities (id, world_id, entity_type, name, access_level)
           VALUES ($1, $2, 'location', $3, 'known')`,
          [id, worldId, `${scope.id}-${id.slice(0, 6)}`],
        )
      }
      await pool.query(
        `INSERT INTO relationships (id, source_entity_id, target_entity_id, relationship_type, description)
         VALUES ($1, $2, $3, 'controls', 'd1'), ($4, $5, $6, 'in', 'd2')`,
        [uuidv7(), a, b, uuidv7(), b, c],
      )
      // Only [a, b] — should return only the a→b row (the b→c row's target is excluded)
      const ab = await relationships.listAmong(pool, [a, b])
      expect(ab).toHaveLength(1)
      expect(ab[0].sourceEntityId).toBe(a)
      expect(ab[0].targetEntityId).toBe(b)

      // [a, b, c] — both rows
      const all = await relationships.listAmong(pool, [a, b, c])
      expect(all).toHaveLength(2)

      // Empty list — no rows
      const none = await relationships.listAmong(pool, [])
      expect(none).toEqual([])

      await cleanupTestScope(pool, scope)
    } finally {
      await pool.end()
    }
  })
})
```

For `prose-kernels.test.ts`, add:

```ts
describe('proseKernels.listByEntities (myth-exac)', () => {
  it('returns kernels for given entity IDs only', async () => {
    const pool = await openPool()
    try {
      const scope = makeTestScope('pk-listByEntities')
      const worldId = uuidv7()
      await pool.query(
        `INSERT INTO worlds (id, name, concept, tone, themes, status)
         VALUES ($1, $2, 'c', 't', 'th', 'generating')`,
        [worldId, scope.worldName(0)],
      )
      const a = uuidv7()
      const b = uuidv7()
      const c = uuidv7()
      for (const id of [a, b, c]) {
        await pool.query(
          `INSERT INTO entities (id, world_id, entity_type, name, access_level)
           VALUES ($1, $2, 'location', $3, 'known')`,
          [id, worldId, `${scope.id}-${id.slice(0, 6)}`],
        )
        await proseKernels.insert(pool, { entityId: id, content: `prose-${id.slice(0, 6)}` })
      }
      const ab = await proseKernels.listByEntities(pool, [a, b])
      expect(ab).toHaveLength(2)
      const ids = ab.map((p) => p.entityId).sort()
      expect(ids).toEqual([a, b].sort())

      await cleanupTestScope(pool, scope)
    } finally {
      await pool.end()
    }
  })
})
```

For `entity-hierarchy.test.ts`, add:

```ts
describe('entityHierarchy.listForWorld (myth-exac)', () => {
  it('returns hierarchy rows scoped to the given world via entity JOIN', async () => {
    const pool = await openPool()
    try {
      const scope = makeTestScope('eh-listForWorld')
      const w1 = uuidv7()
      const w2 = uuidv7()
      for (const w of [w1, w2]) {
        await pool.query(
          `INSERT INTO worlds (id, name, concept, tone, themes, status)
           VALUES ($1, $2, 'c', 't', 'th', 'generating')`,
          [w, `${scope.id}-w-${w.slice(0, 6)}`],
        )
      }
      const e1a = uuidv7()
      const e1b = uuidv7()
      const e2a = uuidv7()
      const e2b = uuidv7()
      for (const [id, wid] of [[e1a, w1], [e1b, w1], [e2a, w2], [e2b, w2]] as const) {
        await pool.query(
          `INSERT INTO entities (id, world_id, entity_type, name, access_level)
           VALUES ($1, $2, 'location', $3, 'known')`,
          [id, wid, `${scope.id}-${id.slice(0, 6)}`],
        )
      }
      await pool.query(
        `INSERT INTO entity_hierarchy (id, parent_entity_id, child_entity_id)
         VALUES ($1, $2, $3), ($4, $5, $6)`,
        [uuidv7(), e1a, e1b, uuidv7(), e2a, e2b],
      )
      const rows = await entityHierarchy.listForWorld(pool, w1)
      expect(rows).toHaveLength(1)
      expect(rows[0].parentEntityId).toBe(e1a)
      expect(rows[0].childEntityId).toBe(e1b)

      await cleanupTestScope(pool, scope)
    } finally {
      await pool.end()
    }
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
pnpm --filter @mythrun/backend vitest run src/repo/__tests__/relationships.test.ts src/repo/__tests__/prose-kernels.test.ts src/repo/__tests__/entity-hierarchy.test.ts
```

Expected: FAIL — methods don't exist.

- [ ] **Step 3: Implement the three methods**

Edit `backend/src/repo/relationships.ts` — add `listAmong`:

```ts
// Add after the existing exports:

export interface RelationshipRow {
  readonly id: string
  readonly sourceEntityId: string
  readonly targetEntityId: string
  readonly relationshipType: string
  readonly description: string
  readonly createdAt: Date
}

interface ClientLike {
  query: Pool['query']
}

// myth-exac: returns rows where BOTH source and target are in entityIds.
// Used by the snapshot endpoint's relationship-projection.
async function listAmong(
  client: ClientLike,
  entityIds: readonly string[],
): Promise<readonly RelationshipRow[]> {
  if (entityIds.length === 0) return []
  const { rows } = await client.query<{
    id: string
    source_entity_id: string
    target_entity_id: string
    relationship_type: string
    description: string
    created_at: Date
  }>(
    `SELECT id, source_entity_id, target_entity_id, relationship_type,
            description, created_at
     FROM relationships
     WHERE source_entity_id = ANY($1) AND target_entity_id = ANY($1)
     ORDER BY id`,
    [entityIds as string[]],
  )
  return rows.map((r) => ({
    id: r.id,
    sourceEntityId: r.source_entity_id,
    targetEntityId: r.target_entity_id,
    relationshipType: r.relationship_type,
    description: r.description,
    createdAt: r.created_at,
  }))
}

// Append to the existing `relationships` export, or extend it:
export const relationships = {
  // ... existing methods
  listAmong,
}
```

Edit `backend/src/repo/prose-kernels.ts` — add `listByEntities`:

```ts
export interface ProseKernelRow {
  readonly id: string
  readonly entityId: string
  readonly content: string
  readonly createdAt: Date
  readonly updatedAt: Date
}

interface ClientLike {
  query: Pool['query']
}

async function listByEntities(
  client: ClientLike,
  entityIds: readonly string[],
): Promise<readonly ProseKernelRow[]> {
  if (entityIds.length === 0) return []
  const { rows } = await client.query<{
    id: string
    entity_id: string
    content: string
    created_at: Date
    updated_at: Date
  }>(
    `SELECT id, entity_id, content, created_at, updated_at
     FROM prose_kernels
     WHERE entity_id = ANY($1)
     ORDER BY entity_id`,
    [entityIds as string[]],
  )
  return rows.map((r) => ({
    id: r.id,
    entityId: r.entity_id,
    content: r.content,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  }))
}

export const proseKernels = {
  // ... existing methods (insert, updateByEntityId)
  listByEntities,
}
```

Edit `backend/src/repo/entity-hierarchy.ts` — add `listForWorld`:

```ts
export interface EntityHierarchyRow {
  readonly id: string
  readonly parentEntityId: string
  readonly childEntityId: string
}

interface ClientLike {
  query: Pool['query']
}

// myth-exac: entity_hierarchy has no world_id column; scope via JOIN to
// the parent entity (parent and child are always in the same world per
// the schema's CASCADE-on-world-delete chain).
async function listForWorld(
  client: ClientLike,
  worldId: string,
): Promise<readonly EntityHierarchyRow[]> {
  const { rows } = await client.query<{
    id: string
    parent_entity_id: string
    child_entity_id: string
  }>(
    `SELECT eh.id, eh.parent_entity_id, eh.child_entity_id
     FROM entity_hierarchy eh
     JOIN entities pe ON pe.id = eh.parent_entity_id
     WHERE pe.world_id = $1
     ORDER BY eh.id`,
    [worldId],
  )
  return rows.map((r) => ({
    id: r.id,
    parentEntityId: r.parent_entity_id,
    childEntityId: r.child_entity_id,
  }))
}

export const entityHierarchy = {
  // ... existing methods (insert)
  listForWorld,
}
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
pnpm --filter @mythrun/backend vitest run src/repo/__tests__/relationships.test.ts src/repo/__tests__/prose-kernels.test.ts src/repo/__tests__/entity-hierarchy.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add backend/src/repo/relationships.ts backend/src/repo/prose-kernels.ts backend/src/repo/entity-hierarchy.ts backend/src/repo/__tests__/relationships.test.ts backend/src/repo/__tests__/prose-kernels.test.ts backend/src/repo/__tests__/entity-hierarchy.test.ts
git commit -m "feat(myth-exac): relationships.listAmong + proseKernels.listByEntities + entityHierarchy.listForWorld"
```

---

## Task 7: stat-blocks repo — new module with listByIds

**Files:**
- Create: `backend/src/repo/stat-blocks.ts`
- Create: `backend/src/repo/__tests__/stat-blocks.test.ts`

- [ ] **Step 1: Write the failing test**

Create `backend/src/repo/__tests__/stat-blocks.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { openPool } from './_helpers/open-pool.js'
import { makeTestScope, cleanupTestScope } from './_helpers/test-scope.js'
import { statBlocks } from '../stat-blocks.js'
import { uuidv7 } from '../uuidv7.js'

describe('statBlocks.listByIds (myth-exac)', () => {
  it('returns stat blocks for the given IDs', async () => {
    const pool = await openPool()
    try {
      const scope = makeTestScope('sb-listByIds')
      const id1 = uuidv7()
      const id2 = uuidv7()
      const id3 = uuidv7()
      for (const id of [id1, id2, id3]) {
        await pool.query(
          `INSERT INTO stat_blocks (id, data) VALUES ($1, $2)`,
          [id, JSON.stringify({ hp: 10, ac: 12 })],
        )
      }
      const rows = await statBlocks.listByIds(pool, [id1, id2])
      expect(rows).toHaveLength(2)

      // Empty list — no query
      const none = await statBlocks.listByIds(pool, [])
      expect(none).toEqual([])

      // Cleanup stat_blocks (no test-scope helper covers them)
      await pool.query(`DELETE FROM stat_blocks WHERE id = ANY($1)`, [[id1, id2, id3]])
      await cleanupTestScope(pool, scope)
    } finally {
      await pool.end()
    }
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

```bash
pnpm --filter @mythrun/backend vitest run src/repo/__tests__/stat-blocks.test.ts
```

Expected: FAIL — module doesn't exist.

- [ ] **Step 3: Create stat-blocks.ts**

Inspect schema first:

```bash
docker compose exec -T postgres psql -U mythrun -d mythrun -c "\d stat_blocks"
```

Note the actual columns. Then create `backend/src/repo/stat-blocks.ts`:

```ts
// backend/src/repo/stat-blocks.ts
//
// myth-exac: new repo module for the snapshot endpoint's statBlocks
// projection. Existing entities reference stat_blocks via stat_block_id
// (nullable). The snapshot endpoint reads only the stat blocks referenced
// by the known-tier entities it returns.

import type { Pool } from 'pg'

export interface StatBlockRow {
  readonly id: string
  readonly data: Record<string, unknown>  // JSONB column
  readonly createdAt: Date
  readonly updatedAt: Date
}

interface ClientLike {
  query: Pool['query']
}

async function listByIds(
  client: ClientLike,
  ids: readonly string[],
): Promise<readonly StatBlockRow[]> {
  if (ids.length === 0) return []
  const { rows } = await client.query<{
    id: string
    data: Record<string, unknown>
    created_at: Date
    updated_at: Date
  }>(
    `SELECT id, data, created_at, updated_at
     FROM stat_blocks
     WHERE id = ANY($1)
     ORDER BY id`,
    [ids as string[]],
  )
  return rows.map((r) => ({
    id: r.id,
    data: r.data,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  }))
}

export const statBlocks = {
  listByIds,
}
```

If the actual schema has different columns (no `created_at`/`updated_at`), adjust the SELECT and the row shape to match — but keep `listByIds` signature stable.

- [ ] **Step 4: Run test to verify it passes**

```bash
pnpm --filter @mythrun/backend vitest run src/repo/__tests__/stat-blocks.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add backend/src/repo/stat-blocks.ts backend/src/repo/__tests__/stat-blocks.test.ts
git commit -m "feat(myth-exac): new stat-blocks repo module with listByIds"
```

---

## Task 8: world-and-factions Zod schema — access_level field-2

**Files:**
- Modify: `backend/src/llm/schemas/world-and-factions.ts`
- Modify: `backend/src/llm/schemas/__tests__/world-and-factions.test.ts`

- [ ] **Step 1: Write the failing test**

Edit `backend/src/llm/schemas/__tests__/world-and-factions.test.ts` (create if missing):

```ts
import { describe, it, expect } from 'vitest'
import { WorldAndFactionsSchema, factSchema } from '../world-and-factions.js'

describe('WorldAndFactionsSchema — myth-exac', () => {
  it('fact rejects old access_level vocabulary', () => {
    expect(() =>
      factSchema.parse({ topic: 'x', content: 'a'.repeat(25), access_level: 'public' }),
    ).toThrow()
    expect(() =>
      factSchema.parse({ topic: 'x', content: 'a'.repeat(25), access_level: 'private' }),
    ).toThrow()
  })

  it('fact accepts new access_level vocabulary', () => {
    for (const tier of ['known', 'discoverable', 'secret']) {
      expect(() =>
        factSchema.parse({ topic: 'x', content: 'a'.repeat(25), access_level: tier }),
      ).not.toThrow()
    }
  })

  it('region requires access_level (no default)', () => {
    const goodRegion = {
      name: 'X',
      access_level: 'known',
      prose: 'a'.repeat(50),
      facts: [
        { topic: 't1', content: 'a'.repeat(25), access_level: 'known' },
        { topic: 't2', content: 'a'.repeat(25), access_level: 'discoverable' },
      ],
    }
    expect(() =>
      WorldAndFactionsSchema.parse({
        world_overview: 'a'.repeat(80),
        regions: [goodRegion, goodRegion, goodRegion],
        factions: [goodRegion, goodRegion, goodRegion],
      }),
    ).not.toThrow()

    // Missing access_level on region — fails
    const { access_level: _, ...regionNoAccess } = goodRegion
    expect(() =>
      WorldAndFactionsSchema.parse({
        world_overview: 'a'.repeat(80),
        regions: [regionNoAccess, goodRegion, goodRegion],
        factions: [goodRegion, goodRegion, goodRegion],
      }),
    ).toThrow()
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

```bash
pnpm --filter @mythrun/backend vitest run src/llm/schemas/__tests__/world-and-factions.test.ts
```

Expected: FAIL — fact accepts old vocabulary; region has no access_level requirement.

- [ ] **Step 3: Update the schema**

Edit `backend/src/llm/schemas/world-and-factions.ts`:

```ts
// backend/src/llm/schemas/world-and-factions.ts
//
// Stage 2 (world_and_factions) Zod schema.
//
// myth-exac: access_level is the SECOND field in every entity object
// (right after `name`), required, no default. This co-locates with the
// streaming-extractor's closed-entry detection: by the time the partial
// stream advances past entry i, name + access_level are guaranteed
// present and the emit gate can apply the tier filter deterministically.
//
// narrative_status is NOT in the fact schema — the persister stamps
// 'undelivered' as a constant at INSERT time.

import { z } from 'zod'

const ACCESS_LEVEL = z.enum(['known', 'discoverable', 'secret'])

export const factSchema = z.object({
  topic: z.string().min(2).max(80),
  content: z.string().min(20).max(800),
  access_level: ACCESS_LEVEL,
})

const regionSchema = z.object({
  // FIELD ORDER MATTERS: name first, access_level second.
  name: z.string().min(1).max(200),
  access_level: ACCESS_LEVEL,
  prose: z.string().min(40).max(2400),
  facts: z.array(factSchema).min(2).max(12),
})

const factionSchema = z.object({
  name: z.string().min(1).max(200),
  access_level: ACCESS_LEVEL,
  prose: z.string().min(40).max(2400),
  facts: z.array(factSchema).min(2).max(12),
})

export const WorldAndFactionsSchema = z.object({
  world_overview: z.string().min(60).max(2400),
  regions: z.array(regionSchema).min(3).max(8),
  factions: z.array(factionSchema).min(3).max(8),
})

export type WorldAndFactionsTree = z.infer<typeof WorldAndFactionsSchema>
```

- [ ] **Step 4: Run test to verify it passes**

```bash
pnpm --filter @mythrun/backend vitest run src/llm/schemas/__tests__/world-and-factions.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add backend/src/llm/schemas/world-and-factions.ts backend/src/llm/schemas/__tests__/world-and-factions.test.ts
git commit -m "feat(myth-exac): WorldAndFactionsSchema — access_level required at field 2 on entities"
```

---

## Task 9: locations-and-npcs Zod schema — same shape

**Files:**
- Modify: `backend/src/llm/schemas/locations-and-npcs.ts`
- Modify: `backend/src/llm/schemas/__tests__/locations-and-npcs.test.ts`

- [ ] **Step 1: Write the failing test**

Add to `backend/src/llm/schemas/__tests__/locations-and-npcs.test.ts`:

```ts
describe('LocationsAndNpcsSchema — myth-exac', () => {
  it('location and npc require access_level at field 2', () => {
    const goodLocation = {
      name: 'X',
      access_level: 'discoverable',
      prose: 'a'.repeat(50),
      facts: [{ topic: 't1', content: 'a'.repeat(25), access_level: 'known' }],
      // ... whatever other fields the existing schema has
    }
    // Use the existing test fixture and update access_level fields throughout.
    // Then assert valid + invalid (missing access_level on location/npc) shapes.
    // Mirror world-and-factions.test.ts pattern.
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

```bash
pnpm --filter @mythrun/backend vitest run src/llm/schemas/__tests__/locations-and-npcs.test.ts
```

Expected: FAIL.

- [ ] **Step 3: Update the schema**

Edit `backend/src/llm/schemas/locations-and-npcs.ts`. Mirror the world-and-factions pattern: import the same `ACCESS_LEVEL` enum (or redeclare locally), put `name` first and `access_level` second on `locationSchema` and `npcSchema`. Update the fact-level enum from `('public','private','secret')` to `('known','discoverable','secret')`.

- [ ] **Step 4: Run test to verify it passes**

```bash
pnpm --filter @mythrun/backend vitest run src/llm/schemas/__tests__/locations-and-npcs.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add backend/src/llm/schemas/locations-and-npcs.ts backend/src/llm/schemas/__tests__/locations-and-npcs.test.ts
git commit -m "feat(myth-exac): LocationsAndNpcsSchema — access_level required at field 2 on entities"
```

---

## Task 10: world-and-factions prompt — three-tier semantic + field-order + prose-tier constraint

**Files:**
- Modify: `backend/src/llm/prompts/prep/world-and-factions.txt`

(Prompt files don't have unit tests in the conventional sense — verification is via E2E smoke + the schemas at Task 8 enforcing shape.)

- [ ] **Step 1: Read the current prompt to find anchor lines**

```bash
grep -n "access_level\|public\|private\|secret\|Mix" backend/src/llm/prompts/prep/world-and-factions.txt
```

Note the line numbers of:
- The existing fact access_level definition block (`~48-50`)
- The "Mix access levels deliberately" instruction (`~54`)
- The "Name field FIRST" structural instruction (`~63-65`)

- [ ] **Step 2: Rewrite the fact access_level block**

Replace the existing block (line ~50) with:

```
- `access_level` — one of `"known"`, `"discoverable"`, or `"secret"`. These mirror how players learn the fact in play:
  - `known` — common knowledge to anyone in the world or relevant locality. The kind of thing a DM tells players for free, no roll required. The name of a famous tavern, the role of a notable public figure, broad strokes of regional history.
  - `discoverable` — findable through investigation but not advertised. Requires a successful skill check (history, investigation, persuasion), a conversation with the right person, or time spent in a location. Not actively concealed — no one is keeping these secret — they just aren't common knowledge.
  - `secret` — load-bearing plot reveals, actively concealed by those who know them. Discovery drives the narrative forward in a meaningful direction. A church's real identity as a cult, a magistrate's embezzlement, a faction's hidden hand behind public events.
```

- [ ] **Step 3: Add the entity-level access_level block**

Insert immediately after the fact block:

```
Each region and faction object ALSO has an `access_level` of `known`, `discoverable`, or `secret` — with the same semantic applied to the entity as a whole:
  - `known` regions/factions are the visible world: known to anyone in-fiction, named in maps and rumor.
  - `discoverable` regions/factions exist but aren't advertised — a hidden grove, a faction operating quietly, found through investigation or asking around.
  - `secret` regions/factions are concealed entirely — a cult faction pulling strings, a lost city — revealed only by plot.

Mix entity access levels too. Most regions and factions should be `known`. AT LEAST ONE region or faction per world should be `discoverable` (something players uncover through play). AT LEAST ONE should be `secret` (a load-bearing reveal). Don't over-stuff the visible world with secrets; depth comes from a few well-placed hidden things, not from making everything mysterious.
```

- [ ] **Step 4: Update the structural instructions block**

Find the existing `Name field FIRST` instruction (~line 63) and replace with:

```
- Name field MUST be the first key in every region and faction object.
- `access_level` MUST be the SECOND key (immediately after `name`). This is a streaming-correctness requirement, not a stylistic one — the system parses entries as they stream, and the access_level is consulted before the prose/facts arrive.
- Fact `access_level` is exactly one of `known`, `discoverable`, `secret`.
- No `narrative_status` field on facts; the system fills that in.
```

- [ ] **Step 5: Add the prose-tier consistency constraint**

Append (at the end of the prompt, before any closing instructions):

```
PROSE-TIER CONSISTENCY (CRITICAL):

Do NOT reveal `discoverable`-tier or `secret`-tier entities, facts, or plot reveals inside `known`-tier prose fields or fact `content`. The prose of a `known` region/faction is the public-knowledge view of that thing — what anyone in the world casually knows. If a `secret` truth about the region exists, it belongs in a `secret`-tier fact on that region, NOT woven into the region's prose. Treat each tier as a separate "what-can-be-said-here" boundary.

Examples:
- BAD: A `known` faction's prose says "The Lighthouse Wardens publicly serve the queen, but secretly worship the drowned god." (The "secretly worship" reveal is plot — it belongs in a `secret` fact, NOT in the prose.)
- GOOD: A `known` faction's prose says "The Lighthouse Wardens serve the queen, tending the great lamps along the coast." A separate `secret` fact on the faction reads: "The Wardens' founders sealed a drowned god into the lamps generations ago, and the eldest priest is the only one who still remembers the rite."
- GOOD: A `discoverable` region's prose can hint at its hidden nature ("rarely visited, named by locals only after the spring tides") because the discoverable tier's narrative status is "findable through asking around" — the prose can carry the asking-around-level detail.
```

- [ ] **Step 6: Commit**

```bash
git add backend/src/llm/prompts/prep/world-and-factions.txt
git commit -m "feat(myth-exac): world-and-factions.txt — three-tier semantic + field-order + prose-tier"
```

---

## Task 11: locations-and-npcs prompt — same updates + cross-stage awareness

**Files:**
- Modify: `backend/src/llm/prompts/prep/locations-and-npcs.txt`

- [ ] **Step 1: Apply the same fact-tier rewrite, entity-tier additions, field-order constraints, and prose-tier consistency constraint as Task 10.**

Find each anchor in `backend/src/llm/prompts/prep/locations-and-npcs.txt` and apply the equivalent changes. Use the same exemplar text from Task 10 but referring to "locations and NPCs" instead of "regions and factions."

- [ ] **Step 2: Add the cross-stage awareness note**

Append (in addition to the prose-tier constraint):

```
CROSS-STAGE AWARENESS:

Stage 2 (world_and_factions) classified the world's regions and factions before you. Your locations and NPCs should COMPLEMENT that classification, not duplicate the secret floor.

- If stage 2 placed a `secret` cult faction in a region, your locations under that region should mix tiers — don't classify every location in a "secret-rich" region as `secret` itself.
- If a region is `known`, its sub-locations can span any tier.
- If a region is `discoverable` or `secret`, MOST of its locations should be at that tier or lower-visibility (revealing them via `known` locations would leak the parent's hiddenness).
- Aim for a coherent overall world distribution, not a per-stage repeat of the floor (mostly-known, a few discoverable, a sprinkling of secret).
```

- [ ] **Step 3: Commit**

```bash
git add backend/src/llm/prompts/prep/locations-and-npcs.txt
git commit -m "feat(myth-exac): locations-and-npcs.txt — tier semantics + field-order + prose-tier + cross-stage"
```

---

## Task 12: streaming-extractor — closed-entry gate + Set + tier filter + post-loop pass + bypass arg

**Files:**
- Modify: `backend/src/llm/prep/streaming-extractor.ts`
- Modify: `backend/src/llm/prep/__tests__/streaming-extractor.test.ts`

- [ ] **Step 1: Write the failing tests**

Replace existing tests + add new in `backend/src/llm/prep/__tests__/streaming-extractor.test.ts`. The full test file:

```ts
import { describe, it, expect, vi } from 'vitest'
import { runStreamingStage } from '../streaming-extractor.js'

interface FakeRedis {
  publish: ReturnType<typeof vi.fn>
}

function makeRedis(): FakeRedis {
  return { publish: vi.fn().mockResolvedValue(1) }
}

const fakeJob = { updateProgress: vi.fn() }

async function* partials(snapshots: unknown[]): AsyncGenerator<unknown> {
  for (const s of snapshots) yield s
}

describe('runStreamingStage — myth-exac closed-entry gate', () => {
  it('emits entity-added exactly once per known-tier entry when next index opens', async () => {
    const redis = makeRedis()
    const stream = partials([
      { regions: [{ name: 'R1' }] },
      { regions: [{ name: 'R1', access_level: 'known' }] },
      { regions: [{ name: 'R1', access_level: 'known', prose: 'p' }] },
      { regions: [{ name: 'R1', access_level: 'known', prose: 'pp', facts: [] }, { name: 'R2' }] },
    ])
    await runStreamingStage(stream, {
      stage: 'world_and_factions',
      campaignId: 'c1',
      job: fakeJob,
      redisRealtime: redis as never,
      keyPrefix: 'test:',
      arrays: [{ path: 'regions', kind: 'location', role: 'entity' }],
      bypassAccessFilter: false,
      endpointTierMap: new Map(),
    })
    // R1 emitted once on closure; R2 emitted once on stream-end via post-loop pass.
    const publishes = redis.publish.mock.calls
    expect(publishes.length).toBeGreaterThanOrEqual(1)
    const events = publishes.map((c) => JSON.parse(c[1] as string))
    const entityAdded = events.filter((e) => e.type === 'entity-added')
    // R1 must appear exactly once; R2 NOT yet (since R2 never received access_level — it stays in the post-loop pass and is skipped or emits depending on whether access_level was set).
    const r1 = entityAdded.filter((e) => e.name === 'R1')
    expect(r1).toHaveLength(1)
    expect(r1[0]).toMatchObject({
      type: 'entity-added',
      entityKind: 'location',
      name: 'R1',
    })
    expect(r1[0].data).toBeUndefined()
  })

  it('skips emission for discoverable-tier entries (silent persist)', async () => {
    const redis = makeRedis()
    const stream = partials([
      {
        regions: [
          { name: 'R1', access_level: 'discoverable', prose: 'p', facts: [] },
          { name: 'R2', access_level: 'known', prose: 'pp', facts: [] },
        ],
      },
    ])
    await runStreamingStage(stream, {
      stage: 'world_and_factions',
      campaignId: 'c1',
      job: fakeJob,
      redisRealtime: redis as never,
      keyPrefix: 'test:',
      arrays: [{ path: 'regions', kind: 'location', role: 'entity' }],
      bypassAccessFilter: false,
      endpointTierMap: new Map(),
    })
    const events = redis.publish.mock.calls.map((c) => JSON.parse(c[1] as string))
    const names = events.filter((e) => e.type === 'entity-added').map((e) => e.name)
    expect(names).toEqual(['R2'])
  })

  it('emits all tiers when bypassAccessFilter is true', async () => {
    const redis = makeRedis()
    const stream = partials([
      {
        regions: [
          { name: 'R1', access_level: 'secret', prose: 'p', facts: [] },
          { name: 'R2', access_level: 'discoverable', prose: 'p', facts: [] },
        ],
      },
    ])
    await runStreamingStage(stream, {
      stage: 'world_and_factions',
      campaignId: 'c1',
      job: fakeJob,
      redisRealtime: redis as never,
      keyPrefix: 'test:',
      arrays: [{ path: 'regions', kind: 'location', role: 'entity' }],
      bypassAccessFilter: true,
      endpointTierMap: new Map(),
    })
    const events = redis.publish.mock.calls.map((c) => JSON.parse(c[1] as string))
    const names = events.filter((e) => e.type === 'entity-added').map((e) => e.name)
    expect(names.sort()).toEqual(['R1', 'R2'])
  })

  it('emits edge only when both endpoints are known-tier', async () => {
    const redis = makeRedis()
    const e1 = 'aaaaaaaa-0000-7000-8000-000000000001'
    const e2 = 'aaaaaaaa-0000-7000-8000-000000000002'
    const e3 = 'aaaaaaaa-0000-7000-8000-000000000003'
    const endpointTierMap = new Map<string, 'known' | 'discoverable' | 'secret'>([
      [e1, 'known'],
      [e2, 'known'],
      [e3, 'secret'],
    ])
    const stream = partials([
      {
        relationships: [
          { from: e1, to: e2, relationship: 'controls' },
          { from: e1, to: e3, relationship: 'fears' },
        ],
      },
    ])
    await runStreamingStage(stream, {
      stage: 'entity_relationships',
      campaignId: 'c1',
      job: fakeJob,
      redisRealtime: redis as never,
      keyPrefix: 'test:',
      arrays: [{ path: 'relationships', kind: 'edge', role: 'edge' }],
      bypassAccessFilter: false,
      endpointTierMap,
    })
    const events = redis.publish.mock.calls.map((c) => JSON.parse(c[1] as string))
    const edges = events.filter((e) => e.type === 'edge-added')
    expect(edges).toHaveLength(1)
    expect(edges[0]).toMatchObject({ from: e1, to: e2, relationship: 'controls' })
    expect(edges[0].description).toBeUndefined()
  })

  it('skips emission and logs when closed entry lacks access_level', async () => {
    const redis = makeRedis()
    const stream = partials([
      { regions: [{ name: 'R1', prose: 'p', facts: [] }, { name: 'R2' }] },
    ])
    await runStreamingStage(stream, {
      stage: 'world_and_factions',
      campaignId: 'c1',
      job: fakeJob,
      redisRealtime: redis as never,
      keyPrefix: 'test:',
      arrays: [{ path: 'regions', kind: 'location', role: 'entity' }],
      bypassAccessFilter: false,
      endpointTierMap: new Map(),
    })
    const events = redis.publish.mock.calls.map((c) => JSON.parse(c[1] as string))
    expect(events.filter((e) => e.type === 'entity-added')).toEqual([])
  })

  it('repeated partials with no new closure do not re-emit', async () => {
    const redis = makeRedis()
    const stream = partials([
      {
        regions: [
          { name: 'R1', access_level: 'known', prose: 'p', facts: [] },
          { name: 'R2' },
        ],
      },
      {
        regions: [
          { name: 'R1', access_level: 'known', prose: 'p', facts: [] },
          { name: 'R2', access_level: 'known' },
        ],
      },
    ])
    await runStreamingStage(stream, {
      stage: 'world_and_factions',
      campaignId: 'c1',
      job: fakeJob,
      redisRealtime: redis as never,
      keyPrefix: 'test:',
      arrays: [{ path: 'regions', kind: 'location', role: 'entity' }],
      bypassAccessFilter: false,
      endpointTierMap: new Map(),
    })
    const events = redis.publish.mock.calls.map((c) => JSON.parse(c[1] as string))
    expect(events.filter((e) => e.type === 'entity-added').map((e) => e.name)).toEqual(['R1'])
    // R2 not emitted yet — closure point hasn't been reached AND post-loop pass skips it because it has access_level but no other fields.
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
pnpm --filter @mythrun/backend vitest run src/llm/prep/__tests__/streaming-extractor.test.ts
```

Expected: FAIL — extractor's signature, behavior, and shape all wrong.

- [ ] **Step 3: Rewrite streaming-extractor.ts**

Replace `backend/src/llm/prep/streaming-extractor.ts` with:

```ts
// backend/src/llm/prep/streaming-extractor.ts
//
// myth-exac rewrite. Reusable streaming entity-extraction loop. Used by
// stages 2, 3, and 4.
//
// Emit gate: closed-entry detection. For each configured array path,
// emits at most one `entity-added` / `edge-added` event per synthKey,
// fired when the LLM has finished writing that entry. Detection:
// non-last entries close when `partial.array.length > i + 1`; the last
// entry of each array closes via the post-loop pass that runs after the
// `for await` exits.
//
// Tier filter: entries (and edges) only emit when access_level === 'known'
// (or bypass is on). Discoverable/secret entries persist silently via
// the stage handler — the wire is what's filtered, not the DB.
//
// Edge endpoint tier check uses `endpointTierMap: Map<entityId,
// AccessLevel>` passed in by the stage handler (stage 4 builds the map
// from its entity inventory query).

import type { Job } from 'bullmq'
import type { Redis } from 'ioredis'
import type { AccessLevel } from '../../repo/facts.js'

export type WorldGenStage =
  | 'concept_intake'
  | 'world_and_factions'
  | 'locations_and_npcs'
  | 'entity_relationships'
  | 'starting_situation'
  | 'random_tables'
  | 'coherence_pass'

export interface ArrayConfig {
  readonly path: string
  readonly kind: string
  readonly role: 'entity' | 'edge'
}

export interface StreamingExtractorConfig {
  readonly stage: WorldGenStage
  readonly campaignId: string
  readonly job: Pick<Job, 'updateProgress'>
  readonly redisRealtime: Pick<Redis, 'publish'>
  readonly keyPrefix: string
  readonly arrays: readonly ArrayConfig[]
  /**
   * myth-exac: bypass the access_level filter for THIS world (set when
   * worlds.dev_bypass_access_filter is true). The wire payload still
   * stays identity-only; bypass only widens which entries emit.
   */
  readonly bypassAccessFilter: boolean
  /**
   * myth-exac (stage 4 only): map of persisted entity UUID → AccessLevel,
   * built by the stage handler from its inventory query. Used by the
   * edge-emit gate to require both endpoints be known-tier.
   * Stages 2 and 3 pass an empty map.
   */
  readonly endpointTierMap: ReadonlyMap<string, AccessLevel>
  readonly logger?: { warn: (msg: string) => void }
}

export interface StreamingExtractorResult<T> {
  readonly finalTree: T
  readonly emittedSynthKeys: ReadonlySet<string>
}

function isAccessLevel(v: unknown): v is AccessLevel {
  return v === 'known' || v === 'discoverable' || v === 'secret'
}

function shouldEmitEntity(
  entry: Record<string, unknown>,
  bypass: boolean,
  logger: { warn: (msg: string) => void } | undefined,
  synthKey: string,
): boolean {
  if (typeof entry.name !== 'string' || entry.name.length === 0) return false
  if (!isAccessLevel(entry.access_level)) {
    logger?.warn(
      `streaming-extractor: closed entry ${synthKey} lacks access_level; skipping emit (Zod will fail stage at validate-time)`,
    )
    return false
  }
  if (bypass) return true
  return entry.access_level === 'known'
}

function shouldEmitEdge(
  entry: Record<string, unknown>,
  bypass: boolean,
  endpointTierMap: ReadonlyMap<string, AccessLevel>,
): boolean {
  const from = entry.from
  const to = entry.to
  const rel = entry.relationship
  if (typeof from !== 'string' || from.length === 0) return false
  if (typeof to !== 'string' || to.length === 0) return false
  if (typeof rel !== 'string' || rel.length === 0) return false
  if (bypass) return true
  const fromTier = endpointTierMap.get(from)
  const toTier = endpointTierMap.get(to)
  return fromTier === 'known' && toTier === 'known'
}

async function publishEntityAdded(
  config: StreamingExtractorConfig,
  synthKey: string,
  arrayCfg: ArrayConfig,
  entry: Record<string, unknown>,
): Promise<void> {
  const channel = `${config.keyPrefix}pipeline:campaign:${config.campaignId}`
  await config.redisRealtime.publish(
    channel,
    JSON.stringify({
      type: 'entity-added',
      synthKey,
      entityKind: arrayCfg.kind,
      name: entry.name as string,
    }),
  )
}

async function publishEdgeAdded(
  config: StreamingExtractorConfig,
  synthKey: string,
  entry: Record<string, unknown>,
): Promise<void> {
  const channel = `${config.keyPrefix}pipeline:campaign:${config.campaignId}`
  await config.redisRealtime.publish(
    channel,
    JSON.stringify({
      type: 'edge-added',
      synthKey,
      from: entry.from as string,
      to: entry.to as string,
      relationship: entry.relationship as string,
    }),
  )
}

async function maybeEmit(
  config: StreamingExtractorConfig,
  arrayCfg: ArrayConfig,
  entry: Record<string, unknown>,
  synthKey: string,
  emitted: Set<string>,
): Promise<void> {
  if (emitted.has(synthKey)) {
    throw new Error(`streaming-extractor: synthKey ${synthKey} already emitted (invariant violation)`)
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

export async function runStreamingStage<T>(
  partialObjectStream: AsyncIterable<T>,
  config: StreamingExtractorConfig,
): Promise<StreamingExtractorResult<T>> {
  const emitted = new Set<string>()
  let finalTree: T | undefined
  let chunkCount = 0
  // Track last in-progress index per array path so the post-loop pass
  // can close the trailing entry on stream-end.
  const lastSeenLength = new Map<string, number>()

  for await (const partial of partialObjectStream) {
    chunkCount += 1
    finalTree = partial
    const tree = partial as unknown as Record<string, unknown>
    for (const arrayCfg of config.arrays) {
      const arr = tree[arrayCfg.path]
      if (!Array.isArray(arr)) continue
      const entries = arr as unknown[]
      lastSeenLength.set(arrayCfg.path, entries.length)
      // Process every index in [0, entries.length - 1) — i.e., every entry
      // BUT the trailing one (still potentially mid-stream). For each,
      // if it isn't emitted yet, attempt to emit.
      for (let i = 0; i < entries.length - 1; i++) {
        const synthKey = `${config.stage}/${arrayCfg.path}/${String(i)}`
        if (emitted.has(synthKey)) continue
        const entry = entries[i]
        if (typeof entry !== 'object' || entry === null) continue
        await maybeEmit(config, arrayCfg, entry as Record<string, unknown>, synthKey, emitted)
      }
    }
    await config.job.updateProgress(chunkCount)
  }

  if (finalTree === undefined) {
    throw new Error('streaming-extractor: partialObjectStream yielded no values')
  }

  // Post-loop pass: the trailing entry of each array has not yet had an
  // `i+1` event to signal closure. Stream-end IS the closure signal for
  // that entry.
  const finalRoot = finalTree as unknown as Record<string, unknown>
  for (const arrayCfg of config.arrays) {
    const arr = finalRoot[arrayCfg.path]
    if (!Array.isArray(arr)) continue
    const entries = arr as unknown[]
    if (entries.length === 0) continue
    const lastIdx = entries.length - 1
    const synthKey = `${config.stage}/${arrayCfg.path}/${String(lastIdx)}`
    if (emitted.has(synthKey)) continue
    const entry = entries[lastIdx]
    if (typeof entry !== 'object' || entry === null) continue
    await maybeEmit(config, arrayCfg, entry as Record<string, unknown>, synthKey, emitted)
  }

  return { finalTree, emittedSynthKeys: emitted }
}
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
pnpm --filter @mythrun/backend vitest run src/llm/prep/__tests__/streaming-extractor.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add backend/src/llm/prep/streaming-extractor.ts backend/src/llm/prep/__tests__/streaming-extractor.test.ts
git commit -m "feat(myth-exac): streaming-extractor — closed-entry gate + tier filter + post-loop pass"
```

---

## Task 13: world-and-factions stage — tier-aware persist + finalized filter + bypass arg

**Files:**
- Modify: `backend/src/llm/prep/stages/world-and-factions.ts`
- Modify: `backend/src/llm/prep/stages/__tests__/world-and-factions.test.ts`

- [ ] **Step 1: Write the failing test**

Edit `backend/src/llm/prep/stages/__tests__/world-and-factions.test.ts`. Add tests:

```ts
describe('runWorldAndFactionsStage — myth-exac', () => {
  it('persists access_level on entities + facts', async () => {
    // Mock the Opus streamObject + repair chain to return a fixed tree
    // with mixed-tier regions. After the stage runs, assert each entity
    // row has the access_level the LLM emitted.
    // (Use the existing test scaffolding from this file as a template.)
  })

  it('finalizedEvents excludes non-known-tier entities (when bypass off)', async () => {
    // Stage returns 3 regions (known, discoverable, secret).
    // Assert StageDispatchResult.finalizedEvents contains only 1 entry
    // (the known-tier region) plus the corresponding `finalized` event arm.
  })

  it('finalizedEvents includes all entities when bypass on', async () => {
    // Same fixture but pass bypassAccessFilter: true to runStage args.
    // Assert all 3 region finalized events fire.
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

```bash
pnpm --filter @mythrun/backend vitest run src/llm/prep/stages/__tests__/world-and-factions.test.ts
```

Expected: FAIL — stage doesn't pass tier through, doesn't filter finalizedEvents.

- [ ] **Step 3: Update world-and-factions.ts stage handler**

Edit `backend/src/llm/prep/stages/world-and-factions.ts`:

1. `RunWorldAndFactionsArgs` gains `readonly bypassAccessFilter: boolean`.
2. `streamObject` call's downstream `runStreamingStage` call passes `bypassAccessFilter: args.bypassAccessFilter, endpointTierMap: new Map()`.
3. `persistEntities` arg shape gains `accessLevel: item.access_level` threaded into the `entities.insert` call:
   ```ts
   await entities.insert(args.client, {
     id: entityId,
     worldId: args.worldId,
     entityType: args.entityType,
     name: item.name,
     accessLevel: item.access_level,  // myth-exac
   })
   ```
4. The `FinalizedRow` push gains a tier check — push only when the entity is `known`-tier OR bypass is true:
   ```ts
   if (args.bypassAccessFilter || item.access_level === 'known') {
     args.out.push({
       synthKey: `world_and_factions/${args.synthArrayPath}/${String(i)}`,
       entityId,
     })
   }
   ```
5. `persistEntities` argshape gains `bypassAccessFilter: boolean`; thread it through from `persistTree`.

- [ ] **Step 4: Run test to verify it passes**

```bash
pnpm --filter @mythrun/backend vitest run src/llm/prep/stages/__tests__/world-and-factions.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add backend/src/llm/prep/stages/world-and-factions.ts backend/src/llm/prep/stages/__tests__/world-and-factions.test.ts
git commit -m "feat(myth-exac): world-and-factions stage — tier-aware persist + finalized filter"
```

---

## Task 14: locations-and-npcs stage — same pattern

**Files:**
- Modify: `backend/src/llm/prep/stages/locations-and-npcs.ts`
- Modify: `backend/src/llm/prep/stages/__tests__/locations-and-npcs.test.ts`

Apply the same pattern as Task 13:
1. Add `bypassAccessFilter` to args.
2. Thread it into `runStreamingStage`.
3. Read `access_level` from each LLM entry and pass into `entities.insert`.
4. Filter `finalizedEvents` to known-tier (or bypass).

Pattern follows Task 13 verbatim. Steps 1-5 mirror Task 13.

- [ ] **Step 1-5**: TDD cycle as in Task 13.

- [ ] **Commit:**

```bash
git add backend/src/llm/prep/stages/locations-and-npcs.ts backend/src/llm/prep/stages/__tests__/locations-and-npcs.test.ts
git commit -m "feat(myth-exac): locations-and-npcs stage — tier-aware persist + finalized filter"
```

---

## Task 15: entity-relationships stage — build endpointTierMap + filter

**Files:**
- Modify: `backend/src/llm/prep/stages/entity-relationships.ts`
- Modify: `backend/src/llm/prep/stages/__tests__/entity-relationships.test.ts`

- [ ] **Step 1: Write the failing test**

Add to the test file:

```ts
describe('runEntityRelationshipsStage — myth-exac endpoint filter', () => {
  it('builds endpointTierMap from the world inventory and threads it through', async () => {
    // Seed entities at mixed tiers. Mock the LLM to return relationships
    // between known-known, known-secret, secret-secret pairs.
    // Assert only known-known relationship's edge-added event publishes.
    // Assert only known-known finalized event fires.
  })

  it('passes bypassAccessFilter through to the streaming-extractor', async () => {
    // Same fixture, bypass on. Assert all 3 relationships' events publish.
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

```bash
pnpm --filter @mythrun/backend vitest run src/llm/prep/stages/__tests__/entity-relationships.test.ts
```

Expected: FAIL.

- [ ] **Step 3: Update entity-relationships.ts**

Edit `backend/src/llm/prep/stages/entity-relationships.ts`:

1. Add `bypassAccessFilter: boolean` to `RunEntityRelationshipsArgs`.
2. Right after the existing inventory query, build the tier map:
   ```ts
   const inventory = await entities.listByWorld(args.client, args.worldId)
   const endpointTierMap = new Map<string, AccessLevel>(
     inventory.map((e) => [e.id, e.accessLevel]),
   )
   ```
3. Pass `bypassAccessFilter: args.bypassAccessFilter, endpointTierMap` to `runStreamingStage`.
4. When persisting relationships, filter the `finalizedEvents` for relationship rows to only those where both endpoints are known-tier (or bypass on):
   ```ts
   const shouldFinalize =
     args.bypassAccessFilter ||
     (endpointTierMap.get(rel.from) === 'known' && endpointTierMap.get(rel.to) === 'known')
   if (shouldFinalize) {
     finalized.push({ synthKey, entityId: relationshipId })
   }
   ```

- [ ] **Step 4: Run test to verify it passes**

```bash
pnpm --filter @mythrun/backend vitest run src/llm/prep/stages/__tests__/entity-relationships.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add backend/src/llm/prep/stages/entity-relationships.ts backend/src/llm/prep/stages/__tests__/entity-relationships.test.ts
git commit -m "feat(myth-exac): entity-relationships stage — endpoint tier filter + bypass"
```

---

## Task 16: coherence-pass — load access_level + render in dump + emit filter

**Files:**
- Modify: `backend/src/llm/prep/stages/coherence-pass.ts`
- Modify: `backend/src/llm/prep/stages/__tests__/coherence-pass.test.ts`
- Modify: `backend/src/llm/prompts/prep/coherence-pass.txt` (add prose-tier consistency note)

- [ ] **Step 1: Write the failing tests**

Add to the test file:

```ts
describe('runCoherencePassStage — myth-exac tier filter', () => {
  it('emits entity-updated for known-tier patches only (when bypass off)', async () => {
    // Mock the LLM to return 3 patches: edit_prose on a known entity,
    // edit_prose on a secret entity, rename_entity on a discoverable entity.
    // Assert finalizedEvents contains entity-updated only for the known patch.
    // DB writes still happen for all 3.
  })

  it('emits all patches as events when bypass on', async () => {
    // Same fixture, bypass on. Assert all 3 events fire.
  })

  it('renders access_level into the world dump', async () => {
    // Spy on the prompt sent to the LLM. Assert it contains
    // `[access_level: known]`, `[access_level: discoverable]`,
    // `[access_level: secret]` per entity.
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

```bash
pnpm --filter @mythrun/backend vitest run src/llm/prep/stages/__tests__/coherence-pass.test.ts
```

Expected: FAIL.

- [ ] **Step 3: Update coherence-pass.ts**

Edit `backend/src/llm/prep/stages/coherence-pass.ts`:

1. Extend `loadWorldInventory` to SELECT `access_level` from entities:
   ```ts
   `SELECT id, name, entity_type, access_level FROM entities WHERE world_id = $1`
   ```
   Add `access_level` to the row type + `entitiesById` map value.
2. Update `renderWorldDump` to include `[access_level: known]` (or the entity's actual tier) in each entity's rendered line.
3. Add `bypassAccessFilter: boolean` to `CoherencePassArgs`.
4. At each emit site (`applyEditEntityProse`, `applyRenameEntity`, `applyFixRelationship`, `applyDeleteRelationship`), before pushing the event into `finalizedEvents`, check the patched entity's access_level:
   ```ts
   const entity = inventory.entitiesById.get(patch.entityId)
   const shouldEmit = args.bypassAccessFilter || entity?.access_level === 'known'
   if (shouldEmit) {
     events.push({ ... })  // existing event push
   }
   // DB write happens regardless (move it outside the `if` if it's currently inside).
   ```
5. Edge emit sites: check BOTH endpoints' tiers.

Also edit `backend/src/llm/prompts/prep/coherence-pass.txt` — append the prose-tier consistency constraint (same text as Task 10's prose-tier section).

- [ ] **Step 4: Run test to verify it passes**

```bash
pnpm --filter @mythrun/backend vitest run src/llm/prep/stages/__tests__/coherence-pass.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add backend/src/llm/prep/stages/coherence-pass.ts backend/src/llm/prep/stages/__tests__/coherence-pass.test.ts backend/src/llm/prompts/prep/coherence-pass.txt
git commit -m "feat(myth-exac): coherence-pass — load access_level, render in dump, filter emits"
```

---

## Task 17: derivePhase — return world_snapshot_ready

**Files:**
- Modify: `backend/src/sse/derive-phase.ts`
- Modify: `backend/src/sse/__tests__/derive-phase.test.ts`

- [ ] **Step 1: Write the failing test**

Add to `backend/src/sse/__tests__/derive-phase.test.ts`:

```ts
describe('derivePhase — myth-exac world_snapshot_ready', () => {
  it('returns world_snapshot_ready when entity_relationships is completed and status is generating', () => {
    const phase = derivePhase({
      worldStatus: 'generating',
      pipelineRuns: [
        { stage: 'concept_intake', status: 'completed' },
        { stage: 'world_and_factions', status: 'completed' },
        { stage: 'locations_and_npcs', status: 'completed' },
        { stage: 'entity_relationships', status: 'completed' },
        { stage: 'starting_situation', status: 'in_progress' },
      ],
    })
    expect(phase).toBe('world_snapshot_ready')
  })

  it('still returns world_gen when entity_relationships is not completed', () => {
    const phase = derivePhase({
      worldStatus: 'generating',
      pipelineRuns: [
        { stage: 'entity_relationships', status: 'in_progress' },
      ],
    })
    expect(phase).toBe('world_gen')
  })

  it('returns world_ready when worldStatus is world_ready (unchanged semantic)', () => {
    const phase = derivePhase({
      worldStatus: 'world_ready',
      pipelineRuns: [
        { stage: 'entity_relationships', status: 'completed' },
        { stage: 'coherence_pass', status: 'completed' },
      ],
    })
    expect(phase).toBe('world_ready')
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

```bash
pnpm --filter @mythrun/backend vitest run src/sse/__tests__/derive-phase.test.ts
```

Expected: FAIL.

- [ ] **Step 3: Update derivePhase**

Open `backend/src/sse/derive-phase.ts` and find the phase-derivation logic. Add the new arm:

```ts
// myth-exac: after stage 4 commits, but before stage 7 finishes, the world
// is in "snapshot fetchable" state. derivePhase reports this to clients
// that subscribe mid-window (since the live world_snapshot_ready event
// fires once and Redis pub/sub doesn't persist).
const entityRels = pipelineRuns.find((r) => r.stage === 'entity_relationships')
if (worldStatus === 'generating' && entityRels?.status === 'completed') {
  return 'world_snapshot_ready'
}
```

Insert this BEFORE the existing `world_gen` fall-through so it takes precedence when matched.

- [ ] **Step 4: Run test to verify it passes**

```bash
pnpm --filter @mythrun/backend vitest run src/sse/__tests__/derive-phase.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add backend/src/sse/derive-phase.ts backend/src/sse/__tests__/derive-phase.test.ts
git commit -m "feat(myth-exac): derivePhase returns world_snapshot_ready for stage-4-done-but-7-pending"
```

---

## Task 18: world-gen-processor — emit world_snapshot_ready post-stage-4

**Files:**
- Modify: `backend/src/llm/prep/world-gen-processor.ts`
- Modify: `backend/src/llm/prep/__tests__/world-gen-processor.test.ts`

- [ ] **Step 1: Write the failing test**

Add to the test file:

```ts
describe('worldGenProcessor — myth-exac phase emission', () => {
  it('publishes phase: world_snapshot_ready after stage 4 commits', async () => {
    // Set up: mock stages 1-3 to succeed quickly. Mock stage 4 to commit
    // its transaction. Inspect redis.publish calls for a phase event.
    const phaseEvents = redis.publish.mock.calls
      .map((c) => JSON.parse(c[1] as string))
      .filter((e) => e.type === 'phase')
    expect(phaseEvents).toContainEqual({ type: 'phase', phase: 'world_snapshot_ready' })
  })

  it('publishes phase: world_ready after stage 7 commits (unchanged semantic)', async () => {
    // Existing test, asserted to still pass.
  })

  it('re-publishes phase: world_snapshot_ready on idempotent re-run', async () => {
    // Mock the processor to enter the loop with stage 4 already completed
    // (atomicClaimStage returns 'skipped'). Assert phase event still fires.
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

```bash
pnpm --filter @mythrun/backend vitest run src/llm/prep/__tests__/world-gen-processor.test.ts
```

Expected: FAIL.

- [ ] **Step 3: Update world-gen-processor.ts**

Find the stage-4 (entity_relationships) commit point. Immediately after a successful commit, publish the phase event:

```ts
// myth-exac: after entity_relationships completes, the snapshot is
// fetchable. Publish the phase event so connected clients know to fetch.
// Also publish on idempotent re-runs (claim === 'skipped') so reconnecting
// clients see the correct phase.
if (stage === 'entity_relationships' && (claim === 'claimed' || claim === 'skipped')) {
  await redisRealtime.publish(
    `${keyPrefix}pipeline:campaign:${campaignId}`,
    JSON.stringify({ type: 'phase', phase: 'world_snapshot_ready' }),
  )
}
```

Pair this with: thread `bypassAccessFilter` from the world row (read at job entry) into every stage's args. Add a `getById` for worlds at the top of the processor, read `dev_bypass_access_filter`, and pass it through.

- [ ] **Step 4: Run test to verify it passes**

```bash
pnpm --filter @mythrun/backend vitest run src/llm/prep/__tests__/world-gen-processor.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add backend/src/llm/prep/world-gen-processor.ts backend/src/llm/prep/__tests__/world-gen-processor.test.ts
git commit -m "feat(myth-exac): world-gen-processor emits world_snapshot_ready + threads bypass through stages"
```

---

## Task 19: WorldSummary + response Zod schemas + world-snapshot-view repo

**Files:**
- Create: `backend/src/repo/world-snapshot-view.ts`
- Create: `backend/src/repo/__tests__/world-snapshot-view.test.ts`
- Modify: `backend/src/routes/world-snapshot-schemas.ts` (new file co-located with route additions)

- [ ] **Step 1: Write the failing test**

Create `backend/src/repo/__tests__/world-snapshot-view.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { openPool } from './_helpers/open-pool.js'
import { makeTestScope, cleanupTestScope } from './_helpers/test-scope.js'
import { worldSnapshotView } from '../world-snapshot-view.js'
import { entities } from '../entities.js'
import { facts } from '../facts.js'
import { proseKernels } from '../prose-kernels.js'
import { uuidv7 } from '../uuidv7.js'

describe('worldSnapshotView.fetch — myth-exac', () => {
  it('returns only known-tier entities + their facts + relationships among them', async () => {
    const pool = await openPool()
    try {
      const scope = makeTestScope('snapshot-view')
      const worldId = uuidv7()
      await pool.query(
        `INSERT INTO worlds (id, name, concept, tone, themes, status, dev_bypass_access_filter)
         VALUES ($1, $2, 'c', 't', 'th', 'generating', false)`,
        [worldId, scope.worldName(0)],
      )
      const known1 = uuidv7()
      const known2 = uuidv7()
      const discoverable = uuidv7()
      await entities.insert(pool, {
        id: known1,
        worldId,
        entityType: 'location',
        name: `${scope.id}-k1`,
        accessLevel: 'known',
      })
      await entities.insert(pool, {
        id: known2,
        worldId,
        entityType: 'faction',
        name: `${scope.id}-k2`,
        accessLevel: 'known',
      })
      await entities.insert(pool, {
        id: discoverable,
        worldId,
        entityType: 'npc',
        name: `${scope.id}-d`,
        accessLevel: 'discoverable',
      })
      await facts.insertMany(pool, [
        { entityId: known1, topic: 'a', accessLevel: 'known', content: 'k1-public' },
        { entityId: known1, topic: 'b', accessLevel: 'secret', content: 'k1-hidden' },
        { entityId: discoverable, topic: 'c', accessLevel: 'known', content: 'd-public' },
      ])
      await proseKernels.insert(pool, { entityId: known1, content: 'prose-k1' })
      await proseKernels.insert(pool, { entityId: known2, content: 'prose-k2' })
      await proseKernels.insert(pool, { entityId: discoverable, content: 'prose-d' })
      await pool.query(
        `INSERT INTO relationships (id, source_entity_id, target_entity_id, relationship_type, description)
         VALUES ($1, $2, $3, 'controls', 'd1'), ($4, $5, $6, 'knows', 'd2')`,
        [uuidv7(), known1, known2, uuidv7(), known1, discoverable],
      )

      const snapshot = await worldSnapshotView.fetch(pool, worldId, { bypass: false })

      // World summary (allowlist only — see §"WorldSummary column allowlist")
      expect(snapshot.world.id).toBe(worldId)
      expect(snapshot.world.name).toBe(scope.worldName(0))
      // PROVE the leak-prone columns are absent
      expect('starting_situations' in snapshot.world).toBe(false)
      expect('key_tensions' in snapshot.world).toBe(false)
      expect('political_summary' in snapshot.world).toBe(false)
      expect('dev_bypass_access_filter' in snapshot.world).toBe(false)

      // Only known-tier entities
      expect(snapshot.entities).toHaveLength(2)
      const entityIds = snapshot.entities.map((e) => e.id).sort()
      expect(entityIds).toEqual([known1, known2].sort())

      // Only known-tier facts of those entities
      expect(snapshot.facts).toHaveLength(1)
      expect(snapshot.facts[0].content).toBe('k1-public')

      // Only the known→known relationship
      expect(snapshot.relationships).toHaveLength(1)
      expect(snapshot.relationships[0].sourceEntityId).toBe(known1)
      expect(snapshot.relationships[0].targetEntityId).toBe(known2)

      // Prose kernels for known entities only
      expect(snapshot.proseKernels).toHaveLength(2)

      await cleanupTestScope(pool, scope)
    } finally {
      await pool.end()
    }
  })

  it('returns ALL tiers when bypass is true', async () => {
    // Same fixture; pass { bypass: true }. Assert all 3 entities, all 3 facts,
    // all 2 relationships are returned. starting_situations is STILL omitted
    // from world (the dev inspector defers stage-5 reveal — see spec §
    // "Dev-mode access tier bypass" subsection on WorldSummary widening).
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

```bash
pnpm --filter @mythrun/backend vitest run src/repo/__tests__/world-snapshot-view.test.ts
```

Expected: FAIL — module doesn't exist.

- [ ] **Step 3: Create world-snapshot-view.ts**

Create `backend/src/repo/world-snapshot-view.ts`:

```ts
// backend/src/repo/world-snapshot-view.ts
//
// myth-exac: runtime snapshot composition for the world-snapshot endpoint.
// Distinct from the prototype-era `world_snapshots` table (labeled save
// games — different data, different file: `world-snapshots.ts` if/when
// that's wired). This module is named `world-snapshot-view` to avoid
// grep collision.
//
// Composes 7 queries in a single Promise.all round. Tier filter applied
// in the entities + facts queries; relationship endpoints are filtered
// post-query (one trip, no JOIN). Hierarchy filtered post-query to pairs
// both-in-known-set.

import type { Pool } from 'pg'
import type { AccessLevel } from './facts.js'
import { entities, type EntityRow } from './entities.js'
import { facts, type FactRow } from './facts.js'
import { proseKernels, type ProseKernelRow } from './prose-kernels.js'
import { relationships, type RelationshipRow } from './relationships.js'
import { entityHierarchy, type EntityHierarchyRow } from './entity-hierarchy.js'
import { statBlocks, type StatBlockRow } from './stat-blocks.js'

export interface WorldSummary {
  readonly id: string
  readonly name: string
  readonly concept: string
  readonly tone: string
  readonly themes: string
  readonly era: string | null
}

export interface WorldSnapshot {
  readonly world: WorldSummary
  readonly entities: readonly EntityRow[]
  readonly facts: readonly FactRow[]
  readonly relationships: readonly RelationshipRow[]
  readonly proseKernels: readonly ProseKernelRow[]
  readonly entityHierarchy: readonly EntityHierarchyRow[]
  readonly statBlocks: readonly StatBlockRow[]
}

interface ClientLike {
  query: Pool['query']
}

async function fetch(
  client: ClientLike,
  worldId: string,
  opts: { readonly bypass: boolean },
): Promise<WorldSnapshot> {
  const accessLevels: readonly AccessLevel[] = opts.bypass
    ? ['known', 'discoverable', 'secret']
    : ['known']

  // 1. World allowlist projection (NEVER spread the row).
  const { rows: worldRows } = await client.query<{
    id: string
    name: string
    concept: string
    tone: string
    themes: string
    era: string | null
  }>(
    `SELECT id, name, concept, tone, themes, era FROM worlds WHERE id = $1`,
    [worldId],
  )
  if (worldRows.length === 0) {
    throw new Error(`world-snapshot-view: world ${worldId} not found`)
  }
  const world: WorldSummary = worldRows[0]

  // 2. Tier-filtered entities.
  const entityRows = await entities.listByWorld(client, worldId, { accessLevels })
  const entityIds = entityRows.map((e) => e.id)
  const entityIdSet = new Set(entityIds)

  // 3+4+5+6. In parallel: facts, prose, hierarchy, stat blocks.
  const statBlockIds = entityRows
    .map((e) => e.statBlockId)
    .filter((v): v is string => v !== null)
  const [factRows, proseRows, hierarchyRows, statBlockRows] = await Promise.all([
    facts.listByEntities(client, entityIds, { accessLevels }),
    proseKernels.listByEntities(client, entityIds),
    entityHierarchy.listForWorld(client, worldId),
    statBlocks.listByIds(client, statBlockIds),
  ])

  // 7. Relationships among entities (single-trip).
  const relRows = await relationships.listAmong(client, entityIds)

  // Hierarchy filter: only pairs where BOTH ends are in the known set.
  const hierarchyFiltered = hierarchyRows.filter(
    (h) => entityIdSet.has(h.parentEntityId) && entityIdSet.has(h.childEntityId),
  )

  return {
    world,
    entities: entityRows,
    facts: factRows,
    relationships: relRows,
    proseKernels: proseRows,
    entityHierarchy: hierarchyFiltered,
    statBlocks: statBlockRows,
  }
}

export const worldSnapshotView = {
  fetch,
}
```

- [ ] **Step 4: Run test to verify it passes**

```bash
pnpm --filter @mythrun/backend vitest run src/repo/__tests__/world-snapshot-view.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add backend/src/repo/world-snapshot-view.ts backend/src/repo/__tests__/world-snapshot-view.test.ts
git commit -m "feat(myth-exac): world-snapshot-view repo composition + WorldSummary allowlist"
```

---

## Task 20: GET /world-snapshot route handler

**Files:**
- Modify: `backend/src/routes/campaigns.ts`
- Modify: `backend/src/routes/__tests__/campaigns-snapshot.test.ts` (new test file)

- [ ] **Step 1: Write the failing test**

Create `backend/src/routes/__tests__/campaigns-snapshot.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { buildTestApp } from './_helpers/test-app.js'  // existing helper
import { makeTestScope, cleanupTestScope } from '../../repo/__tests__/_helpers/test-scope.js'
import { uuidv7 } from '../../repo/uuidv7.js'

describe('GET /api/campaigns/:campaignId/world-snapshot — myth-exac', () => {
  it('returns 409 snapshot_not_ready before stage 4 completes', async () => {
    const { app, pool } = await buildTestApp()
    try {
      const scope = makeTestScope('snap-not-ready')
      // Seed campaign + world without stage 4 completed
      // ... (use existing seed-campaign helper)
      const res = await app.inject({
        method: 'GET',
        url: `/api/campaigns/${campaignId}/world-snapshot`,
        headers: { 'x-mythrun-dev-sub': 'dev-user-1' },
      })
      expect(res.statusCode).toBe(409)
      expect(res.json()).toEqual({ code: 'snapshot_not_ready' })
      await cleanupTestScope(pool, scope)
    } finally {
      await app.close()
    }
  })

  it('returns 200 with known-tier projection when stage 4 is completed', async () => {
    // Seed campaign + world + entities (mixed tiers) + pipeline_run for
    // entity_relationships at status='completed'. Inject the request.
    // Assert response shape (entities only known; facts only known;
    // relationships only known→known; world allowlist only).
  })

  it('returns 403 not_campaign_owner for non-owner member', async () => {
    // ...
  })

  it('returns 403 not_campaign_member for stranger', async () => {
    // ...
  })

  it('returns unfiltered content when world.dev_bypass_access_filter AND requester is bypass-auth', async () => {
    // Seed dev_bypass_access_filter=true. Request as dev-user-1 (bypass).
    // Assert response contains secret-tier entity + facts.
  })

  it('returns filtered content even when world.dev_bypass_access_filter is true but requester is NOT bypass-auth', async () => {
    // Inject buildApp with mode: 'jwt'. Seed dev_bypass_access_filter=true.
    // Assert only known-tier content returned (defense-in-depth).
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

```bash
pnpm --filter @mythrun/backend vitest run src/routes/__tests__/campaigns-snapshot.test.ts
```

Expected: FAIL — route doesn't exist.

- [ ] **Step 3: Add the route**

Edit `backend/src/routes/campaigns.ts`. Find a natural insertion point near the existing `GET /api/campaigns/:campaignId` handler and add:

```ts
// -------------------------------------------------------------------------
// GET /api/campaigns/:campaignId/world-snapshot (myth-exac)
//
// Returns the known-tier slice of a world's persisted content for the
// dev-tool wiki inspector. Owner-only; 409 until stage 4 (entity_relationships)
// completes. Dev-mode bypass widens the projection when the requester is
// also in bypass-auth (defense-in-depth: a dev-created world's secrets
// don't leak via a prod-auth-user request).
// -------------------------------------------------------------------------

app.get<{ Params: Params }>(
  '/api/campaigns/:campaignId/world-snapshot',
  {
    config: {
      rateLimit: { max: 30, timeWindow: '1 minute' },
      pipelineRoute: true,
    },
    preHandler: requireCampaignMember(repo, 'owner'),
  },
  async (request, reply) => {
    const campaign = await repo.campaigns.getById(request.params.campaignId)
    if (!campaign) return reply.code(404).send({ code: 'campaign_not_found' })

    // Pre-readiness gate: entity_relationships pipeline_run must be completed.
    const ready = await repo.pipelineRuns.isStageCompleted(
      campaign.worldId,
      'entity_relationships',
    )
    if (!ready) return reply.code(409).send({ code: 'snapshot_not_ready' })

    const world = await repo.worlds.getById(campaign.worldId)
    if (!world) return reply.code(404).send({ code: 'world_not_found' })

    // myth-exac: bypass requires BOTH the world flag AND the requester being
    // in bypass-auth (defense-in-depth). request.user is AuthUser; bypass
    // identity carries `scopes: ['bypass']` — no `authMode` field exists.
    const bypass =
      world.dev_bypass_access_filter && request.user.scopes.includes('bypass')

    const snapshot = await repo.worldSnapshotView.fetch(opts.pool, campaign.worldId, {
      bypass,
    })
    return reply.send(snapshot)
  },
)
```

Wire `repo.worldSnapshotView` and `repo.pipelineRuns.isStageCompleted` in the repo index if not already present.

`isStageCompleted` query:
```ts
async isStageCompleted(worldId: string, stage: PipelineStage): Promise<boolean> {
  const { rows } = await pool.query(
    `SELECT 1 FROM pipeline_runs
     WHERE world_id = $1 AND stage = $2 AND status = 'completed'
     LIMIT 1`,
    [worldId, stage],
  )
  return rows.length > 0
}
```

- [ ] **Step 4: Run test to verify it passes**

```bash
pnpm --filter @mythrun/backend vitest run src/routes/__tests__/campaigns-snapshot.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add backend/src/routes/campaigns.ts backend/src/routes/__tests__/campaigns-snapshot.test.ts backend/src/repo/pipeline-runs.ts backend/src/repo/index.ts
git commit -m "feat(myth-exac): GET /world-snapshot route — owner-only, 409 gate, bypass detection"
```

---

## Task 21: POST /api/campaigns devBypassAccessFilter body field + gate + persist + audit

**Files:**
- Modify: `backend/src/routes/campaigns.ts`
- Modify: `backend/src/routes/__tests__/campaigns-create.test.ts`

- [ ] **Step 1: Write the failing tests**

Add to `backend/src/routes/__tests__/campaigns-create.test.ts`:

```ts
describe('POST /api/campaigns devBypassAccessFilter — myth-exac', () => {
  it('201 with devBypassAccessFilter:true under bypass-auth + dev env', async () => {
    // Build app with mode: 'bypass', NODE_ENV='development'. POST with field.
    // Assert 201 + world row has dev_bypass_access_filter = true.
    // Assert audit log emitted.
  })

  it('400 bypass_not_permitted with devBypassAccessFilter:true under non-bypass auth', async () => {
    // Build app with mode: 'jwt'. POST with field set.
    // Assert 400 { code: 'bypass_not_permitted' }.
  })

  it('400 bypass_not_permitted with devBypassAccessFilter:true under bypass-auth + prod env', async () => {
    // Build app with mode: 'bypass', NODE_ENV='production' (mock the env).
    // POST with field set. Assert 400 { code: 'bypass_not_permitted' }.
  })

  it('201 without devBypassAccessFilter field; column defaults to false', async () => {
    // POST without the field. Assert 201 + world row has dev_bypass_access_filter = false.
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

```bash
pnpm --filter @mythrun/backend vitest run src/routes/__tests__/campaigns-create.test.ts
```

Expected: FAIL — field not in schema, no gate.

- [ ] **Step 3: Update CreateCampaignBodySchema + route handler**

In `backend/src/routes/campaigns.ts`:

1. Extend the schema:
   ```ts
   const CreateCampaignBodySchema = z.object({
     world: z.discriminatedUnion('kind', [...]),
     devBypassAccessFilter: z.boolean().optional(),  // myth-exac
   })
   ```
2. In the route handler, after Zod parse:
   ```ts
   if (parsed.data.devBypassAccessFilter === true) {
     const isBypassAuth = request.user.scopes.includes('bypass')
     const isDevEnv =
       opts.env.nodeEnv === 'development' || opts.env.nodeEnv === 'test'
     if (!isBypassAuth || !isDevEnv) {
       return reply.code(400).send({ code: 'bypass_not_permitted' })
     }
   }
   const devBypass = parsed.data.devBypassAccessFilter ?? false
   ```
3. Thread `devBypass` into `executeCreateTransaction` so the INSERT into `worlds` sets `dev_bypass_access_filter = $N`.
4. Audit log after successful insert when bypass is on:
   ```ts
   if (devBypass) {
     const dbUser = requireDbUser(request)
     request.log.info(
       { event: 'world.dev_bypass_access_filter.enabled', campaignId, userId: dbUser.id },
       'dev-mode access tier bypass enabled for new world',
     )
   }
   ```

- [ ] **Step 4: Run test to verify it passes**

```bash
pnpm --filter @mythrun/backend vitest run src/routes/__tests__/campaigns-create.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add backend/src/routes/campaigns.ts backend/src/routes/__tests__/campaigns-create.test.ts
git commit -m "feat(myth-exac): POST /api/campaigns — devBypassAccessFilter field + gate + audit"
```

---

## Task 22: dev-tool campaign-create panel — bypass checkbox

**Files:**
- Modify: `backend/dev-tool/src/components/campaign-create-panel.ts`
- Modify: `backend/dev-tool/src/components/__tests__/campaign-create-panel.test.ts` (if exists)

- [ ] **Step 1: Add the checkbox + body wiring**

Edit `campaign-create-panel.ts`. In the DOM construction section, add a labeled checkbox below the concept input:

```ts
const bypassRow = document.createElement('div')
bypassRow.className = 'panel-row'
const bypassCheckbox = document.createElement('input')
bypassCheckbox.type = 'checkbox'
bypassCheckbox.id = 'dev-bypass-access-filter'
const bypassLabel = document.createElement('label')
bypassLabel.setAttribute('for', 'dev-bypass-access-filter')
bypassLabel.textContent = 'Bypass access tiers (dev mode — see secrets in stream + snapshot)'
bypassRow.appendChild(bypassCheckbox)
bypassRow.appendChild(bypassLabel)
card.appendChild(bypassRow)
```

In `buildBody()`:

```ts
const body: Record<string, unknown> = {
  world: { kind: 'new', source: { mode: 'freeform', concept: conceptInput.value } },
}
if (bypassCheckbox.checked) {
  body.devBypassAccessFilter = true
}
return body
```

- [ ] **Step 2: Run a manual smoke**

```bash
pnpm --filter @mythrun/backend dev  # backend on :3030
pnpm --filter @mythrun/dev-tool dev  # dev tool on :5273
```

Visit `http://localhost:5273/`, check the new bypass checkbox, submit a freeform concept, verify `200` and that the world row has `dev_bypass_access_filter = true`:

```bash
docker compose exec -T postgres psql -U mythrun -d mythrun -c \
  "SELECT dev_bypass_access_filter FROM worlds ORDER BY created_at DESC LIMIT 1;"
```

- [ ] **Step 3: Commit**

```bash
git add backend/dev-tool/src/components/campaign-create-panel.ts
git commit -m "feat(myth-exac): dev-tool campaign-create panel — bypass checkbox"
```

---

## Task 23: dev-tool world-snapshot panel — state machine + scaffold

**Files:**
- Create: `backend/dev-tool/src/components/world-snapshot-panel.ts`
- Create: `backend/dev-tool/src/components/__tests__/world-snapshot-panel.test.ts`

- [ ] **Step 1: Write the failing test (state machine)**

Create the test file. Assert the state machine transitions:
- Initial: `data-state="idle"`.
- On phase `world_snapshot_ready`: transition to `loading` → snapshot fetch fires → on success: `ready`; on 4xx: `error`.
- On phase change to a pre-stage-4 phase: revert to `idle`.

- [ ] **Step 2: Run test to verify it fails**

Expected: FAIL — panel doesn't exist.

- [ ] **Step 3: Create world-snapshot-panel.ts**

```ts
// backend/dev-tool/src/components/world-snapshot-panel.ts
//
// myth-exac: world-snapshot inspector. Mounts when a campaign is selected
// AND the SSE phase is world_snapshot_ready or later. Fetches the snapshot
// once, then applies post-snapshot SSE deltas in place.

import type { ApiClient } from '../api-client.js'
import type { SseChannel } from '../sse-channel.js'

type State = 'idle' | 'loading' | 'ready' | 'error'

export function mountWorldSnapshotPanel(
  root: HTMLElement,
  api: ApiClient,
  sse: SseChannel,
): void {
  // ... DOM construction, state machine, etc.
  // Set data-state="idle" initially.
  // Subscribe to phase events and campaign-selection state.
  // On phase >= world_snapshot_ready: data-state="loading", fetch.
  // Set data-state="ready" on success; "error" on failure.
}
```

(Full implementation in subsequent tasks; this task lands the scaffold + state machine + data-state markers.)

- [ ] **Step 4: Run test to verify it passes**

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add backend/dev-tool/src/components/world-snapshot-panel.ts backend/dev-tool/src/components/__tests__/world-snapshot-panel.test.ts
git commit -m "feat(myth-exac): world-snapshot panel scaffold + state machine"
```

---

## Task 24: world-snapshot panel — snapshot fetch + tree + detail rendering

**Files:**
- Modify: `backend/dev-tool/src/components/world-snapshot-panel.ts`

- [ ] **Step 1: Add the failing test**

Mount the panel with a mocked snapshot fetch. Assert:
- Tree pane renders entities grouped by entity_type with counts.
- Selecting an entity sets a `selectedEntityId` state and renders the detail card with prose kernel content + facts + relationships.

- [ ] **Step 2: Implement the rendering**

Inside the `ready` state branch:
1. Build a tree pane (`<ul>` with `<li>` per group + nested `<li>` per entity).
2. Build a detail pane: name + kind + prose kernel content + facts list + in/out relationships + stat block (if any).
3. Wire clicks to update `selectedEntityId` and re-render the detail pane.

Refer to the spec's ASCII diagram for the layout (left tree, right detail).

- [ ] **Step 3: Verify**

```bash
pnpm --filter @mythrun/backend dev-tool:verify
```

Expected: PASS — verifier reaches `data-state="ready"`.

- [ ] **Step 4: Commit**

```bash
git add backend/dev-tool/src/components/world-snapshot-panel.ts
git commit -m "feat(myth-exac): world-snapshot panel — tree + detail rendering"
```

---

## Task 25: world-snapshot panel — delta handlers + synthKey↔DB-id maps

**Files:**
- Modify: `backend/dev-tool/src/components/world-snapshot-panel.ts`

- [ ] **Step 1: Add the failing tests**

```ts
it('applies entity-updated patch to the local snapshot', () => {
  // Mount; deliver `finalized { synthKey: 'world_and_factions/regions/0', entityId: 'abc' }`.
  // Then deliver `entity-updated { synthKey: 'world_and_factions/regions/0', patch: { name: 'NewName' } }`.
  // Assert the entity's name in the local snapshot is now 'NewName'.
})

it('applies edge-added (post-snapshot coherence) by appending a relationship row', () => {
  // ...
})

it('applies edge-removed by removing the relationship row', () => {
  // ...
})
```

- [ ] **Step 2: Implement the delta handlers**

Maintain two maps:
- `synthKeyToEntityId: Map<string, string>` populated from `finalized` events for entity synthKeys
- `synthKeyToRelId: Map<string, string>` populated from `finalized` events for relationship synthKeys

Distinguish by the synthKey's stage prefix (`entity_relationships/*` is a relationship).

Handler for `entity-updated { synthKey, patch }`:
1. Resolve `synthKey` → `entityId` via the entity map.
2. Find the matching `EntityRow` in local state; apply `patch.name` (rename) directly to `name`. If `patch.prose` is present, find the matching `ProseKernelRow` and update its `content`.
3. Re-render if selected.

Handler for `edge-added`:
1. Append a new `RelationshipRow` to local state with the from/to from the event.
2. Add `synthKey → relationshipId` mapping when the corresponding `finalized` arrives.
3. Re-render the affected entities' relationship sections.

Handler for `edge-removed`:
1. Resolve `synthKey` → relationship ID via the rel map.
2. Remove the row.
3. Re-render.

Reconnect handler:
1. On SSE reconnect, if phase ≥ `world_snapshot_ready`, refetch and **replace** local state (not merge).

- [ ] **Step 3: Verify**

```bash
pnpm --filter @mythrun/backend dev-tool:verify
```

Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add backend/dev-tool/src/components/world-snapshot-panel.ts backend/dev-tool/src/components/__tests__/world-snapshot-panel.test.ts
git commit -m "feat(myth-exac): world-snapshot panel — delta handlers + synthKey↔DB-id maps"
```

---

## Task 26: dev-tool coverage + verify-registry

**Files:**
- Modify: `backend/dev-tool/coverage.json`
- Modify: `backend/dev-tool/verify-registry.ts`

- [ ] **Step 1: Update coverage.json**

Add the new route to the `routes` array:

```json
{
  "version": 1,
  "routes": [
    "GET /api/campaigns/:campaignId/status",
    "GET /api/campaigns/:campaignId/status/stream",
    "POST /api/campaigns",
    "GET /api/campaigns/:campaignId",
    "GET /api/campaigns/mine",
    "POST /api/campaigns/:campaignId/resume",
    "DELETE /api/campaigns/:campaignId",
    "PATCH /api/campaigns/:campaignId/name",
    "GET /api/campaigns/:campaignId/world-snapshot"
  ],
  ...
}
```

- [ ] **Step 2: Register the panel**

Edit `backend/dev-tool/verify-registry.ts`:

```ts
{
  name: 'world-snapshot',
  exercises: [
    route('GET', '/api/campaigns/:campaignId/world-snapshot'),
  ],
  bootstrap: async (api) => {
    // Create a world that reaches world_snapshot_ready before the verifier
    // hits the panel. Either use a fixture-seeded world or trigger a real
    // small world-gen.
    return await seedTestWorld(api)
  },
},
```

- [ ] **Step 3: Run dev-tool:check**

```bash
pnpm dev-tool:check
```

Expected: PASS — 0 errors, route covered.

- [ ] **Step 4: Run dev-tool:verify**

```bash
pnpm --filter @mythrun/backend dev  # backend on :3030
pnpm --filter @mythrun/dev-tool dev  # dev tool on :5273
pnpm dev-tool:verify
```

Expected: PASS — `world-snapshot` panel reaches `data-state="ready"`.

- [ ] **Step 5: Commit**

```bash
git add backend/dev-tool/coverage.json backend/dev-tool/verify-registry.ts
git commit -m "feat(myth-exac): dev-tool coverage + verify-registry entries for world-snapshot"
```

---

## Task 27: Wiki updates

**Files:**
- Modify: `docs/wiki/content/runtime/world-gen.html`
- Modify: `docs/wiki/content/runtime/dev-tool.html`
- Modify: `docs/wiki/content/data/schema.html`

- [ ] **Step 1: Update world-gen.html**

Find the lifecycle narrative. Add a section describing:
- The new `world_snapshot_ready` phase between `world_gen` and `world_ready`.
- The snapshot endpoint as the owner-only known-tier slice.
- The post-snapshot delta channel (same SSE stream, coherence events flow as patches).
- The three-tier access classification + the dev-mode bypass.

Add source markers for the new code references at the top of the file.

- [ ] **Step 2: Update dev-tool.html**

Mention the new `world-snapshot` panel + the campaign-create bypass checkbox.

- [ ] **Step 3: Update schema.html**

Update for `entities.access_level` and `worlds.dev_bypass_access_filter` columns. The schema generator may auto-pick these up; rerun `pnpm wiki:build` and inspect.

- [ ] **Step 4: Run wiki:check**

```bash
DATABASE_URL="postgresql://mythrun:mythrun_dev@localhost:5432/mythrun" pnpm wiki:check
```

Expected: PASS, no drift.

- [ ] **Step 5: Commit**

```bash
git add docs/wiki/
git commit -m "docs(wiki): myth-exac — world-gen lifecycle + dev-tool + schema"
```

---

## Task 28: End-to-end smoke (real LLM + real DB)

**Files:** — (no edits; pure verification)

- [ ] **Step 1: Restart backend + dev-tool cleanly**

```bash
# Kill any stale tsx/pnpm dev processes (memory: reference_parallel_worktree_db_collision)
ps aux | grep -E "tsx.*server\.ts|tsx.*dev:dev-tool|pnpm dev" | grep -v grep
# kill stale PIDs as needed
pnpm --filter @mythrun/backend dev  # background
pnpm --filter @mythrun/dev-tool dev  # background
```

- [ ] **Step 2: Run the worker pre-push gate locally**

```bash
pnpm typecheck
pnpm lint
pnpm test
pnpm wiki:check
pnpm dev-tool:check
pnpm dev-tool:verify
```

All must pass.

- [ ] **Step 3: Smoke a real world-gen with bypass OFF**

Via dev-tool UI: create a campaign with a freeform concept, bypass UNCHECKED. Wait through stage 4 to `phase: world_snapshot_ready`. Verify in the world-snapshot panel that:
- Only known-tier entities appear.
- No `secret`-tier or `discoverable`-tier facts visible.
- The world summary card omits `key_tensions` / `starting_situations`.

- [ ] **Step 4: Smoke a real world-gen with bypass ON**

Same flow, but with the bypass checkbox CHECKED. After `world_snapshot_ready`:
- All tier entities visible.
- `secret` and `discoverable` facts present in the detail pane.
- Live-stream graph shows all entities (not just known).

- [ ] **Step 5: Inspect DB**

```bash
docker compose exec -T postgres psql -U mythrun -d mythrun -c \
  "SELECT name, entity_type, access_level FROM entities WHERE world_id = (SELECT world_id FROM campaigns ORDER BY created_at DESC LIMIT 1) ORDER BY entity_type, name;"
```

Expected: mix of `known`, `discoverable`, `secret` per entity_type. If everything is `known`, the persistence-path threading (Task 13/14) didn't land — fix.

- [ ] **Step 6: Push**

```bash
git push origin main
```

CI's `Dev tool check`, `Wiki check`, `Deploy` (test+lint+typecheck) all green. If anything fails, triage and fix as a follow-up commit.

- [ ] **Step 7: Close the bead**

```bash
bd close myth-exac
```

Flip the Linear ticket to Done if there's a parent issue. (This is a beads-only ticket per the user's instruction at file-time, so Linear flip may be skipped.)

---

## Self-Review Checklist (run before handoff)

1. **Spec coverage:** Every section of the spec maps to a task:
   - § Lead → framing only, no task
   - § Access tier classification → Tasks 1 (migration), 8-11 (LLM + prompts), 22 (snapshot view)
   - § Lifecycle → Tasks 2 (contract), 17 (derivePhase), 18 (processor)
   - § Streaming events → Tasks 12 (extractor), 13-15 (stages)
   - § Schema changes → Tasks 1, 5, 8-9
   - § Snapshot endpoint → Tasks 19, 20
   - § Post-snapshot delta lifecycle → Task 16 (coherence), 18 (phase emission)
   - § Dev tool snapshot inspector panel → Tasks 23-25
   - § Dev-mode access tier bypass → Tasks 1, 12-16 (filter sites), 21 (route), 22 (UI)
   - § Coverage / contract registrations → Tasks 2-3, 26
   - § Wiki updates → Task 27
   - § Testing → embedded in every task
   - § Out of scope / Open questions → no tasks needed

2. **Type consistency:**
   - `AccessLevel` defined in `facts.ts`, re-exported as needed.
   - `WorldSummary` defined in `world-snapshot-view.ts`.
   - `endpointTierMap: ReadonlyMap<string, AccessLevel>` consistent across streaming-extractor + stage 4.
   - `bypassAccessFilter: boolean` consistent across all stage args + extractor config.
   - `synthKey` format `${stage}/${path}/${index}` consistent.

3. **No placeholders.** Every task has full code or a complete pattern. No "TODO" / "TBD."
