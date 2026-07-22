# Session-Prep Smoke + Reusable Fixture Toolkit + Staging Gate (MYT-64) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.
>
> **Commit discipline (Mythrun):** implementer subagents do NOT `git add`/`commit`/`push`. Each task's "Commit" step is run by the CONTROLLER, serially, after the two-stage (spec + code-quality) review. Hold pushes until the issue is done (final verification → wiki subagent → single push). Some tasks are **controller-operational** (real-LLM capture / real-LLM smoke run) and are not "implementer writes code + tests" — they're marked.

**Goal:** Exercise `generateSessionPrep`'s real Opus call for the first time via a local constructed-direct smoke, built on a reusable smoke-fixture toolkit, and wire a staging-gate extension so the deployed prep pipeline stays covered.

**Architecture:** A generic fixture toolkit (`scripts/smoke/fixtures/`: a JSON-snapshot loader + a capture CLI + a per-fixture manifest) captures a real ready-to-play campaign once and replays it into mythrun_test. The local smoke loads that fixture, invokes `processSessionPrepJob` directly with real Opus + recording publishers, and asserts the plumbing (events, persisted prep, completed stage). The staging smoke (`prep-pipeline.ts`) gains a per-campaign session-prep trigger + prep-status SSE observe.

**Tech Stack:** Node 24 + TypeScript (strict) + Postgres via `pg` + Anthropic Opus (AI SDK `streamObject`) + Vitest. Smokes are `tsx` CLIs.

**Spec:** `docs/superpowers/specs/2026-06-03-myt-64-session-prep-smoke-design.md` (committed `a94ab70`).

---

## File Structure

**Create:**
- `backend/scripts/smoke/fixtures/types.ts` — `FixtureManifest` / `FixtureTableManifest` / `FixtureRootIds` (capture-side) + `FixtureFile` / `FixtureTableData` (the committed JSON shape).
- `backend/scripts/smoke/fixtures/load.ts` — `readFixture(name)` + `loadFixture(pool, name)` (the reusable engine).
- `backend/scripts/smoke/fixtures/capture.ts` — the one-time capture CLI.
- `backend/scripts/smoke/fixtures/ready-to-play-campaign.manifest.ts` — the first fixture's table set + filters.
- `backend/scripts/smoke/fixtures/ready-to-play-campaign.json` — captured in Task 3 (committed artifact).
- `backend/scripts/smoke/fixtures/__tests__/load.test.ts` — real-PG tests for `loadFixture` (mythrun_test).
- `backend/scripts/smoke/fixtures/__tests__/capture.test.ts` — real-PG round-trip test for capture→load.
- `backend/scripts/smoke/session-prep.ts` — the local constructed-direct smoke.

**Modify:**
- `backend/package.json` — add `smoke:session-prep` + `capture:ready-to-play` scripts.
- `backend/scripts/smoke/prep-pipeline.ts` — the staging session-prep extension.
- `docs/wiki/content/runtime/session-prep.html` — the smoke + capture runbook.

**Do NOT touch:** the session-prep processor / stage / event contracts (verified correct in review — §7 hardening is verify-and-document, no code). `src/**` (the toolkit is dev tooling, lives in `scripts/`). `infra/` Terraform unless Task 5's measure-first analysis shows the cap is actually exceeded.

**Toolkit placement note:** lives in `scripts/smoke/fixtures/` (dev tooling, alongside the other smoke scripts). Vitest's `parallel` project runs `scripts/**/*.test.ts` (a failing toolkit test fails the suite), but `coverage.include` is `src/**` only — so the toolkit is **tested but not under the 100% coverage gate**, same posture as `prep-pipeline.ts` et al. Do NOT add `c8` ignores or chase coverage on it.

---

## Task 1: Fixture toolkit — types + `loadFixture` engine

**Files:**
- Create: `backend/scripts/smoke/fixtures/types.ts`, `backend/scripts/smoke/fixtures/load.ts`
- Test: `backend/scripts/smoke/fixtures/__tests__/load.test.ts`

- [ ] **Step 1: Write the types**

`backend/scripts/smoke/fixtures/types.ts`:
```ts
// Reusable smoke-fixture toolkit (MYT-64). A fixture is a captured snapshot of a
// real DB entity-graph, replayed into mythrun_test for a smoke. See
// docs/superpowers/specs/2026-06-03-myt-64-session-prep-smoke-design.md §3.

/** Root ids a manifest's filters are scoped to. */
export interface FixtureRootIds {
  readonly campaignId: string
  readonly worldId: string
}

/** One table in a fixture's capture manifest (capture-side only). */
export interface FixtureTableManifest {
  readonly name: string
  /** `true` → a globalSetup-seeded shared row (e.g. dev users): the loader INSERTs it
   *  ON CONFLICT DO NOTHING and NEVER deletes it (deleting would corrupt the shared seed). */
  readonly shared?: boolean
  /** Root-scoped SELECT filter used by capture.ts to pull this table's rows. */
  readonly filter: (ids: FixtureRootIds) => { readonly sql: string; readonly params: readonly unknown[] }
}

/** A fixture's capture manifest: the durable record of "what graph this fixture is."
 *  Tables MUST be in FK-dependency order (parents before children). */
export interface FixtureManifest {
  readonly name: string
  readonly tables: readonly FixtureTableManifest[]
}

/** One table's captured rows in the committed JSON (load-side; self-contained). */
export interface FixtureTableData {
  readonly name: string
  readonly shared: boolean
  readonly rows: readonly Record<string, unknown>[]
}

/** The committed `<name>.json` shape. `loadFixture` needs only this — never the manifest. */
export interface FixtureFile {
  readonly name: string
  readonly capturedAt: string
  readonly schemaVersion: string
  readonly rootCampaignId: string
  readonly rootWorldId: string
  readonly tables: readonly FixtureTableData[]
}
```

- [ ] **Step 2: Write the failing test**

`backend/scripts/smoke/fixtures/__tests__/load.test.ts` (real-PG, mythrun_test; mirrors the repo test convention — `createTestPool` + `guardTestDatabase`). It hand-authors a tiny self-contained fixture file on disk (a 1-world / 1-entity / 1-shared-user graph) so the engine is tested WITHOUT the real capture:

```ts
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import type { Pool } from 'pg'
import { writeFileSync, rmSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { guardTestDatabase } from '../../../../src/db/__tests__/guard-db.js'
import { createTestPool } from '../../../../src/repo/__tests__/_helpers/test-pool.js'
import { uuidv7 } from '../../../../src/repo/uuidv7.js'
import { loadFixture } from '../load.js'
import type { FixtureFile } from '../types.js'

const databaseUrl = process.env.DATABASE_URL ?? ''
const FIX_DIR = join(dirname(fileURLToPath(import.meta.url)), '..')

// Fixed ids so the fixture is self-referential (worlds.created_by → users.id).
const SHARED_USER = '019700e0-0000-7000-8000-00000000d001' // a globalSetup dev user (seeded)
const WORLD_ID = '019e0000-0000-7000-8000-0000000000a1'
const ENTITY_ID = '019e0000-0000-7000-8000-0000000000b1'

function tinyFixture(): FixtureFile {
  return {
    name: 'toolkit-test-tiny',
    capturedAt: '2026-06-03T00:00:00.000Z',
    schemaVersion: '022_session_preps_unique.sql',
    rootCampaignId: WORLD_ID, // unused by the engine; any value
    rootWorldId: WORLD_ID,
    tables: [
      { name: 'users', shared: true, rows: [{ id: SHARED_USER, cognito_sub: 'fixture:should-not-insert', display_name: 'X', username: 'fixture_x' }] },
      { name: 'worlds', shared: false, rows: [{ id: WORLD_ID, created_by: SHARED_USER, name: 'Fixture World', concept: 'a tiny test world', status: 'complete', vocabulary_registry: { entries: [], adjacent_franchises: [] } }] },
      { name: 'entities', shared: false, rows: [{ id: ENTITY_ID, world_id: WORLD_ID, entity_type: 'location', name: 'Fixture Cove', access_level: 'known' }] },
    ],
  }
}

describe('loadFixture (smoke-fixture toolkit)', () => {
  let pool: Pool
  const fixturePath = join(FIX_DIR, 'toolkit-test-tiny.json')

  beforeAll(async () => {
    await guardTestDatabase(databaseUrl)
    pool = createTestPool(databaseUrl)
  })
  afterAll(async () => {
    rmSync(fixturePath, { force: true })
    // cleanup the loaded graph (NOT the shared user)
    await pool.query(`DELETE FROM entities WHERE id = $1`, [ENTITY_ID])
    await pool.query(`DELETE FROM worlds WHERE id = $1`, [WORLD_ID])
    await pool.end()
  })
  beforeEach(() => {
    writeFileSync(fixturePath, JSON.stringify(tinyFixture()), 'utf8')
  })

  it('loads the graph; jsonb column round-trips; shared row uses ON CONFLICT (not re-inserted)', async () => {
    // Prove the shared user already exists (globalSetup) and is NOT clobbered.
    const before = await pool.query<{ cognito_sub: string }>(`SELECT cognito_sub FROM users WHERE id = $1`, [SHARED_USER])
    expect(before.rows).toHaveLength(1)
    const seededSub = before.rows[0]?.cognito_sub

    await loadFixture(pool, 'toolkit-test-tiny')

    const world = await pool.query<{ status: string; vocabulary_registry: unknown }>(`SELECT status, vocabulary_registry FROM worlds WHERE id = $1`, [WORLD_ID])
    expect(world.rows[0]?.status).toBe('complete')
    expect(world.rows[0]?.vocabulary_registry).toEqual({ entries: [], adjacent_franchises: [] }) // jsonb round-trip
    const ent = await pool.query(`SELECT id FROM entities WHERE id = $1`, [ENTITY_ID])
    expect(ent.rows).toHaveLength(1)
    // Shared user untouched: ON CONFLICT DO NOTHING kept the seeded sub, not the fixture's.
    const after = await pool.query<{ cognito_sub: string }>(`SELECT cognito_sub FROM users WHERE id = $1`, [SHARED_USER])
    expect(after.rows[0]?.cognito_sub).toBe(seededSub)
    expect(after.rows[0]?.cognito_sub).not.toBe('fixture:should-not-insert')
  })

  it('is idempotent — loading twice leaves exactly one graph (delete-then-load), shared row survives', async () => {
    await loadFixture(pool, 'toolkit-test-tiny')
    await loadFixture(pool, 'toolkit-test-tiny')
    const worlds = await pool.query(`SELECT id FROM worlds WHERE id = $1`, [WORLD_ID])
    expect(worlds.rows).toHaveLength(1)
    const users = await pool.query(`SELECT id FROM users WHERE id = $1`, [SHARED_USER])
    expect(users.rows).toHaveLength(1) // shared row never deleted
  })

  it('throws a regenerate-hint when a row has a column the schema lacks', async () => {
    const bad = tinyFixture()
    const worldsTable = bad.tables.find((t) => t.name === 'worlds')
    ;(worldsTable as { rows: Record<string, unknown>[] }).rows[0].nonexistent_column = 'boom'
    writeFileSync(fixturePath, JSON.stringify(bad), 'utf8')
    await expect(loadFixture(pool, 'toolkit-test-tiny')).rejects.toThrow(/regenerate via capture\.ts/)
  })
})
```

- [ ] **Step 3: Run, verify failure**

Run: `cd backend && pnpm exec vitest run scripts/smoke/fixtures/__tests__/load.test.ts`
Expected: FAIL — `Cannot find module '../load.js'`.

- [ ] **Step 4: Implement `load.ts`**

`backend/scripts/smoke/fixtures/load.ts`:
```ts
import type { Pool } from 'pg'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import type { FixtureFile } from './types.js'

const FIXTURES_DIR = dirname(fileURLToPath(import.meta.url))

/** Quote a SQL identifier (table/column) — fixtures are trusted dev artifacts, but
 *  quoting keeps reserved words + casing safe. */
function q(ident: string): string {
  return `"${ident.replace(/"/g, '""')}"`
}

/** pg sends a JS object/array as a text param; a jsonb column rejects it without an
 *  explicit ::jsonb cast. Key off the JS value shape. */
function isJsonbValue(v: unknown): boolean {
  return typeof v === 'object' && v !== null
}

export function readFixture(name: string): FixtureFile {
  return JSON.parse(readFileSync(join(FIXTURES_DIR, `${name}.json`), 'utf8')) as FixtureFile
}

/** Replay a captured fixture into the pool's DB. Delete-then-load (idempotent):
 *  non-shared tables are deleted bottom-to-top by `id`, then all tables inserted
 *  top-to-bottom (FK order). Shared rows (`shared: true`, e.g. globalSetup users) are
 *  inserted ON CONFLICT DO NOTHING and NEVER deleted. Every table is assumed to have an
 *  `id` PK (Mythrun's UUIDv7-everywhere convention); a future fixture needing a non-`id`
 *  PK would extend the manifest with a pk field. */
export async function loadFixture(pool: Pool, name: string): Promise<FixtureFile> {
  const fixture = readFixture(name)
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    for (const table of [...fixture.tables].reverse()) {
      if (table.shared) continue
      const ids = table.rows.map((r) => r.id)
      if (ids.length > 0) await client.query(`DELETE FROM ${q(table.name)} WHERE id = ANY($1)`, [ids])
    }
    for (const table of fixture.tables) {
      for (const row of table.rows) {
        const cols = Object.keys(row)
        const vals = cols.map((c) => (isJsonbValue(row[c]) ? JSON.stringify(row[c]) : row[c]))
        const placeholders = cols.map((c, i) => (isJsonbValue(row[c]) ? `$${String(i + 1)}::jsonb` : `$${String(i + 1)}`))
        const conflict = table.shared ? ' ON CONFLICT DO NOTHING' : ''
        await client.query(
          `INSERT INTO ${q(table.name)} (${cols.map(q).join(', ')}) VALUES (${placeholders.join(', ')})${conflict}`,
          vals,
        )
      }
    }
    await client.query('COMMIT')
    return fixture
  } catch (err) {
    await client.query('ROLLBACK')
    const cause = err instanceof Error ? err.message : String(err)
    throw new Error(
      `loadFixture(${name}) failed (fixture captured against schemaVersion=${fixture.schemaVersion}). ` +
        `If a migration changed a column since, regenerate via capture.ts. Cause: ${cause}`,
    )
  } finally {
    client.release()
  }
}
```

- [ ] **Step 5: Run, verify pass**

Run: `cd backend && pnpm exec vitest run scripts/smoke/fixtures/__tests__/load.test.ts`
Expected: PASS (3/3). Then `pnpm typecheck` → exit 0; `pnpm eslint scripts/smoke/fixtures/load.ts scripts/smoke/fixtures/types.ts scripts/smoke/fixtures/__tests__/load.test.ts` → clean.

- [ ] **Step 6: Commit** (controller, after review)
```bash
git add backend/scripts/smoke/fixtures/types.ts backend/scripts/smoke/fixtures/load.ts backend/scripts/smoke/fixtures/__tests__/load.test.ts
git commit -m "feat(myth): reusable smoke-fixture loadFixture engine (MYT-64)"
```

---

## Task 2: Capture CLI + the ready-to-play manifest

**Files:**
- Create: `backend/scripts/smoke/fixtures/capture.ts`, `backend/scripts/smoke/fixtures/ready-to-play-campaign.manifest.ts`
- Modify: `backend/package.json` (add `capture:ready-to-play`)
- Test: `backend/scripts/smoke/fixtures/__tests__/capture.test.ts`

- [ ] **Step 1: Write the manifest**

`backend/scripts/smoke/fixtures/ready-to-play-campaign.manifest.ts` (FK-dependency order; corrected against the real schema per the spec — no `world_inventory`/`starting_situation_entries` tables; `campaign_characters` first-class; multi-user filter):
```ts
import type { FixtureManifest } from './types.js'

export const READY_TO_PLAY_MANIFEST: FixtureManifest = {
  name: 'ready-to-play-campaign',
  tables: [
    // Shared: all member users (owner + players). globalSetup seeds dev users; ON CONFLICT DO NOTHING.
    { name: 'users', shared: true, filter: (ids) => ({ sql: 'id IN (SELECT user_id FROM campaign_members WHERE campaign_id = $1)', params: [ids.campaignId] }) },
    { name: 'stat_blocks', filter: (ids) => ({ sql: 'id IN (SELECT stat_block_id FROM entities WHERE world_id = $1 AND stat_block_id IS NOT NULL)', params: [ids.worldId] }) },
    { name: 'worlds', filter: (ids) => ({ sql: 'id = $1', params: [ids.worldId] }) },
    { name: 'entities', filter: (ids) => ({ sql: 'world_id = $1', params: [ids.worldId] }) },
    { name: 'prose_kernels', filter: (ids) => ({ sql: 'entity_id IN (SELECT id FROM entities WHERE world_id = $1)', params: [ids.worldId] }) },
    { name: 'facts', filter: (ids) => ({ sql: 'entity_id IN (SELECT id FROM entities WHERE world_id = $1)', params: [ids.worldId] }) },
    { name: 'relationships', filter: (ids) => ({ sql: 'source_entity_id IN (SELECT id FROM entities WHERE world_id = $1)', params: [ids.worldId] }) },
    { name: 'entity_hierarchy', filter: (ids) => ({ sql: 'parent_entity_id IN (SELECT id FROM entities WHERE world_id = $1)', params: [ids.worldId] }) },
    { name: 'campaigns', filter: (ids) => ({ sql: 'id = $1', params: [ids.campaignId] }) },
    { name: 'characters', filter: (ids) => ({ sql: 'id IN (SELECT character_id FROM campaign_characters WHERE campaign_id = $1)', params: [ids.campaignId] }) },
    { name: 'campaign_members', filter: (ids) => ({ sql: 'campaign_id = $1', params: [ids.campaignId] }) },
    { name: 'campaign_characters', filter: (ids) => ({ sql: 'campaign_id = $1', params: [ids.campaignId] }) },
  ],
}
```
(NOT captured: `session_preps` + `pipeline_runs` — the fixture is a ready-to-play campaign with NO prep yet; the smoke generates the prep fresh, and a captured `session-prep:1` row would trip the processor's idempotent-skip.)

- [ ] **Step 2: Write the failing round-trip test**

`backend/scripts/smoke/fixtures/__tests__/capture.test.ts` — seed a tiny 2-table graph via raw INSERT under a scope, run `captureFixture` with a tiny inline manifest, assert the returned `FixtureFile` has the rows + ordering + a `schemaVersion`:
```ts
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { Pool } from 'pg'
import { guardTestDatabase } from '../../../../src/db/__tests__/guard-db.js'
import { createTestPool } from '../../../../src/repo/__tests__/_helpers/test-pool.js'
import { uuidv7 } from '../../../../src/repo/uuidv7.js'
import { captureFixture } from '../capture.js'
import type { FixtureManifest } from '../types.js'

const databaseUrl = process.env.DATABASE_URL ?? ''

describe('captureFixture (smoke-fixture toolkit)', () => {
  let pool: Pool
  const userId = '019700e0-0000-7000-8000-00000000d002' // a seeded dev user
  const worldId = uuidv7()

  beforeAll(async () => {
    await guardTestDatabase(databaseUrl)
    pool = createTestPool(databaseUrl)
    await pool.query(`INSERT INTO worlds (id, created_by, name, concept, status) VALUES ($1, $2, 'CapTest', 'cap concept', 'complete')`, [worldId, userId])
  })
  afterAll(async () => {
    await pool.query(`DELETE FROM worlds WHERE id = $1`, [worldId])
    await pool.end()
  })

  it('captures the manifest tables into a self-contained FixtureFile with schemaVersion', async () => {
    const manifest: FixtureManifest = {
      name: 'cap-test',
      tables: [{ name: 'worlds', filter: (ids) => ({ sql: 'id = $1', params: [ids.worldId] }) }],
    }
    const file = await captureFixture(pool, manifest, { campaignId: worldId, worldId })
    expect(file.name).toBe('cap-test')
    expect(file.schemaVersion).toMatch(/\.sql$/)
    const worldsTable = file.tables.find((t) => t.name === 'worlds')
    expect(worldsTable?.rows).toHaveLength(1)
    expect((worldsTable?.rows[0] as { name: string }).name).toBe('CapTest')
  })
})
```

- [ ] **Step 3: Run, verify failure**

Run: `cd backend && pnpm exec vitest run scripts/smoke/fixtures/__tests__/capture.test.ts`
Expected: FAIL — `Cannot find module '../capture.js'`.

- [ ] **Step 4: Implement `capture.ts`**

`backend/scripts/smoke/fixtures/capture.ts` (exports `captureFixture` for the test + a CLI `main`):
```ts
import type { Pool } from 'pg'
import { Pool as PgPool } from 'pg'
import { writeFileSync, readdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import type { FixtureFile, FixtureManifest, FixtureRootIds } from './types.js'

const HERE = dirname(fileURLToPath(import.meta.url))
const MIGRATIONS_DIR = join(HERE, '..', '..', '..', 'migrations')

/** Latest migration filename — stamped into the fixture as a drift breadcrumb. */
function latestMigration(): string {
  return readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith('.sql')).sort().at(-1) ?? 'unknown'
}

export async function captureFixture(
  pool: Pool,
  manifest: FixtureManifest,
  ids: FixtureRootIds,
): Promise<FixtureFile> {
  const tables = []
  for (const t of manifest.tables) {
    const { sql, params } = t.filter(ids)
    const res = await pool.query(`SELECT * FROM "${t.name}" WHERE ${sql}`, [...params])
    tables.push({ name: t.name, shared: t.shared ?? false, rows: res.rows as Record<string, unknown>[] })
  }
  return {
    name: manifest.name,
    capturedAt: new Date().toISOString(),
    schemaVersion: latestMigration(),
    rootCampaignId: ids.campaignId,
    rootWorldId: ids.worldId,
    tables,
  }
}

// CLI: `tsx capture.ts <manifestName> <rootCampaignId>` against $DATABASE_URL.
// Resolves worldId from the campaign, runs the manifest, writes <name>.json.
/* c8 ignore start — CLI entry; the engine (captureFixture) is unit-tested */
async function main(): Promise<void> {
  const [manifestName, campaignId] = process.argv.slice(2)
  if (!manifestName || !campaignId) throw new Error('usage: capture.ts <manifestName> <rootCampaignId>')
  const dbUrl = process.env.DATABASE_URL
  if (!dbUrl) throw new Error('DATABASE_URL required')
  // dynamic import of `<manifestName>.manifest.ts`
  const mod = (await import(`./${manifestName}.manifest.js`)) as Record<string, FixtureManifest>
  const manifest = Object.values(mod).find((m) => m && typeof m === 'object' && 'tables' in m)
  if (!manifest) throw new Error(`no FixtureManifest export in ${manifestName}.manifest.ts`)
  const pool = new PgPool({ connectionString: dbUrl })
  try {
    const wr = await pool.query<{ world_id: string }>(`SELECT world_id FROM campaigns WHERE id = $1`, [campaignId])
    const worldId = wr.rows[0]?.world_id
    if (!worldId) throw new Error(`campaign ${campaignId} not found`)
    const file = await captureFixture(pool, manifest, { campaignId, worldId })
    const out = join(HERE, `${manifest.name}.json`)
    writeFileSync(out, `${JSON.stringify(file, null, 2)}\n`, 'utf8')
    process.stdout.write(`captured ${String(file.tables.reduce((n, t) => n + t.rows.length, 0))} rows → ${out}\n`)
  } finally {
    await pool.end()
  }
}

if (process.argv[1] && process.argv[1].endsWith('capture.ts')) {
  main().catch((err: unknown) => {
    process.stderr.write(`${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`)
    process.exit(1)
  })
}
/* c8 ignore stop */
```

- [ ] **Step 5: Run, verify pass + add the package script**

Run: `cd backend && pnpm exec vitest run scripts/smoke/fixtures/__tests__/capture.test.ts` → PASS.
Add to `backend/package.json` scripts (after the existing `smoke:*` lines):
```json
    "capture:ready-to-play": "tsx scripts/smoke/fixtures/capture.ts ready-to-play-campaign",
```
(Invoked as `DATABASE_URL=<test-or-capture-db> pnpm capture:ready-to-play <campaignId>` in Task 3.)
`pnpm typecheck` → exit 0; eslint clean on the new files.

- [ ] **Step 6: Commit** (controller, after review)
```bash
git add backend/scripts/smoke/fixtures/capture.ts backend/scripts/smoke/fixtures/ready-to-play-campaign.manifest.ts backend/scripts/smoke/fixtures/__tests__/capture.test.ts backend/package.json
git commit -m "feat(myth): smoke-fixture capture CLI + ready-to-play manifest (MYT-64)"
```

---

## Task 3: Capture the real `ready-to-play-campaign` fixture (CONTROLLER-OPERATIONAL)

This is NOT an implementer code task — it's a one-time real-LLM capture the **controller** drives (live stack + real Anthropic + multi-step pipeline). Produces the committed `ready-to-play-campaign.json`.

**Files:** Create `backend/scripts/smoke/fixtures/ready-to-play-campaign.json` (the captured artifact).

- [ ] **Step 1: Migrate mythrun_test** — `cd backend && pnpm db:migrate:test` (the capture + smoke target mythrun_test).

- [ ] **Step 2: Bring up the stack pointed at mythrun_test.** Start the API server + worker with `DATABASE_URL` = the mythrun_test URL (`DATABASE_URL_TEST` from `.env.development`) + a real Anthropic key + Redis up:
  - `DATABASE_URL="$DATABASE_URL_TEST" ./node_modules/.bin/tsx --env-file=.env.development src/server.ts` (background)
  - `DATABASE_URL="$DATABASE_URL_TEST" BOOT_GATE_ENABLED=true ./node_modules/.bin/tsx --env-file=.env.development src/worker.ts` (background)
  Confirm `:3030/health` → 200 and the worker logs `worker.started queues:[world-gen, campaign-setup, session-prep]`.

- [ ] **Step 3: Drive the full pipeline to `campaign.status='active'`** via the dev backend (bypass auth `x-mythrun-dev-sub`), mirroring `prep-pipeline.ts`'s steps but locally: create campaign (freeform concept ≥20 chars) → poll `world.status='complete'` → `POST /starting-situation {index:0}` → submit ≥1 character concept (`POST /characters`) → `POST /finalize-character-creation` → poll `campaign.status='active'`. Capture the `campaignId`.

- [ ] **Step 4: Capture** — `DATABASE_URL="$DATABASE_URL_TEST" pnpm capture:ready-to-play <campaignId>`. Verify the written `ready-to-play-campaign.json`: it has all 12 manifest tables, `worlds`/`entities`/`facts`/`prose_kernels` non-empty, ≥1 `characters` row with `entity_id` set, ≥1 known-tier `facts` row for a PC entity, and `worlds.starting_situation_entries` non-empty + `campaigns.starting_situation_index` set.

- [ ] **Step 5: Sanity-load** — confirm the captured fixture round-trips: `loadFixture` it into a clean mythrun_test (a tiny throwaway tsx one-liner, or rely on Task 4's smoke). Then delete the live capture campaign from mythrun_test (it's now frozen in the JSON).

- [ ] **Step 6: Commit** (controller)
```bash
git add backend/scripts/smoke/fixtures/ready-to-play-campaign.json
git commit -m "chore(myth): capture ready-to-play-campaign smoke fixture (MYT-64)"
```
Note the capture cost (~$1.50 for the full pipeline) in the commit/PR. Stop the server+worker when done.

---

## Task 4: Local session-prep smoke

**Files:**
- Create: `backend/scripts/smoke/session-prep.ts`
- Modify: `backend/package.json` (add `smoke:session-prep`)

(No unit test — the smoke IS the test, run against real Opus in Step 4. The toolkit it depends on is tested in Tasks 1–2.)

- [ ] **Step 1: Write the smoke**

`backend/scripts/smoke/session-prep.ts`:
```ts
// backend/scripts/smoke/session-prep.ts
//
// MYT-64 — the FIRST real-Opus exercise of generateSessionPrep. Constructed-direct:
// load the ready-to-play fixture into mythrun_test, invoke processSessionPrepJob with
// real Opus + recording publishers, assert the plumbing. Manual (real LLM ~$0.30-0.60),
// NOT in CI. Targets mythrun_test (NOT mythrun_dev) — see the DATABASE_URL_TEST note.
//
// PRECONDITIONS: `pnpm db:migrate:test` (or a prior `pnpm test`) so mythrun_test has a
// schema; Redis up (the recording publishers don't need it, but createRepo/processor
// don't either — pure pool). Do NOT run concurrently with `pnpm test` (both hit mythrun_test).

import { guardTestDatabase } from '../../src/db/__tests__/guard-db.js'
import { createTestPool } from '../../src/repo/__tests__/_helpers/test-pool.js'
import { loadFixture } from './fixtures/load.js'
import { processSessionPrepJob, type SessionPrepProcessorDeps } from '../../src/llm/prep/session-prep-processor.js'
import type { PipelineEvent, ProseEvent } from '../../src/contract/pipeline-events.js'

function log(msg: string, extra?: Record<string, unknown>): void {
  process.stdout.write(`${JSON.stringify({ ts: new Date().toISOString(), msg, ...extra })}\n`)
}

async function main(): Promise<void> {
  const dbUrl = process.env.DATABASE_URL_TEST
  if (!dbUrl) throw new Error('DATABASE_URL_TEST required (set in .env.development) — this smoke targets mythrun_test')
  await guardTestDatabase(dbUrl) // localhost + /^mythrun_test(_.+)?$/ fence
  const pool = createTestPool(dbUrl)

  const events: PipelineEvent[] = []
  const prose: ProseEvent[] = []
  const deps: SessionPrepProcessorDeps = {
    pool,
    publishEvent: (_campaignId, event) => { events.push(event); return Promise.resolve() },
    publishProse: (_campaignId, event) => { prose.push(event); return Promise.resolve() },
  }

  try {
    const fixture = await loadFixture(pool, 'ready-to-play-campaign')
    const campaignId = fixture.rootCampaignId
    log('fixture_loaded', { campaignId, worldId: fixture.rootWorldId })

    const t0 = Date.now()
    await processSessionPrepJob(deps, { data: { campaignId, sessionNumber: 1 } })
    log('processor_returned', { ms: Date.now() - t0 })

    // --- Assertions (fail loudly; never report success on a miss) ---
    const started = events.find((e) => e.type === 'prep-started')
    const ready = events.find((e) => e.type === 'prep-ready')
    if (!started) throw new Error('no prep-started event emitted')
    if (!ready || ready.type !== 'prep-ready') throw new Error('no prep-ready event emitted')
    if (ready.costUsd <= 0) throw new Error(`prep-ready costUsd not positive: ${String(ready.costUsd)}`)
    if (events.indexOf(started) > events.indexOf(ready)) throw new Error('prep-started after prep-ready')

    const row = await pool.query<{ ft_context: string; sd_playbook: string }>(
      `SELECT ft_context, sd_playbook FROM session_preps WHERE campaign_id = $1 AND session_number = 1`,
      [campaignId],
    )
    const prep = row.rows[0]
    if (!prep) throw new Error('no session_preps row written')
    if (prep.ft_context.length === 0 || prep.sd_playbook.length === 0) throw new Error('ft_context or sd_playbook empty')
    if (prep.ft_context === prep.sd_playbook) throw new Error('ft_context and sd_playbook are identical')

    const stage = await pool.query<{ status: string; cost_usd: string }>(
      `SELECT status, cost_usd FROM pipeline_runs WHERE campaign_id = $1 AND stage = 'session-prep:1' AND user_id IS NULL`,
      [campaignId],
    )
    if (stage.rows[0]?.status !== 'completed') throw new Error(`pipeline_runs session-prep:1 status = ${String(stage.rows[0]?.status)}`)
    if (Number(stage.rows[0]?.cost_usd) <= 0) throw new Error('pipeline_runs cost_usd not positive')

    // --- Soft/diagnostic (warn, do NOT fail): per-field prose deltas ---
    // The haiku-then-sonnet repair runs after the partial stream, so a repaired field
    // may stream no deltas while await result.object still succeeds. Log, don't gate.
    for (const field of ['ft_context', 'sd_playbook'] as const) {
      const n = prose.filter((p) => p.field === field).length
      if (n === 0) log('WARN_no_prose_deltas', { field })
      else log('prose_deltas', { field, count: n })
    }

    log('SMOKE PASSED', {
      costUsd: ready.costUsd,
      ftContextLen: prep.ft_context.length,
      sdPlaybookLen: prep.sd_playbook.length,
    })

    // Cleanup: re-run the loader's delete pass by deleting non-shared roots (mirror teardown).
    // loadFixture's delete is internal; here just delete the campaign + world (cascades) + characters.
    const charIds = (fixture.tables.find((t) => t.name === 'characters')?.rows ?? []).map((r) => (r as { id: string }).id)
    if (charIds.length > 0) await pool.query(`DELETE FROM characters WHERE id = ANY($1)`, [charIds])
    await pool.query(`DELETE FROM worlds WHERE id = $1`, [fixture.rootWorldId])
  } finally {
    await pool.end()
  }
}

main().catch((err: unknown) => {
  process.stderr.write(`${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`)
  process.exit(1)
})
```

- [ ] **Step 2: Add the package script**

`backend/package.json` scripts:
```json
    "smoke:session-prep": "tsx --env-file=.env.development scripts/smoke/session-prep.ts",
```

- [ ] **Step 3: Typecheck + lint**

Run: `cd backend && pnpm typecheck` → exit 0; `pnpm eslint scripts/smoke/session-prep.ts` → clean.

- [ ] **Step 4: Run the real-LLM smoke (CONTROLLER-gated, ~$0.40)**

Precondition: `pnpm db:migrate:test`; Redis up; the fixture committed (Task 3). Run: `cd backend && pnpm smoke:session-prep`.
Expected: `SMOKE PASSED` with `costUsd` (~$0.30–0.60) + non-zero `ftContextLen`/`sdPlaybookLen`. **This is the first real Opus hit on session-prep** — if it surfaces a prompt-template or Zod-schema bug, root-cause + fix it here (that's the point of the ticket). Record the real `costUsd` — it feeds Task 5's cap decision.

- [ ] **Step 5: Commit** (controller, after review + a green run)
```bash
git add backend/scripts/smoke/session-prep.ts backend/package.json
git commit -m "feat(myth): local real-LLM session-prep smoke (MYT-64)"
```

---

## Task 5: Staging gate — extend `prep-pipeline.ts`

**Files:** Modify `backend/scripts/smoke/prep-pipeline.ts`.

- [ ] **Step 1: Add an SSE-reader helper** (Node `fetch` + `ReadableStream` + Bearer; native EventSource can't set the auth header). Add near the other helpers (after `pollFor`, ≈L292):
```ts
// Reads the prep-status SSE until `prep-ready`/`prep-failed`, or treats an initial
// `snapshot: {status:'ready'}` as already-done (the route emits one snapshot frame on
// connect + does NOT replay prep-ready — so a fast/idempotent finish must be caught here).
async function waitForPrepReady(client: ApiClient, campaignId: string, budgetMs: number): Promise<void> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), budgetMs)
  try {
    const res = await fetch(`${client.base}/api/campaigns/${campaignId}/prep-status`, {
      headers: { authorization: `Bearer ${client.token}`, accept: 'text/event-stream' },
      signal: controller.signal,
    })
    if (!res.ok || !res.body) throw new Error(`prep-status SSE open → ${String(res.status)}`)
    const reader = res.body.getReader()
    const decoder = new TextDecoder()
    let buffer = ''
    for (;;) {
      const chunk = await reader.read()
      if (chunk.done) throw new Error('prep-status stream closed before prep-ready')
      buffer += decoder.decode(chunk.value, { stream: true })
      let sep = buffer.indexOf('\n\n')
      while (sep !== -1) {
        const frame = buffer.slice(0, sep)
        buffer = buffer.slice(sep + 2)
        sep = buffer.indexOf('\n\n')
        const dataLine = frame.split('\n').find((l) => l.startsWith('data:'))
        if (!dataLine) continue
        const data = JSON.parse(dataLine.slice('data:'.length).trim()) as { status?: string; type?: string; terminal?: boolean }
        if (data.status === 'ready' || data.type === 'prep-ready') return
        if (data.type === 'prep-failed') throw new Error(`prep-failed (terminal=${String(data.terminal)})`)
      }
    }
  } finally {
    clearTimeout(timer)
  }
}
```

- [ ] **Step 2: Trigger + observe + assert, per campaign** — insert between `log('info', 'campaign_active', …)` (≈L499) and `const stats = await readCampaignStats(…)` (≈L502):
```ts
  // MYT-64: trigger session prep on the now-active campaign, observe the prep-status
  // SSE to prep-ready, assert the persisted prep. The session-prep:1 pipeline_runs row
  // carries campaign_id, so its cost folds into readCampaignStats' costUsd automatically.
  const trigger = await apiPost<{ campaignId: string; sessionNumber: number }>(ownerApi, `/api/campaigns/${campaignId}/session-prep`, {})
  if (trigger.sessionNumber !== 1) throw new Error(`session-prep trigger returned sessionNumber=${String(trigger.sessionNumber)}`)
  await waitForPrepReady(ownerApi, campaignId, 10 * 60_000)
  const prepRow = await pool.query<{ ft_context: string; sd_playbook: string }>(
    `SELECT ft_context, sd_playbook FROM session_preps WHERE campaign_id = $1 AND session_number = 1`,
    [campaignId],
  )
  if (!prepRow.rows[0] || prepRow.rows[0].ft_context.length === 0 || prepRow.rows[0].sd_playbook.length === 0) {
    throw new Error(`session-prep row missing/empty for ${campaignId}`)
  }
  log('info', 'session_prep_ready', { concept: concept.name, campaignId })
```
(`ownerApi`, `pool`, `concept`, `campaignId` are all in scope at the insertion point — confirm against the surrounding code.)

- [ ] **Step 3: Measure-first cap decision** (per spec §6) — using Task 4's real `costUsd`:
  1. Read a recent staging `prep-pipeline` run's total spend (its logged `costUsd` sum, or `SMOKE_COST_CAP_USD` headroom).
  2. If `existing_total + (perPrep × 3) > 5.00`, bump `SMOKE_COST_CAP_USD` in `infra/environments/staging/main.tf` (one-line value change) + a `Deploy` to roll the task-def env (cf. `reference_tf_ci_taskdef_split`). Reassess `SMOKE_WALL_CLOCK_BUDGET_MS` (35 min) for the +~10-min prep wait on the slowest chain. If headroom is sufficient, NO Terraform change — note that explicitly.
  3. Document the decision (the numbers + whether a bump was made) in the commit/PR.

- [ ] **Step 4: Verify** — `pnpm typecheck` → exit 0; `pnpm eslint scripts/smoke/prep-pipeline.ts` → clean. (The smoke itself runs on staging via the existing ECS task — not run locally; `createPgPool` refuses a non-staging DB.) The PASS-teardown needs NO change: `session_preps` cascades from `worlds`→`campaigns` (migration 001), and the new `session-prep:1` `pipeline_runs` row is swept by the existing `DELETE FROM pipeline_runs WHERE campaign_id = ANY(...)`.

- [ ] **Step 5: Commit** (controller, after review)
```bash
git add backend/scripts/smoke/prep-pipeline.ts
# + infra/environments/staging/main.tf IF Step 3 required a cap bump
git commit -m "feat(myth): extend staging prep-pipeline smoke with session-prep gate (MYT-64)"
```

---

## Task 6: Wiki runbook + hardening documentation

**Files:** Modify `docs/wiki/content/runtime/session-prep.html`.

- [ ] **Step 1: Add an "Operating this piece" runbook** (the page exists from MYT-63; per `docs/wiki/AUTHORING.md`, runbook entries are `<h3>` under the exact `<h2>Operating this piece</h2>` text). Add two runbooks: **"Run the session-prep smoke"** (`pnpm db:migrate:test` → `pnpm smoke:session-prep`; targets mythrun_test; ~$0.40 real Opus; not in CI) and **"Regenerate the ready-to-play fixture"** (drive the real pipeline to `active` against mythrun_test → `pnpm capture:ready-to-play <campaignId>` → commit the JSON). Keep it illustrative, not a copy of the scripts (per the seven principles).

- [ ] **Step 2: Confirm the narrative + add the hardening note** — apply the mental-model test: does the page reflect that the LLM path is now smoke-validated? Add a short note (inline, not a new section) that the per-call Opus timeout (`SESSION_PREP_TIMEOUT_MS`), idempotent resume (claim-`completed` no-op + `ON CONFLICT DO NOTHING`), and partial-generation safety (persist only after `await result.object`) are verified by the smoke — the §7 hardening, no code change. If the existing narrative still matches, `pnpm wiki:accept-drift` for the source-hash; else a light edit.

- [ ] **Step 3: Build + check** — `pnpm wiki:build` then `pnpm wiki:check` (must exit 0; set `DATABASE_URL` from `.env.development` for the schema-reference marker — MYT-64 adds no migration, so the schema page won't drift). `npx prettier --write docs/wiki/content/runtime/session-prep.html`. Watch for the iCloud `site N/` build-race (`reference_icloud_site_build_race`): remove any `docs/wiki/site N` conflict dirs after the build.

- [ ] **Step 4: Commit** (controller — but the wiki is normally synced by the wiki-update subagent at close-out; if the AUTHORING.md subagent runs at close, it may own this. If done inline here, commit:)
```bash
git add docs/wiki/content/runtime/session-prep.html docs/wiki/site
git commit -m "docs(wiki): session-prep smoke + fixture runbook (MYT-64)"
```

---

## Task 7: Full verification + close-out

**Files:** none (verification).

- [ ] **Step 1:** `cd backend && pnpm typecheck` (exit 0) + `pnpm lint` (0 errors) + `pnpm test` (full suite green — the toolkit tests run in the `parallel` project against mythrun_test).
- [ ] **Step 2:** Confirm the local smoke passed (Task 4 Step 4) — that's the deliverable validation (first real Opus hit). Re-run if any code changed since.
- [ ] **Step 3:** Confirm the §7 hardening claims held under the smoke (timeout/resume/partial); they're documented in the wiki (Task 6).
- [ ] **Step 4: Close-out** (controller): wiki sync (if not done in Task 6, dispatch the AUTHORING.md subagent) → single `git push` → flip MYT-64 to Done. The staging smoke RUN happens on the existing staging-smoke cadence (or a manual ECS run-task after the deploy); MYT-64 ships the wiring + the local validation. Note: the diff does NOT touch `backend/dev-tool/**`, so the dev-tool-verifier marker gate does not apply.

---

## Self-Review (controller, before dispatching Task 1)

- **Spec coverage:** §3 toolkit → Tasks 1–2 (loadFixture engine + capture CLI + manifest); §4 fixture → Task 3 (organic capture); §5 local smoke → Task 4 (constructed-direct + real run); §6 staging → Task 5 (SSE reader + trigger + measure-first cap); §7 hardening → verify-and-document in Task 4 run + Task 6; §8 wiki → Task 6; §9 testing → Task 1/2 real-PG tests + the manual smokes. Covered.
- **Placeholder scan:** none — complete code for the engine/capture/smoke/SSE-reader; Task 3 is an explicit operational procedure; the prep-pipeline insertion shows the full inserted block + the exact insertion point.
- **Type consistency:** `FixtureFile`/`FixtureManifest`/`FixtureTableData`/`FixtureRootIds` are defined in Task 1 `types.ts` and consumed identically in `load.ts` (Task 1), `capture.ts` + the manifest (Task 2), and the smoke (Task 4). `loadFixture(pool, name)` returns `FixtureFile`; the smoke uses `fixture.rootCampaignId`/`.rootWorldId`/`.tables`. `SessionPrepProcessorDeps` (pool + publishEvent:(id,PipelineEvent) + publishProse:(id,ProseEvent)) matches the processor; the recording stubs match. Event types `prep-started`/`prep-ready{costUsd}`/`prep-delta{field}` match `pipeline-events.ts`. `ApiClient`/`apiPost`/`pollFor` in Task 5 match prep-pipeline.ts's real signatures.
- **Grounding corrections baked in:** guard-db imported from `src/db/__tests__/guard-db.js` (not `_helpers/`); the smoke builds its pool from `DATABASE_URL_TEST` directly (loadEnv has no test URL); every table has an `id` PK so the loader deletes reverse-FK by `id`; jsonb-cast set is the three `worlds` columns; the prep-pipeline `log` is 4-arg `log(level, event, payload)`; `assertContract` Layer C is cost+429s (no wall-clock) so the prep cost auto-folds via the OR-campaign_id costUsd query; teardown needs no new SQL.
