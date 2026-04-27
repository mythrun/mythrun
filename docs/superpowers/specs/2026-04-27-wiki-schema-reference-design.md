# Wiki Schema Reference — Auto-Generated Search Page

> Bead: myth-6u4 · Date: 2026-04-27

A build-time generator that produces an interactive search-and-expand schema reference page for the internal wiki, sourced from `backend/migrations/*.sql`. Replaces the (deliberately-skipped) v1 hand-authored page. After this lands, a contributor browsing the wiki can search for any table or column and expand to see types, nullability, defaults, FK targets + `ON DELETE` rules, CHECK constraints, and indexes — and the answer is always whatever the migrations say, because the page is regenerated from them on every `pnpm wiki:build`.

## Page-kind framing: Narrative vs Reference

This bead also formalizes a split that's been latent in the wiki since the runbooks index shipped:

- **Narrative pages** — hand-authored, story-shaped, voice-driven explainers governed by AUTHORING.md principles 1–4 (illustrative, explainer-not-reference, story-shaped, diagram-central). One page per coherent concept of the system; the reader scrolls front-to-back to learn. Lives in topical sections: `Infra`, `Runtime`, `Data`, `Auth & Billing`, `World & Campaign`, `Combat`, `Frontend`.
- **Reference pages** — derived views over data that lives elsewhere in the repo or in other wiki pages. Auto-generated from upstream sources. Lookup-shaped, not narrative; no rationale callouts, no top-of-page diagram, no "How it fits together" section. The reader arrives with a specific question ("which tables have a CASCADE on user deletion?", "what's the runbook to expand the CIDR range?") and uses the page as an index.

Today's `Runbooks` top-level section already fits the Reference shape; it's just been the only one. With the schema reference now being the second, this bead renames the section from `runbooks` to `reference` and treats it as the home for all auto-generated lookup material going forward. The seven narrative sections stay narrative; the Reference section is for tool-shaped pages.

Future Reference candidates (out of scope for this bead, but the section now has a home for them): a CHECK-constraint inventory, an environment-variable index, a feature-flag inventory, a Terraform-output catalog. Each would slot in as `reference/<thing>.html`.

## Goals

1. Schema reference content is regenerated from `backend/migrations/` automatically. No hand-authoring of column-level reference data.
2. Contributors can find any table or column quickly via a top-of-page search bar (filters by table + column name, highlights matches, shows a `Showing N of 38 tables` counter).
3. The existing wiki source-hash drift contract extends to this page: changing a migration without rerunning the build / accept-drift fails CI.
4. The schema-reference page coexists with the explainer at `data/schema.html` (narrative, voice, callouts) — they cross-link bidirectionally and serve different audiences.
5. Adding a future migration (`004_*.sql`) requires zero generator changes — the new tables/columns/indexes/CHECKs/FKs appear on the next build.

## Non-goals

- Column-level docstrings (table comments, column descriptions). The migrations don't carry them today; if/when they do, that's a future bead.
- Cross-linking column references to the prep engine, scribe, or other consumers. Those narrative pages handle their own cross-links.
- Replacing `data/schema.html`. The explainer (clusters, rationale, narrative) and the reference (search-and-expand on raw structure) are different documents.
- Repository-layer codegen. Different concern; lives with MYT-34's repository layer.
- Evolving the migration runner or migration format. The reference reads what's there; it does not constrain how migrations are authored.

## Architecture

### Data flow

```
backend/migrations/*.sql
        │
        ▼
schemaExtractor.ts ─── opens a fresh public schema, runs runMigrations,
        │              queries information_schema / pg_*, drops the schema
        ▼
SchemaMetadata        (typed object: tables, columns, indexes, checks, fks)
        │
        ▼
schemaRenderer.ts ─── pure (metadata) => string
        │
        ▼
HTML fragment         (<details>-per-table search-and-expand UI)
        │
        ▼
buildPipeline.ts ───── splices fragment into content/reference/schema.html
        │              at the <!-- @schema-reference --> marker
        ▼
site/reference/schema.html
```

### Module layout

**New build modules** (under `docs/wiki/build/`):

- **`schemaExtractor.ts`** — opens a `pg.Pool` against `WIKI_DATABASE_URL ?? DATABASE_URL`, drops and recreates `public` schema, calls `runMigrations` from `@mythrun/backend` against a real migrations directory (resolved from the wiki package), then runs five introspection queries lifted from `backend/src/db/__tests__/migrate-schema.test.ts`:
  1. Tables (`information_schema.tables` where `table_schema = 'public' AND table_type = 'BASE TABLE'`).
  2. Columns per table (`information_schema.columns` — name, data_type, is_nullable, column_default, ordinal_position).
  3. Named indexes (`pg_indexes` filtered to `idx_*` plus the partial-index `indexdef` for predicate extraction).
  4. CHECK constraints (`pg_constraint` joined to `pg_class` / `pg_namespace`, with `pg_get_constraintdef`).
  5. FK delete rules (`information_schema.table_constraints` joined to `key_column_usage` / `constraint_column_usage` / `referential_constraints`).
  Stitches the query results into a typed `SchemaMetadata` object — per-table columns/indexes/checks/fks are collated under each `TableMeta`, and each table is tagged with a `cluster` via a static `name → ClusterName` map colocated in this module (mirroring the existing explainer page's clusters). Drops the schema, closes the pool.

- **`schemaRenderer.ts`** — pure function `(metadata: SchemaMetadata) => string`. Renders:
  - Cluster grouping: each `TableMeta` already carries a `cluster` field set by the extractor (see component contracts). The renderer groups by that field in a fixed cluster order (Identity & billing → Worlds & entities → Campaigns & play → Sessions → Pipeline & ops → SRD reference → Other). Empty clusters emit no `<h2>`.
  - One `<h2>` per non-empty cluster, then one `<details class="schema-table" data-table-name="<name>">` per table. The `<summary>` shows the table name + a tiny meta line (`12 columns · 2 indexes · 2 CHECKs · 1 FK`).
  - Per-table body:
    - `<table class="schema-columns">` with rows of `Name | Type | Nullable | Default | References`. Each `<tr data-column-name="<name>">` for the JS filter. The References column shows `entities(id) ON DELETE CASCADE` if the column is an FK; `—` otherwise.
    - `<h4>Indexes</h4>` + `<ul>` listing every named index on this table (with column list and the `WHERE` predicate for partial indexes).
    - `<h4>CHECK constraints</h4>` + `<ul>` listing the CHECK clauses verbatim from `pg_get_constraintdef`.
  - All user-derived strings escaped via the existing `escapeHtml` helper.

- **`schemaRef.ts`** — thin orchestrator: `await extract(); return render(metadata);`. Single export consumed by `buildPipeline.ts`.

**Existing files touched:**

- **`docs/wiki/build/buildPipeline.ts`** — add `resolveSchemaReference(content, fragment)` mirroring the existing `resolveRunbookIndex` (line 271). The build context gains a `schemaFragment: string | null` field; if any page contains `<!-- @schema-reference -->`, the orchestrator runs once before page rendering and the fragment is reused. (We pre-scan, like `scanAllRunbooks` at line 231, so the extractor runs at most once per build regardless of how many pages might reference the marker.)
- **`docs/wiki/structure.ts`** — rename the existing `runbooks` section slug + title to `reference` / `Reference`. Move the existing `{ slug: 'index', title: 'Overview' }` page to `{ slug: 'runbooks', title: 'Runbooks' }` (the page is no longer the section's overview; it's a sibling of the schema reference). Add a new `{ slug: 'index', title: 'Overview' }` for the section landing, plus `{ slug: 'schema', title: 'Schema reference' }` for the new page. Final order: `Overview`, `Runbooks`, `Schema reference`.
- **`docs/wiki/layout/helper.js`** — add `setupSchemaReferenceSearch()` initializer alongside `setActiveToc()` and `setupDiagramModal()`. Vanilla IIFE, same shape as the existing functions. Behavior:
  - On input event, lowercase the query.
  - Walk `.schema-table` elements:
    - Match check 1: lowercased table name (from `data-table-name`) contains the query.
    - Match check 2: any column inside has a `data-column-name` lowercased substring of the query.
    - If neither, set `.hidden` on the `<details>`.
    - If matched, remove `.hidden`, remove existing `<mark>` overlays, walk children to wrap matching substrings in `<mark>`, and `setAttribute('open', '')` so the matched table auto-expands.
  - Update `#schema-counter` text: `Showing N of 38 tables`.
  - Empty query restores all tables to `.hidden = false`, removes `<mark>` overlays, restores the original collapsed state (track initial collapsed-state in a Map at init time).
  - Wire `#schema-expand-all` / `#schema-collapse-all` buttons (delegate to setting/removing the `open` attribute on each `.schema-table`).
- **`docs/wiki/layout/styles.css`** — add minimal styles: `.schema-table`, `.schema-table-name`, `.schema-table-meta`, `.schema-columns`, `.schema-columns th/td` (monospace for type/default/references columns), `.hidden { display: none; }`, `mark` (subtle yellow background, no text color override), `.schema-controls` (flex row for search input + counter + buttons). Maker's-workshop voice — match the existing `wiki-rationale` / `wiki-runbook-index` density.
- **`.github/workflows/wiki-check.yml`** — add a `postgres:16-alpine` service container exactly mirroring `deploy.yml:30-46` (same env, same healthcheck, port 5432), and export `DATABASE_URL=postgresql://mythrun:mythrun_dev@localhost:5432/mythrun` for the `pnpm wiki:check` step.
- **`docs/wiki/AUTHORING.md`** — two additions:
  1. A new section near the top (after "The seven principles") titled **"Narrative vs Reference pages"**. Documents the page-kind split: narrative pages live in topical sections (Infra, Runtime, Data, Auth & Billing, World & Campaign, Combat, Frontend) and follow the seven principles + canonical page spine; reference pages live under the `Reference` section and are derived views (auto-aggregated from other pages or auto-generated from upstream artifacts). The seven principles + canonical spine apply to narrative pages only. Reference pages have their own minimal shape: `<h1>` title + `<p class="lead">` + (optionally) source comments + a marker the build replaces, no diagram, no rationale callouts, no "How it fits together."
  2. A new section after "Page header comments" titled **"Auto-generated reference pages"** documenting the marker-replacement convention specifically: how the build detects a marker (`<!-- @runbooks-index -->`, `<!-- @schema-reference -->`), how the source-hash mechanism applies when the upstream artifact lives outside the wiki (points at the artifact, drifts when the artifact changes, contributor runs `pnpm wiki:accept-drift`), and a list of the markers in use today.

**New / moved content files:**

- **`docs/wiki/content/runbooks/index.html` → `docs/wiki/content/reference/runbooks.html`** — the existing runbook index page moves to its new home and is renamed (it was the section overview at `runbooks/index.html`; it's now a sibling page at `reference/runbooks.html`). Content is unchanged: lead paragraph + `<!-- @runbooks-index -->` marker. The wiki-build's runbook aggregation (which scans every page for runbook entries) keeps working without code changes — the marker is what triggers replacement, not the page slug.

- **`docs/wiki/content/reference/index.html`** — new section landing. Short prose describing what Reference is for ("derived views over data that lives elsewhere — for looking up specific things, not learning the system; the topical sections are where the system is explained"). Lists the available reference pages with one-line descriptions. No source-hash (sourceless landing pages are allowed per AUTHORING.md).

- **`docs/wiki/content/reference/schema.html`** — the new schema reference page. Structure:
  - Source-comment header (`<!-- source: backend/migrations/001_initial_schema.sql -->` plus `002_indexes.sql`, `003_srd_reference_data.sql`, the source-hash placeholder, and `<!-- last-ticket: MYT-33 --> `).
  - `<h1>Schema reference</h1>`.
  - `<p class="lead">` — one sentence: "Every table, column, constraint, and index in the Mythrun database — searchable. Generated from `backend/migrations/`, regenerated on every wiki build."
  - `<p>` of context — single paragraph explaining the difference from the explainer at `data/schema.html` (this page is for lookup; that page tells the story), and that the page is auto-generated.
  - The static search controls block:
    ```html
    <div class="schema-controls">
      <input id="schema-search" type="search" placeholder="Filter by table or column name…" autocomplete="off" />
      <span id="schema-counter">Showing 38 of 38 tables</span>
      <button id="schema-expand-all" type="button">Expand all</button>
      <button id="schema-collapse-all" type="button">Collapse all</button>
    </div>
    ```
  - `<div id="schema-tables-container"><!-- @schema-reference --></div>` — the marker the build replaces.
  - `<h2>Integration points</h2>` paragraph cross-linking back to `../data/schema.html` (the narrative explainer) and `../data/migrations.html` (the runner).

**Updated content file:**

- **`docs/wiki/content/data/schema.html`** — the existing "Integration points" paragraph gains one sentence pointing readers at `../reference/schema.html` for "every column, every constraint, every index — searchable."

### Drift contract

The page's `<!-- source: -->` comments declare `backend/migrations/001_initial_schema.sql`, `backend/migrations/002_indexes.sql`, and `backend/migrations/003_srd_reference_data.sql`. The existing `computeSourceHash` hashes those files; the existing `checkDrift` compares hash-in-comment against current hash.

When a migration changes:

1. Contributor runs `pnpm wiki:build`. The generator regenerates the HTML; the build writes `site/reference/schema.html`. The drift mechanism notices the source files changed: emits a drift warning (mode=`build`) or banner.
2. Contributor inspects the regenerated page in `pnpm wiki:dev`. Looks right? Run `pnpm wiki:accept-drift`. The hash in `content/reference/schema.html` updates.
3. Commit the migration AND the updated content file (only the source-hash comment changes — the HTML body never changes because the static shell is stable).
4. CI runs `pnpm wiki:check`. The build re-runs the generator against CI Postgres, recomputes the hash, compares to the committed hash. They match → green.

If a contributor forgets step 2, CI is red with `drift: docs/wiki/content/reference/schema.html (mismatch)`.

The content file's hand-written shell rarely changes — only the `<!-- source-hash: -->` comment does. A migration change touches one wiki file (the schema-reference content) plus the migration itself.

### CI integration

`wiki-check.yml` gains a `postgres:16-alpine` service container. The service block is copied verbatim from `deploy.yml`:

```yaml
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
```

The check step gains:
```yaml
env:
  DATABASE_URL: postgresql://mythrun:mythrun_dev@localhost:5432/mythrun
```

Existing wiki-check steps (`Typecheck wiki`, `Test wiki`) don't need Postgres and continue to work without it (the service container is up across the whole job, but the typecheck/test steps don't connect).

The wiki-check trigger paths (`docs/wiki/**`, `infra/**`, `backend/**`) already include `backend/**`, so a migration change naturally fires this job.

## Component contracts

### `SchemaMetadata` shape

```ts
interface SchemaMetadata {
  tables: TableMeta[]                        // sorted alphabetically; per-table indexes / checks / fks
                                             // are nested in each TableMeta so the renderer never
                                             // needs to cross-reference at render time
}

type ClusterName =
  | 'Identity & billing'
  | 'Worlds & entities'
  | 'Campaigns & play'
  | 'Sessions'
  | 'Pipeline & ops'
  | 'SRD reference'
  | 'Other'                                  // defensive fallback; should be empty today

interface TableMeta {
  name: string                               // e.g. "facts"
  cluster: ClusterName                       // assigned in the extractor via a static name→cluster map
                                             // (a separate const colocated with the extractor — kept out
                                             // of the renderer so the renderer stays a pure (data) => HTML)
  columns: ColumnMeta[]                      // ordered by ordinal_position
  indexes: IndexMeta[]                       // sorted by index name
  checks: CheckMeta[]                        // sorted by constraint name
  fks: FkMeta[]                              // sorted by column name
}

interface ColumnMeta {
  name: string
  type: string                               // formatted: "uuid", "text", "timestamptz", "jsonb", "numeric(10,2)"
  nullable: boolean
  default: string | null                     // null if no default, else the formatted default expression
  fk: { foreignTable: string; foreignColumn: string; deleteRule: 'CASCADE' | 'SET NULL' | 'NO ACTION' | 'RESTRICT' } | null
}

interface IndexMeta {
  name: string                               // "idx_*"
  columns: string[]                          // ["entity_id", "access_level", "narrative_status"]
  unique: boolean
  predicate: string | null                   // partial-index WHERE clause if present, e.g. "status = 'active'::text"
  expression: string | null                  // raw indexdef if the index is expression-based (COALESCE etc.) — falls back to indexdef when columns can't be cleanly extracted
}

interface CheckMeta {
  name: string                               // constraint name
  clause: string                             // pg_get_constraintdef output, e.g. "CHECK ((status = ANY (ARRAY['active'::text, 'ended'::text, 'crashed'::text])))"
}

interface FkMeta {
  column: string
  foreignTable: string
  foreignColumn: string
  deleteRule: 'CASCADE' | 'SET NULL' | 'NO ACTION' | 'RESTRICT'
}
```

The cluster assignment lives in `schemaRenderer.ts` as a const map (mirroring the explainer page's groupings). The renderer applies it; the extractor doesn't know about clusters.

### `schemaRenderer` output shape

For one table (e.g. `facts`):

```html
<details class="schema-table" data-table-name="facts" id="schema-table-facts">
  <summary>
    <span class="schema-table-name">facts</span>
    <span class="schema-table-meta">8 columns · 2 indexes · 2 CHECKs · 1 FK</span>
  </summary>
  <table class="schema-columns">
    <thead><tr><th>Name</th><th>Type</th><th>Nullable</th><th>Default</th><th>References</th></tr></thead>
    <tbody>
      <tr data-column-name="id"><td>id</td><td>uuid</td><td>NO</td><td>—</td><td>—</td></tr>
      <tr data-column-name="entity_id"><td>entity_id</td><td>uuid</td><td>NO</td><td>—</td><td><code>entities(id)</code> ON DELETE CASCADE</td></tr>
      <!-- … -->
    </tbody>
  </table>
  <h4>Indexes</h4>
  <ul>
    <li><code>idx_facts_entity</code> — (entity_id)</li>
    <li><code>idx_facts_entity_access_status</code> — (entity_id, access_level, narrative_status)</li>
  </ul>
  <h4>CHECK constraints</h4>
  <ul>
    <li><code>CHECK ((access_level = ANY (ARRAY['public'::text, 'private'::text, 'secret'::text])))</code></li>
    <li><code>CHECK ((narrative_status = ANY (ARRAY['undelivered'::text, 'delivered'::text, 'developed'::text, 'resolved'::text])))</code></li>
  </ul>
</details>
```

Special cases:
- **Empty CHECK list / empty index list / no FKs** — omit the `<h4>` entirely (no empty sections).
- **Single-column FK** — appears in the columns table References cell.
- **Multi-column FK** — none today, but the FkMeta supports it (column is a string; multi-column FKs would need a list — defer until a real migration uses one).
- **Partial unique index** — `<li><code>idx_sessions_one_active</code> — UNIQUE (campaign_id) WHERE status = 'active'</li>`.
- **Expression-based unique index** — when a table has an index whose `indexdef` is too complex for clean column extraction (e.g. `idx_pipeline_runs_unique` with COALESCE), the renderer falls back to the raw indexdef rendered inside `<code>`. This keeps the page truthful at the cost of a slightly less pretty list item for that one index.

### `setupSchemaReferenceSearch()` JS

Vanilla IIFE in `helper.js`, no framework. Top-of-function abort if `#schema-search` not present (every other wiki page short-circuits). Uses native `<details open>` for expansion. Filtering toggles `.hidden`; highlighting wraps in `<mark>`. The function tracks each `.schema-table`'s initial `open` state in a Map at init so empty-query restores it. Counter updates on every input.

## Test strategy

**Unit tests** (in `docs/wiki/build/__tests__/`):

- **`schemaRenderer.test.ts`** — pure. Given a fixture `SchemaMetadata` (a tiny one with 2 tables, 1 index, 1 CHECK, 1 FK), assert the HTML output structurally:
  - Every table gets exactly one `<details>` with the right `data-table-name`.
  - Every column gets a `<tr data-column-name="...">`.
  - Empty index/CHECK/FK lists produce no `<h4>` heading.
  - Partial-index predicate renders.
  - Expression-based index falls back to raw indexdef.
  - HTML escaping fires on table/column names with quotes or angle brackets (defensive — should never happen given Postgres identifier rules, but the test pins it).
  - Cluster grouping: tables in the fixture get assigned to the right `<h2>`.
  - Empty cluster (no tables in it) emits no `<h2>`.

- **No separate `schemaExtractor.test.ts`** — the extractor is tested by CI's `pnpm wiki:check` running it end-to-end against real migrations + real Postgres. Adding a Vitest integration test would duplicate that signal without adding coverage; the source-hash drift check is already a strong regression net.

**Integration signal** — CI's existing `pnpm wiki:check` step. With the Postgres service container in place, this step exercises the full extract → render → compare-source-hash path against the real migrations on every PR.

## Failure modes

- **Postgres unavailable at build time** — `pg.Pool.connect()` fails with a clear error. The build fails. No graceful degrade. Local devs already have `pnpm db:up` muscle memory; CI provisions the service container.
- **A migration introduces syntax pg can't apply** — `runMigrations` fails with the pg error. Build fails. Author fixes the migration.
- **An introspection query returns an unexpected shape** — TypeScript types catch it at the boundary. If a future Postgres version changes a column name in `pg_indexes`, the extractor crashes loudly with a runtime error.
- **The cluster map doesn't include a new table** — the table falls into the "Other" cluster bucket and renders at the bottom of the page. Defensive — picked up in code review.
- **Migrations directory is empty / missing** — `runMigrations` errors. Build fails.
- **Multiple pages contain the `<!-- @schema-reference -->` marker** — the orchestrator runs once (pre-scanned, cached), the same fragment is spliced into every page that uses it. Today only one page does, but the design supports the case.

## Performance budget

Today `pnpm wiki:build` is sub-second. The new generator adds:
- One Postgres connection (~50ms cold, ~5ms warm).
- One `runMigrations` pass (~1-2s — the migrations are small but the SQL has to apply).
- Five introspection queries (~50ms total).
- The schema-drop on cleanup (~50ms).

Estimated added build time: 2-3 seconds. Total `pnpm wiki:build`: still under 5 seconds. Acceptable. No memoization needed; the generator runs once per build invocation regardless.

## Implementation order

The plan-into-beads decomposition will live in the implementation plan (next step), but the rough order:

1. **Section refactor.** Rename `runbooks` → `reference` in `structure.ts`. Move `content/runbooks/index.html` → `content/reference/runbooks.html`. Add a new `content/reference/index.html` section landing. Run `pnpm wiki:build` and confirm the runbooks page still renders correctly under its new path (the `<!-- @runbooks-index -->` marker is content-driven, not path-driven, so no code change should be needed).
2. **Skeleton.** New `content/reference/schema.html` content file with the marker and source comments, plus a hardcoded test fragment in `buildPipeline.ts` to verify the splice plumbing end-to-end before any DB code lands.
3. **Extractor.** `schemaExtractor.ts` against the existing migrations (lift the queries from `migrate-schema.test.ts`); thin smoke test that runs locally and asserts ≥35 tables and the cluster map covers them all.
4. **Renderer.** `schemaRenderer.ts` against a fixture `SchemaMetadata`, with the unit-test suite (table-by-table HTML structure, edge cases, escaping).
5. **Wire.** Extractor → renderer → buildPipeline. Replace the hardcoded fragment with the real path. Run `pnpm wiki:build` end-to-end. Verify the page in `pnpm wiki:dev`.
6. **Client-side.** `helper.js` search/filter/highlight + counter + expand-all/collapse-all. Verify in browser.
7. **Style.** `styles.css` polish.
8. **CI.** `.github/workflows/wiki-check.yml` Postgres service container + `DATABASE_URL` env. Verify in CI on the PR.
9. **AUTHORING.md.** Two additions: Narrative vs Reference framing near the top; auto-generated-page convention after Page header comments.
10. **Cross-link.** `content/data/schema.html` integration-points paragraph adds the link to `../reference/schema.html`.
11. **Verify.** `pnpm typecheck && pnpm lint && pnpm test && pnpm wiki:check` — green.

## Done when

- The wiki has a top-level `Reference` section containing `Overview`, `Runbooks`, and `Schema reference`. The runbooks page works as before (the existing `<!-- @runbooks-index -->` aggregation continues to fire).
- `pnpm wiki:build` produces `site/reference/schema.html` with all 38 tables expandable, all columns, all indexes (including the partial unique and the COALESCE expression-based unique), all CHECKs, all FK delete rules.
- The page's search input filters by table-name or column-name with match highlighting and a `Showing N of 38 tables` counter.
- Adding a hypothetical `004_test.sql` with `CREATE TABLE foo (id UUID PRIMARY KEY)` and rerunning `pnpm wiki:build` regenerates the page to include `foo`. Removing the file restores the previous page.
- `pnpm wiki:check` fires drift if `backend/migrations/` changes and the page's source-hash hasn't been updated.
- `data/schema.html` cross-links to `reference/schema.html`, and the reference page links back to both `data/schema.html` and `data/migrations.html`.
- `AUTHORING.md` documents the Narrative vs Reference page-kind split and the auto-generated-page marker convention.
- `pnpm typecheck && pnpm lint && pnpm test && pnpm wiki:check` green locally.
- CI's `wiki-check` job is green with the Postgres service container active.
- A single wiki commit on the same branch as the implementation lands the section refactor + the new schema reference page + the drift baseline + the cross-links.
