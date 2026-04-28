# Wiki Schema Reference Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add an auto-generated, search-and-expand schema reference page to the internal wiki, sourced from `backend/migrations/*.sql`. The page is regenerated on every `pnpm wiki:build` and protected by the existing source-hash drift contract. Also reorganizes the wiki's top-nav: rename the existing `runbooks` section to `reference` and treat it as the home for derived/auto-generated lookup pages.

**Architecture:** A new build module pair (`schemaExtractor.ts` + `schemaRenderer.ts`, orchestrated by `schemaRef.ts`) opens a Postgres connection at build time, applies the migrations to a fresh `public` schema, runs five `information_schema` / `pg_*` introspection queries (lifted from `backend/src/db/__tests__/migrate-schema.test.ts`), produces a typed `SchemaMetadata` object, and renders an HTML fragment of `<details>`-per-table elements. `buildPipeline.ts` splices the fragment into `content/reference/schema.html` at the `<!-- @schema-reference -->` marker, mirroring the existing `<!-- @runbooks-index -->` pattern. Client-side `helper.js` adds vanilla-JS search/filter/highlight/counter behavior. CI's `wiki-check.yml` gains a `postgres:16-alpine` service container.

**Tech Stack:** TypeScript (strict), pnpm workspaces, Vitest, tsx, `pg` (already a backend dependency, will be added to the wiki package), GitHub Actions, vanilla JS for client-side.

**Spec:** `docs/superpowers/specs/2026-04-27-wiki-schema-reference-design.md`.

---

## Reference notes

**Migrations to introspect:**
- `backend/migrations/001_initial_schema.sql`
- `backend/migrations/002_indexes.sql`
- `backend/migrations/003_srd_reference_data.sql`

**Expected schema after the three migrations apply:** 38 base tables (1 `_migrations` + 35 application + 3 SRD), 23 named `idx_*` indexes, 19 CHECK constraints, 47 FK delete rules. The schema-parity test in `backend/src/db/__tests__/migrate-schema.test.ts` pins these counts.

**Cluster mapping** (used in Task 4, lifted from `content/data/schema.html`):
- **Identity & billing:** `users`, `credit_ledger`, `subscription_tiers`, `user_subscriptions`, `session_packs`, `purchases`, `stripe_events`
- **Worlds & entities:** `worlds`, `entities`, `prose_kernels`, `facts`, `relationships`, `entity_hierarchy`, `random_tables`, `random_table_entries`, `stat_blocks`, `stat_block_actions`
- **Campaigns & play:** `campaigns`, `campaign_members`, `campaign_invites`, `characters`, `character_skills`, `character_features`, `character_equipment`, `character_spells`, `sessions`, `session_messages`, `session_participants`, `world_snapshots`, `session_preps`, `session_usage`
- **Pipeline & ops:** `pipeline_runs`, `world_marketplace`, `moderation_flags`, `settings`
- **SRD reference:** `srd_monsters`, `srd_spells`, `srd_conditions`
- **Other:** unmatched tables (defensive fallback). `_migrations` is hidden — it's framework metadata, not application schema, and the user-facing reference shouldn't show it.

**Database connection:** Local dev uses `DATABASE_URL` from `backend/.env.development`. CI sets it as a step env. The wiki extractor falls back chain: `WIKI_DATABASE_URL → DATABASE_URL → throws`.

**Conventional Commits:** Use `feat(myth-6u4): ...`, `refactor(myth-6u4): ...`, `docs(myth-6u4): ...`, `ci(myth-6u4): ...` per CLAUDE.md.

**Standing rule (CLAUDE.md):** All `pnpm typecheck && pnpm lint && pnpm test && pnpm wiki:check` must pass before the plan is done.

---

## Task 1: Reference section refactor

Rename the existing top-level `runbooks` section to `reference`. Move the runbook index page from a section overview to a sibling page. Add a new section landing.

**Files:**
- Modify: `docs/wiki/structure.ts`
- Move: `docs/wiki/content/runbooks/index.html` → `docs/wiki/content/reference/runbooks.html`
- Create: `docs/wiki/content/reference/index.html`
- Delete: `docs/wiki/content/runbooks/` (the now-empty directory)

- [ ] **Step 1: Read the existing runbook index content for reference**

```bash
cat docs/wiki/content/runbooks/index.html
```

Expected output:
```html
<h1>Runbooks</h1>

<p class="lead">
  Every operational procedure for the shipped Mythrun system, in one scan-fast list. Each runbook
  lives on the architectural page it operates on — follow the link to see the steps in context.
</p>

<!-- @runbooks-index -->
```

- [ ] **Step 2: Update `structure.ts` to rename the section**

Replace the existing `runbooks` block in `docs/wiki/structure.ts`:

```ts
  {
    slug: 'runbooks',
    title: 'Runbooks',
    pages: [{ slug: 'index', title: 'Overview' }],
  },
```

With:

```ts
  {
    slug: 'reference',
    title: 'Reference',
    pages: [
      { slug: 'index', title: 'Overview' },
      { slug: 'runbooks', title: 'Runbooks' },
      { slug: 'schema', title: 'Schema reference' },
    ],
  },
```

- [ ] **Step 3: Move the runbook page to its new location**

```bash
mkdir -p docs/wiki/content/reference
git mv docs/wiki/content/runbooks/index.html docs/wiki/content/reference/runbooks.html
rmdir docs/wiki/content/runbooks
```

- [ ] **Step 4: Create the new section landing page at `docs/wiki/content/reference/index.html`**

```html
<h1>Reference</h1>

<p class="lead">
  Derived views over the shipped system. For looking up specific things, not for learning how the
  system fits together — the topical sections (Infra, Runtime, Data, Auth & Billing, World &
  Campaign, Combat, Frontend) are where the system is explained.
</p>

<p>
  Reference pages are auto-generated. The runbook index aggregates every runbook entry across the
  narrative pages; the schema reference is regenerated from <code>backend/migrations/</code> on
  every wiki build. They go stale only if the upstream source changes and the generator hasn't
  been rerun — the source-hash drift check catches that case in CI.
</p>

<h2>Pages in this section</h2>

<ul>
  <li>
    <a href="./runbooks.html">Runbooks</a> — every operational procedure for the shipped system, in
    one scan-fast list.
  </li>
  <li>
    <a href="./schema.html">Schema reference</a> — every table, column, constraint, and index in the
    Mythrun database, searchable.
  </li>
</ul>
```

- [ ] **Step 5: Create a placeholder `docs/wiki/content/reference/schema.html` so structure validation passes**

The `validateStructure` step in `buildPipeline.ts` will fail if `structure.ts` references a page whose content file doesn't exist. Create a minimal stub now; Task 2 fills it in.

```html
<h1>Schema reference</h1>

<p class="lead">Coming in the next task.</p>
```

- [ ] **Step 6: Build and verify**

```bash
pnpm wiki:build
```

Expected: exit 0, output line ending with `built N pages, M diagrams, 0 errors`. The new section appears at `docs/wiki/site/reference/index.html`, `runbooks.html`, `schema.html`. The runbook index continues to render correctly under its new path.

- [ ] **Step 7: Smoke-test in the dev server**

```bash
pnpm wiki:dev
```

Open http://localhost:3100. Confirm:
- Top-nav shows `Reference` (not `Runbooks`).
- Clicking `Reference` lands on the new overview page.
- Sidebar shows `Overview`, `Runbooks`, `Schema reference`.
- Clicking `Runbooks` shows the auto-aggregated runbook list (the same content that used to live at `runbooks/index.html`). The list is non-empty (existing pages have runbook entries — `data/schema.html` has `Apply the schema locally` and `Recover from the MYT-32 → MYT-33 transition`).

Stop the dev server with Ctrl+C.

- [ ] **Step 8: Commit**

```bash
git add docs/wiki/structure.ts docs/wiki/content/reference/ docs/wiki/content/runbooks
git status
git commit -m "refactor(myth-6u4): wiki — rename runbooks section to reference

The runbook index is the first auto-generated reference page; the
schema reference page coming next is the second. Promote the section
to a home for derived/auto-generated lookup pages and demote the
runbook index from section overview to a sibling page.
"
```

---

## Task 2: Skeleton schema reference page + buildPipeline marker plumbing

Wire the `<!-- @schema-reference -->` marker through `buildPipeline.ts` end-to-end with a hardcoded test fragment, before any database code lands. This validates the splice path independently.

**Files:**
- Modify: `docs/wiki/build/buildPipeline.ts` (add `resolveSchemaReference` near the existing `resolveRunbookIndex` at line 271)
- Replace: `docs/wiki/content/reference/schema.html` (the stub from Task 1)

- [ ] **Step 1: Replace the stub `docs/wiki/content/reference/schema.html` with the full hand-written shell**

```html
<!-- source: backend/migrations/001_initial_schema.sql -->
<!-- source: backend/migrations/002_indexes.sql -->
<!-- source: backend/migrations/003_srd_reference_data.sql -->
<!-- source-hash: sha256:<auto> -->
<!-- last-ticket: MYT-33 -->

<h1>Schema reference</h1>

<p class="lead">
  Every table, column, constraint, and index in the Mythrun database — searchable. Generated from
  <code>backend/migrations/</code>, regenerated on every wiki build.
</p>

<p>
  This is the lookup view: type a table or column name into the filter, expand the matching tables,
  read the columns and constraints. For the story — what these tables are <em>for</em>, why the
  cascades flow the way they do, why the ledger is append-only — read the
  <a href="../data/schema.html">narrative explainer</a>. This page is auto-generated and never
  hand-edited; the explainer carries the rationale.
</p>

<div class="schema-controls">
  <input
    id="schema-search"
    type="search"
    placeholder="Filter by table or column name…"
    autocomplete="off"
  />
  <span id="schema-counter" class="schema-counter">Showing all tables</span>
  <button id="schema-expand-all" type="button">Expand all</button>
  <button id="schema-collapse-all" type="button">Collapse all</button>
</div>

<div id="schema-tables-container">
  <!-- @schema-reference -->
</div>

<h2>Integration points</h2>

<p>
  The narrative explainer at <a href="../data/schema.html">Data → Schema</a> walks through the
  clusters and decisions; the <a href="../data/migrations.html">migrations runner</a> is what
  applies these files to a real database.
</p>
```

- [ ] **Step 2: Add `resolveSchemaReference` to `docs/wiki/build/buildPipeline.ts`**

After the existing `resolveRunbookIndex` function (around line 271), add:

```ts
function resolveSchemaReference(content: string, fragment: string | null): string {
  if (!content.includes('<!-- @schema-reference -->')) return content
  if (fragment === null) {
    // No fragment provided (the orchestrator was not run for this build).
    // Leave the marker so the page still renders, but the absent fragment
    // surfaces as a build error elsewhere.
    return content
  }
  return content.replace(/<!--\s*@schema-reference\s*-->/g, fragment)
}
```

- [ ] **Step 3: Wire `resolveSchemaReference` into the page render path**

In `buildPipeline.ts`, find the `renderPage` function (around line 310). After the existing `resolveRunbookIndex` call (around line 341-345), add a call to `resolveSchemaReference` reading the fragment from a new `ctx.schemaFragment` field:

```ts
  const withRunbookIndex = resolveRunbookIndex(
    stripMetaComments(rawContent),
    ctx.runbookAggregate,
    rootPath,
  )
  const withSchemaRef = resolveSchemaReference(withRunbookIndex, ctx.schemaFragment)
  const diagrams = await resolveDiagrams(withSchemaRef, ctx.root, ctx.dotHeader)
```

- [ ] **Step 4: Add `schemaFragment` to the build context type**

Find the `ctx` object passed into `renderPage` (around line 311-322). Add `schemaFragment: string | null` to the inline type:

```ts
async function renderPage(
  page: Page,
  ctx: {
    root: string
    repoRoot: string
    structure: Section[]
    mode: BuildMode
    shell: string
    dotHeader: string
    shellSlotNames: Set<string>
    siteDir: string
    runbookAggregate: RunbookAggregateItem[]
    schemaFragment: string | null
  },
): Promise<PageOutcome> {
```

- [ ] **Step 5: Initialize `schemaFragment` in `runBuild`**

In `runBuild` (around line 373), find the `ctx` object construction (around line 399). Add the field, hardcoded for now:

```ts
  const ctx = {
    root,
    repoRoot,
    structure,
    mode,
    shell,
    dotHeader,
    shellSlotNames,
    siteDir,
    runbookAggregate,
    schemaFragment:
      '<p class="schema-fragment-stub">[schema fragment placeholder — replaced in Task 5]</p>',
  }
```

- [ ] **Step 6: Run the existing build tests to confirm nothing regressed**

```bash
pnpm --filter @mythrun/wiki test
```

Expected: all existing tests pass.

- [ ] **Step 7: Run a full build and verify the splice fired**

```bash
pnpm wiki:build
grep -c 'schema-fragment-stub' docs/wiki/site/reference/schema.html
```

Expected: `1` (the stub fragment was spliced into the page).

```bash
grep -c '@schema-reference' docs/wiki/site/reference/schema.html
```

Expected: `0` (the marker was consumed).

- [ ] **Step 8: Run wiki:check and confirm the source-hash drift fires (the page is brand-new, so it should drift)**

```bash
pnpm wiki:check
```

Expected: exit 1, with an error like `drift: docs/wiki/content/reference/schema.html (new)`. This is correct — the page has source declarations but no source-hash yet.

- [ ] **Step 9: Run accept-drift to lock the baseline source-hash**

```bash
pnpm wiki:accept-drift
```

Expected: a warning line `accepted drift: docs/wiki/content/reference/schema.html`. The `<!-- source-hash: sha256:<auto> -->` line in the content file is rewritten to a real `sha256:...` hash.

- [ ] **Step 10: Re-run wiki:check to confirm green**

```bash
pnpm wiki:check
```

Expected: exit 0.

- [ ] **Step 11: Commit**

```bash
git add docs/wiki/build/buildPipeline.ts docs/wiki/content/reference/schema.html
git status
git commit -m "feat(myth-6u4): wiki — wire schema-reference marker plumbing

The marker pattern mirrors the existing runbook-index resolution.
The fragment is a hardcoded stub for now; Task 5 replaces it with
the live extractor + renderer.
"
```

---

## Task 3: Add `pg` to the wiki package and create the migrations-applier helper

The extractor needs to apply the SQL files to a fresh schema. Rather than importing `runMigrations` from `@mythrun/backend` (which adds a workspace-build coupling we don't need), the wiki gets its own minimal migrations-applier — read .sql files, run them in a transaction, full stop. No advisory lock, no `_migrations` ledger, no logger plumbing. The wiki owns its throwaway schema.

**Files:**
- Modify: `docs/wiki/package.json` (add `pg` and `@types/pg` deps)
- Create: `docs/wiki/build/applyMigrations.ts`
- Create: `docs/wiki/build/__tests__/applyMigrations.test.ts`

- [ ] **Step 1: Add `pg` and `@types/pg` to the wiki package**

Edit `docs/wiki/package.json`. Add `pg` to `dependencies` and `@types/pg` to `devDependencies`, matching the backend's versions:

```json
{
  "dependencies": {
    "@hpcc-js/wasm": "^2.18.0",
    "pg": "^8.13.0"
  },
  "devDependencies": {
    "@types/browser-sync": "^2.29.0",
    "@types/node": "^24.0.0",
    "@types/pg": "^8.11.0",
    "browser-sync": "^3.0.0",
    "tsx": "^4.19.0",
    "typescript": "^5.6.0",
    "vitest": "^3.0.0"
  }
}
```

Then install:

```bash
pnpm install
```

Expected: `pnpm-lock.yaml` updated; no other warnings.

- [ ] **Step 2: Write the failing test for `applyMigrations`**

Create `docs/wiki/build/__tests__/applyMigrations.test.ts`:

```ts
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import { Pool } from 'pg'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { applyMigrations } from '../applyMigrations.ts'

const databaseUrl = process.env.WIKI_DATABASE_URL ?? process.env.DATABASE_URL

const here = dirname(fileURLToPath(import.meta.url))
const migrationsDir = resolve(here, '../../../../backend/migrations')

describe.skipIf(databaseUrl === undefined)('applyMigrations (integration)', () => {
  let pool: Pool

  beforeAll(() => {
    pool = new Pool({ connectionString: databaseUrl, max: 1 })
  })

  afterAll(async () => {
    await pool.end()
  })

  beforeEach(async () => {
    await pool.query('DROP SCHEMA IF EXISTS wiki_test CASCADE')
    await pool.query('CREATE SCHEMA wiki_test')
    await pool.query('SET search_path TO wiki_test, public')
  })

  it('applies every migration and yields a populated schema', async () => {
    await applyMigrations(pool, migrationsDir)

    const tables = await pool.query<{ table_name: string }>(
      `SELECT table_name FROM information_schema.tables
         WHERE table_schema = current_schema() AND table_type = 'BASE TABLE'`,
    )
    expect(tables.rows.length).toBeGreaterThanOrEqual(35)
  })

  it('throws when a migration file references a missing table', async () => {
    await expect(applyMigrations(pool, '/nonexistent')).rejects.toThrow()
  })
})
```

- [ ] **Step 3: Run the test to verify it fails (file not implemented)**

```bash
pnpm --filter @mythrun/wiki test --run applyMigrations
```

Expected: FAIL with `Cannot find module '../applyMigrations.ts'`.

- [ ] **Step 4: Implement `docs/wiki/build/applyMigrations.ts`**

```ts
import { readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { Pool } from 'pg'

const FILENAME_RE = /^[0-9]{3,}_[a-z0-9_]+\.sql$/

/**
 * Reads every `NNN_name.sql` file in `migrationsDir` (alphabetical order is
 * the apply order), and executes them inside a single transaction against the
 * pool's current search_path. Throws if a file fails. Used by the wiki schema
 * extractor to populate a throwaway schema before introspection — it does not
 * track migrations in `_migrations`, take advisory locks, or log structured
 * events the way the backend's runMigrations does. The wiki owns its schema.
 */
export async function applyMigrations(pool: Pool, migrationsDir: string): Promise<void> {
  const entries = await readdir(migrationsDir)
  const files = entries.filter((name) => FILENAME_RE.test(name)).sort()
  if (files.length === 0) {
    throw new Error(`applyMigrations: no migrations found in ${migrationsDir}`)
  }

  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    for (const file of files) {
      const sql = await readFile(join(migrationsDir, file), 'utf-8')
      await client.query(sql)
    }
    await client.query('COMMIT')
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {})
    throw err
  } finally {
    client.release()
  }
}
```

- [ ] **Step 5: Run the test to verify it passes**

```bash
pnpm db:up           # ensure local Postgres is running
pnpm --filter @mythrun/wiki test --run applyMigrations
```

Expected: PASS for both test cases.

If `DATABASE_URL` is unset locally, the suite skips with `describe.skipIf` — set the env from `backend/.env.development`:

```bash
DATABASE_URL=$(grep '^DATABASE_URL=' backend/.env.development | cut -d= -f2-) \
  pnpm --filter @mythrun/wiki test --run applyMigrations
```

- [ ] **Step 6: Typecheck and lint**

```bash
pnpm --filter @mythrun/wiki typecheck
pnpm --filter @mythrun/wiki lint
```

Expected: both exit 0.

- [ ] **Step 7: Commit**

```bash
git add docs/wiki/package.json docs/wiki/build/applyMigrations.ts docs/wiki/build/__tests__/applyMigrations.test.ts pnpm-lock.yaml
git commit -m "feat(myth-6u4): wiki — minimal migrations-applier for the schema extractor

A throwaway-schema applier that reads backend/migrations/*.sql in
order and executes them in a single transaction. Skips the advisory
lock, _migrations ledger, and structured logging the backend
runMigrations does — the wiki owns its own schema and doesn't need
those guarantees.
"
```

---

## Task 4: Schema extractor

Create `schemaExtractor.ts`: opens a Postgres pool, drops/recreates a throwaway schema, applies the migrations via `applyMigrations`, runs five introspection queries, packages the result as `SchemaMetadata`, drops the schema, closes the pool.

**Files:**
- Create: `docs/wiki/build/schemaTypes.ts`
- Create: `docs/wiki/build/schemaExtractor.ts`
- Create: `docs/wiki/build/__tests__/schemaExtractor.test.ts`

- [ ] **Step 1: Create `docs/wiki/build/schemaTypes.ts` with the metadata interfaces**

```ts
/**
 * Typed shape returned by the schema extractor and consumed by the renderer.
 * The renderer is a pure function of this object — no DB access, no I/O.
 */

export type ClusterName =
  | 'Identity & billing'
  | 'Worlds & entities'
  | 'Campaigns & play'
  | 'Pipeline & ops'
  | 'SRD reference'
  | 'Other'

export type DeleteRule = 'CASCADE' | 'SET NULL' | 'NO ACTION' | 'RESTRICT'

export interface ColumnMeta {
  name: string
  type: string
  nullable: boolean
  default: string | null
  fk: { foreignTable: string; foreignColumn: string; deleteRule: DeleteRule } | null
}

export interface IndexMeta {
  name: string
  columns: string[]
  unique: boolean
  predicate: string | null
  expression: string | null
  rawDef: string
}

export interface CheckMeta {
  name: string
  clause: string
}

export interface FkMeta {
  column: string
  foreignTable: string
  foreignColumn: string
  deleteRule: DeleteRule
}

export interface TableMeta {
  name: string
  cluster: ClusterName
  columns: ColumnMeta[]
  indexes: IndexMeta[]
  checks: CheckMeta[]
  fks: FkMeta[]
}

export interface SchemaMetadata {
  tables: TableMeta[]
}

/**
 * Static cluster assignment. Lifted from content/data/schema.html groupings.
 * Tables not in this map fall into 'Other' (defensive — should never fire).
 * `_migrations` is intentionally absent: framework metadata, not application
 * schema, and the user-facing reference hides it.
 */
export const TABLE_CLUSTERS: Readonly<Record<string, ClusterName>> = {
  // Identity & billing
  users: 'Identity & billing',
  credit_ledger: 'Identity & billing',
  subscription_tiers: 'Identity & billing',
  user_subscriptions: 'Identity & billing',
  session_packs: 'Identity & billing',
  purchases: 'Identity & billing',
  stripe_events: 'Identity & billing',
  // Worlds & entities
  worlds: 'Worlds & entities',
  entities: 'Worlds & entities',
  prose_kernels: 'Worlds & entities',
  facts: 'Worlds & entities',
  relationships: 'Worlds & entities',
  entity_hierarchy: 'Worlds & entities',
  random_tables: 'Worlds & entities',
  random_table_entries: 'Worlds & entities',
  stat_blocks: 'Worlds & entities',
  stat_block_actions: 'Worlds & entities',
  // Campaigns & play
  campaigns: 'Campaigns & play',
  campaign_members: 'Campaigns & play',
  campaign_invites: 'Campaigns & play',
  characters: 'Campaigns & play',
  character_skills: 'Campaigns & play',
  character_features: 'Campaigns & play',
  character_equipment: 'Campaigns & play',
  character_spells: 'Campaigns & play',
  sessions: 'Campaigns & play',
  session_messages: 'Campaigns & play',
  session_participants: 'Campaigns & play',
  world_snapshots: 'Campaigns & play',
  session_preps: 'Campaigns & play',
  session_usage: 'Campaigns & play',
  // Pipeline & ops
  pipeline_runs: 'Pipeline & ops',
  world_marketplace: 'Pipeline & ops',
  moderation_flags: 'Pipeline & ops',
  settings: 'Pipeline & ops',
  // SRD reference
  srd_monsters: 'SRD reference',
  srd_spells: 'SRD reference',
  srd_conditions: 'SRD reference',
}

/** Display order for clusters in the rendered page. */
export const CLUSTER_ORDER: readonly ClusterName[] = [
  'Identity & billing',
  'Worlds & entities',
  'Campaigns & play',
  'Pipeline & ops',
  'SRD reference',
  'Other',
]

/** Tables explicitly excluded from the reference page. */
export const HIDDEN_TABLES: ReadonlySet<string> = new Set(['_migrations'])
```

- [ ] **Step 2: Write the failing test for the extractor**

Create `docs/wiki/build/__tests__/schemaExtractor.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { extractSchema } from '../schemaExtractor.ts'

const databaseUrl = process.env.WIKI_DATABASE_URL ?? process.env.DATABASE_URL

const here = dirname(fileURLToPath(import.meta.url))
const migrationsDir = resolve(here, '../../../../backend/migrations')

describe.skipIf(databaseUrl === undefined)('extractSchema (integration)', () => {
  it('returns metadata for every application table, with cluster assignments', async () => {
    const meta = await extractSchema({
      databaseUrl: databaseUrl as string,
      migrationsDir,
    })

    // 35 application tables + 3 SRD = 38, minus _migrations which we hide = 38 in metadata.
    // We assert ≥35 to leave room for future migrations.
    expect(meta.tables.length).toBeGreaterThanOrEqual(35)

    // _migrations must not appear.
    const names = meta.tables.map((t) => t.name)
    expect(names).not.toContain('_migrations')

    // Spot-check a representative table from each cluster.
    const facts = meta.tables.find((t) => t.name === 'facts')
    expect(facts).toBeDefined()
    expect(facts?.cluster).toBe('Worlds & entities')
    expect(facts?.columns.length).toBeGreaterThan(0)

    const users = meta.tables.find((t) => t.name === 'users')
    expect(users?.cluster).toBe('Identity & billing')

    const sessions = meta.tables.find((t) => t.name === 'sessions')
    expect(sessions?.cluster).toBe('Campaigns & play')

    // sessions has the partial-unique index.
    const sessionsIdx = sessions?.indexes.find((i) => i.name === 'idx_sessions_one_active')
    expect(sessionsIdx?.predicate).toContain("status = 'active'")

    // facts has the access_level CHECK.
    expect(facts?.checks.some((c) => c.clause.includes('access_level'))).toBe(true)

    // entities has a CASCADE FK to worlds.
    const entities = meta.tables.find((t) => t.name === 'entities')
    const worldFk = entities?.fks.find((f) => f.column === 'world_id')
    expect(worldFk).toEqual({
      column: 'world_id',
      foreignTable: 'worlds',
      foreignColumn: 'id',
      deleteRule: 'CASCADE',
    })

    // No table is in the 'Other' cluster (the static map covers all current tables).
    const others = meta.tables.filter((t) => t.cluster === 'Other')
    expect(others).toEqual([])
  })

  it('cleans up the throwaway schema after extraction', async () => {
    await extractSchema({
      databaseUrl: databaseUrl as string,
      migrationsDir,
    })
    // A second call must succeed — proves the schema was dropped, not left behind in a half-applied state.
    await extractSchema({
      databaseUrl: databaseUrl as string,
      migrationsDir,
    })
  })
})
```

- [ ] **Step 3: Run the test to verify it fails**

```bash
pnpm --filter @mythrun/wiki test --run schemaExtractor
```

Expected: FAIL with `Cannot find module '../schemaExtractor.ts'`.

- [ ] **Step 4: Implement `docs/wiki/build/schemaExtractor.ts`**

```ts
import { Pool } from 'pg'
import { applyMigrations } from './applyMigrations.ts'
import {
  CLUSTER_ORDER,
  HIDDEN_TABLES,
  TABLE_CLUSTERS,
  type CheckMeta,
  type ClusterName,
  type ColumnMeta,
  type DeleteRule,
  type FkMeta,
  type IndexMeta,
  type SchemaMetadata,
  type TableMeta,
} from './schemaTypes.ts'

const SCHEMA_NAME = 'wiki_schema_introspect'

interface RawColumnRow {
  table_name: string
  column_name: string
  data_type: string
  udt_name: string
  is_nullable: 'YES' | 'NO'
  column_default: string | null
  ordinal_position: number
  character_maximum_length: number | null
  numeric_precision: number | null
  numeric_scale: number | null
}

interface RawIndexRow {
  tablename: string
  indexname: string
  indexdef: string
}

interface RawCheckRow {
  table_name: string
  conname: string
  clause: string
}

interface RawFkRow {
  table_name: string
  column_name: string
  foreign_table_name: string
  foreign_column_name: string
  delete_rule: string
}

export interface ExtractOptions {
  readonly databaseUrl: string
  readonly migrationsDir: string
}

/**
 * Applies the migrations to a throwaway schema, introspects it, returns a
 * typed metadata object, drops the schema, closes the pool. The schema name
 * is constant — concurrent runs against the same DB will collide.
 */
export async function extractSchema(opts: ExtractOptions): Promise<SchemaMetadata> {
  const pool = new Pool({ connectionString: opts.databaseUrl, max: 1 })
  try {
    await pool.query(`DROP SCHEMA IF EXISTS ${SCHEMA_NAME} CASCADE`)
    await pool.query(`CREATE SCHEMA ${SCHEMA_NAME}`)
    await pool.query(`SET search_path TO ${SCHEMA_NAME}, public`)

    await applyMigrations(pool, opts.migrationsDir)

    const tablesQ = await pool.query<{ table_name: string }>(
      `SELECT table_name FROM information_schema.tables
         WHERE table_schema = $1 AND table_type = 'BASE TABLE'
         ORDER BY table_name`,
      [SCHEMA_NAME],
    )

    const columnsQ = await pool.query<RawColumnRow>(
      `SELECT
         table_name, column_name, data_type, udt_name, is_nullable, column_default,
         ordinal_position, character_maximum_length, numeric_precision, numeric_scale
       FROM information_schema.columns
       WHERE table_schema = $1
       ORDER BY table_name, ordinal_position`,
      [SCHEMA_NAME],
    )

    const indexesQ = await pool.query<RawIndexRow>(
      `SELECT tablename, indexname, indexdef
         FROM pg_indexes
        WHERE schemaname = $1 AND indexname LIKE 'idx_%'
        ORDER BY tablename, indexname`,
      [SCHEMA_NAME],
    )

    const checksQ = await pool.query<RawCheckRow>(
      `SELECT t.relname AS table_name, c.conname, pg_get_constraintdef(c.oid) AS clause
         FROM pg_constraint c
         JOIN pg_class t ON t.oid = c.conrelid
         JOIN pg_namespace n ON n.oid = t.relnamespace
        WHERE c.contype = 'c' AND n.nspname = $1
        ORDER BY t.relname, c.conname`,
      [SCHEMA_NAME],
    )

    const fksQ = await pool.query<RawFkRow>(
      `SELECT
         tc.table_name,
         kcu.column_name,
         ccu.table_name AS foreign_table_name,
         ccu.column_name AS foreign_column_name,
         rc.delete_rule
       FROM information_schema.table_constraints tc
       JOIN information_schema.key_column_usage kcu USING (constraint_name)
       JOIN information_schema.constraint_column_usage ccu USING (constraint_name)
       JOIN information_schema.referential_constraints rc USING (constraint_name)
       WHERE tc.constraint_type = 'FOREIGN KEY' AND tc.table_schema = $1
       ORDER BY tc.table_name, kcu.column_name`,
      [SCHEMA_NAME],
    )

    const tables = buildSchemaMetadata(
      tablesQ.rows,
      columnsQ.rows,
      indexesQ.rows,
      checksQ.rows,
      fksQ.rows,
    )

    return { tables }
  } finally {
    await pool.query(`DROP SCHEMA IF EXISTS ${SCHEMA_NAME} CASCADE`).catch(() => {})
    await pool.end()
  }
}

function clusterFor(tableName: string): ClusterName {
  const c = TABLE_CLUSTERS[tableName]
  return c ?? 'Other'
}

function formatType(col: RawColumnRow): string {
  // information_schema.data_type collapses many types to broad labels
  // ("USER-DEFINED" for enums, "ARRAY" for any array). udt_name is the
  // underlying type name (uuid, jsonb, etc.). Prefer udt_name for the
  // common cases where data_type is unhelpful.
  if (col.data_type === 'USER-DEFINED' || col.data_type === 'ARRAY') return col.udt_name
  if (col.data_type === 'character varying') {
    return col.character_maximum_length === null
      ? 'varchar'
      : `varchar(${String(col.character_maximum_length)})`
  }
  if (col.data_type === 'numeric' && col.numeric_precision !== null) {
    const scale = col.numeric_scale ?? 0
    return `numeric(${String(col.numeric_precision)},${String(scale)})`
  }
  if (col.data_type === 'timestamp with time zone') return 'timestamptz'
  if (col.data_type === 'timestamp without time zone') return 'timestamp'
  return col.data_type
}

const COLUMN_LIST_RE = /\(([^)]+)\)(?:\s+WHERE\s+\((.+)\))?/i
const PREDICATE_RE = /\bWHERE\s+\((.+)\)\s*$/i

function parseIndexDef(rawDef: string): { columns: string[]; predicate: string | null; expression: string | null } {
  // pg's indexdef looks like:
  //   CREATE [UNIQUE] INDEX <name> ON <schema>.<table> USING btree (col1, col2) [WHERE (...)]
  // For simple column lists, the parens after USING-something contain comma-separated
  // identifiers. For expression-based indexes (COALESCE(...)), the parens contain
  // expressions we can't cleanly tokenize — fall back to rendering the raw def.
  const match = COLUMN_LIST_RE.exec(rawDef)
  if (match === null) return { columns: [], predicate: null, expression: rawDef }
  const inner = match[1] ?? ''
  // Crude expression detection: a comma-separated list of bare identifiers
  // (lowercase letters, digits, underscores) is "simple"; anything else
  // (parentheses, casts, function calls) is treated as an expression and we
  // fall back to the raw def.
  const parts = inner.split(',').map((s) => s.trim())
  const isSimple = parts.every((p) => /^[a-z_][a-z0-9_]*$/.test(p))
  const predicateMatch = PREDICATE_RE.exec(rawDef)
  const predicate = predicateMatch?.[1] ?? null
  if (!isSimple) {
    return { columns: [], predicate, expression: rawDef }
  }
  return { columns: parts, predicate, expression: null }
}

function buildSchemaMetadata(
  tableRows: { table_name: string }[],
  columnRows: RawColumnRow[],
  indexRows: RawIndexRow[],
  checkRows: RawCheckRow[],
  fkRows: RawFkRow[],
): TableMeta[] {
  const fkByTableCol = new Map<string, FkMeta>()
  for (const row of fkRows) {
    const rule = row.delete_rule.toUpperCase() as DeleteRule
    fkByTableCol.set(`${row.table_name}.${row.column_name}`, {
      column: row.column_name,
      foreignTable: row.foreign_table_name,
      foreignColumn: row.foreign_column_name,
      deleteRule: rule,
    })
  }

  const columnsByTable = new Map<string, ColumnMeta[]>()
  for (const row of columnRows) {
    const cols = columnsByTable.get(row.table_name) ?? []
    cols.push({
      name: row.column_name,
      type: formatType(row),
      nullable: row.is_nullable === 'YES',
      default: row.column_default,
      fk: fkByTableCol.get(`${row.table_name}.${row.column_name}`) ?? null,
    })
    columnsByTable.set(row.table_name, cols)
  }

  const indexesByTable = new Map<string, IndexMeta[]>()
  for (const row of indexRows) {
    const parsed = parseIndexDef(row.indexdef)
    const list = indexesByTable.get(row.tablename) ?? []
    list.push({
      name: row.indexname,
      columns: parsed.columns,
      unique: /CREATE UNIQUE/i.test(row.indexdef),
      predicate: parsed.predicate,
      expression: parsed.expression,
      rawDef: row.indexdef,
    })
    indexesByTable.set(row.tablename, list)
  }

  const checksByTable = new Map<string, CheckMeta[]>()
  for (const row of checkRows) {
    const list = checksByTable.get(row.table_name) ?? []
    list.push({ name: row.conname, clause: row.clause })
    checksByTable.set(row.table_name, list)
  }

  const fksByTable = new Map<string, FkMeta[]>()
  for (const fk of fkByTableCol.values()) {
    // We need to recover the table from the map key; rebuild from rows.
  }
  for (const row of fkRows) {
    const list = fksByTable.get(row.table_name) ?? []
    const rule = row.delete_rule.toUpperCase() as DeleteRule
    list.push({
      column: row.column_name,
      foreignTable: row.foreign_table_name,
      foreignColumn: row.foreign_column_name,
      deleteRule: rule,
    })
    fksByTable.set(row.table_name, list)
  }

  const tables: TableMeta[] = []
  for (const tr of tableRows) {
    if (HIDDEN_TABLES.has(tr.table_name)) continue
    tables.push({
      name: tr.table_name,
      cluster: clusterFor(tr.table_name),
      columns: columnsByTable.get(tr.table_name) ?? [],
      indexes: indexesByTable.get(tr.table_name) ?? [],
      checks: checksByTable.get(tr.table_name) ?? [],
      fks: fksByTable.get(tr.table_name) ?? [],
    })
  }
  return tables
}

/** Used by buildPipeline.ts to ensure clusters are emitted in display order. */
export const ORDERED_CLUSTERS = CLUSTER_ORDER
```

- [ ] **Step 5: Run the test to verify it passes**

```bash
DATABASE_URL=$(grep '^DATABASE_URL=' backend/.env.development | cut -d= -f2-) \
  pnpm --filter @mythrun/wiki test --run schemaExtractor
```

Expected: PASS for both test cases.

- [ ] **Step 6: Typecheck and lint**

```bash
pnpm --filter @mythrun/wiki typecheck
pnpm --filter @mythrun/wiki lint
```

Expected: both exit 0. The typecheck will catch the dead loop on the unused fkByTableCol values — leave as-is if the linter doesn't flag it; remove the dead `for (const fk of fkByTableCol.values()) { ... }` block if eslint complains.

- [ ] **Step 7: Remove the dead loop in `schemaExtractor.ts`**

The `for (const fk of fkByTableCol.values())` block was a leftover thinking-out-loud step. Delete it cleanly:

```ts
  // Delete this block:
  const fksByTable = new Map<string, FkMeta[]>()
  for (const fk of fkByTableCol.values()) {
    // We need to recover the table from the map key; rebuild from rows.
  }
  for (const row of fkRows) {
```

Becomes:

```ts
  const fksByTable = new Map<string, FkMeta[]>()
  for (const row of fkRows) {
```

Re-run typecheck and lint:

```bash
pnpm --filter @mythrun/wiki typecheck
pnpm --filter @mythrun/wiki lint
```

Expected: both exit 0.

- [ ] **Step 8: Commit**

```bash
git add docs/wiki/build/schemaTypes.ts docs/wiki/build/schemaExtractor.ts docs/wiki/build/__tests__/schemaExtractor.test.ts
git commit -m "feat(myth-6u4): wiki — schema metadata extractor

Introspects a fresh throwaway schema with the migrations applied,
returns a typed SchemaMetadata object covering tables, columns, named
indexes (including partial predicates and expression-based fallbacks),
CHECK constraints, and FK delete rules. Cluster assignment is a
static name→ClusterName map colocated in schemaTypes.ts.
"
```

---

## Task 5: Schema renderer

Create `schemaRenderer.ts`: a pure function from `SchemaMetadata` to an HTML string. TDD with fixture-driven unit tests.

**Files:**
- Create: `docs/wiki/build/schemaRenderer.ts`
- Create: `docs/wiki/build/__tests__/schemaRenderer.test.ts`
- Create: `docs/wiki/build/__tests__/fixtures/schemaRenderer/minimal-metadata.ts`

- [ ] **Step 1: Create the fixture metadata file**

`docs/wiki/build/__tests__/fixtures/schemaRenderer/minimal-metadata.ts`:

```ts
import type { SchemaMetadata } from '../../../schemaTypes.ts'

/**
 * Minimal fixture: one table per cluster covering the rendering edge cases.
 * - users: simple columns + one CHECK + one FK (auth_provider)
 * - facts: partial-unique index, multi-column index, multiple CHECKs, FK with CASCADE
 * - sessions: partial-unique index with a WHERE predicate
 * - pipeline_runs: expression-based unique index (no clean column list)
 * - srd_monsters: empty (no indexes, no CHECKs, no FKs) — proves empty sections collapse
 */
export const minimalMetadata: SchemaMetadata = {
  tables: [
    {
      name: 'users',
      cluster: 'Identity & billing',
      columns: [
        { name: 'id', type: 'uuid', nullable: false, default: null, fk: null },
        { name: 'email', type: 'text', nullable: false, default: null, fk: null },
        { name: 'auth_provider', type: 'text', nullable: false, default: null, fk: null },
      ],
      indexes: [],
      checks: [
        {
          name: 'users_auth_provider_check',
          clause: "CHECK ((auth_provider = ANY (ARRAY['google'::text, 'discord'::text])))",
        },
      ],
      fks: [],
    },
    {
      name: 'facts',
      cluster: 'Worlds & entities',
      columns: [
        { name: 'id', type: 'uuid', nullable: false, default: null, fk: null },
        {
          name: 'entity_id',
          type: 'uuid',
          nullable: false,
          default: null,
          fk: { foreignTable: 'entities', foreignColumn: 'id', deleteRule: 'CASCADE' },
        },
        { name: 'access_level', type: 'text', nullable: false, default: null, fk: null },
      ],
      indexes: [
        {
          name: 'idx_facts_entity',
          columns: ['entity_id'],
          unique: false,
          predicate: null,
          expression: null,
          rawDef: 'CREATE INDEX idx_facts_entity ON wiki_schema_introspect.facts USING btree (entity_id)',
        },
      ],
      checks: [
        {
          name: 'facts_access_level_check',
          clause:
            "CHECK ((access_level = ANY (ARRAY['public'::text, 'private'::text, 'secret'::text])))",
        },
      ],
      fks: [
        {
          column: 'entity_id',
          foreignTable: 'entities',
          foreignColumn: 'id',
          deleteRule: 'CASCADE',
        },
      ],
    },
    {
      name: 'sessions',
      cluster: 'Campaigns & play',
      columns: [
        { name: 'id', type: 'uuid', nullable: false, default: null, fk: null },
        {
          name: 'campaign_id',
          type: 'uuid',
          nullable: false,
          default: null,
          fk: { foreignTable: 'campaigns', foreignColumn: 'id', deleteRule: 'CASCADE' },
        },
        { name: 'status', type: 'text', nullable: false, default: null, fk: null },
      ],
      indexes: [
        {
          name: 'idx_sessions_one_active',
          columns: ['campaign_id'],
          unique: true,
          predicate: "status = 'active'::text",
          expression: null,
          rawDef:
            "CREATE UNIQUE INDEX idx_sessions_one_active ON wiki_schema_introspect.sessions USING btree (campaign_id) WHERE (status = 'active'::text)",
        },
      ],
      checks: [],
      fks: [
        {
          column: 'campaign_id',
          foreignTable: 'campaigns',
          foreignColumn: 'id',
          deleteRule: 'CASCADE',
        },
      ],
    },
    {
      name: 'pipeline_runs',
      cluster: 'Pipeline & ops',
      columns: [
        { name: 'id', type: 'uuid', nullable: false, default: null, fk: null },
        {
          name: 'world_id',
          type: 'uuid',
          nullable: true,
          default: null,
          fk: { foreignTable: 'worlds', foreignColumn: 'id', deleteRule: 'CASCADE' },
        },
        { name: 'stage', type: 'text', nullable: false, default: null, fk: null },
      ],
      indexes: [
        {
          name: 'idx_pipeline_runs_unique',
          columns: [],
          unique: true,
          predicate: null,
          expression:
            "CREATE UNIQUE INDEX idx_pipeline_runs_unique ON wiki_schema_introspect.pipeline_runs USING btree (COALESCE(world_id, campaign_id), stage, COALESCE(user_id, '00000000-0000-0000-0000-000000000000'::uuid))",
          rawDef:
            "CREATE UNIQUE INDEX idx_pipeline_runs_unique ON wiki_schema_introspect.pipeline_runs USING btree (COALESCE(world_id, campaign_id), stage, COALESCE(user_id, '00000000-0000-0000-0000-000000000000'::uuid))",
        },
      ],
      checks: [],
      fks: [
        {
          column: 'world_id',
          foreignTable: 'worlds',
          foreignColumn: 'id',
          deleteRule: 'CASCADE',
        },
      ],
    },
    {
      name: 'srd_monsters',
      cluster: 'SRD reference',
      columns: [
        { name: 'id', type: 'uuid', nullable: false, default: null, fk: null },
        { name: 'name', type: 'text', nullable: false, default: null, fk: null },
      ],
      indexes: [],
      checks: [],
      fks: [],
    },
  ],
}
```

- [ ] **Step 2: Write the failing test**

`docs/wiki/build/__tests__/schemaRenderer.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { renderSchema } from '../schemaRenderer.ts'
import { minimalMetadata } from './fixtures/schemaRenderer/minimal-metadata.ts'

describe('renderSchema', () => {
  const html = renderSchema(minimalMetadata)

  it('emits one <h2> per non-empty cluster, in display order', () => {
    const h2s = [...html.matchAll(/<h2[^>]*>([^<]+)<\/h2>/g)].map((m) => m[1])
    expect(h2s).toEqual([
      'Identity & billing',
      'Worlds & entities',
      'Campaigns & play',
      'Pipeline & ops',
      'SRD reference',
    ])
  })

  it('emits one <details data-table-name="X"> per table', () => {
    for (const name of ['users', 'facts', 'sessions', 'pipeline_runs', 'srd_monsters']) {
      expect(html).toContain(`data-table-name="${name}"`)
    }
  })

  it('emits one <tr data-column-name="X"> per column', () => {
    expect(html).toMatch(/data-column-name="email"/)
    expect(html).toMatch(/data-column-name="entity_id"/)
    expect(html).toMatch(/data-column-name="access_level"/)
  })

  it('renders FK references inline in the columns table', () => {
    expect(html).toMatch(/entities\(id\)<\/code>\s*ON DELETE CASCADE/)
  })

  it('omits the Indexes section when a table has no indexes', () => {
    // srd_monsters has no indexes; the <details> for it must not contain "<h4>Indexes</h4>".
    // Find the srd_monsters block and assert.
    const srdStart = html.indexOf('data-table-name="srd_monsters"')
    const srdEnd = html.indexOf('</details>', srdStart)
    const srdBlock = html.slice(srdStart, srdEnd)
    expect(srdBlock).not.toContain('Indexes')
    expect(srdBlock).not.toContain('CHECK constraints')
  })

  it('renders the partial-index predicate', () => {
    expect(html).toContain("WHERE status = 'active'::text")
  })

  it('falls back to raw indexdef for expression-based indexes', () => {
    // pipeline_runs idx_pipeline_runs_unique has columns=[] expression=raw.
    expect(html).toContain('idx_pipeline_runs_unique')
    expect(html).toContain("COALESCE(world_id, campaign_id)")
  })

  it('renders CHECK constraint clauses verbatim', () => {
    expect(html).toContain(
      "CHECK ((access_level = ANY (ARRAY['public'::text, 'private'::text, 'secret'::text])))",
    )
  })

  it('escapes HTML special characters in identifiers', () => {
    const evil: import('../schemaTypes.ts').SchemaMetadata = {
      tables: [
        {
          name: 't<x>',
          cluster: 'Other',
          columns: [{ name: 'c"y', type: 'text', nullable: false, default: null, fk: null }],
          indexes: [],
          checks: [],
          fks: [],
        },
      ],
    }
    const out = renderSchema(evil)
    expect(out).toContain('t&lt;x&gt;')
    expect(out).toContain('c&quot;y')
    expect(out).not.toContain('<x>')
  })

  it('formats the column-row meta summary with counts', () => {
    // facts: 3 columns, 1 index, 1 CHECK, 1 FK — the summary should show those counts.
    const factsStart = html.indexOf('data-table-name="facts"')
    const factsEnd = html.indexOf('</summary>', factsStart)
    const summary = html.slice(factsStart, factsEnd)
    expect(summary).toContain('3 columns')
    expect(summary).toContain('1 index')
    expect(summary).toContain('1 CHECK')
    expect(summary).toContain('1 FK')
  })

  it('produces no output for an empty cluster', () => {
    const empty: import('../schemaTypes.ts').SchemaMetadata = { tables: [] }
    const out = renderSchema(empty)
    // No <h2> headers; the wrapper is allowed to be empty.
    expect(out).not.toMatch(/<h2/)
  })
})
```

- [ ] **Step 3: Run the test to verify it fails**

```bash
pnpm --filter @mythrun/wiki test --run schemaRenderer
```

Expected: FAIL with `Cannot find module '../schemaRenderer.ts'`.

- [ ] **Step 4: Implement `docs/wiki/build/schemaRenderer.ts`**

```ts
import { CLUSTER_ORDER, type ClusterName, type IndexMeta, type SchemaMetadata, type TableMeta } from './schemaTypes.ts'

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

function pluralize(n: number, singular: string, plural?: string): string {
  return `${String(n)} ${n === 1 ? singular : (plural ?? `${singular}s`)}`
}

function renderColumnRow(table: TableMeta, col: TableMeta['columns'][number]): string {
  const nullable = col.nullable ? 'YES' : 'NO'
  const def = col.default === null ? '—' : `<code>${escapeHtml(col.default)}</code>`
  let ref = '—'
  if (col.fk !== null) {
    ref = `<code>${escapeHtml(col.fk.foreignTable)}(${escapeHtml(col.fk.foreignColumn)})</code> ON DELETE ${col.fk.deleteRule}`
  }
  return [
    `      <tr data-column-name="${escapeHtml(col.name)}">`,
    `        <td><code>${escapeHtml(col.name)}</code></td>`,
    `        <td><code>${escapeHtml(col.type)}</code></td>`,
    `        <td>${nullable}</td>`,
    `        <td>${def}</td>`,
    `        <td>${ref}</td>`,
    `      </tr>`,
  ].join('\n')
}

function renderIndex(idx: IndexMeta): string {
  if (idx.expression !== null) {
    // Expression-based index — render the raw indexdef.
    return `    <li><code>${escapeHtml(idx.name)}</code> — <code>${escapeHtml(idx.expression)}</code></li>`
  }
  const uniq = idx.unique ? 'UNIQUE ' : ''
  const cols = `(${idx.columns.join(', ')})`
  const where = idx.predicate === null ? '' : ` WHERE ${escapeHtml(idx.predicate)}`
  return `    <li><code>${escapeHtml(idx.name)}</code> — ${uniq}${escapeHtml(cols)}${where}</li>`
}

function renderTable(table: TableMeta): string {
  const counts: string[] = [
    pluralize(table.columns.length, 'column'),
    pluralize(table.indexes.length, 'index', 'indexes'),
    pluralize(table.checks.length, 'CHECK'),
    pluralize(table.fks.length, 'FK'),
  ]

  const parts: string[] = []
  parts.push(
    `<details class="schema-table" data-table-name="${escapeHtml(table.name)}" id="schema-table-${escapeHtml(table.name)}">`,
  )
  parts.push(`  <summary>`)
  parts.push(`    <span class="schema-table-name">${escapeHtml(table.name)}</span>`)
  parts.push(`    <span class="schema-table-meta">${counts.join(' · ')}</span>`)
  parts.push(`  </summary>`)
  parts.push(`  <table class="schema-columns">`)
  parts.push(`    <thead><tr><th>Name</th><th>Type</th><th>Nullable</th><th>Default</th><th>References</th></tr></thead>`)
  parts.push(`    <tbody>`)
  for (const col of table.columns) {
    parts.push(renderColumnRow(table, col))
  }
  parts.push(`    </tbody>`)
  parts.push(`  </table>`)
  if (table.indexes.length > 0) {
    parts.push(`  <h4>Indexes</h4>`)
    parts.push(`  <ul class="schema-list">`)
    for (const idx of table.indexes) parts.push(renderIndex(idx))
    parts.push(`  </ul>`)
  }
  if (table.checks.length > 0) {
    parts.push(`  <h4>CHECK constraints</h4>`)
    parts.push(`  <ul class="schema-list">`)
    for (const c of table.checks) {
      parts.push(`    <li><code>${escapeHtml(c.clause)}</code></li>`)
    }
    parts.push(`  </ul>`)
  }
  parts.push(`</details>`)
  return parts.join('\n')
}

export function renderSchema(meta: SchemaMetadata): string {
  const byCluster = new Map<ClusterName, TableMeta[]>()
  for (const t of meta.tables) {
    const list = byCluster.get(t.cluster) ?? []
    list.push(t)
    byCluster.set(t.cluster, list)
  }

  const out: string[] = []
  for (const cluster of CLUSTER_ORDER) {
    const tables = byCluster.get(cluster)
    if (tables === undefined || tables.length === 0) continue
    out.push(`<h2 class="schema-cluster">${escapeHtml(cluster)}</h2>`)
    for (const t of tables) {
      out.push(renderTable(t))
    }
  }
  return out.join('\n')
}
```

- [ ] **Step 5: Run the test to verify it passes**

```bash
pnpm --filter @mythrun/wiki test --run schemaRenderer
```

Expected: all assertions PASS.

- [ ] **Step 6: Typecheck and lint**

```bash
pnpm --filter @mythrun/wiki typecheck
pnpm --filter @mythrun/wiki lint
```

Expected: both exit 0.

- [ ] **Step 7: Commit**

```bash
git add docs/wiki/build/schemaRenderer.ts docs/wiki/build/__tests__/schemaRenderer.test.ts docs/wiki/build/__tests__/fixtures/schemaRenderer/
git commit -m "feat(myth-6u4): wiki — schema renderer and fixture-driven tests

Pure function from SchemaMetadata to HTML string. Renders one
<details> per table grouped by cluster, with columns table, indexes
list, and CHECK constraints list. Expression-based indexes fall back
to rendering the raw indexdef. Empty index/check sections collapse.
"
```

---

## Task 6: Wire extractor → renderer → buildPipeline

Replace the hardcoded fragment from Task 2 with a call to the live extractor + renderer.

**Files:**
- Create: `docs/wiki/build/schemaRef.ts`
- Modify: `docs/wiki/build/buildPipeline.ts`

- [ ] **Step 1: Create the orchestrator `docs/wiki/build/schemaRef.ts`**

```ts
import { extractSchema } from './schemaExtractor.ts'
import { renderSchema } from './schemaRenderer.ts'

export interface BuildSchemaFragmentOptions {
  readonly databaseUrl: string
  readonly migrationsDir: string
}

/** Returns the HTML fragment to splice at the <!-- @schema-reference --> marker. */
export async function buildSchemaFragment(opts: BuildSchemaFragmentOptions): Promise<string> {
  const meta = await extractSchema(opts)
  return renderSchema(meta)
}
```

- [ ] **Step 2: Modify `docs/wiki/build/buildPipeline.ts` to call the orchestrator when a marker is detected**

At the top of the file, add the import:

```ts
import { buildSchemaFragment } from './schemaRef.ts'
```

Add a helper that scans pages for the marker, mirroring `scanAllRunbooks`. Place it near `scanAllRunbooks` (around line 231):

```ts
async function detectSchemaReferenceNeed(pages: Page[]): Promise<boolean> {
  for (const page of pages) {
    const raw = await readFile(page.contentAbs, 'utf-8')
    if (raw.includes('<!-- @schema-reference -->')) return true
  }
  return false
}
```

In `runBuild` (around line 373), replace the hardcoded `schemaFragment` placeholder. Find:

```ts
    schemaFragment:
      '<p class="schema-fragment-stub">[schema fragment placeholder — replaced in Task 5]</p>',
```

Replace with:

```ts
    schemaFragment: null as string | null,
```

Then, BEFORE the `for (const page of pages)` loop, add:

```ts
  let schemaFragment: string | null = null
  if (await detectSchemaReferenceNeed(pages)) {
    const databaseUrl = process.env.WIKI_DATABASE_URL ?? process.env.DATABASE_URL
    if (databaseUrl === undefined) {
      throw new Error(
        'wiki:build needs DATABASE_URL (or WIKI_DATABASE_URL) set so the schema reference page can be generated. Run `pnpm db:up` and source backend/.env.development.',
      )
    }
    const migrationsDir = join(repoRoot, 'backend', 'migrations')
    schemaFragment = await buildSchemaFragment({ databaseUrl, migrationsDir })
  }
  ctx.schemaFragment = schemaFragment
```

(Note: `ctx` was previously a `const` literal; you'll need to convert it to `let ctx` or re-construct it after the fragment is computed. The cleanest edit is to compute the fragment first, then build ctx:

```ts
  let schemaFragment: string | null = null
  if (await detectSchemaReferenceNeed(pages)) {
    const databaseUrl = process.env.WIKI_DATABASE_URL ?? process.env.DATABASE_URL
    if (databaseUrl === undefined) {
      throw new Error(
        'wiki:build needs DATABASE_URL (or WIKI_DATABASE_URL) set so the schema reference page can be generated. Run `pnpm db:up` and source backend/.env.development.',
      )
    }
    const migrationsDir = join(repoRoot, 'backend', 'migrations')
    schemaFragment = await buildSchemaFragment({ databaseUrl, migrationsDir })
  }

  const ctx = {
    root,
    repoRoot,
    structure,
    mode,
    shell,
    dotHeader,
    shellSlotNames,
    siteDir,
    runbookAggregate,
    schemaFragment,
  }
```

This is the form you should leave behind.)

- [ ] **Step 3: Build and verify the page contains real data**

```bash
DATABASE_URL=$(grep '^DATABASE_URL=' backend/.env.development | cut -d= -f2-) \
  pnpm wiki:build
```

Expected: exit 0.

```bash
grep -c 'data-table-name="users"' docs/wiki/site/reference/schema.html
grep -c 'data-table-name="facts"' docs/wiki/site/reference/schema.html
grep -c 'idx_sessions_one_active' docs/wiki/site/reference/schema.html
grep -c 'idx_pipeline_runs_unique' docs/wiki/site/reference/schema.html
grep -c 'access_level' docs/wiki/site/reference/schema.html
grep -c '_migrations' docs/wiki/site/reference/schema.html
```

Expected: all `1` or higher except `_migrations` which must be `0`.

- [ ] **Step 4: Source-hash drift will fire because the rendered HTML changed; accept and re-check**

```bash
DATABASE_URL=$(grep '^DATABASE_URL=' backend/.env.development | cut -d= -f2-) \
  pnpm wiki:check
```

Expected: exit 1, `drift: docs/wiki/content/reference/schema.html (mismatch)`. Wait — but the SOURCE files (`backend/migrations/*.sql`) haven't changed since Task 2 accepted drift. Why would `wiki:check` fire? It shouldn't. If it does, something has changed about the source-hash inputs. Investigate.

If `wiki:check` is green, proceed. If it fires drift, check whether any migration file or `applyMigrations` source got accidentally modified.

- [ ] **Step 5: Smoke-test the rendered page in the dev server**

```bash
DATABASE_URL=$(grep '^DATABASE_URL=' backend/.env.development | cut -d= -f2-) \
  pnpm wiki:dev
```

Open http://localhost:3100/reference/schema.html. Confirm:
- Five `<h2>` cluster headings.
- 38 `<details>` table elements (one per application + SRD table; `_migrations` is hidden).
- Clicking a `<details>` summary expands it. Columns table renders with type/nullable/default/references columns.
- The page works without JS (the search bar exists but is non-functional yet — that's Task 7).

Stop the dev server.

- [ ] **Step 6: Typecheck and lint**

```bash
pnpm --filter @mythrun/wiki typecheck
pnpm --filter @mythrun/wiki lint
```

Expected: both exit 0.

- [ ] **Step 7: Commit**

```bash
git add docs/wiki/build/schemaRef.ts docs/wiki/build/buildPipeline.ts
git commit -m "feat(myth-6u4): wiki — wire live schema fragment into buildPipeline

Detects the <!-- @schema-reference --> marker on any page; if
present, runs the extractor against DATABASE_URL once per build and
caches the rendered fragment for splice. Fails loudly if the marker
is present but no DATABASE_URL is set.
"
```

---

## Task 7: Client-side search/filter/highlight + counter + expand-all

Add a vanilla-JS handler in `helper.js` that wires the search bar, the counter, and the Expand all / Collapse all buttons. Highlight matches with `<mark>`. Auto-expand matched tables.

**Files:**
- Modify: `docs/wiki/layout/helper.js`

- [ ] **Step 1: Add `setupSchemaReferenceSearch` to `docs/wiki/layout/helper.js`**

After `setupDiagramModal()` (around line 89), add:

```js
  // Schema-reference search/filter/highlight. Lives only on
  // /reference/schema.html — short-circuits everywhere else.
  function setupSchemaReferenceSearch() {
    var search = document.getElementById('schema-search')
    var counter = document.getElementById('schema-counter')
    var expandAll = document.getElementById('schema-expand-all')
    var collapseAll = document.getElementById('schema-collapse-all')
    if (search === null || counter === null) return

    var tables = Array.prototype.slice.call(document.querySelectorAll('details.schema-table'))
    var totalTables = tables.length

    // Track each table's initial open state so empty-query restores it.
    var initialOpen = new Map()
    tables.forEach(function (t) {
      initialOpen.set(t, t.open)
    })

    function clearHighlights(root) {
      var marks = root.querySelectorAll('mark.schema-match')
      marks.forEach(function (m) {
        var parent = m.parentNode
        while (m.firstChild !== null) parent.insertBefore(m.firstChild, m)
        parent.removeChild(m)
        parent.normalize()
      })
    }

    function highlightInTextNodes(root, query) {
      // Walk text nodes; wrap matches in <mark class="schema-match">.
      var walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
        acceptNode: function (node) {
          // Skip <code> children inside the constraints/index lists — too noisy and we only
          // want to highlight in identifier-bearing cells.
          var p = node.parentNode
          if (p === null) return NodeFilter.FILTER_REJECT
          // Only highlight in: .schema-table-name, td (column rows), .schema-table-meta is fine to skip.
          var inTableName = p.classList && p.classList.contains('schema-table-name')
          var inSummary = false
          var ancestor = p
          while (ancestor !== null && ancestor !== root) {
            if (ancestor.tagName === 'TD') {
              inSummary = true
              break
            }
            ancestor = ancestor.parentNode
          }
          if (inTableName || inSummary) return NodeFilter.FILTER_ACCEPT
          return NodeFilter.FILTER_REJECT
        },
      })

      var nodes = []
      var n = walker.nextNode()
      while (n !== null) {
        nodes.push(n)
        n = walker.nextNode()
      }

      var lower = query.toLowerCase()
      nodes.forEach(function (textNode) {
        var text = textNode.nodeValue
        var lowerText = text.toLowerCase()
        var idx = lowerText.indexOf(lower)
        if (idx === -1) return
        var frag = document.createDocumentFragment()
        var cursor = 0
        while (idx !== -1) {
          if (idx > cursor) frag.appendChild(document.createTextNode(text.slice(cursor, idx)))
          var m = document.createElement('mark')
          m.className = 'schema-match'
          m.appendChild(document.createTextNode(text.slice(idx, idx + query.length)))
          frag.appendChild(m)
          cursor = idx + query.length
          idx = lowerText.indexOf(lower, cursor)
        }
        if (cursor < text.length) frag.appendChild(document.createTextNode(text.slice(cursor)))
        textNode.parentNode.replaceChild(frag, textNode)
      })
    }

    function applyFilter() {
      var rawQuery = search.value
      var query = rawQuery.trim().toLowerCase()

      tables.forEach(function (t) {
        clearHighlights(t)
      })

      if (query === '') {
        // Restore initial state.
        tables.forEach(function (t) {
          t.classList.remove('schema-hidden')
          t.open = initialOpen.get(t) === true
        })
        counter.textContent = 'Showing all tables'
        return
      }

      var matches = 0
      tables.forEach(function (t) {
        var tableName = (t.getAttribute('data-table-name') || '').toLowerCase()
        var nameMatch = tableName.indexOf(query) !== -1

        var rows = t.querySelectorAll('tr[data-column-name]')
        var anyColumnMatch = false
        for (var i = 0; i < rows.length; i++) {
          var col = (rows[i].getAttribute('data-column-name') || '').toLowerCase()
          if (col.indexOf(query) !== -1) {
            anyColumnMatch = true
            break
          }
        }

        if (!nameMatch && !anyColumnMatch) {
          t.classList.add('schema-hidden')
          return
        }

        t.classList.remove('schema-hidden')
        t.open = true
        highlightInTextNodes(t, rawQuery.trim())
        matches++
      })

      counter.textContent =
        'Showing ' + String(matches) + ' of ' + String(totalTables) + ' tables'
    }

    search.addEventListener('input', applyFilter)

    if (expandAll !== null) {
      expandAll.addEventListener('click', function () {
        tables.forEach(function (t) {
          t.open = true
        })
      })
    }
    if (collapseAll !== null) {
      collapseAll.addEventListener('click', function () {
        tables.forEach(function (t) {
          t.open = false
        })
      })
    }

    counter.textContent = 'Showing all tables'
  }
```

- [ ] **Step 2: Add `setupSchemaReferenceSearch()` to the `init()` call**

Find:

```js
  function init() {
    setActiveToc()
    setupDiagramModal()
  }
```

Change to:

```js
  function init() {
    setActiveToc()
    setupDiagramModal()
    setupSchemaReferenceSearch()
  }
```

- [ ] **Step 3: Build and smoke-test the JS in the dev server**

```bash
DATABASE_URL=$(grep '^DATABASE_URL=' backend/.env.development | cut -d= -f2-) \
  pnpm wiki:dev
```

Open http://localhost:3100/reference/schema.html. Test:
1. Type `facts` in the search bar → only the `facts` table is visible, expanded, with `facts` highlighted. Counter reads `Showing 1 of 38 tables`.
2. Clear the search → all tables visible again, in their initial collapsed state. Counter reads `Showing all tables`.
3. Type `access_level` → tables containing that column are visible and expanded; the `access_level` text in each visible td is highlighted. Counter reads the right count (`facts` has it; possibly others).
4. Type something with no match (e.g. `xyzzy`) → all tables hidden. Counter reads `Showing 0 of 38 tables`.
5. Click `Expand all` → every table opens.
6. Click `Collapse all` → every table closes.
7. Repeated typing must not produce duplicate `<mark>` tags (we clear highlights at the start of each `applyFilter`).

Stop the dev server.

- [ ] **Step 4: No tests required for this step — vanilla JS in a browser**

The wiki package doesn't have a JS-DOM test harness for `helper.js` today (the existing `setActiveToc` and `setupDiagramModal` are not unit-tested either — they're verified manually in the dev server). Don't introduce one for this bead; the manual smoke test is the contract.

- [ ] **Step 5: Commit**

```bash
git add docs/wiki/layout/helper.js
git commit -m "feat(myth-6u4): wiki — schema reference client-side search/filter

Vanilla-JS filter wired to the search input on
/reference/schema.html. Hides non-matching tables, auto-expands
matching ones, wraps matched substrings in <mark>, updates the
counter. Expand-all / Collapse-all buttons.
"
```

---

## Task 8: Styles for the schema reference

Add minimal CSS for the search controls, the table chrome, the column table, and the highlight mark.

**Files:**
- Modify: `docs/wiki/layout/styles.css`

- [ ] **Step 1: Read the bottom of `styles.css` to see the existing convention**

```bash
tail -40 docs/wiki/layout/styles.css
```

Note the existing style of class names (`wiki-*`, `schema-*` will be parallel) and the use of CSS custom properties (`var(--paper-500)`, etc).

- [ ] **Step 2: Append schema-reference styles to `docs/wiki/layout/styles.css`**

```css
/* ===== Schema reference (reference/schema.html) ===== */

.schema-controls {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  align-items: center;
  margin: 16px 0 24px;
  padding: 12px;
  border: 1px solid var(--paper-300);
  border-radius: 4px;
  background: var(--paper-100);
}

.schema-controls input[type='search'] {
  flex: 1;
  min-width: 200px;
  padding: 6px 10px;
  font: inherit;
  border: 1px solid var(--paper-400);
  border-radius: 3px;
}

.schema-controls button {
  padding: 6px 10px;
  font: inherit;
  background: var(--paper-50);
  border: 1px solid var(--paper-400);
  border-radius: 3px;
  cursor: pointer;
}
.schema-controls button:hover {
  background: var(--paper-100);
}

.schema-counter {
  font-size: 12px;
  color: var(--paper-600);
  white-space: nowrap;
}

.schema-cluster {
  margin-top: 32px;
  padding-bottom: 4px;
  border-bottom: 1px solid var(--paper-300);
}

.schema-table {
  margin: 8px 0;
  padding: 0;
  border: 1px solid var(--paper-300);
  border-radius: 4px;
  background: var(--paper-50);
}

.schema-table > summary {
  list-style: none;
  cursor: pointer;
  padding: 8px 12px;
  display: flex;
  justify-content: space-between;
  align-items: center;
  user-select: none;
}
.schema-table > summary::-webkit-details-marker {
  display: none;
}
.schema-table > summary::before {
  content: '▸';
  margin-right: 8px;
  display: inline-block;
  transition: transform 0.1s;
}
.schema-table[open] > summary::before {
  transform: rotate(90deg);
}

.schema-table-name {
  font-family: var(--mono, monospace);
  font-weight: 600;
}

.schema-table-meta {
  font-size: 12px;
  color: var(--paper-600);
}

.schema-table[open] {
  background: var(--paper-100);
}

.schema-columns {
  width: 100%;
  margin: 8px 0 0;
  padding: 0 12px 12px;
  border-collapse: collapse;
}

.schema-columns th,
.schema-columns td {
  padding: 4px 8px;
  text-align: left;
  border-bottom: 1px solid var(--paper-200);
  font-size: 13px;
  vertical-align: top;
}

.schema-columns th {
  font-weight: 600;
  color: var(--paper-700);
}

.schema-table h4 {
  margin: 12px 12px 4px;
  font-size: 13px;
  font-weight: 600;
  color: var(--paper-700);
}

.schema-list {
  margin: 0 12px 12px 28px;
  padding: 0;
  font-size: 13px;
}
.schema-list li {
  padding: 2px 0;
}

.schema-hidden {
  display: none;
}

mark.schema-match {
  background: #fff59d;
  padding: 0;
  color: inherit;
}
```

If `var(--paper-N)` or `var(--mono)` aren't defined in the existing CSS, the styles fall back gracefully — but if the layout looks plain, check what variables the existing `wiki-*` classes use and substitute.

- [ ] **Step 3: Build and visually verify**

```bash
DATABASE_URL=$(grep '^DATABASE_URL=' backend/.env.development | cut -d= -f2-) \
  pnpm wiki:dev
```

Open http://localhost:3100/reference/schema.html. Confirm:
- Search controls bar is visible at the top, with input + counter + buttons.
- Cluster headings (`<h2>`) are visually distinct.
- Table summaries show name + meta line; the disclosure triangle rotates when expanded.
- Column tables have visible borders, monospace identifiers, readable typography.
- Highlights (`mark`) show as a subtle yellow background.

- [ ] **Step 4: Commit**

```bash
git add docs/wiki/layout/styles.css
git commit -m "style(myth-6u4): wiki — schema reference page styles

Search controls bar, table chrome, column table layout, mark highlights.
"
```

---

## Task 9: CI workflow — Postgres service container

Add a `postgres:16-alpine` service container to `wiki-check.yml` and export `DATABASE_URL` for the build step.

**Files:**
- Modify: `.github/workflows/wiki-check.yml`

- [ ] **Step 1: Read the existing wiki-check.yml**

```bash
cat .github/workflows/wiki-check.yml
```

Note the structure: single `check` job with `actions/checkout`, `pnpm/action-setup`, `actions/setup-node`, install, then three steps (typecheck, test, wiki:check).

- [ ] **Step 2: Replace `wiki-check.yml` with the Postgres-aware version**

```yaml
name: Wiki

on:
  pull_request:
    paths:
      - 'docs/wiki/**'
      - 'infra/**'
      - 'backend/**'
      - '.github/workflows/wiki-check.yml'
  push:
    branches: [main]
    paths:
      - 'docs/wiki/**'
      - 'infra/**'
      - 'backend/**'

jobs:
  check:
    runs-on: ubuntu-latest
    services:
      postgres:
        image: postgres:16-alpine
        env:
          POSTGRES_USER: mythrun
          POSTGRES_PASSWORD: mythrun_dev
          POSTGRES_DB: mythrun
        ports:
          - 5432:5432
        options: >-
          --health-cmd "pg_isready -U mythrun"
          --health-interval 5s
          --health-timeout 3s
          --health-retries 10
    env:
      DATABASE_URL: postgresql://mythrun:mythrun_dev@localhost:5432/mythrun
    steps:
      - uses: actions/checkout@v6
      - uses: pnpm/action-setup@v6
      - uses: actions/setup-node@v4
        with:
          node-version: 24
          cache: pnpm
      - name: Install dependencies
        run: pnpm install --frozen-lockfile
      - name: Typecheck wiki
        run: pnpm --filter @mythrun/wiki typecheck
      - name: Test wiki
        run: pnpm --filter @mythrun/wiki test
      - name: Check wiki freshness
        run: pnpm wiki:check
```

- [ ] **Step 3: Push to a branch and verify the workflow on GitHub**

This step requires the user (or follow-on commits) to push the branch and observe the CI run. Locally, you cannot exercise the GitHub Actions runner — but the YAML is structurally valid against `deploy.yml`'s known-good pattern.

For local sanity, validate the YAML syntactically:

```bash
python3 -c "import yaml; yaml.safe_load(open('.github/workflows/wiki-check.yml'))"
```

Expected: no output (valid YAML).

- [ ] **Step 4: Commit**

```bash
git add .github/workflows/wiki-check.yml
git commit -m "ci(myth-6u4): wiki-check — provision Postgres for schema reference build

The schema reference page is generated by introspecting a fresh
Postgres at build time. Adds the same postgres:16-alpine service
container deploy.yml uses, plus DATABASE_URL.
"
```

---

## Task 10: AUTHORING.md updates

Two additions: the Narrative-vs-Reference page-kind framing near the top, and the auto-generated-page convention after Page header comments.

**Files:**
- Modify: `docs/wiki/AUTHORING.md`

- [ ] **Step 1: Add the Narrative vs Reference section**

In `docs/wiki/AUTHORING.md`, find the section ending `7. **Default stance: author rather than skip.**` (around line 23) and the `---` divider after it. After that divider, insert a new section before "Canonical page spine":

```markdown
## Narrative vs Reference pages

The wiki holds two kinds of pages and they have different rules.

**Narrative pages** live in topical sections (`Infra`, `Runtime`, `Data`, `Auth & Billing`, `World & Campaign`, `Combat`, `Frontend`). They are story-shaped explainers, hand-authored, governed by the seven principles above and the canonical page spine below. One page per coherent concept; the reader scrolls front-to-back to learn how the system fits together.

**Reference pages** live in the top-level `Reference` section. They are derived views — auto-aggregated from other pages or auto-generated from upstream artifacts (migrations, Terraform, etc.). The reader arrives with a specific question ("what runbooks exist for the data plane?", "which tables CASCADE on user deletion?") and uses the page as a tool. The seven principles and the canonical spine apply to narrative pages; reference pages have their own minimal shape:

1. `<h1>` title.
2. `<p class="lead">` — one sentence on what the page is for.
3. (Optionally) source comments at the top declaring the upstream artifacts.
4. A marker the build replaces with generated content (e.g. `<!-- @runbooks-index -->`, `<!-- @schema-reference -->`).

Reference pages don't carry diagrams, "How it fits together" sections, or rationale callouts. The narrative explainer for the same subject does. The schema reference at `reference/schema.html` complements the narrative explainer at `data/schema.html` — same subject, two different use cases.

**Adding a new reference page** means deciding (a) what upstream artifact it derives from, (b) what marker the build will replace, and (c) which page in the topical sections is the narrative complement (cross-link both ways). See "Auto-generated reference pages" below for the marker mechanism.

---
```

- [ ] **Step 2: Add the Auto-generated reference pages section**

Find the existing section "Page header comments" (around line 126). After its closing `---` divider, insert a new section before "Authoring conventions":

```markdown
## Auto-generated reference pages

Reference pages whose body is generated by the build use a marker — an HTML comment the build pipeline replaces with rendered content. The pattern is:

```html
<!-- source: <upstream artifact path> -->
<!-- source-hash: sha256:<auto> -->

<h1>Title</h1>
<p class="lead">…</p>

<!-- @<marker-name> -->
```

Two markers exist today:

| Marker | Page | Source |
| --- | --- | --- |
| `<!-- @runbooks-index -->` | `reference/runbooks.html` | scans every page's `<h3>` under `Operating this piece` |
| `<!-- @schema-reference -->` | `reference/schema.html` | introspects `backend/migrations/*.sql` against a fresh Postgres |

When the upstream artifact changes, the page's source-hash drifts. The contributor:

1. Runs `pnpm wiki:build` (locally with `DATABASE_URL` set if the marker uses it). The build regenerates `site/<page>.html`.
2. Inspects the rebuilt page in `pnpm wiki:dev`.
3. Runs `pnpm wiki:accept-drift`. The hash in `content/<page>.html` updates.
4. Commits the upstream change AND the source-hash bump.

CI's `pnpm wiki:check` re-runs the generator and compares the hash. Forgetting step 3 is a red CI build with `drift: <page> (mismatch)`.

The hand-written shell of an auto-generated page (lead, integration points, framing prose) rarely changes — only the source-hash comment moves when an upstream change ripples through. Don't hand-edit between the markers; the build will overwrite.

---
```

- [ ] **Step 3: Verify the rendered AUTHORING.md is still valid markdown**

```bash
head -200 docs/wiki/AUTHORING.md | grep -E '^#|^##'
```

Expected: a sensible heading hierarchy with the new sections in their right places.

- [ ] **Step 4: Commit**

```bash
git add docs/wiki/AUTHORING.md
git commit -m "docs(myth-6u4): AUTHORING.md — Narrative vs Reference page kinds

Documents the page-kind split (Reference is its own section now, home
for derived views like the runbook index and schema reference) and
the marker-replacement convention used by auto-generated reference
pages.
"
```

---

## Task 11: Cross-link from data/schema.html to reference/schema.html

Add the cross-link the spec promises so a reader on the explainer can find the reference, and vice versa (the reference already links back from its Integration points section per Task 2).

**Files:**
- Modify: `docs/wiki/content/data/schema.html`

- [ ] **Step 1: Find the existing "Integration points" paragraph in `docs/wiki/content/data/schema.html`**

It currently reads (around line 247-256):

```html
<h2>Integration points</h2>

<p>
  The <a href="./migrations.html">migrations runner</a> applies these three files; the runner's
  <code>_migrations</code> bookkeeping is what the drift hint is reasoning about. Downstream, the
  <a href="../runtime/index.html">backend runtime</a>'s repository layer will read and write these
  tables; the <a href="../auth-billing/index.html">auth & billing</a> stories build on
  <code>users</code>, <code>credit_ledger</code>, <code>user_subscriptions</code>, and
  <code>stripe_events</code>; the
  <a href="../world-campaign/index.html">world & campaign</a> pipeline writes <code>worlds</code> +
  <code>entities</code> + <code>facts</code> + <code>prose_kernels</code>.
</p>
```

- [ ] **Step 2: Add a sentence pointing readers at the reference page**

Replace the paragraph with:

```html
<h2>Integration points</h2>

<p>
  The <a href="./migrations.html">migrations runner</a> applies these three files; the runner's
  <code>_migrations</code> bookkeeping is what the drift hint is reasoning about. Downstream, the
  <a href="../runtime/index.html">backend runtime</a>'s repository layer will read and write these
  tables; the <a href="../auth-billing/index.html">auth & billing</a> stories build on
  <code>users</code>, <code>credit_ledger</code>, <code>user_subscriptions</code>, and
  <code>stripe_events</code>; the
  <a href="../world-campaign/index.html">world & campaign</a> pipeline writes <code>worlds</code> +
  <code>entities</code> + <code>facts</code> + <code>prose_kernels</code>. For the column-by-column
  view — every type, default, constraint, index, and FK — see the
  <a href="../reference/schema.html">schema reference</a> page.
</p>
```

- [ ] **Step 3: Run wiki:build and wiki:check**

```bash
DATABASE_URL=$(grep '^DATABASE_URL=' backend/.env.development | cut -d= -f2-) \
  pnpm wiki:build
DATABASE_URL=$(grep '^DATABASE_URL=' backend/.env.development | cut -d= -f2-) \
  pnpm wiki:check
```

Expected: `wiki:build` succeeds; `wiki:check` either green, or red with a drift on `data/schema.html` (the SOURCE for that page is `backend/migrations/`, but the page itself was edited, which is independent of source-hash drift — source-hash drift fires when the source files change, not the content file). If it fires, the hash didn't change because the source files didn't change; this should stay green. If it goes red unexpectedly, investigate.

- [ ] **Step 4: Commit**

```bash
git add docs/wiki/content/data/schema.html
git commit -m "docs(myth-6u4): wiki — cross-link explainer to schema reference

The narrative schema page now points readers at the column-level
reference page for lookup. The reverse link already exists in the
reference page's Integration points footer.
"
```

---

## Task 12: Final verify + add a fake migration to prove the regeneration loop

Per the spec's "Done when": adding a new migration must show up in the page on rebuild. Verify this in a sandboxed-and-reverted way.

**Files (temporary, reverted before commit):**
- Create + revert: `backend/migrations/004_test_foo.sql`

- [ ] **Step 1: Run the full local verification suite**

```bash
DATABASE_URL=$(grep '^DATABASE_URL=' backend/.env.development | cut -d= -f2-) \
  pnpm typecheck
DATABASE_URL=$(grep '^DATABASE_URL=' backend/.env.development | cut -d= -f2-) \
  pnpm lint
DATABASE_URL=$(grep '^DATABASE_URL=' backend/.env.development | cut -d= -f2-) \
  pnpm test
DATABASE_URL=$(grep '^DATABASE_URL=' backend/.env.development | cut -d= -f2-) \
  pnpm wiki:check
```

All four must exit 0.

- [ ] **Step 2: Add a fake migration `backend/migrations/004_test_foo.sql`**

```sql
CREATE TABLE foo (
  id UUID PRIMARY KEY,
  name TEXT NOT NULL
);
```

- [ ] **Step 3: Rebuild and confirm `foo` shows up**

```bash
DATABASE_URL=$(grep '^DATABASE_URL=' backend/.env.development | cut -d= -f2-) \
  pnpm wiki:build
grep -c 'data-table-name="foo"' docs/wiki/site/reference/schema.html
```

Expected: `1`. The `foo` table appears in the rendered page (likely under the `Other` cluster since it's not in the static map). `wiki:check` would now fail with a source-hash drift because `backend/migrations/` changed.

- [ ] **Step 4: Confirm wiki:check fires drift**

```bash
DATABASE_URL=$(grep '^DATABASE_URL=' backend/.env.development | cut -d= -f2-) \
  pnpm wiki:check
```

Expected: exit 1, `drift: docs/wiki/content/reference/schema.html (mismatch)`. This proves the drift contract works for the new page.

- [ ] **Step 5: Revert the fake migration**

```bash
rm backend/migrations/004_test_foo.sql
DATABASE_URL=$(grep '^DATABASE_URL=' backend/.env.development | cut -d= -f2-) \
  pnpm wiki:build
DATABASE_URL=$(grep '^DATABASE_URL=' backend/.env.development | cut -d= -f2-) \
  pnpm wiki:check
```

Expected: build green, check green.

- [ ] **Step 6: Final repo cleanliness check**

```bash
git status
```

Expected: working tree clean. If anything (e.g. the source-hash in `content/reference/schema.html`) shifted during the test cycle, restore it via `git checkout -- <file>`.

- [ ] **Step 7: No commit needed for this task**

This task is purely verification. The work is already in commits from Tasks 1–11. If git status is dirty, investigate before declaring the bead done.

---

## Self-review checklist

After all tasks land:

- [ ] **Spec coverage:** every section of `docs/superpowers/specs/2026-04-27-wiki-schema-reference-design.md` maps to at least one task.
- [ ] **No placeholders:** the plan has zero "TBD", "TODO", or vague guidance — every step has the exact commands, file paths, and code.
- [ ] **Type consistency:** `SchemaMetadata`, `TableMeta`, `ColumnMeta`, `IndexMeta`, `CheckMeta`, `FkMeta`, `ClusterName`, `DeleteRule` are defined once in `schemaTypes.ts` and referenced consistently across extractor, renderer, and tests.
- [ ] **Wiki rebuild:** `pnpm wiki:build && pnpm wiki:check` green locally with `DATABASE_URL` set.
- [ ] **All five spec "done when" criteria** verified (Tasks 6 + 12 cover them).
- [ ] **Two new sections in AUTHORING.md** (Task 10).
- [ ] **Cross-link from data/schema.html** to reference/schema.html (Task 11).
- [ ] **Source-hash drift baseline** committed in Task 2 (the page is sourceful, so `pnpm wiki:check` is green at every commit boundary after Task 2).

## Wiki update + push (after the implementation)

Per CLAUDE.md step 7 of the standard workflow:

1. All implementation commits land locally on `main` (or whatever working branch). **Do not `git push` yet.**
2. Dispatch the wiki-update subagent with the prompt from `docs/wiki/AUTHORING.md` (parameterized with the Linear issue id this bead rolls under — pass `MYT-33` since the schema-reference page is sourced from MYT-33's migrations and there's no Linear ticket for myth-6u4 itself).
3. The subagent updates `docs/wiki/` if anything is stale and commits its changes locally. (Likely no-op: this bead's wiki updates are first-class implementation, not a follow-on sync.)
4. `git push origin main`. Code commits + any wiki commit land in a single push event.
5. Run `bd close myth-6u4`.
