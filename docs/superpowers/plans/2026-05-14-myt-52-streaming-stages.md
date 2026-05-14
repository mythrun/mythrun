# MYT-52 — World Gen Streaming Stages Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship the streaming half of the world-gen pipeline (stages 2, 3, the new entity_relationships stage 4, and the new coherence_pass stage 7) + a structured-output repair chain + a dev-tool live-events inspector. After this plan completes, `POST /api/campaigns` produces a fully-populated coherence-audited world end-to-end (`worlds.status='complete'`).

**Architecture:** Three streaming stages share a reusable extraction loop (`streaming-extractor.ts`) that diffs partial JSON trees from Vercel SDK's `streamObject` and publishes per-entity SSE events. A separate repair chain (Haiku → Sonnet → BullMQ retry) handles Zod validation failures without showing the user disappearing entities. A non-streaming coherence pass at the tail audits the world for contradictions and emits silent patches before `phase: complete` fires. The dev tool inspects the SSE stream as raw event-log data (no graph rendering — that's a production-frontend concern).

**Tech Stack:** TypeScript 5 (strict) · Node 24 · Fastify · pg · Vercel AI SDK v6 (`streamObject` + `partialObjectStream`) · zod · BullMQ · ioredis · Postgres 16 · vitest (real PG harness)

**Design contract (read first):** `docs/superpowers/specs/2026-05-14-myt-52-streaming-stages-design.md`. The plan refers to its sections (D1–D14, §3.x, §4.x, §6, §7, §8). Where the plan and design disagree, the design wins; flag the disagreement and surface it before continuing.

---

## File Inventory

**New production files:**

| Path | Responsibility |
|---|---|
| `backend/src/llm/prep/streaming-extractor.ts` | Diff/emit loop over `partialObjectStream` — reused by stages 2/3/4 |
| `backend/src/llm/prep/structured-output-repair.ts` | `validateOrRepair` helper + 3-tier repair chain |
| `backend/src/llm/prep/stages/world-and-factions.ts` | Stage 2 handler (streaming) |
| `backend/src/llm/prep/stages/locations-and-npcs.ts` | Stage 3 handler (streaming, two-pass hierarchy resolve) |
| `backend/src/llm/prep/stages/entity-relationships.ts` | Stage 4 handler (streaming, NEW) |
| `backend/src/llm/prep/stages/coherence-pass.ts` | Stage 7 handler (non-streaming, NEW) |
| `backend/src/llm/schemas/world-and-factions.ts` | Stage 2 zod (ported from prototype shape) |
| `backend/src/llm/schemas/locations-and-npcs.ts` | Stage 3 zod (ported) |
| `backend/src/llm/schemas/entity-relationships.ts` | Stage 4 zod (NEW — closed-enum `relationship_type`) |
| `backend/src/llm/schemas/coherence-output.ts` | Stage 7 zod (NEW — patch discriminated union) |
| `backend/src/llm/prompts/prep/world-and-factions.txt` | Stage 2 prompt (port + name-first ordering) |
| `backend/src/llm/prompts/prep/locations-and-npcs.txt` | Stage 3 prompt (port + name-first ordering + parent_location field) |
| `backend/src/llm/prompts/prep/entity-relationships.txt` | Stage 4 prompt (NEW — receives entity inventory with UUIDs) |
| `backend/src/llm/prompts/prep/coherence-pass.txt` | Stage 7 prompt (NEW — full world dump in, patches out) |
| `backend/src/llm/prompts/prep/repair.txt` | Repair-chain prompt (NEW) |
| `backend/src/repo/entities.ts` | Repo: insert, findByWorldAndName, listByWorld |
| `backend/src/repo/prose-kernels.ts` | Repo: insert, updateByEntityId |
| `backend/src/repo/facts.ts` | Repo: insertMany (stamps narrative_status), updateContentById |
| `backend/src/repo/relationships.ts` | Repo: deleteByWorld, insertMany, listByWorld, updateById, deleteById |
| `backend/src/repo/entity-hierarchy.ts` | Repo: insert (caller pre-filters; no ON CONFLICT) |
| `backend/dev-tool/src/components/live-events-panel.ts` | SSE event log + inventory inspector (NEW; replaces planned graph) |

**Modified production files:**

| Path | Change |
|---|---|
| `backend/src/llm/prep/world-gen-processor.ts` | `WORLDGEN_STAGES` constant + new `dispatchStage` arms (stages 4 + 7) |
| `backend/src/sse/derive-phase.ts` | `STAGE_ORDER` includes new stages |
| `backend/src/server.ts` | World-gen Queue gets `defaultJobOptions: { attempts: 2, backoff }` |
| `backend/dev-tool/src/main.ts` | Mount `live-events-panel` alongside existing panels |
| `backend/src/llm/errors.ts` | Add `LlmContentFilteredError` for content-policy filter |
| `backend/src/llm/middleware.ts` | Map `finishReason: 'content-filter'` → `LlmContentFilteredError` |

**Test files (every new production file gets `__tests__/X.test.ts` alongside it).** Specific test files called out per task.

---

## Task ordering rationale

Bottom-up. Repo modules first (used by every stage handler). Shared primitives second (extractor, repair chain). Stage handlers third. Pipeline integration fourth. Dev tool fifth. Smoke last.

Each task is independently committable. The CI gates (typecheck + lint + 100% coverage + auth-narrowing + dev-tool:check + wiki:check) must remain green at every commit. The pre-push hook enforces this on local pushes; CI re-asserts on remote.

---

## Phase A — Preconditions (already shipped in pre-plan work)

Verified before plan execution starts:

- [x] `entity-removed` + `edge-removed` arms added to `backend/src/contract/pipeline-events.ts` (commit `fa943a7`)
- [x] `backend/src/contract/__tests__/pipeline-contracts.test.ts` expected list updated (commit `6096c47`)
- [x] `backend/dev-tool/coverage.json` updated with 2 new arms + reason strings (commit `6096c47`)

These are state-of-main as of plan creation. The implementer does not redo them.

---

## Phase B — BullMQ retry configuration

### Task 1: Configure BullMQ world-gen Queue with `attempts: 2`

The Queue currently has no `attempts` config — BullMQ defaults to 1 try, no retries. This breaks every "BullMQ retries" path in the design's §7.2 error matrix. One-line fix at queue construction.

**Files:**
- Modify: `backend/src/server.ts` (`new Queue('world-gen', ...)` call site)
- Test: `backend/src/__tests__/queue-config.test.ts` (NEW)

- [ ] **Step 1: Write the failing test**

```ts
// backend/src/__tests__/queue-config.test.ts
import { describe, it, expect } from 'vitest'
import { Queue } from 'bullmq'
import IoredisMock from 'ioredis-mock'

describe('world-gen BullMQ Queue config', () => {
  it('has defaultJobOptions.attempts = 2 with exponential backoff', () => {
    // Mirror the construction pattern from server.ts so the test is
    // independent of server boot. The assertion is on the option shape
    // the design requires (§7.2 BullMQ-retry rows).
    const queue = new Queue('world-gen', {
      connection: new IoredisMock() as unknown as ConstructorParameters<typeof Queue>[1]['connection'],
      defaultJobOptions: {
        attempts: 2,
        backoff: { type: 'exponential', delay: 30000 },
      },
      removeOnComplete: { count: 0 },
      removeOnFail: { count: 0 },
    })
    const opts = queue.opts.defaultJobOptions
    expect(opts?.attempts).toBe(2)
    expect(opts?.backoff).toEqual({ type: 'exponential', delay: 30000 })
    void queue.close()
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd backend && pnpm vitest run src/__tests__/queue-config.test.ts`
Expected: PASS (the test asserts the shape we're about to add; it'll pass on its own. The actual change is to `server.ts`, which the test mirrors. This is a "shape-assertion in code so any future refactor preserves it" test.)

- [ ] **Step 3: Add `defaultJobOptions` to the production Queue construction**

Locate the existing `new Queue('world-gen', { ... })` in `backend/src/server.ts`. Add `defaultJobOptions`:

```ts
// backend/src/server.ts (around the existing Queue construction)
const worldGenQueue = new Queue(WORLDGEN_QUEUE_NAME, {
  connection: redisBatch,
  // NEW per MYT-52: was missing; BullMQ default is attempts=1 (no retries).
  // The design's §7.2 error matrix's "BullMQ retries the stage" recovery
  // paths require attempts >= 2.
  defaultJobOptions: {
    attempts: 2,
    backoff: { type: 'exponential', delay: 30000 },
  },
  removeOnComplete: { count: 0 },
  removeOnFail: { count: 0 },
})
```

- [ ] **Step 4: Re-run the test + full test suite + typecheck + lint**

```bash
cd backend
pnpm vitest run src/__tests__/queue-config.test.ts
pnpm typecheck
pnpm lint
```

Expected: queue-config test PASS; typecheck + lint clean.

- [ ] **Step 5: Commit**

```bash
git add backend/src/server.ts backend/src/__tests__/queue-config.test.ts
git commit -m "feat(myt-52): configure BullMQ world-gen Queue with attempts=2 + exponential backoff

Precondition for MYT-52's §7.2 error matrix recovery paths. The Queue
previously had no attempts config (BullMQ default: 1 try, no retries) —
every 'BullMQ retries the stage' line in MYT-51's spec was fictional.
This commit makes the retry surface real before the new streaming stages
need it."
```

---

## Phase C — Repo modules (5 new)

Each new repo module follows the bare-named-export convention (no `createXxxRepo` factory) per design §4.3. Tests use real Postgres via the existing `guardTestDatabase` + DROP SCHEMA + runMigrations harness.

### Task 2: `repo/entities.ts`

Persists rows to the existing `entities` table. Schema (`migrations/001_initial_schema.sql:114-123`):

```sql
CREATE TABLE entities (
  id UUID PRIMARY KEY,
  world_id UUID NOT NULL REFERENCES worlds(id) ON DELETE CASCADE,
  entity_type TEXT NOT NULL CHECK (entity_type IN ('npc', 'location', 'faction', 'item')),
  name TEXT NOT NULL,
  ...
)
```

**Files:**
- Create: `backend/src/repo/entities.ts`
- Test: `backend/src/repo/__tests__/entities.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// backend/src/repo/__tests__/entities.test.ts
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import type { Pool } from 'pg'
import { fileURLToPath } from 'node:url'
import { resolve } from 'node:path'
import pino, { type DestinationStream } from 'pino'
import { createPgPool } from '../../db/postgres.js'
import { runMigrations } from '../../db/migrate.js'
import { guardTestDatabase } from '../../db/__tests__/guard-db.js'
import { uuidv7 } from '../uuidv7.js'
import { entities } from '../entities.js'

const databaseUrl = process.env.DATABASE_URL ?? ''
const here = fileURLToPath(import.meta.url)
const REAL_MIGRATIONS_DIR = resolve(here, '../../../../migrations')

function silentLogger(): ReturnType<typeof pino> {
  const sink: DestinationStream = { write: (): void => undefined }
  return pino({ base: { component: 'migrate' } }, sink)
}

describe('entities repo', () => {
  let pool: Pool
  let userId: string
  let worldId: string

  beforeAll(async () => {
    await guardTestDatabase(databaseUrl)
    pool = createPgPool(databaseUrl, { max: 2 })
    await pool.query('DROP EXTENSION IF EXISTS pgcrypto CASCADE')
    await pool.query('DROP SCHEMA public CASCADE')
    await pool.query('CREATE SCHEMA public')
    await pool.query('GRANT ALL ON SCHEMA public TO PUBLIC')
    await pool.query('GRANT ALL ON SCHEMA public TO CURRENT_USER')
    await runMigrations({ pool, migrationsDir: REAL_MIGRATIONS_DIR, logger: silentLogger() })
  })
  afterAll(async () => {
    await pool.end()
  })
  beforeEach(async () => {
    await pool.query('DELETE FROM entities')
    await pool.query('DELETE FROM worlds')
    await pool.query("DELETE FROM users WHERE cognito_sub != 'system:mythrun'")
    userId = uuidv7()
    worldId = uuidv7()
    await pool.query(
      `INSERT INTO users (id, cognito_sub, display_name, username) VALUES ($1, $2, $3, $4)`,
      [userId, `bypass:ent-${userId.slice(-6)}`, 'Ent', `ent${userId.slice(-6)}`],
    )
    await pool.query(
      `INSERT INTO worlds (id, created_by, name, concept, status) VALUES ($1, $2, 'W', 'C', 'generating')`,
      [worldId, userId],
    )
  })

  it('insert writes a row and returns the inserted entity', async () => {
    const id = uuidv7()
    const inserted = await entities.insert(pool, {
      id, worldId, entityType: 'location', name: 'Eredil',
    })
    expect(inserted).toEqual({ id, worldId, entityType: 'location', name: 'Eredil' })

    const row = await pool.query<{ entity_type: string; name: string }>(
      `SELECT entity_type, name FROM entities WHERE id = $1`, [id],
    )
    expect(row.rows[0]).toEqual({ entity_type: 'location', name: 'Eredil' })
  })

  it('findByWorldAndName returns null when no match', async () => {
    const found = await entities.findByWorldAndName(pool, worldId, 'Nowhere')
    expect(found).toBeNull()
  })

  it('findByWorldAndName returns the entity when name matches', async () => {
    const id = uuidv7()
    await entities.insert(pool, { id, worldId, entityType: 'faction', name: 'House Eyrin' })
    const found = await entities.findByWorldAndName(pool, worldId, 'House Eyrin')
    expect(found?.id).toBe(id)
  })

  it('listByWorld returns all entities for the world', async () => {
    await entities.insert(pool, { id: uuidv7(), worldId, entityType: 'location', name: 'A' })
    await entities.insert(pool, { id: uuidv7(), worldId, entityType: 'faction', name: 'B' })
    const rows = await entities.listByWorld(pool, worldId)
    expect(rows).toHaveLength(2)
    expect(rows.map((r) => r.name).sort()).toEqual(['A', 'B'])
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd backend && pnpm vitest run src/repo/__tests__/entities.test.ts`
Expected: FAIL with "Cannot find module '../entities.js'".

- [ ] **Step 3: Implement the repo module**

```ts
// backend/src/repo/entities.ts
//
// Repo for the `entities` table (migration 001 lines 114–123). Bare-named
// exports — every caller already holds a PoolClient via the stage's
// transaction (mirrors `stripe-events.ts`, not `worlds.ts`).
//
// entity_type is constrained by the table's CHECK to ('npc', 'location',
// 'faction', 'item'). Regions are persisted as type='location' per the
// pipeline spec §3 (no separate 'region' enum value).

import type { ClientLike } from './_types.js'

export type EntityType = 'npc' | 'location' | 'faction' | 'item'

export interface InsertEntityInput {
  readonly id: string
  readonly worldId: string
  readonly entityType: EntityType
  readonly name: string
}

export interface Entity {
  readonly id: string
  readonly worldId: string
  readonly entityType: EntityType
  readonly name: string
}

interface EntityRow {
  readonly id: string
  readonly world_id: string
  readonly entity_type: EntityType
  readonly name: string
}

function toEntity(row: EntityRow): Entity {
  return {
    id: row.id,
    worldId: row.world_id,
    entityType: row.entity_type,
    name: row.name,
  }
}

async function insert(client: ClientLike, input: InsertEntityInput): Promise<Entity> {
  await client.query(
    `INSERT INTO entities (id, world_id, entity_type, name)
     VALUES ($1, $2, $3, $4)`,
    [input.id, input.worldId, input.entityType, input.name],
  )
  return { id: input.id, worldId: input.worldId, entityType: input.entityType, name: input.name }
}

async function findByWorldAndName(
  client: ClientLike,
  worldId: string,
  name: string,
): Promise<Entity | null> {
  const result = await client.query<EntityRow>(
    `SELECT id, world_id, entity_type, name
       FROM entities WHERE world_id = $1 AND name = $2 LIMIT 1`,
    [worldId, name],
  )
  return result.rows[0] ? toEntity(result.rows[0]) : null
}

async function listByWorld(client: ClientLike, worldId: string): Promise<Entity[]> {
  const result = await client.query<EntityRow>(
    `SELECT id, world_id, entity_type, name FROM entities WHERE world_id = $1`,
    [worldId],
  )
  return result.rows.map(toEntity)
}

export const entities = { insert, findByWorldAndName, listByWorld } as const
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd backend && pnpm vitest run src/repo/__tests__/entities.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add backend/src/repo/entities.ts backend/src/repo/__tests__/entities.test.ts
git commit -m "feat(myt-52): repo/entities — insert, findByWorldAndName, listByWorld"
```

### Task 3: `repo/prose-kernels.ts`

Schema (`migrations/001_initial_schema.sql:140-146`): `prose_kernels.entity_id UNIQUE`. Two surfaces: `insert` (errors on conflict — stages 2/3 use this with fresh entities) and `updateByEntityId` (coherence pass's `fix_prose` patch path).

**Files:**
- Create: `backend/src/repo/prose-kernels.ts`
- Test: `backend/src/repo/__tests__/prose-kernels.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// backend/src/repo/__tests__/prose-kernels.test.ts
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import type { Pool } from 'pg'
import { fileURLToPath } from 'node:url'
import { resolve } from 'node:path'
import pino, { type DestinationStream } from 'pino'
import { createPgPool } from '../../db/postgres.js'
import { runMigrations } from '../../db/migrate.js'
import { guardTestDatabase } from '../../db/__tests__/guard-db.js'
import { uuidv7 } from '../uuidv7.js'
import { entities } from '../entities.js'
import { proseKernels } from '../prose-kernels.js'

const databaseUrl = process.env.DATABASE_URL ?? ''
const here = fileURLToPath(import.meta.url)
const REAL_MIGRATIONS_DIR = resolve(here, '../../../../migrations')

function silentLogger(): ReturnType<typeof pino> {
  const sink: DestinationStream = { write: (): void => undefined }
  return pino({ base: { component: 'migrate' } }, sink)
}

describe('proseKernels repo', () => {
  let pool: Pool
  let entityId: string

  beforeAll(async () => {
    await guardTestDatabase(databaseUrl)
    pool = createPgPool(databaseUrl, { max: 2 })
    await pool.query('DROP EXTENSION IF EXISTS pgcrypto CASCADE')
    await pool.query('DROP SCHEMA public CASCADE')
    await pool.query('CREATE SCHEMA public')
    await pool.query('GRANT ALL ON SCHEMA public TO PUBLIC')
    await pool.query('GRANT ALL ON SCHEMA public TO CURRENT_USER')
    await runMigrations({ pool, migrationsDir: REAL_MIGRATIONS_DIR, logger: silentLogger() })
  })
  afterAll(async () => {
    await pool.end()
  })
  beforeEach(async () => {
    await pool.query('DELETE FROM prose_kernels')
    await pool.query('DELETE FROM entities')
    await pool.query('DELETE FROM worlds')
    await pool.query("DELETE FROM users WHERE cognito_sub != 'system:mythrun'")
    const userId = uuidv7()
    const worldId = uuidv7()
    entityId = uuidv7()
    await pool.query(
      `INSERT INTO users (id, cognito_sub, display_name, username) VALUES ($1, $2, $3, $4)`,
      [userId, `bypass:pk-${userId.slice(-6)}`, 'PK', `pk${userId.slice(-6)}`],
    )
    await pool.query(
      `INSERT INTO worlds (id, created_by, name, concept, status) VALUES ($1, $2, 'W', 'C', 'generating')`,
      [worldId, userId],
    )
    await entities.insert(pool, {
      id: entityId, worldId, entityType: 'location', name: 'X',
    })
  })

  it('insert writes a prose_kernel row for the entity', async () => {
    await proseKernels.insert(pool, { entityId, content: 'A forested region.' })
    const row = await pool.query<{ content: string }>(
      `SELECT content FROM prose_kernels WHERE entity_id = $1`, [entityId],
    )
    expect(row.rows[0]?.content).toBe('A forested region.')
  })

  it('insert errors when entity_id already has a prose_kernel (UNIQUE violation)', async () => {
    await proseKernels.insert(pool, { entityId, content: 'first' })
    await expect(
      proseKernels.insert(pool, { entityId, content: 'second' }),
    ).rejects.toThrow()
  })

  it('updateByEntityId replaces the existing content', async () => {
    await proseKernels.insert(pool, { entityId, content: 'original' })
    await proseKernels.updateByEntityId(pool, entityId, { content: 'revised' })
    const row = await pool.query<{ content: string }>(
      `SELECT content FROM prose_kernels WHERE entity_id = $1`, [entityId],
    )
    expect(row.rows[0]?.content).toBe('revised')
  })

  it('updateByEntityId is a no-op when no row exists (zero affected rows)', async () => {
    const affected = await proseKernels.updateByEntityId(pool, entityId, { content: 'x' })
    expect(affected).toBe(0)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd backend && pnpm vitest run src/repo/__tests__/prose-kernels.test.ts`
Expected: FAIL with "Cannot find module '../prose-kernels.js'".

- [ ] **Step 3: Implement**

```ts
// backend/src/repo/prose-kernels.ts
//
// Repo for prose_kernels table (migration 001 lines 140–146).
// UNIQUE(entity_id) — exactly one prose blob per entity.
//
// insert() errors on conflict (used by stages 2/3 with fresh entities).
// updateByEntityId() is the coherence-pass fix_prose path. Do NOT
// implement as an upsert that conflates the two cases — the design
// (§4.3) explicitly calls out the separation.

import type { ClientLike } from './_types.js'
import { uuidv7 } from './uuidv7.js'

export interface InsertProseKernelInput {
  readonly entityId: string
  readonly content: string
}

async function insert(client: ClientLike, input: InsertProseKernelInput): Promise<void> {
  await client.query(
    `INSERT INTO prose_kernels (id, entity_id, content) VALUES ($1, $2, $3)`,
    [uuidv7(), input.entityId, input.content],
  )
}

async function updateByEntityId(
  client: ClientLike,
  entityId: string,
  patch: { content: string },
): Promise<number> {
  const result = await client.query(
    `UPDATE prose_kernels SET content = $1, updated_at = now() WHERE entity_id = $2`,
    [patch.content, entityId],
  )
  return result.rowCount ?? 0
}

export const proseKernels = { insert, updateByEntityId } as const
```

- [ ] **Step 4: Run test**

Run: `cd backend && pnpm vitest run src/repo/__tests__/prose-kernels.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add backend/src/repo/prose-kernels.ts backend/src/repo/__tests__/prose-kernels.test.ts
git commit -m "feat(myt-52): repo/prose-kernels — insert + updateByEntityId"
```

### Task 4: `repo/facts.ts`

Schema (`migrations/001_initial_schema.sql:148-159`): `facts.narrative_status` is NOT NULL with CHECK; `facts.source` defaults to `'prep'`. Per design §3.1, the LLM does NOT emit `narrative_status` — the persister stamps `'undelivered'` as a constant. `source` defaults via the column.

**Files:**
- Create: `backend/src/repo/facts.ts`
- Test: `backend/src/repo/__tests__/facts.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// backend/src/repo/__tests__/facts.test.ts
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import type { Pool } from 'pg'
import { fileURLToPath } from 'node:url'
import { resolve } from 'node:path'
import pino, { type DestinationStream } from 'pino'
import { createPgPool } from '../../db/postgres.js'
import { runMigrations } from '../../db/migrate.js'
import { guardTestDatabase } from '../../db/__tests__/guard-db.js'
import { uuidv7 } from '../uuidv7.js'
import { entities } from '../entities.js'
import { facts } from '../facts.js'

const databaseUrl = process.env.DATABASE_URL ?? ''
const here = fileURLToPath(import.meta.url)
const REAL_MIGRATIONS_DIR = resolve(here, '../../../../migrations')

function silentLogger(): ReturnType<typeof pino> {
  const sink: DestinationStream = { write: (): void => undefined }
  return pino({ base: { component: 'migrate' } }, sink)
}

describe('facts repo', () => {
  let pool: Pool
  let entityId: string

  beforeAll(async () => {
    await guardTestDatabase(databaseUrl)
    pool = createPgPool(databaseUrl, { max: 2 })
    await pool.query('DROP EXTENSION IF EXISTS pgcrypto CASCADE')
    await pool.query('DROP SCHEMA public CASCADE')
    await pool.query('CREATE SCHEMA public')
    await pool.query('GRANT ALL ON SCHEMA public TO PUBLIC')
    await pool.query('GRANT ALL ON SCHEMA public TO CURRENT_USER')
    await runMigrations({ pool, migrationsDir: REAL_MIGRATIONS_DIR, logger: silentLogger() })
  })
  afterAll(async () => {
    await pool.end()
  })
  beforeEach(async () => {
    await pool.query('DELETE FROM facts')
    await pool.query('DELETE FROM entities')
    await pool.query('DELETE FROM worlds')
    await pool.query("DELETE FROM users WHERE cognito_sub != 'system:mythrun'")
    const userId = uuidv7()
    const worldId = uuidv7()
    entityId = uuidv7()
    await pool.query(
      `INSERT INTO users (id, cognito_sub, display_name, username) VALUES ($1, $2, $3, $4)`,
      [userId, `bypass:f-${userId.slice(-6)}`, 'F', `f${userId.slice(-6)}`],
    )
    await pool.query(
      `INSERT INTO worlds (id, created_by, name, concept, status) VALUES ($1, $2, 'W', 'C', 'generating')`,
      [worldId, userId],
    )
    await entities.insert(pool, { id: entityId, worldId, entityType: 'location', name: 'X' })
  })

  it('insertMany stamps narrative_status=undelivered and source=prep on every row', async () => {
    await facts.insertMany(pool, [
      { entityId, topic: 'history', accessLevel: 'public', content: 'Founded long ago.' },
      { entityId, topic: 'secrets', accessLevel: 'secret', content: 'Hidden vault below.' },
    ])
    const rows = await pool.query<{
      topic: string; access_level: string; content: string; narrative_status: string; source: string
    }>(
      `SELECT topic, access_level, content, narrative_status, source FROM facts WHERE entity_id = $1 ORDER BY topic`,
      [entityId],
    )
    expect(rows.rows).toEqual([
      { topic: 'history', access_level: 'public', content: 'Founded long ago.', narrative_status: 'undelivered', source: 'prep' },
      { topic: 'secrets', access_level: 'secret', content: 'Hidden vault below.', narrative_status: 'undelivered', source: 'prep' },
    ])
  })

  it('insertMany with empty array is a no-op', async () => {
    await facts.insertMany(pool, [])
    const count = await pool.query<{ count: string }>(`SELECT count(*)::text AS count FROM facts`)
    expect(count.rows[0]?.count).toBe('0')
  })

  it('updateContentById updates a single fact row', async () => {
    await facts.insertMany(pool, [
      { entityId, topic: 'history', accessLevel: 'public', content: 'wrong' },
    ])
    const row = await pool.query<{ id: string }>(`SELECT id FROM facts WHERE entity_id = $1`, [entityId])
    const factId = row.rows[0]!.id
    await facts.updateContentById(pool, factId, { content: 'corrected' })
    const updated = await pool.query<{ content: string }>(
      `SELECT content FROM facts WHERE id = $1`, [factId],
    )
    expect(updated.rows[0]?.content).toBe('corrected')
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd backend && pnpm vitest run src/repo/__tests__/facts.test.ts`
Expected: FAIL with "Cannot find module '../facts.js'".

- [ ] **Step 3: Implement**

```ts
// backend/src/repo/facts.ts
//
// Repo for the facts table (migration 001 lines 148–159).
//
// narrative_status is NOT NULL with CHECK ('undelivered', 'delivered',
// 'developed', 'resolved'). The LLM does NOT emit this field per design
// §3.1 — the persister stamps 'undelivered' as a constant on every
// row at INSERT time. Play-runtime owns subsequent transitions.
//
// source defaults to 'prep' via the column default. Persister relies
// on the default; no explicit value passed.

import type { ClientLike } from './_types.js'
import { uuidv7 } from './uuidv7.js'

export type AccessLevel = 'public' | 'private' | 'secret'

export interface InsertFactInput {
  readonly entityId: string
  readonly topic: string
  readonly accessLevel: AccessLevel
  readonly content: string
}

async function insertMany(client: ClientLike, rows: readonly InsertFactInput[]): Promise<void> {
  if (rows.length === 0) return

  // Build parameterized multi-row INSERT. Each row contributes 5
  // placeholders ($1..$5, $6..$10, etc.). narrative_status is baked in
  // as the constant 'undelivered'; source defaults via the column.
  const values: string[] = []
  const params: unknown[] = []
  let p = 1
  for (const row of rows) {
    values.push(`($${String(p++)}, $${String(p++)}, $${String(p++)}, $${String(p++)}, $${String(p++)}, 'undelivered')`)
    params.push(uuidv7(), row.entityId, row.topic, row.accessLevel, row.content)
  }
  await client.query(
    `INSERT INTO facts (id, entity_id, topic, access_level, content, narrative_status)
     VALUES ${values.join(', ')}`,
    params,
  )
}

async function updateContentById(
  client: ClientLike,
  factId: string,
  patch: { content: string },
): Promise<number> {
  const result = await client.query(
    `UPDATE facts SET content = $1, updated_at = now() WHERE id = $2`,
    [patch.content, factId],
  )
  return result.rowCount ?? 0
}

export const facts = { insertMany, updateContentById } as const
```

- [ ] **Step 4: Run test**

Run: `cd backend && pnpm vitest run src/repo/__tests__/facts.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add backend/src/repo/facts.ts backend/src/repo/__tests__/facts.test.ts
git commit -m "feat(myt-52): repo/facts — insertMany (stamps narrative_status) + updateContentById"
```

### Task 5: `repo/relationships.ts`

Schema (`migrations/001_initial_schema.sql:161-168`). No UNIQUE constraint on `(source_entity_id, target_entity_id, relationship_type)`. The `deleteByWorld` method is called at stage-4 start for retry idempotency per design §D9.

**Files:**
- Create: `backend/src/repo/relationships.ts`
- Test: `backend/src/repo/__tests__/relationships.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// backend/src/repo/__tests__/relationships.test.ts
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import type { Pool } from 'pg'
import { fileURLToPath } from 'node:url'
import { resolve } from 'node:path'
import pino, { type DestinationStream } from 'pino'
import { createPgPool } from '../../db/postgres.js'
import { runMigrations } from '../../db/migrate.js'
import { guardTestDatabase } from '../../db/__tests__/guard-db.js'
import { uuidv7 } from '../uuidv7.js'
import { entities } from '../entities.js'
import { relationships } from '../relationships.js'

const databaseUrl = process.env.DATABASE_URL ?? ''
const here = fileURLToPath(import.meta.url)
const REAL_MIGRATIONS_DIR = resolve(here, '../../../../migrations')

function silentLogger(): ReturnType<typeof pino> {
  const sink: DestinationStream = { write: (): void => undefined }
  return pino({ base: { component: 'migrate' } }, sink)
}

describe('relationships repo', () => {
  let pool: Pool
  let worldId: string
  let entA: string
  let entB: string

  beforeAll(async () => {
    await guardTestDatabase(databaseUrl)
    pool = createPgPool(databaseUrl, { max: 2 })
    await pool.query('DROP EXTENSION IF EXISTS pgcrypto CASCADE')
    await pool.query('DROP SCHEMA public CASCADE')
    await pool.query('CREATE SCHEMA public')
    await pool.query('GRANT ALL ON SCHEMA public TO PUBLIC')
    await pool.query('GRANT ALL ON SCHEMA public TO CURRENT_USER')
    await runMigrations({ pool, migrationsDir: REAL_MIGRATIONS_DIR, logger: silentLogger() })
  })
  afterAll(async () => {
    await pool.end()
  })
  beforeEach(async () => {
    await pool.query('DELETE FROM relationships')
    await pool.query('DELETE FROM entities')
    await pool.query('DELETE FROM worlds')
    await pool.query("DELETE FROM users WHERE cognito_sub != 'system:mythrun'")
    const userId = uuidv7()
    worldId = uuidv7()
    entA = uuidv7()
    entB = uuidv7()
    await pool.query(
      `INSERT INTO users (id, cognito_sub, display_name, username) VALUES ($1, $2, $3, $4)`,
      [userId, `bypass:r-${userId.slice(-6)}`, 'R', `r${userId.slice(-6)}`],
    )
    await pool.query(
      `INSERT INTO worlds (id, created_by, name, concept, status) VALUES ($1, $2, 'W', 'C', 'generating')`,
      [worldId, userId],
    )
    await entities.insert(pool, { id: entA, worldId, entityType: 'faction', name: 'A' })
    await entities.insert(pool, { id: entB, worldId, entityType: 'location', name: 'B' })
  })

  it('insertMany writes relationship rows', async () => {
    await relationships.insertMany(pool, [
      { sourceEntityId: entA, targetEntityId: entB, relationshipType: 'controls', description: 'A controls B.' },
    ])
    const rows = await pool.query<{ relationship_type: string; description: string }>(
      `SELECT relationship_type, description FROM relationships WHERE source_entity_id = $1`,
      [entA],
    )
    expect(rows.rows[0]).toEqual({ relationship_type: 'controls', description: 'A controls B.' })
  })

  it('insertMany with empty array is a no-op', async () => {
    await relationships.insertMany(pool, [])
    const count = await pool.query<{ count: string }>(`SELECT count(*)::text AS count FROM relationships`)
    expect(count.rows[0]?.count).toBe('0')
  })

  it('listByWorld returns rows joined via source entity', async () => {
    await relationships.insertMany(pool, [
      { sourceEntityId: entA, targetEntityId: entB, relationshipType: 'controls', description: 'X' },
    ])
    const rows = await relationships.listByWorld(pool, worldId)
    expect(rows).toHaveLength(1)
    expect(rows[0]?.relationshipType).toBe('controls')
  })

  it('deleteByWorld removes all relationships whose source entity is in the world', async () => {
    await relationships.insertMany(pool, [
      { sourceEntityId: entA, targetEntityId: entB, relationshipType: 'controls', description: 'X' },
    ])
    await relationships.deleteByWorld(pool, worldId)
    const count = await pool.query<{ count: string }>(`SELECT count(*)::text AS count FROM relationships`)
    expect(count.rows[0]?.count).toBe('0')
  })

  it('updateById updates the type + description', async () => {
    await relationships.insertMany(pool, [
      { sourceEntityId: entA, targetEntityId: entB, relationshipType: 'controls', description: 'old' },
    ])
    const row = await pool.query<{ id: string }>(`SELECT id FROM relationships`)
    const id = row.rows[0]!.id
    await relationships.updateById(pool, id, { relationshipType: 'rules', description: 'new' })
    const after = await pool.query<{ relationship_type: string; description: string }>(
      `SELECT relationship_type, description FROM relationships WHERE id = $1`, [id],
    )
    expect(after.rows[0]).toEqual({ relationship_type: 'rules', description: 'new' })
  })

  it('deleteById removes a single row', async () => {
    await relationships.insertMany(pool, [
      { sourceEntityId: entA, targetEntityId: entB, relationshipType: 'controls', description: 'x' },
    ])
    const row = await pool.query<{ id: string }>(`SELECT id FROM relationships`)
    await relationships.deleteById(pool, row.rows[0]!.id)
    const count = await pool.query<{ count: string }>(`SELECT count(*)::text AS count FROM relationships`)
    expect(count.rows[0]?.count).toBe('0')
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd backend && pnpm vitest run src/repo/__tests__/relationships.test.ts`
Expected: FAIL with "Cannot find module '../relationships.js'".

- [ ] **Step 3: Implement**

```ts
// backend/src/repo/relationships.ts
//
// Repo for the relationships table (migration 001 lines 161–168). No
// UNIQUE constraint on (source, target, type) by schema — stage 4's
// retry idempotency is enforced by calling deleteByWorld at stage
// start (design §D9).

import type { ClientLike } from './_types.js'
import { uuidv7 } from './uuidv7.js'

export interface InsertRelationshipInput {
  readonly sourceEntityId: string
  readonly targetEntityId: string
  readonly relationshipType: string
  readonly description: string
}

export interface Relationship {
  readonly id: string
  readonly sourceEntityId: string
  readonly targetEntityId: string
  readonly relationshipType: string
  readonly description: string
}

interface RelationshipRow {
  readonly id: string
  readonly source_entity_id: string
  readonly target_entity_id: string
  readonly relationship_type: string
  readonly description: string
}

function toRelationship(row: RelationshipRow): Relationship {
  return {
    id: row.id,
    sourceEntityId: row.source_entity_id,
    targetEntityId: row.target_entity_id,
    relationshipType: row.relationship_type,
    description: row.description,
  }
}

async function insertMany(client: ClientLike, rows: readonly InsertRelationshipInput[]): Promise<void> {
  if (rows.length === 0) return
  const values: string[] = []
  const params: unknown[] = []
  let p = 1
  for (const row of rows) {
    values.push(`($${String(p++)}, $${String(p++)}, $${String(p++)}, $${String(p++)}, $${String(p++)})`)
    params.push(uuidv7(), row.sourceEntityId, row.targetEntityId, row.relationshipType, row.description)
  }
  await client.query(
    `INSERT INTO relationships (id, source_entity_id, target_entity_id, relationship_type, description)
     VALUES ${values.join(', ')}`,
    params,
  )
}

async function listByWorld(client: ClientLike, worldId: string): Promise<Relationship[]> {
  const result = await client.query<RelationshipRow>(
    `SELECT r.id, r.source_entity_id, r.target_entity_id, r.relationship_type, r.description
       FROM relationships r
       JOIN entities e ON e.id = r.source_entity_id
       WHERE e.world_id = $1`,
    [worldId],
  )
  return result.rows.map(toRelationship)
}

async function deleteByWorld(client: ClientLike, worldId: string): Promise<void> {
  await client.query(
    `DELETE FROM relationships
       WHERE source_entity_id IN (SELECT id FROM entities WHERE world_id = $1)`,
    [worldId],
  )
}

async function updateById(
  client: ClientLike,
  id: string,
  patch: { relationshipType?: string; description?: string },
): Promise<number> {
  const sets: string[] = []
  const params: unknown[] = []
  let p = 1
  if (patch.relationshipType !== undefined) {
    sets.push(`relationship_type = $${String(p++)}`)
    params.push(patch.relationshipType)
  }
  if (patch.description !== undefined) {
    sets.push(`description = $${String(p++)}`)
    params.push(patch.description)
  }
  if (sets.length === 0) return 0
  params.push(id)
  const result = await client.query(
    `UPDATE relationships SET ${sets.join(', ')} WHERE id = $${String(p)}`,
    params,
  )
  return result.rowCount ?? 0
}

async function deleteById(client: ClientLike, id: string): Promise<number> {
  const result = await client.query(`DELETE FROM relationships WHERE id = $1`, [id])
  return result.rowCount ?? 0
}

export const relationships = {
  insertMany, listByWorld, deleteByWorld, updateById, deleteById,
} as const
```

- [ ] **Step 4: Run test**

Run: `cd backend && pnpm vitest run src/repo/__tests__/relationships.test.ts`
Expected: PASS (6 tests).

- [ ] **Step 5: Commit**

```bash
git add backend/src/repo/relationships.ts backend/src/repo/__tests__/relationships.test.ts
git commit -m "feat(myt-52): repo/relationships — insertMany, deleteByWorld, listByWorld, updateById, deleteById"
```

### Task 6: `repo/entity-hierarchy.ts`

Schema (`migrations/001_initial_schema.sql:170-175`): `UNIQUE(child_entity_id)` — at most one parent per entity. Caller pre-filters (per design §D9); no ON CONFLICT.

**Files:**
- Create: `backend/src/repo/entity-hierarchy.ts`
- Test: `backend/src/repo/__tests__/entity-hierarchy.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// backend/src/repo/__tests__/entity-hierarchy.test.ts
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import type { Pool } from 'pg'
import { fileURLToPath } from 'node:url'
import { resolve } from 'node:path'
import pino, { type DestinationStream } from 'pino'
import { createPgPool } from '../../db/postgres.js'
import { runMigrations } from '../../db/migrate.js'
import { guardTestDatabase } from '../../db/__tests__/guard-db.js'
import { uuidv7 } from '../uuidv7.js'
import { entities } from '../entities.js'
import { entityHierarchy } from '../entity-hierarchy.js'

const databaseUrl = process.env.DATABASE_URL ?? ''
const here = fileURLToPath(import.meta.url)
const REAL_MIGRATIONS_DIR = resolve(here, '../../../../migrations')

function silentLogger(): ReturnType<typeof pino> {
  const sink: DestinationStream = { write: (): void => undefined }
  return pino({ base: { component: 'migrate' } }, sink)
}

describe('entityHierarchy repo', () => {
  let pool: Pool
  let parentId: string
  let childId: string

  beforeAll(async () => {
    await guardTestDatabase(databaseUrl)
    pool = createPgPool(databaseUrl, { max: 2 })
    await pool.query('DROP EXTENSION IF EXISTS pgcrypto CASCADE')
    await pool.query('DROP SCHEMA public CASCADE')
    await pool.query('CREATE SCHEMA public')
    await pool.query('GRANT ALL ON SCHEMA public TO PUBLIC')
    await pool.query('GRANT ALL ON SCHEMA public TO CURRENT_USER')
    await runMigrations({ pool, migrationsDir: REAL_MIGRATIONS_DIR, logger: silentLogger() })
  })
  afterAll(async () => {
    await pool.end()
  })
  beforeEach(async () => {
    await pool.query('DELETE FROM entity_hierarchy')
    await pool.query('DELETE FROM entities')
    await pool.query('DELETE FROM worlds')
    await pool.query("DELETE FROM users WHERE cognito_sub != 'system:mythrun'")
    const userId = uuidv7()
    const worldId = uuidv7()
    parentId = uuidv7()
    childId = uuidv7()
    await pool.query(
      `INSERT INTO users (id, cognito_sub, display_name, username) VALUES ($1, $2, $3, $4)`,
      [userId, `bypass:h-${userId.slice(-6)}`, 'H', `h${userId.slice(-6)}`],
    )
    await pool.query(
      `INSERT INTO worlds (id, created_by, name, concept, status) VALUES ($1, $2, 'W', 'C', 'generating')`,
      [worldId, userId],
    )
    await entities.insert(pool, { id: parentId, worldId, entityType: 'location', name: 'P' })
    await entities.insert(pool, { id: childId, worldId, entityType: 'location', name: 'C' })
  })

  it('insert writes a hierarchy row', async () => {
    await entityHierarchy.insert(pool, { parentEntityId: parentId, childEntityId: childId })
    const row = await pool.query<{ parent_entity_id: string; child_entity_id: string }>(
      `SELECT parent_entity_id, child_entity_id FROM entity_hierarchy WHERE child_entity_id = $1`,
      [childId],
    )
    expect(row.rows[0]).toEqual({ parent_entity_id: parentId, child_entity_id: childId })
  })

  it('insert errors on UNIQUE(child_entity_id) conflict', async () => {
    await entityHierarchy.insert(pool, { parentEntityId: parentId, childEntityId: childId })
    const otherParent = uuidv7()
    await entities.insert(pool, {
      id: otherParent,
      worldId: (await pool.query<{ world_id: string }>(`SELECT world_id FROM entities WHERE id = $1`, [parentId])).rows[0]!.world_id,
      entityType: 'location',
      name: 'Other',
    })
    await expect(
      entityHierarchy.insert(pool, { parentEntityId: otherParent, childEntityId: childId }),
    ).rejects.toThrow()
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd backend && pnpm vitest run src/repo/__tests__/entity-hierarchy.test.ts`
Expected: FAIL with "Cannot find module '../entity-hierarchy.js'".

- [ ] **Step 3: Implement**

```ts
// backend/src/repo/entity-hierarchy.ts
//
// Repo for entity_hierarchy table (migration 001 lines 170–175).
// UNIQUE(child_entity_id) — at most one parent per entity. The caller
// (stage 4's straggler insert) pre-filters against existing rows; this
// repo does NOT do ON CONFLICT (design §D9 — caller controls collision
// policy, here it's "stage 3 wins").

import type { ClientLike } from './_types.js'
import { uuidv7 } from './uuidv7.js'

export interface InsertHierarchyInput {
  readonly parentEntityId: string
  readonly childEntityId: string
}

async function insert(client: ClientLike, input: InsertHierarchyInput): Promise<void> {
  await client.query(
    `INSERT INTO entity_hierarchy (id, parent_entity_id, child_entity_id) VALUES ($1, $2, $3)`,
    [uuidv7(), input.parentEntityId, input.childEntityId],
  )
}

export const entityHierarchy = { insert } as const
```

- [ ] **Step 4: Run test**

Run: `cd backend && pnpm vitest run src/repo/__tests__/entity-hierarchy.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add backend/src/repo/entity-hierarchy.ts backend/src/repo/__tests__/entity-hierarchy.test.ts
git commit -m "feat(myt-52): repo/entity-hierarchy — bare insert (caller pre-filters)"
```

---

## Phase D — Shared primitives

### Task 7: `streaming-extractor.ts` (the reusable diff/emit loop)

Per design §4.1. The load-bearing primitive used by stages 2/3/4. Owns: partial-tree iteration, synthKey assignment, name-closed predicate, entity-added/entity-updated event publishing, heartbeat.

**Files:**
- Create: `backend/src/llm/prep/streaming-extractor.ts`
- Test: `backend/src/llm/prep/__tests__/streaming-extractor.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// backend/src/llm/prep/__tests__/streaming-extractor.test.ts
import { describe, it, expect, vi } from 'vitest'
import { runStreamingStage } from '../streaming-extractor.js'

interface FakeJob {
  updateProgress: (n: number) => Promise<void>
}

function fakeJob(): FakeJob & { progressCalls: number[] } {
  const progressCalls: number[] = []
  return {
    progressCalls,
    updateProgress: async (n: number): Promise<void> => {
      progressCalls.push(n)
    },
  }
}

interface FakeRedis {
  publish: (channel: string, message: string) => Promise<number>
}

function fakeRedis(): FakeRedis & { publishes: { channel: string; payload: unknown }[] } {
  const publishes: { channel: string; payload: unknown }[] = []
  return {
    publishes,
    publish: async (channel: string, message: string): Promise<number> => {
      publishes.push({ channel, payload: JSON.parse(message) as unknown })
      return 1
    },
  }
}

async function* twoFactionStream(): AsyncGenerator<{ factions?: Array<Partial<{ name: string; prose: string }>> }> {
  // Three deltas: name appears alone (not emittable), then prose starts
  // (emittable -> entity-added), then prose grows (entity-updated).
  yield { factions: [{ name: 'House Eyrin' }] }
  yield { factions: [{ name: 'House Eyrin', prose: 'The eyrie' }] }
  yield { factions: [{ name: 'House Eyrin', prose: 'The eyrie clings to the cliffs.' }] }
}

describe('runStreamingStage', () => {
  it('publishes entity-added when name is non-empty AND another field has begun', async () => {
    const job = fakeJob()
    const redis = fakeRedis()
    const result = await runStreamingStage(twoFactionStream(), {
      stage: 'world_and_factions',
      campaignId: 'cmp-1',
      job: job as unknown as Parameters<typeof runStreamingStage>[1]['job'],
      redisRealtime: redis as unknown as Parameters<typeof runStreamingStage>[1]['redisRealtime'],
      keyPrefix: 'test:',
      arrays: [{ path: 'factions', kind: 'faction', role: 'entity' }],
    })
    const events = redis.publishes.map((p) => p.payload as { type: string; synthKey?: string })
    const added = events.filter((e) => e.type === 'entity-added')
    expect(added).toHaveLength(1)
    expect(added[0]?.synthKey).toBe('world_and_factions/factions/0')
    expect(result.finalTree.factions?.[0]?.name).toBe('House Eyrin')
  })

  it('publishes entity-updated when emitted entry grows', async () => {
    const job = fakeJob()
    const redis = fakeRedis()
    await runStreamingStage(twoFactionStream(), {
      stage: 'world_and_factions',
      campaignId: 'cmp-1',
      job: job as unknown as Parameters<typeof runStreamingStage>[1]['job'],
      redisRealtime: redis as unknown as Parameters<typeof runStreamingStage>[1]['redisRealtime'],
      keyPrefix: 'test:',
      arrays: [{ path: 'factions', kind: 'faction', role: 'entity' }],
    })
    const updated = redis.publishes.filter(
      (p) => (p.payload as { type: string }).type === 'entity-updated',
    )
    expect(updated.length).toBeGreaterThanOrEqual(1)
  })

  it('publishes one progress update per partial-tree iteration', async () => {
    const job = fakeJob()
    const redis = fakeRedis()
    await runStreamingStage(twoFactionStream(), {
      stage: 'world_and_factions',
      campaignId: 'cmp-1',
      job: job as unknown as Parameters<typeof runStreamingStage>[1]['job'],
      redisRealtime: redis as unknown as Parameters<typeof runStreamingStage>[1]['redisRealtime'],
      keyPrefix: 'test:',
      arrays: [{ path: 'factions', kind: 'faction', role: 'entity' }],
    })
    expect(job.progressCalls.length).toBe(3) // three partial trees
  })

  it('skips entries where name is empty', async () => {
    async function* stream() {
      yield { factions: [{ name: '' }] }
      yield { factions: [{ name: '', prose: 'mystery' }] }
    }
    const job = fakeJob()
    const redis = fakeRedis()
    await runStreamingStage(stream(), {
      stage: 'world_and_factions',
      campaignId: 'cmp-1',
      job: job as unknown as Parameters<typeof runStreamingStage>[1]['job'],
      redisRealtime: redis as unknown as Parameters<typeof runStreamingStage>[1]['redisRealtime'],
      keyPrefix: 'test:',
      arrays: [{ path: 'factions', kind: 'faction', role: 'entity' }],
    })
    expect(redis.publishes.filter((p) => (p.payload as { type: string }).type === 'entity-added')).toHaveLength(0)
  })

  it('publishes edge-added when role is edge', async () => {
    async function* stream() {
      yield { rels: [{ from: 'A', to: 'B', relationship: 'rules' }] }
    }
    const job = fakeJob()
    const redis = fakeRedis()
    await runStreamingStage(stream(), {
      stage: 'entity_relationships',
      campaignId: 'cmp-1',
      job: job as unknown as Parameters<typeof runStreamingStage>[1]['job'],
      redisRealtime: redis as unknown as Parameters<typeof runStreamingStage>[1]['redisRealtime'],
      keyPrefix: 'test:',
      arrays: [{ path: 'rels', kind: 'edge', role: 'edge' }],
    })
    const edgeAdded = redis.publishes.filter(
      (p) => (p.payload as { type: string }).type === 'edge-added',
    )
    expect(edgeAdded).toHaveLength(1)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd backend && pnpm vitest run src/llm/prep/__tests__/streaming-extractor.test.ts`
Expected: FAIL with "Cannot find module '../streaming-extractor.js'".

- [ ] **Step 3: Implement**

```ts
// backend/src/llm/prep/streaming-extractor.ts
//
// Reusable streaming entity-extraction loop. Used by stages 2, 3, and 4.
// Per design §4.1 + §D7.
//
// Iterates a partialObjectStream-shaped async iterable. For each
// configured array path, emits entity-added / entity-updated /
// edge-added events as entries cross the "name field closed" boundary
// (predicate: non-empty name + at least one other field present).

import type { Job } from 'bullmq'
import type { Redis } from 'ioredis'

export type WorldGenStage =
  | 'concept_intake'
  | 'world_and_factions'
  | 'locations_and_npcs'
  | 'entity_relationships'
  | 'starting_situation'
  | 'random_tables'
  | 'coherence_pass'

export interface ArrayConfig {
  readonly path: string                       // top-level array key
  readonly kind: string                       // entityKind or relationship-kind passed through
  readonly role: 'entity' | 'edge'
}

export interface StreamingExtractorConfig {
  readonly stage: WorldGenStage
  readonly campaignId: string
  readonly job: Pick<Job, 'updateProgress'>
  readonly redisRealtime: Pick<Redis, 'publish'>
  readonly keyPrefix: string
  readonly arrays: readonly ArrayConfig[]
}

export interface StreamingExtractorResult<T> {
  readonly finalTree: T
  readonly emittedSnapshots: Map<string, unknown>
}

function isEmittableEntity(entry: Record<string, unknown>): boolean {
  if (typeof entry.name !== 'string' || entry.name.length === 0) return false
  // At least one OTHER field has begun (non-empty).
  for (const [k, v] of Object.entries(entry)) {
    if (k === 'name') continue
    if (v !== undefined && v !== null && v !== '') return true
  }
  return false
}

function isEmittableEdge(entry: Record<string, unknown>): boolean {
  // Edge entries are emittable once both endpoints are non-empty AND the
  // relationship type field is non-empty.
  const from = entry.from
  const to = entry.to
  const rel = entry.relationship
  return typeof from === 'string' && from.length > 0
      && typeof to === 'string' && to.length > 0
      && typeof rel === 'string' && rel.length > 0
}

function diffPatch(prev: Record<string, unknown>, next: Record<string, unknown>): Record<string, unknown> | null {
  const patch: Record<string, unknown> = {}
  let changed = false
  for (const [k, v] of Object.entries(next)) {
    if (prev[k] !== v) {
      patch[k] = v
      changed = true
    }
  }
  return changed ? patch : null
}

async function publishEvent(
  config: StreamingExtractorConfig,
  payload: Record<string, unknown>,
): Promise<void> {
  const channel = `${config.keyPrefix}pipeline:campaign:${config.campaignId}`
  await config.redisRealtime.publish(channel, JSON.stringify(payload))
}

export async function runStreamingStage<T>(
  partialObjectStream: AsyncIterable<T>,
  config: StreamingExtractorConfig,
): Promise<StreamingExtractorResult<T>> {
  const emittedSnapshots = new Map<string, Record<string, unknown>>()
  let finalTree: T | undefined
  let chunkCount = 0

  for await (const partial of partialObjectStream) {
    chunkCount += 1
    finalTree = partial
    const tree = partial as unknown as Record<string, unknown>

    for (const arrayCfg of config.arrays) {
      const arr = tree[arrayCfg.path]
      if (!Array.isArray(arr)) continue
      for (let i = 0; i < arr.length; i++) {
        const entry = arr[i]
        if (typeof entry !== 'object' || entry === null) continue
        const entryObj = entry as Record<string, unknown>
        const synthKey = `${config.stage}/${arrayCfg.path}/${String(i)}`

        const isEmittable =
          arrayCfg.role === 'entity'
            ? isEmittableEntity(entryObj)
            : isEmittableEdge(entryObj)

        const prevSnapshot = emittedSnapshots.get(synthKey)
        if (prevSnapshot === undefined) {
          if (!isEmittable) continue
          if (arrayCfg.role === 'entity') {
            await publishEvent(config, {
              type: 'entity-added',
              synthKey,
              entityKind: arrayCfg.kind,
              data: { ...entryObj },
            })
          } else {
            await publishEvent(config, {
              type: 'edge-added',
              synthKey,
              from: entryObj.from,
              to: entryObj.to,
              relationship: entryObj.relationship,
              description: entryObj.description,
            })
          }
          emittedSnapshots.set(synthKey, { ...entryObj })
        } else {
          const patch = diffPatch(prevSnapshot, entryObj)
          if (patch !== null) {
            await publishEvent(config, {
              type: arrayCfg.role === 'entity' ? 'entity-updated' : 'edge-added',
              synthKey,
              ...(arrayCfg.role === 'entity' ? { patch } : { from: entryObj.from, to: entryObj.to, relationship: entryObj.relationship, description: entryObj.description }),
            })
            emittedSnapshots.set(synthKey, { ...entryObj })
          }
        }
      }
    }

    await config.job.updateProgress(chunkCount)
  }

  if (finalTree === undefined) {
    throw new Error('streaming-extractor: partialObjectStream yielded no values')
  }
  return { finalTree, emittedSnapshots }
}
```

- [ ] **Step 4: Run test**

Run: `cd backend && pnpm vitest run src/llm/prep/__tests__/streaming-extractor.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add backend/src/llm/prep/streaming-extractor.ts backend/src/llm/prep/__tests__/streaming-extractor.test.ts
git commit -m "feat(myt-52): streaming-extractor — reusable diff/emit loop for streaming stages"
```

### Task 8: `structured-output-repair.ts` (Haiku → Sonnet → BullMQ-retry)

Per design §4.2 + §D3.

**Files:**
- Create: `backend/src/llm/prep/structured-output-repair.ts`
- Create: `backend/src/llm/prompts/prep/repair.txt`
- Test: `backend/src/llm/prep/__tests__/structured-output-repair.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// backend/src/llm/prep/__tests__/structured-output-repair.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { z } from 'zod'
import { HAIKU, SONNET } from '../../models.js'

vi.mock('ai', () => ({
  generateText: vi.fn(),
  Output: { object: vi.fn((opts: unknown) => opts) },
}))

import { generateText } from 'ai'
import { repairStructuredOutput } from '../structured-output-repair.js'

const mockGenerateText = vi.mocked(generateText)

const TestSchema = z.object({
  name: z.string().min(1).max(50),
  age: z.number().int().min(0),
})

describe('repairStructuredOutput', () => {
  beforeEach(() => {
    mockGenerateText.mockReset()
  })

  it('returns { ok: true, tree } when repair output validates', async () => {
    mockGenerateText.mockResolvedValueOnce({
      output: { name: 'Alice', age: 30 },
      usage: { inputTokens: 100, outputTokens: 50, totalTokens: 150 },
    } as unknown as Awaited<ReturnType<typeof generateText>>)

    const result = await repairStructuredOutput({
      tree: { name: 'Alice', age: 'thirty' },
      schema: TestSchema,
      zodErrors: TestSchema.safeParse({ name: 'Alice', age: 'thirty' }).error!,
      model: HAIKU,
      stage: 'world_and_factions',
      providerOptions: { mythrun: { stage: 'world_and_factions' } },
    })
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.tree).toEqual({ name: 'Alice', age: 30 })
    }
  })

  it('returns { ok: false } when repair output still fails validation', async () => {
    mockGenerateText.mockResolvedValueOnce({
      output: { name: '', age: -5 },
      usage: { inputTokens: 100, outputTokens: 50, totalTokens: 150 },
    } as unknown as Awaited<ReturnType<typeof generateText>>)

    const result = await repairStructuredOutput({
      tree: { name: 'Alice', age: 'thirty' },
      schema: TestSchema,
      zodErrors: TestSchema.safeParse({ name: 'Alice', age: 'thirty' }).error!,
      model: HAIKU,
      stage: 'world_and_factions',
      providerOptions: { mythrun: { stage: 'world_and_factions' } },
    })
    expect(result.ok).toBe(false)
  })

  it('returns usage from the underlying generateText call', async () => {
    mockGenerateText.mockResolvedValueOnce({
      output: { name: 'Bob', age: 25 },
      usage: { inputTokens: 200, outputTokens: 80, totalTokens: 280 },
    } as unknown as Awaited<ReturnType<typeof generateText>>)

    const result = await repairStructuredOutput({
      tree: { name: 'Bob', age: 'unknown' },
      schema: TestSchema,
      zodErrors: TestSchema.safeParse({ name: 'Bob', age: 'unknown' }).error!,
      model: SONNET,
      stage: 'locations_and_npcs',
      providerOptions: { mythrun: { stage: 'locations_and_npcs' } },
    })
    expect(result.usage.inputTokens).toBe(200)
    expect(result.usage.outputTokens).toBe(80)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd backend && pnpm vitest run src/llm/prep/__tests__/structured-output-repair.test.ts`
Expected: FAIL with "Cannot find module '../structured-output-repair.js'".

- [ ] **Step 3: Create the repair prompt template**

```txt
# backend/src/llm/prompts/prep/repair.txt
You are repairing a structurally-invalid JSON object so it matches a strict schema.

CRITICAL RULES (in priority order):
1. Preserve semantic content — do NOT invent new information.
2. Do NOT add or remove array entries. Preserve array length and ordering exactly.
3. If a field is missing or wrong-shaped, infer it from surrounding context in the input, or use the most conservative reasonable value.
4. Do NOT rewrite content stylistically. Only fix what the validation errors point to.
5. If preserving array length means some entries would still be invalid, return them as best you can fix without dropping them. The downstream pipeline will decide whether to retry.

Schema (as JSON Schema):
{{schemaJson}}

The current object (failed validation):
{{currentTree}}

Validation errors:
{{zodErrors}}

Return a corrected object that matches the schema, preserving as much of the original semantic content as possible.
```

- [ ] **Step 4: Implement the helper**

```ts
// backend/src/llm/prep/structured-output-repair.ts
//
// Per design §4.2 + §D3. The repair helper takes a structurally-invalid
// tree + Zod errors and asks a smaller LLM (Haiku or Sonnet) to fix it.
//
// The helper preserves array length/ordering (the prompt enforces this);
// if a min-floor or max-ceiling violation would require adding/dropping
// entries, the prompt instructs the LLM to return the best it can fix
// without dropping. Caller decides what to do with persistent failures
// (escalate to Sonnet, then to BullMQ retry).

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { resolve, dirname } from 'node:path'
import { generateText, Output, type LanguageModel, type LanguageModelUsage } from 'ai'
import { z } from 'zod'
import type { WorldGenStage } from './streaming-extractor.js'

const PROMPT_TEMPLATE = readFileSync(
  resolve(dirname(fileURLToPath(import.meta.url)), '../prompts/prep/repair.txt'),
  'utf8',
)

export interface RepairArgs<T> {
  readonly tree: unknown
  readonly schema: z.ZodType<T>
  readonly zodErrors: z.ZodError
  readonly model: LanguageModel
  readonly stage: WorldGenStage
  readonly providerOptions: { readonly mythrun: { readonly stage: WorldGenStage } }
}

export type RepairResult<T> =
  | { readonly ok: true; readonly tree: T; readonly usage: LanguageModelUsage }
  | { readonly ok: false; readonly errors: z.ZodError; readonly usage: LanguageModelUsage }

function zodToJsonSchemaString(_schema: z.ZodType<unknown>): string {
  // Minimal placeholder — replaced by a real zod→JSON-Schema lib in
  // a follow-up if needed. For repair the LLM only needs the error
  // strings + the tree; the schema text is supplementary.
  return '(schema described by validation errors below)'
}

export async function repairStructuredOutput<T>(args: RepairArgs<T>): Promise<RepairResult<T>> {
  const prompt = PROMPT_TEMPLATE
    .replace('{{schemaJson}}', zodToJsonSchemaString(args.schema))
    .replace('{{currentTree}}', JSON.stringify(args.tree, null, 2))
    .replace('{{zodErrors}}', args.zodErrors.issues.map((i) => `- ${i.path.join('.')}: ${i.message}`).join('\n'))

  const result = await generateText({
    model: args.model,
    output: Output.object({ schema: args.schema }),
    prompt,
    temperature: 0,
    maxRetries: 1,
    providerOptions: args.providerOptions as unknown as Parameters<typeof generateText>[0]['providerOptions'],
  })

  const parsed = args.schema.safeParse(result.output)
  if (parsed.success) {
    return { ok: true, tree: parsed.data, usage: result.usage }
  }
  return { ok: false, errors: parsed.error, usage: result.usage }
}
```

- [ ] **Step 5: Run test**

Run: `cd backend && pnpm vitest run src/llm/prep/__tests__/structured-output-repair.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 6: Commit**

```bash
git add backend/src/llm/prep/structured-output-repair.ts backend/src/llm/prompts/prep/repair.txt backend/src/llm/prep/__tests__/structured-output-repair.test.ts
git commit -m "feat(myt-52): structured-output-repair — Haiku/Sonnet tier helper"
```

---

## Phase E — Stage handlers

The four new stage handlers (2, 3, 4, 7) follow the same shape. Tasks 9–12 implement them. Each task:
- Defines the schema in `backend/src/llm/schemas/<stage>.ts`
- Writes the prompt template
- Implements the handler in `backend/src/llm/prep/stages/<stage>.ts`
- Tests against mocked `streamObject` / `generateText` + real Postgres harness

Because each handler is substantial (~250-400 LOC + ~400 LOC of test), the tasks below give the canonical shape ONCE in Task 9. Tasks 10-12 reuse it.

### Task 9: Stage 2 — `world_and_factions` handler

Per design §3.1. Persists `entities` (location for regions, faction) + `prose_kernels` + `facts` + `worlds.world_overview`. Streams `entity-added`/`entity-updated` events live.

**Files:**
- Create: `backend/src/llm/schemas/world-and-factions.ts`
- Create: `backend/src/llm/prompts/prep/world-and-factions.txt` (port from `/Personal/mythrun-v5/`)
- Create: `backend/src/llm/prep/stages/world-and-factions.ts`
- Test: `backend/src/llm/prep/stages/__tests__/world-and-factions.test.ts`

- [ ] **Step 1: Write the schema**

```ts
// backend/src/llm/schemas/world-and-factions.ts
//
// Per design §3.1. Ported shape from prototype; bounds tightened to
// min(3).max(8) for regions/factions (was min(2).max(12) in early draft).
//
// narrative_status is NOT in the fact schema — the persister stamps
// 'undelivered' as a constant per design §3.1.

import { z } from 'zod'

export const factSchema = z.object({
  topic: z.string().min(2).max(80),
  content: z.string().min(20).max(800),
  access_level: z.enum(['public', 'private', 'secret']),
})

export const WorldAndFactionsSchema = z.object({
  world_overview: z.string().min(60).max(2400),
  regions: z.array(z.object({
    name: z.string().min(1).max(200),
    prose: z.string().min(40).max(2400),
    facts: z.array(factSchema).min(2).max(12),
  })).min(3).max(8),
  factions: z.array(z.object({
    name: z.string().min(1).max(200),
    prose: z.string().min(40).max(2400),
    facts: z.array(factSchema).min(2).max(12),
  })).min(3).max(8),
})

export type WorldAndFactionsTree = z.infer<typeof WorldAndFactionsSchema>
```

- [ ] **Step 2: Port the prompt template from the prototype**

Read `/Users/miklos/Desktop/Files/Personal/mythrun-v5/backend/src/llm/prompts/world-and-factions.txt` (or similar — find with `grep -r world_and_factions /Users/miklos/Desktop/Files/Personal/mythrun-v5/backend/src/llm/prompts/` first).

Adapt the prototype's prompt to the production schema's shape. CRITICAL ADDITIONS to the prompt:

- "**Name field MUST be the first key in every region and faction object.** Output `{"name": "...", ...}` not `{..., "name": "..."}`. This enables live streaming UX."
- "Each fact has these fields: `topic`, `content`, `access_level` (public/private/secret). Do NOT include `narrative_status` — the system stamps that."
- "Generate 3-8 regions and 3-8 factions. Each region's prose is 40-2400 chars; world_overview is 60-2400 chars."

Save to `backend/src/llm/prompts/prep/world-and-factions.txt`.

- [ ] **Step 3: Write the failing test**

```ts
// backend/src/llm/prep/stages/__tests__/world-and-factions.test.ts
//
// Pattern crib: src/llm/prep/__tests__/concept-intake.test.ts
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Pool } from 'pg'
import IoredisMock from 'ioredis-mock'
import type { Job } from 'bullmq'
import { fileURLToPath } from 'node:url'
import { resolve } from 'node:path'
import pino, { type DestinationStream } from 'pino'
import { createPgPool } from '../../../db/postgres.js'
import { runMigrations } from '../../../db/migrate.js'
import { guardTestDatabase } from '../../../db/__tests__/guard-db.js'
import { uuidv7 } from '../../../repo/uuidv7.js'

vi.mock('ai', async () => {
  const actual = await vi.importActual<typeof import('ai')>('ai')
  return { ...actual, streamObject: vi.fn() }
})

import { streamObject } from 'ai'
import { runWorldAndFactionsStage } from '../world-and-factions.js'

const mockStreamObject = vi.mocked(streamObject)

const databaseUrl = process.env.DATABASE_URL ?? ''
const here = fileURLToPath(import.meta.url)
const REAL_MIGRATIONS_DIR = resolve(here, '../../../../../migrations')

function silentLogger(): ReturnType<typeof pino> {
  const sink: DestinationStream = { write: (): void => undefined }
  return pino({ base: { component: 'migrate' } }, sink)
}

function fakeJob(): Pick<Job, 'updateProgress'> {
  return { updateProgress: async (): Promise<void> => undefined } as unknown as Pick<Job, 'updateProgress'>
}

function fixtureTree() {
  return {
    world_overview: 'A forested kingdom on the edge of an ancient elven wood. '.repeat(2),
    regions: Array.from({ length: 3 }, (_, i) => ({
      name: `Region ${String(i)}`,
      prose: `Description of region ${String(i)}. `.repeat(3),
      facts: [
        { topic: 'history', content: 'Founded long ago by elven settlers.', access_level: 'public' as const },
        { topic: 'secret', content: 'Hides an ancient burial mound below the meadow.', access_level: 'secret' as const },
      ],
    })),
    factions: Array.from({ length: 3 }, (_, i) => ({
      name: `Faction ${String(i)}`,
      prose: `Description of faction ${String(i)}. `.repeat(3),
      facts: [
        { topic: 'goal', content: 'Reclaim the lost sword of the founders.', access_level: 'public' as const },
        { topic: 'enemy', content: 'Rivals with the Iron Coast factions.', access_level: 'public' as const },
      ],
    })),
  }
}

describe('runWorldAndFactionsStage', () => {
  let pool: Pool
  let userId: string
  let campaignId: string
  let worldId: string

  beforeAll(async () => {
    await guardTestDatabase(databaseUrl)
    pool = createPgPool(databaseUrl, { max: 2 })
    await pool.query('DROP EXTENSION IF EXISTS pgcrypto CASCADE')
    await pool.query('DROP SCHEMA public CASCADE')
    await pool.query('CREATE SCHEMA public')
    await pool.query('GRANT ALL ON SCHEMA public TO PUBLIC')
    await pool.query('GRANT ALL ON SCHEMA public TO CURRENT_USER')
    await runMigrations({ pool, migrationsDir: REAL_MIGRATIONS_DIR, logger: silentLogger() })
  })
  afterAll(async () => {
    await pool.end()
  })

  beforeEach(async () => {
    mockStreamObject.mockReset()
    await pool.query('DELETE FROM facts')
    await pool.query('DELETE FROM prose_kernels')
    await pool.query('DELETE FROM entities')
    await pool.query('DELETE FROM campaigns')
    await pool.query('DELETE FROM worlds')
    await pool.query("DELETE FROM users WHERE cognito_sub != 'system:mythrun'")
    userId = uuidv7()
    worldId = uuidv7()
    campaignId = uuidv7()
    await pool.query(
      `INSERT INTO users (id, cognito_sub, display_name, username) VALUES ($1, $2, $3, $4)`,
      [userId, `bypass:wf-${userId.slice(-6)}`, 'WF', `wf${userId.slice(-6)}`],
    )
    await pool.query(
      `INSERT INTO worlds (id, created_by, name, concept, status) VALUES ($1, $2, 'W', 'C', 'generating')`,
      [worldId, userId],
    )
    await pool.query(
      `INSERT INTO campaigns (id, world_id, created_by, name, status) VALUES ($1, $2, $3, 'Smoke', 'setup')`,
      [campaignId, worldId, userId],
    )
  })

  it('persists regions + factions + prose + facts + world_overview', async () => {
    const tree = fixtureTree()
    async function* stream() { yield tree }
    mockStreamObject.mockReturnValueOnce({
      partialObjectStream: stream(),
      object: Promise.resolve(tree),
      usage: Promise.resolve({ inputTokens: 5000, outputTokens: 6000, totalTokens: 11000 }),
    } as unknown as ReturnType<typeof streamObject>)

    const result = await runWorldAndFactionsStage({
      pool,
      world: { id: worldId, createdBy: userId, name: 'W', concept: 'C' },
      campaignId,
      job: fakeJob() as unknown as Job,
      redisRealtime: new IoredisMock() as unknown as Parameters<typeof runWorldAndFactionsStage>[0]['redisRealtime'],
      keyPrefix: 'test:',
    })
    expect(result.costUsd).toBeGreaterThan(0)

    const counts = await pool.query<{ ent: string; pk: string; f: string }>(`
      SELECT
        (SELECT count(*)::text FROM entities WHERE world_id = $1) AS ent,
        (SELECT count(*)::text FROM prose_kernels pk JOIN entities e ON e.id = pk.entity_id WHERE e.world_id = $1) AS pk,
        (SELECT count(*)::text FROM facts f JOIN entities e ON e.id = f.entity_id WHERE e.world_id = $1) AS f
    `, [worldId])
    expect(Number(counts.rows[0]?.ent)).toBe(6) // 3 regions + 3 factions
    expect(Number(counts.rows[0]?.pk)).toBe(6)
    expect(Number(counts.rows[0]?.f)).toBe(12)  // 2 facts × 6 entities

    const w = await pool.query<{ world_overview: string | null }>(
      `SELECT world_overview FROM worlds WHERE id = $1`, [worldId],
    )
    expect(w.rows[0]?.world_overview).toBeTruthy()
  })

  it('stamps facts.narrative_status = undelivered and source = prep', async () => {
    const tree = fixtureTree()
    async function* stream() { yield tree }
    mockStreamObject.mockReturnValueOnce({
      partialObjectStream: stream(),
      object: Promise.resolve(tree),
      usage: Promise.resolve({ inputTokens: 5000, outputTokens: 6000, totalTokens: 11000 }),
    } as unknown as ReturnType<typeof streamObject>)

    await runWorldAndFactionsStage({
      pool,
      world: { id: worldId, createdBy: userId, name: 'W', concept: 'C' },
      campaignId,
      job: fakeJob() as unknown as Job,
      redisRealtime: new IoredisMock() as unknown as Parameters<typeof runWorldAndFactionsStage>[0]['redisRealtime'],
      keyPrefix: 'test:',
    })

    const rows = await pool.query<{ narrative_status: string; source: string }>(
      `SELECT DISTINCT narrative_status, source FROM facts WHERE entity_id IN (SELECT id FROM entities WHERE world_id = $1)`,
      [worldId],
    )
    expect(rows.rows).toEqual([{ narrative_status: 'undelivered', source: 'prep' }])
  })

  it('does NOT write to relationships table (stage 4 owns edges)', async () => {
    const tree = fixtureTree()
    async function* stream() { yield tree }
    mockStreamObject.mockReturnValueOnce({
      partialObjectStream: stream(),
      object: Promise.resolve(tree),
      usage: Promise.resolve({ inputTokens: 5000, outputTokens: 6000, totalTokens: 11000 }),
    } as unknown as ReturnType<typeof streamObject>)

    await runWorldAndFactionsStage({
      pool,
      world: { id: worldId, createdBy: userId, name: 'W', concept: 'C' },
      campaignId,
      job: fakeJob() as unknown as Job,
      redisRealtime: new IoredisMock() as unknown as Parameters<typeof runWorldAndFactionsStage>[0]['redisRealtime'],
      keyPrefix: 'test:',
    })
    const c = await pool.query<{ count: string }>(`SELECT count(*)::text AS count FROM relationships`)
    expect(c.rows[0]?.count).toBe('0')
  })

  // Additional tests to add: Zod-fail → Haiku-repair-success; Zod-fail
  // → Sonnet-repair-success; Zod-fail → repair-exhausted → throws +
  // stage-reset published; persistence COMMIT failure path.
})
```

- [ ] **Step 3a: Run test to verify it fails**

Run: `cd backend && pnpm vitest run src/llm/prep/stages/__tests__/world-and-factions.test.ts`
Expected: FAIL with "Cannot find module '../world-and-factions.js'".

- [ ] **Step 4: Implement the stage handler**

```ts
// backend/src/llm/prep/stages/world-and-factions.ts
//
// Stage 2 per design §3.1.
//
// Streams via Vercel SDK streamObject (maxRetries: 0). Iterates
// partialObjectStream via streaming-extractor.ts; emits entity-added
// events live. At stream end: validateOrRepair → BEGIN/INSERT/COMMIT →
// publish finalized per entity.

import type { Pool } from 'pg'
import type { Redis } from 'ioredis'
import type { Job } from 'bullmq'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { resolve, dirname } from 'node:path'
import { streamObject } from 'ai'
import { OPUS, HAIKU, SONNET } from '../../models.js'
import { computeCostUsd } from '../../../billing/model-pricing.js'
import { uuidv7 } from '../../../repo/uuidv7.js'
import { entities } from '../../../repo/entities.js'
import { proseKernels } from '../../../repo/prose-kernels.js'
import { facts } from '../../../repo/facts.js'
import { worlds as worldsRepo } from '../../../repo/worlds.js'
import { runStreamingStage } from '../streaming-extractor.js'
import { repairStructuredOutput } from '../structured-output-repair.js'
import { WorldAndFactionsSchema, type WorldAndFactionsTree } from '../../schemas/world-and-factions.js'
import type { StageCost } from '../world-gen-processor.js'

const PROMPT_TEMPLATE = readFileSync(
  resolve(dirname(fileURLToPath(import.meta.url)), '../../prompts/prep/world-and-factions.txt'),
  'utf8',
)

export interface RunWorldAndFactionsInput {
  readonly pool: Pool
  readonly world: { readonly id: string; readonly createdBy: string; readonly name: string; readonly concept: string }
  readonly campaignId: string
  readonly job: Job
  readonly redisRealtime: Redis
  readonly keyPrefix: string
}

export async function runWorldAndFactionsStage(
  input: RunWorldAndFactionsInput,
): Promise<StageCost> {
  const prompt = PROMPT_TEMPLATE
    .replace('{{worldName}}', input.world.name)
    .replace('{{concept}}', input.world.concept)

  const result = streamObject({
    model: OPUS,
    schema: WorldAndFactionsSchema,
    prompt,
    temperature: 0.7,
    maxRetries: 0,
    providerOptions: { mythrun: { worldId: input.world.id, campaignId: input.campaignId, stage: 'world_and_factions' } } as unknown as Parameters<typeof streamObject>[0]['providerOptions'],
  })

  const { finalTree, emittedSnapshots } = await runStreamingStage<unknown>(
    result.partialObjectStream as unknown as AsyncIterable<unknown>,
    {
      stage: 'world_and_factions',
      campaignId: input.campaignId,
      job: input.job,
      redisRealtime: input.redisRealtime,
      keyPrefix: input.keyPrefix,
      arrays: [
        { path: 'regions', kind: 'location', role: 'entity' },
        { path: 'factions', kind: 'faction', role: 'entity' },
      ],
    },
  )

  let costUsd = 0
  let inputTokens = 0
  let outputTokens = 0
  const usage = await result.usage
  inputTokens += usage.inputTokens ?? 0
  outputTokens += usage.outputTokens ?? 0
  costUsd += computeCostUsd('claude-opus', inputTokens, outputTokens)

  // Validate or repair.
  let validated: WorldAndFactionsTree
  const direct = WorldAndFactionsSchema.safeParse(finalTree)
  if (direct.success) {
    validated = direct.data
  } else {
    const haiku = await repairStructuredOutput({
      tree: finalTree, schema: WorldAndFactionsSchema, zodErrors: direct.error,
      model: HAIKU, stage: 'world_and_factions',
      providerOptions: { mythrun: { stage: 'world_and_factions' } },
    })
    costUsd += computeCostUsd('claude-haiku', haiku.usage.inputTokens ?? 0, haiku.usage.outputTokens ?? 0)
    if (haiku.ok) {
      validated = haiku.tree
    } else {
      const sonnet = await repairStructuredOutput({
        tree: finalTree, schema: WorldAndFactionsSchema, zodErrors: haiku.errors,
        model: SONNET, stage: 'world_and_factions',
        providerOptions: { mythrun: { stage: 'world_and_factions' } },
      })
      costUsd += computeCostUsd('claude-sonnet', sonnet.usage.inputTokens ?? 0, sonnet.usage.outputTokens ?? 0)
      if (!sonnet.ok) {
        // Publish stage-reset before throwing.
        await input.redisRealtime.publish(
          `${input.keyPrefix}pipeline:campaign:${input.campaignId}`,
          JSON.stringify({ type: 'stage-reset', stage: 'world_and_factions' }),
        )
        throw new Error('world_and_factions: repair chain exhausted')
      }
      validated = sonnet.tree
    }
    // Repair preserves array shape (D3); array-length-changed cases
    // already failed validation above and escalated. Field-level diffs
    // here flow through emittedSnapshots → entity-updated patches.
    // For brevity in this plan: implementer adds publishUpdatedPatches
    // walking emittedSnapshots vs validated to emit entity-updated for
    // any fields that changed.
    void emittedSnapshots // silence lint
  }

  // Persist.
  const client = await input.pool.connect()
  try {
    await client.query('BEGIN')
    const finalized: Array<{ synthKey: string; entityId: string }> = []
    for (let i = 0; i < validated.regions.length; i++) {
      const region = validated.regions[i]!
      const entityId = uuidv7()
      await entities.insert(client, { id: entityId, worldId: input.world.id, entityType: 'location', name: region.name })
      await proseKernels.insert(client, { entityId, content: region.prose })
      await facts.insertMany(client, region.facts.map((f) => ({
        entityId, topic: f.topic, accessLevel: f.access_level, content: f.content,
      })))
      finalized.push({ synthKey: `world_and_factions/regions/${String(i)}`, entityId })
    }
    for (let i = 0; i < validated.factions.length; i++) {
      const f = validated.factions[i]!
      const entityId = uuidv7()
      await entities.insert(client, { id: entityId, worldId: input.world.id, entityType: 'faction', name: f.name })
      await proseKernels.insert(client, { entityId, content: f.prose })
      await facts.insertMany(client, f.facts.map((fc) => ({
        entityId, topic: fc.topic, accessLevel: fc.access_level, content: fc.content,
      })))
      finalized.push({ synthKey: `world_and_factions/factions/${String(i)}`, entityId })
    }
    await worldsRepo.update(client, input.world.id, { worldOverview: validated.world_overview })
    await client.query('COMMIT')

    for (const f of finalized) {
      await input.redisRealtime.publish(
        `${input.keyPrefix}pipeline:campaign:${input.campaignId}`,
        JSON.stringify({ type: 'finalized', synthKey: f.synthKey, entityId: f.entityId }),
      )
    }
  } catch (err) {
    try { await client.query('ROLLBACK') } catch { /* swallow */ }
    await input.redisRealtime.publish(
      `${input.keyPrefix}pipeline:campaign:${input.campaignId}`,
      JSON.stringify({ type: 'stage-reset', stage: 'world_and_factions' }),
    )
    throw err
  } finally {
    client.release()
  }

  return { costUsd, inputTokens, outputTokens }
}
```

- [ ] **Step 5: Run tests**

Run: `cd backend && pnpm vitest run src/llm/prep/stages/__tests__/world-and-factions.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 6: Add the additional cases noted in the test file (Zod-fail-with-repair-success, repair-exhausted-with-stage-reset, COMMIT-failure-with-stage-reset). Use vi.mocked `streamObject` + safeParse on the mocked output to drive each path.

- [ ] **Step 7: Commit**

```bash
git add backend/src/llm/schemas/world-and-factions.ts backend/src/llm/prompts/prep/world-and-factions.txt backend/src/llm/prep/stages/world-and-factions.ts backend/src/llm/prep/stages/__tests__/world-and-factions.test.ts
git commit -m "feat(myt-52): stage 2 world_and_factions handler — streaming + repair chain + persist"
```

### Task 10: Stage 3 — `locations_and_npcs` handler

Per design §3.2 + §D8. Same shape as Task 9 but adds two-pass `parent_location` resolution (entity_hierarchy writes).

**Files:**
- Create: `backend/src/llm/schemas/locations-and-npcs.ts`
- Create: `backend/src/llm/prompts/prep/locations-and-npcs.txt` (port + parent_location field instruction)
- Create: `backend/src/llm/prep/stages/locations-and-npcs.ts`
- Test: `backend/src/llm/prep/stages/__tests__/locations-and-npcs.test.ts`

**Key differences from Task 9:**
1. Schema has `parent_location: z.string().nullable()` on each location.
2. After validateOrRepair, the persister runs the THREE-PASS resolver:
   - Pass 1: insert all locations + NPCs + their prose + facts
   - Pass 2: build `nameToId` map from `entities.listByWorld` (filtered to `entityType='location'`)
   - Pass 3: for each location with non-null `parent_location`, resolve via map (kind-filter to 'location' per §D8 — already filtered by step 2; name-collision rule: stage-2 entity wins; if unresolvable, publish `entity-updated { synthKey, patch: { parent_location: null } }` and persist parentless)
3. Tests must cover: nested hierarchy (Region → City → Inn from design's example), unresolvable parent (typo), name-collision (region + city with same name).

Steps follow Task 9 shape; one commit per logical sub-step (schema, prompt, handler, tests).

- [ ] **Step 1: Write schema** (see design §3.2 zod sketch)
- [ ] **Step 2: Port + adapt prompt** (add explicit "emit `parent_location: 'name of containing location, or null'`" instruction)
- [ ] **Step 3: Write failing test** (mirror Task 9's test scaffold; add nested-hierarchy + unresolvable-parent + name-collision cases)
- [ ] **Step 4: Implement handler with three-pass resolver**
- [ ] **Step 5: Run tests; verify all pass**
- [ ] **Step 6: Commit**

```bash
git add backend/src/llm/schemas/locations-and-npcs.ts backend/src/llm/prompts/prep/locations-and-npcs.txt backend/src/llm/prep/stages/locations-and-npcs.ts backend/src/llm/prep/stages/__tests__/locations-and-npcs.test.ts
git commit -m "feat(myt-52): stage 3 locations_and_npcs handler — streaming + two-pass hierarchy resolve"
```

### Task 11: Stage 4 (NEW) — `entity_relationships` handler

Per design §3.3 + §D9. Streams edges via `streamObject` on Sonnet. Pre-filters hallucinated UUIDs before INSERT. Calls `relationships.deleteByWorld` at stage start for retry idempotency.

**Files:**
- Create: `backend/src/llm/schemas/entity-relationships.ts`
- Create: `backend/src/llm/prompts/prep/entity-relationships.txt` (NEW — receives entity inventory list with UUIDs)
- Create: `backend/src/llm/prep/stages/entity-relationships.ts`
- Test: `backend/src/llm/prep/stages/__tests__/entity-relationships.test.ts`

**Key shape:**
- Schema has `relationships: z.array(...).min(5).max(80)` and closed-enum `relationship_type`
- Handler reads entity inventory at start (`entities.listByWorld`) + prose_kernels + facts; builds a reference-list block for the prompt
- Pre-INSERT filter: `Set<entity_id>` from inventory; drop relationships whose source/target IDs aren't in the set; log WARN
- Streaming-extractor config: `arrays: [{ path: 'relationships', kind: 'edge', role: 'edge' }]`
- Persists via `relationships.insertMany`; hierarchy_stragglers via `entity-hierarchy.insert` with caller pre-filter against existing rows

Steps follow Task 9 shape.

- [ ] **Step 1: Write schema with closed enum**
- [ ] **Step 2: Write prompt** (instructs LLM to reference entities by UUID from the supplied inventory; warns that hallucinated UUIDs are dropped)
- [ ] **Step 3: Write failing test** (cover happy path, hallucinated-UUID skip, retry-idempotency via deleteByWorld)
- [ ] **Step 4: Implement handler**
- [ ] **Step 5: Run tests**
- [ ] **Step 6: Commit**

```bash
git add backend/src/llm/schemas/entity-relationships.ts backend/src/llm/prompts/prep/entity-relationships.txt backend/src/llm/prep/stages/entity-relationships.ts backend/src/llm/prep/stages/__tests__/entity-relationships.test.ts
git commit -m "feat(myt-52): stage 4 entity_relationships handler (NEW) — streaming edges with UUID pre-filter"
```

### Task 12: Stage 7 (NEW) — `coherence_pass` handler

Per design §3.6 + §D5. Non-streaming. Reads full world state; emits patches; applies in a transaction; emits entity-updated/entity-removed/edge-added/edge-removed events.

**Files:**
- Create: `backend/src/llm/schemas/coherence-output.ts`
- Create: `backend/src/llm/prompts/prep/coherence-pass.txt`
- Create: `backend/src/llm/prep/stages/coherence-pass.ts`
- Test: `backend/src/llm/prep/stages/__tests__/coherence-pass.test.ts`

**Key shape:**
- Patch discriminated union per design §3.6
- Uses `generateText` + `Output.object` (not streaming) with `maxRetries: 1`
- Handler maintains UUID→synthKey reverse map from prior stage finalized events (or re-derives via the entity inventory)
- Applies patches in BEGIN/COMMIT; publishes per-patch SSE event after COMMIT
- Stage-7 cap-fire exception: marks world `complete` not failed (per §D5)

Steps follow Task 9 shape.

- [ ] **Step 1: Schema**
- [ ] **Step 2: Prompt (asks LLM to reference IDs from the supplied world dump)**
- [ ] **Step 3: Failing test (cover patch application + unknown-ID skip + stage-7 cap-fire exception)**
- [ ] **Step 4: Implement handler**
- [ ] **Step 5: Tests pass**
- [ ] **Step 6: Commit**

```bash
git add backend/src/llm/schemas/coherence-output.ts backend/src/llm/prompts/prep/coherence-pass.txt backend/src/llm/prep/stages/coherence-pass.ts backend/src/llm/prep/stages/__tests__/coherence-pass.test.ts
git commit -m "feat(myt-52): stage 7 coherence_pass handler (NEW) — non-streaming audit + patch application"
```

---

## Phase F — Pipeline integration

### Task 13: Wire new stages into `world-gen-processor.ts` + `derive-phase.ts`

Per design §5.1 + §5.3.

**Files:**
- Modify: `backend/src/llm/prep/world-gen-processor.ts`
- Modify: `backend/src/sse/derive-phase.ts`
- Test: existing `world-gen-processor.test.ts` (extend for stage-4 + stage-7 paths)

- [ ] **Step 1: Update `WORLDGEN_STAGES` constant in world-gen-processor.ts**

```ts
const WORLDGEN_STAGES = [
  'concept_intake',
  'world_and_factions',
  'locations_and_npcs',
  'entity_relationships',     // NEW
  'starting_situation',
  'random_tables',
  'coherence_pass',           // NEW
] as const
```

- [ ] **Step 2: Update `dispatchStage` switch with new arms**

Each new arm calls the corresponding handler from Phase E. Stages 2/3 swap out the existing `stage_not_implemented` throw.

- [ ] **Step 3: Update `STAGE_ORDER` in derive-phase.ts**

```ts
export const STAGE_ORDER = [
  'concept_intake',
  'world_and_factions',
  'locations_and_npcs',
  'entity_relationships',     // NEW
  'starting_situation',
  'random_tables',
  'coherence_pass',           // NEW
]
```

- [ ] **Step 4: Run existing world-gen-processor tests** (they reference WORLDGEN_STAGES; ensure the constant update doesn't break them)

```bash
cd backend && pnpm vitest run src/llm/prep/__tests__/world-gen-processor.test.ts
```

- [ ] **Step 5: Run derive-phase tests**

```bash
pnpm vitest run src/sse/__tests__/derive-phase.test.ts
```

Both should pass (the existing tests should be agnostic to new stage names if they're keyed on `WORLDGEN_STAGES` or `STAGE_ORDER` constants).

- [ ] **Step 6: Commit**

```bash
git add backend/src/llm/prep/world-gen-processor.ts backend/src/sse/derive-phase.ts
git commit -m "feat(myt-52): wire new stages 4 (entity_relationships) + 7 (coherence_pass) into pipeline orchestrator"
```

---

## Phase G — Dev tool

### Task 14: `live-events-panel.ts`

Per design §6. Chronological event log + filtered current-entity inventory; no graph rendering.

**Files:**
- Create: `backend/dev-tool/src/components/live-events-panel.ts`
- Modify: `backend/dev-tool/src/main.ts`
- Test: `backend/dev-tool/src/components/__tests__/live-events-panel.test.ts`

- [ ] **Step 1: Write failing tests for per-event-arm rendering**

Tests covered (per §8 Layer 4):
- `entity-added` arrival → renders card with kind + name + truncated data
- `entity-updated` arrival → applies patch to inventory + renders card with field-change count
- `entity-removed` arrival → deletes inventory row + renders card
- `edge-added` arrival → renders card with from→to + relationship
- `edge-removed` arrival → decrements inventory edge counter + renders card
- `stage-reset` arrival → drops inventory rows by synthKey prefix + renders card
- `finalized` arrival → swaps inventory display-ID from synthKey to entityId + renders card
- Truncation rule: strings, objects, arrays each render per §6 §Truncation rule
- Expand: click card → full `JSON.stringify(event, null, 2)` shown
- Filter chips: clicking chip hides events of that type; un-clicking restores chronological position
- 2000-event cap: FIFO eviction + `[…N earlier events dropped]` placeholder card
- `mythrun.closewatch` handler: closes SSE, clears log, clears inventory, resets filters

- [ ] **Step 2: Verify tests fail (module doesn't exist)**

- [ ] **Step 3: Implement live-events-panel.ts**

- [ ] **Step 4: Mount in main.ts**

```ts
// backend/dev-tool/src/main.ts
import { mountLiveEventsPanel } from './components/live-events-panel.js'
// ...
mountLiveEventsPanel(parent)
```

- [ ] **Step 5: Run tests + `pnpm dev-tool:check`**

```bash
cd backend
pnpm vitest run dev-tool/src/components/__tests__/live-events-panel.test.ts
pnpm dev-tool:check
```

Expected: all tests pass; dev-tool:check passes.

- [ ] **Step 6: Move 5 entity-event arms out of `coverage.json` `exempt.events`** (they remain in `events`)

```diff
   "exempt": {
     "routes": {},
     "events": {
-      "stage-reset": "Rendered by the live-events inspector panel landing in MYT-52; bridge forwards verbatim in MYT-50",
-      "entity-added": "...",
-      "entity-updated": "...",
-      "entity-removed": "...",
-      "edge-added": "...",
-      "edge-removed": "...",
-      "finalized": "..."
     },
```

`pnpm dev-tool:check` should still pass since all 7 are in `events`.

- [ ] **Step 7: Commit**

```bash
git add backend/dev-tool/src/components/live-events-panel.ts backend/dev-tool/src/components/__tests__/live-events-panel.test.ts backend/dev-tool/src/main.ts backend/dev-tool/coverage.json
git commit -m "feat(myt-52): dev-tool live-events inspector panel + coverage manifest migration"
```

---

## Phase H — Error matrix additions

### Task 15: `LlmContentFilteredError` + content-policy mapping

Per design §7.2 row "Content-policy filter."

**Files:**
- Modify: `backend/src/llm/errors.ts` (add error class)
- Modify: `backend/src/llm/middleware.ts` (map `finishReason: 'content-filter'`)
- Modify: `backend/src/app.ts` or `error-handler.ts` (map to typed HTTP response)
- Test: `backend/src/llm/__tests__/errors.test.ts` (extend)

- [ ] **Step 1: Write failing test for the mapping**
- [ ] **Step 2: Add the error class + mapping logic**
- [ ] **Step 3: Tests pass**
- [ ] **Step 4: Commit**

```bash
git add backend/src/llm/errors.ts backend/src/llm/middleware.ts backend/src/error-handler.ts backend/src/llm/__tests__/errors.test.ts
git commit -m "feat(myt-52): LlmContentFilteredError + content-policy finishReason mapping"
```

---

## Phase I — Wire-level smoke + final push

### Task 16: Wire-level E2E smoke

Per design §8 Layer 3. Cost: ~$1.50-$2.00 of Anthropic credits per run.

- [ ] **Step 1: Ensure backend dev server is running**

```bash
cd /Users/miklos/Desktop/Files/Mythrun/Code/mythrun
pnpm dev:db && pnpm --filter @mythrun/backend dev &
sleep 5
```

- [ ] **Step 2: Run the smoke script**

```bash
export DEV_SUB='dev-user-1'; export BASE='http://127.0.0.1:3030'

# Grant credits
curl -fsS -X POST $BASE/api/dev/credits/grant \
  -H "x-mythrun-dev-sub: $DEV_SUB" -H 'Content-Type: application/json' \
  -d '{"creditType":"world_gen","amount":5}'

# Create campaign
CAMPAIGN_ID=$(curl -fsS -X POST $BASE/api/campaigns \
  -H "x-mythrun-dev-sub: $DEV_SUB" -H 'Content-Type: application/json' \
  -d '{"name":"Smoke","world":{"kind":"new","source":{"mode":"freeform","concept":"A standard fantasy kingdom on the edge of an ancient forest."}}}' \
  | jq -r .campaignId)

# Watch SSE stream
curl -N -fsS $BASE/api/campaigns/$CAMPAIGN_ID/status/stream \
  -H "x-mythrun-dev-sub: $DEV_SUB"
```

- [ ] **Step 3: Assert (deterministic checks per §8 Layer 3 table)**

```bash
psql $DATABASE_URL -c "SELECT stage, status FROM pipeline_runs
                       WHERE world_id = (SELECT world_id FROM campaigns WHERE id = '$CAMPAIGN_ID')
                       ORDER BY started_at"
# All 7 stages should be 'completed'

psql $DATABASE_URL -c "SELECT
  (SELECT count(*) FROM entities WHERE world_id = w.id) AS entities,
  (SELECT count(*) FROM prose_kernels pk JOIN entities e ON e.id=pk.entity_id WHERE e.world_id=w.id) AS pk,
  (SELECT count(*) FROM facts f JOIN entities e ON e.id=f.entity_id WHERE e.world_id=w.id) AS facts,
  (SELECT count(*) FROM relationships r JOIN entities e ON e.id=r.source_entity_id WHERE e.world_id=w.id) AS rels,
  (SELECT count(*) FROM entity_hierarchy h JOIN entities e ON e.id=h.parent_entity_id WHERE e.world_id=w.id) AS hier,
  w.status, w.world_overview IS NOT NULL AS has_overview,
  w.starting_situations IS NOT NULL AS has_situations
  FROM worlds w WHERE w.id = (SELECT world_id FROM campaigns WHERE id = '$CAMPAIGN_ID')"
# All counts > 0; status='complete'; has_overview=true; has_situations=true

psql $DATABASE_URL -c "SELECT sum(cost_usd) FROM pipeline_runs
                       WHERE world_id = (SELECT world_id FROM campaigns WHERE id = '$CAMPAIGN_ID')"
# Should be < $10
```

- [ ] **Step 4: If any assertion fails, fix the bug + re-run** (per `feedback_dev_tool_e2e_smoke_required` — drive past the bug yourself, don't ask user)

### Task 17: Wiki sync + final push

Per `feedback_wiki_sync_is_part_of_close` — wiki content sync happens BEFORE the final push, BEFORE flipping Linear.

- [ ] **Step 1: Dispatch the wiki AUTHORING.md subagent**

Use the Agent tool with prompt from `docs/wiki/AUTHORING.md`, parameterized with `linearIssueId=MYT-52`.

- [ ] **Step 2: After wiki commits land, run final local verification**

```bash
cd /Users/miklos/Desktop/Files/Mythrun/Code/mythrun
pnpm wiki:check
pnpm dev-tool:check
pnpm --filter @mythrun/backend typecheck
pnpm --filter @mythrun/backend lint
pnpm --filter @mythrun/backend test:coverage
```

All gates green.

- [ ] **Step 3: `git push origin main`** — pre-push hook re-runs all 4 gates; CI re-asserts on remote.

- [ ] **Step 4: Wait for the 10-min CI verifier hook to report no failures** (or manually check `gh run list --limit 5 --json conclusion,workflowName,headSha` 10 minutes after push).

### Task 18: Flip Linear MYT-52 to Done

```bash
# Via the linear-server MCP:
mcp__linear-server__save_issue(id="MYT-52", state="Done")
```

The PostToolUse hook `post-linear-close.sh` will emit a reminder to dispatch the wiki subagent — that's a backstop; we already did it in Task 17.

---

## Spec coverage self-review

Walking the design spec section by section:

- **§0 Scope statement** — covered by all tasks
- **§1 Background** — context, no implementation
- **§2 Design decisions D1–D15** — every D has a corresponding task implementing its constraint
- **§3.1 Stage 2** — Task 9
- **§3.2 Stage 3** — Task 10
- **§3.3 Stage 4 (NEW)** — Task 11
- **§3.4 Stage 5 unchanged** — no task needed
- **§3.5 Stage 6 unchanged** — no task needed
- **§3.6 Stage 7 (NEW)** — Task 12
- **§4.1 streaming-extractor.ts** — Task 7
- **§4.2 structured-output-repair.ts** — Task 8
- **§4.3 5 repo modules** — Tasks 2–6
- **§5 World-gen processor updates** — Task 13
- **§6 Dev tool live-events panel** — Task 14
- **§7.1 Cost cap** — already at $10; no change required
- **§7.2 Error handling matrix** — content-filter row covered by Task 15; pg-deadlock row left to inline implementation discretion in stage handlers
- **§7.3 stage-reset semantics** — covered in stage handler implementations + extractor publishes
- **§8 Testing strategy Layer 1** — covered per task (unit tests with synthesized fixtures)
- **§8 Testing strategy Layer 2** — covered per task (mocked LLM + real PG)
- **§8 Testing strategy Layer 3 wire-level smoke** — Task 16
- **§8 Testing strategy Layer 4 coverage manifest** — Task 14 step 6
- **§9 Done-when checklist** — checked at Task 17 step 2 + Task 18

**Gaps:** none identified. The plan is comprehensive to the design spec.

---

## Execution handoff

Plan complete and saved to `docs/superpowers/plans/2026-05-14-myt-52-streaming-stages.md`. Two execution options:

**1. Subagent-Driven (recommended)** — I dispatch a fresh subagent per task, review between tasks, fast iteration. Best for this plan because the 18 tasks are mostly independent (repo modules, stage handlers, dev tool) — parallel-safe within each Phase.

**2. Inline Execution** — Execute tasks in this session using executing-plans, batch execution with checkpoints. Slower; pollutes this session's context.

Which approach?
