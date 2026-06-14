# MYT-71 — World-Store Retrieval Substrates & Curated Query Tools — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the world store queryable for the lookup resolver. Ship (1) the **pgvector substrate** — semantic search over facts ∪ entities (`searchLore`) and canon-only entity match-vs-mint (`findSimilarEntities`); (2) the **graph substrate** — recursive-CTE social-graph + hierarchy walks (`charactersKnownTo`, `factionTree`); (3) the **Voyage embedding write-path** — a thin first-party REST wrapper (`embed.ts`) plus `embedWorld` wired into world-gen as a TOTAL terminal stage, into the character-integration post-pass, and into a backfill command. Done when: each substrate answers its query type deterministically, queries span ALL tiers (no `access_level` predicate anywhere in this layer), and a constructed real-Voyage smoke proves the live round-trip.

**Architecture:** ZFC-clean orchestration. The `world/retrieval/` functions are a thin shell — embed (via `llm/embed.ts`, OUTSIDE any tx) → repo parameterized SQL (cosine rank + the entities world-join, recursive CTEs) → shape typed rows. **The resolver over-pulls freely across `known | discoverable | secret` — the ST gate (MYT-72) is the safety boundary, not this layer.** MYT-71 wires NOTHING into the FT tool registry or the ST gate; it delivers callable functions returning typed rows that MYT-72 (tool wrapping) and MYT-73 (Scribe match-vs-mint) consume. The embedding write-path runs the Voyage call outside any PG transaction (the MYT-55 idle-in-tx lesson) and the world-gen embed stage is TOTAL (catches all Voyage errors internally, `costUsd:0`, leaves rows NULL, never fails the world).

**Tech Stack:** Node 24 + TypeScript strict, Fastify, Postgres (`pg`) + **pgvector ≥ 0.8** (HNSW, cosine ops), Redis (`ioredis`), BullMQ, Vitest. Embeddings via **Voyage AI** (`voyage-4-lite`, `output_dimension: 512`) through a plain `fetch` wrapper — NO third-party embedding SDK. Repo/SQL tests target `mythrun_test` (`DATABASE_URL_TEST`) via the scoped-fixture pattern (`backend/src/__tests__/CONVENTIONS.md`); vector tests use **hand-injected deterministic `vector(512)` literals**; the Voyage wrapper is tested by mocking the `fetch` boundary; the constructed real-Voyage smoke is GATED on `VOYAGE_API_KEY`.

**Spec:** `docs/superpowers/specs/2026-06-14-myt-71-world-store-retrieval-design.md` (§ references below point there). The §12 file-level change map is the decomposition backbone; the §13 resolved decisions and §15 blind-review record are BINDING — the ~25 folded corrections are implemented here, not re-litigated.

---

## Context primer (read first)

- **Over-pull across ALL tiers — NO `access_level` filter anywhere in this layer (§1, §13.6).** `searchLore`/`findSimilarEntities`/`charactersKnownTo`/`factionTree` return `known`, `discoverable`, AND `secret` rows ranked purely by relevance. There is no tier predicate, no `encountered` filter. **Building any tier filter here is the wrong boundary and a bug** — the ST gate (MYT-72) is the single safety boundary and is *allowed* secrets. The resolver "must find what is relevant, not what is safe."
- **Live-schema facts the resolver MUST honor (migration drift since 001 — `reference_world_schema_drift_since_001`):**
  - **`access_level` is `known | discoverable | secret`** (renamed in 014). Import the existing `AccessLevel` type from `repo/facts.ts`. **NEVER re-declare a `public`/`private` union** — that vocabulary is dead.
  - **`facts` has NO `world_id`.** World scope is `facts → entities → entities.world_id` (the `JOIN facts f JOIN entities e ON e.id = f.entity_id WHERE e.world_id = $1` pattern, mirroring `relationships.listByWorld`). `relationships`/`entity_hierarchy` likewise inherit world scope from same-world endpoints (the existing repos JOIN to entities for this). **Cross-world isolation is a TESTED invariant.**
  - **`entities.entity_type` includes `'pc'`** (added 016). The `pc` exclusion in entity embedding + `searchLore`/`findSimilarEntities` is meaningful, not dead code. Graph traversal INCLUDES PCs.
- **`searchLore` ranks facts ∪ entities merged (§5, §13.8).** Facts via the entities-join; entities via `entities WHERE world_id=$1 AND entity_type <> 'pc' AND embedding IS NOT NULL` with `name || prose_kernel.content` embedded (LEFT JOIN). Ranking ENTITIES too is load-bearing: "what's known about the gods" is best served by an entity's `prose_kernel`, which lives only in the entity embedding. Returns a merged, re-ranked list. **`searchLore` is TOTAL** — an embed/infra failure returns `[]` + `logger.warn` (MYT-72 narrates a blank; never a throw on the turn path).
- **`findSimilarEntities` is CANON-ONLY and THROWS on embed failure (§5, §8, §13.8).** It ranks committed `entities` (world-scoped, `entity_type <> 'pc'`, optional `entityType` filter). On embed failure it **throws** (NOT `[]`) — returning `[]` is indistinguishable from "no similar entity" and would silently MINT DUPLICATE CANON on a transient Voyage blip. This asymmetry vs `searchLore` is deliberate and is flagged for MYT-72/73 in the types.
- **Score = `1 - cosine_distance`, range `[-1, 1]`** (1 = identical, 0 = orthogonal). The match-vs-mint THRESHOLD is MYT-73's model-calibrated config constant, NOT here.
- **Graph (§6):** `charactersKnownTo` — recursive walk over `relationships`, **both directions** (v1 treats every `relationship_type` as undirected), bounded by `maxDepth` (`GRAPH_DEFAULT_DEPTH` 2, capped `GRAPH_MAX_DEPTH` 5), **cycle-safe via a `path` array** (`WHERE NOT next = ANY(path)`), **`DISTINCT ON (entityId)` keeping min depth** (a SET of reachable characters — the diamond A→B,A→C,B→D,C→D returns D once), `nameFilter` is a normalized post-filter (trim + case-fold — mechanical, not fuzzy), PCs included. `factionTree` — walk `entity_hierarchy` (parent→child; `child_entity_id UNIQUE` → strict tree, no cycle risk), returns `{ entityId, name, entityType, parentId, depth }`, a subtree deeper than `GRAPH_MAX_DEPTH` returns partial + `truncated: true`.
- **Embed write-path (§4.3):** Voyage call runs OUTSIDE any tx; writes `embedding` + `embedded_at`. `embedDocuments` is batched by BOTH an input-count cap AND a token-estimate cap (`char/4` — mechanical). Split timeouts: `VOYAGE_DOC_TIMEOUT_MS` (generous) for the write-path, `VOYAGE_QUERY_TIMEOUT_MS` (tight) for `embedQuery` on MYT-72's turn path; bounded 429 backoff. The wrapper asserts the returned vector length === `EMBED_DIM` (512) and fails loud on mismatch.
- **The world-gen embed stage is a TOTAL terminal stage (§4.3, §13.5).** The `WORLD_GEN_STAGES` loop contract is "any thrown error → `handleStageError` → world `failed`." The embed stage therefore **catches all Voyage/embed errors internally, logs, leaves rows NULL, and ALWAYS returns a successful `StageDispatchResult` with `costUsd:0, inputTokens:0, outputTokens:0`** (Voyage spend is deliberately OFF the Anthropic cost cap — ~sub-cent/world). On completion it emits a structured summary log `{ worldId, embedded, leftNull, voyageErrors }` (a `complete` world with `leftNull > 0` is silently unsearchable otherwise).
- **`VOYAGE_API_KEY` is required on BOTH task-defs (§4.4, §13.10).** `loadEnv()` is the boot gate for EVERY process (API and worker both call it), so a required-and-missing field crashloops both. It goes in the shared `common_secrets` list (present on both task-defs) and is required in `loadEnv`. The full surface set is larger than three: `config/env.ts` validator + loadEnv, `setup-env.ts` baseline + `.env.development` + `.env.development.example`, staging `manual_secret_names` + out-of-band value population, serving `common_secrets`, serving `variables.tf` validation.
- **pgvector image swap is a HARD PRECONDITION for the ENTIRE suite (§10).** Migration 026's `CREATE EXTENSION vector` runs in the global schema bootstrap (`global-setup.ts` → `runMigrations` against `mythrun_test`), so EVERY backend test needs the pgvector image. `pgcrypto` ships in alpine's contrib (so 001 passing today is NO evidence `vector` is available — different bundles). Swap `postgres:16-alpine` → `pgvector/pgvector:pg16` (Debian) in `docker-compose.yml` AND the CI `deploy.yml` Postgres service. **Verify the existing ~2800-test suite still passes on the new image on a FRESH DB BEFORE migration 026** (the green-local/red-CI + warm-vs-fresh-DB trap).
- **Migration runner constraints (`db/migrate.ts`):** each file is wrapped in a single `BEGIN`/`COMMIT`; top-level `BEGIN`/`COMMIT`/`ROLLBACK`/`START TRANSACTION`/`END` are forbidden (validator). `CREATE INDEX CONCURRENTLY` cannot run inside a tx — so 026's `CREATE INDEX … USING hnsw` is the ONLY valid form (plain, non-concurrent). The runner already holds `rds_superuser` on RDS (001 runs `CREATE EXTENSION pgcrypto` through it), so `CREATE EXTENSION vector` is authorized (the migrate-CLI even has a `42501`/CREATE-EXTENSION hint baked in).
- **Repo binder pattern (`*Ns(c)`):** every repo exposes a `xNs(c: ClientLike)` binder holding canonical SQL, plus a back-compat const-object shim that delegates. `world-retrieval.ts` follows this; `entities.ts`/`facts.ts` gain `updateEmbedding` on their `*Ns` binders (and the shim only if a non-`*Ns` caller needs it — under the coverage gate, a binder is uncovered until a consumer calls it, so keep the binder canonical and route `embedWorld` through `repo.entities`/`repo.facts`).
- **Filtered-ANN posture (§3):** the HNSW index is global; every `searchLore` runs `WHERE e.world_id = $1`, which pgvector applies as a post-filter on the ANN candidate set. Per-world corpora are small (hundreds–low-thousands), so set `SET LOCAL hnsw.iterative_scan = 'relaxed_order'` in the query tx (requires pgvector ≥ 0.8 — confirm the image ships it; if it predates 0.8, fall back to an exact scan). Resolver/vector TESTS set `iterative_scan`/exact scan so cosine order is index-independent and exactly predictable.
- **ZFC / determinism:** the ONLY non-determinism is the Voyage embedding, isolated to `embed.ts` and mockable at the `fetch` boundary. Given fixed embeddings every function is deterministic SQL. `nameFilter` normalization is `lower(btrim(...))` — mechanical, never fuzzy.
- **Worker rules:** there is a separate dev server — never kill it. Implementer subagents run ONLY their own test file (`pnpm --filter @mythrun/backend vitest run <path>`); the controller runs lint + scoped coverage after each wave (feedback_implementers_skip_lint_and_coverage). Implementers do NOT `git add`/`commit`/`push` — the controller commits each task's files serially (feedback_parallel_agent_commits).
- **Lint gotchas (error-level):** `@typescript-eslint/no-non-null-assertion` (guard, not `!`), `@typescript-eslint/no-deprecated`, `max-lines` 400/module, `max-lines-per-function` 100. 100% coverage gate — budget SCOPED coverage per task (`pnpm vitest run <test> --coverage --coverage.include='<source>'`; never full `test:coverage` during iteration — feedback_scoped_coverage_for_iteration). NO `.max()` on any LLM/Voyage-fed free-prose field. UUIDv7 for any new PK: `import { uuidv7 } from '../repo/uuidv7.js'` (MYT-71 mints no new table PKs, but `ledger_events`-style journal rows would — none here).
- **Run tests:** `cd backend && pnpm vitest run src/<path>` (DATABASE_URL_TEST → `mythrun_test`; inspect `mythrun_test`, NOT `mythrun_dev`, on a DB-row test failure — reference_tests_target_mythrun_test_db).
- **dev-tool typecheck is separate** (reference_dev_tool_typecheck_separate). This issue touches no `backend/dev-tool/**` sources, so the dev-tool verifier is NOT in scope and `dev-tool:verify` does not require a live backend for the push. `scripts/world-embed-backfill.ts` is a `backend/scripts` file, not a contract route.
- **SDK / codebase deviation rule:** where `exactOptionalPropertyTypes` or installed types force a deviation from the sketches below, `pnpm typecheck` is the authority — adjust property reads / generic shapes, keep the structure, never loosen to `any` or add a type assertion.

## The Voyage REST contract (verified 2026-06-14 against docs.voyageai.com/reference/embeddings-api)

`POST https://api.voyageai.com/v1/embeddings`, header `Authorization: Bearer $VOYAGE_API_KEY`, JSON body:
```json
{ "model": "voyage-4-lite", "input": ["text", ...], "input_type": "document" | "query", "output_dimension": 512 }
```
Response: `{ "data": [{ "embedding": [<512 floats>], "index": 0 }, ...], "usage": { "total_tokens": N }, "model": "voyage-4-lite" }`.
- `voyage-4-lite` **defaults to 1024-dim** → MUST send `output_dimension: 512` on every request (supported dims: 2048/1024/512/256). The length-assert catches drift.
- Max **1,000 inputs/request**; per-request token limit **1M tokens** for `voyage-4-lite`. Batch by BOTH (count cap + token-estimate cap).
- `truncation` defaults `true`; leave default. `input_type` defaults `null` — we send `document`/`query` explicitly (asymmetric retrieval).
- **NOTE for the implementer:** the docs page did NOT surface the Authorization header form or the "200M free tokens/acct" claim in the fetched excerpt — the `Bearer` form is the Voyage standard and is what the spec pins; **re-confirm both the Bearer header and the live model id at implementation time** (runbooks-must-be-executed) before the smoke. See "Spec ambiguities" #4.

---

## File map / task ownership (non-overlapping per wave)

| Task | Files (Create/Modify) |
|---|---|
| T1 | M: `docker-compose.yml` + `.github/workflows/deploy.yml` (Postgres service image swap) — then a fresh-DB FULL-suite re-verify (controller) |
| T2 | C: `backend/migrations/026_world_retrieval.sql` |
| T3 | C: `backend/src/llm/embed.ts` + test `backend/src/llm/__tests__/embed.test.ts` |
| T4 | C: `backend/src/world/retrieval/config.ts` + `backend/src/world/retrieval/types.ts` + tests |
| T5 | M: `backend/src/config/env.ts` (+ its test); M: `backend/src/__tests__/setup-env.ts`, `backend/.env.development`, `backend/.env.development.example`; M: `infra/environments/staging/main.tf`, `infra/modules/serving/main.tf`, `infra/modules/serving/variables.tf` |
| T6 | C: `backend/src/repo/world-retrieval.ts` (vector + recursive-CTE SQL) + test; M: `backend/src/repo/entities.ts`, `backend/src/repo/facts.ts` (`updateEmbedding`) + extend their tests |
| T7 | C: `backend/src/world/retrieval/search.ts` (`searchLore`, `findSimilarEntities`) + test |
| T8 | C: `backend/src/world/retrieval/graph.ts` (`charactersKnownTo`, `factionTree`) + test |
| T9 | C: `backend/src/world/retrieval/embed-write.ts` (`embedWorld`) + `backend/src/world/retrieval/index.ts` + test; C: `backend/scripts/world-embed-backfill.ts` + `package.json` script |
| T10 | C: `backend/src/llm/prep/stages/embed-world.ts` (TOTAL terminal stage) + test; M: `backend/src/llm/prep/world-gen-processor.ts` (`WORLD_GEN_STAGES` + dispatch arm) + extend test; M: `backend/src/llm/prep/streaming-extractor.ts` (`WorldGenStage` union); M: `backend/src/llm/ai.ts` (`VALID_STAGES`); M: `backend/src/sse/derive-phase.ts` (`WORLDGEN_STAGES`) |
| T11 | M: `backend/src/llm/prep/character-integration-processor.ts` (terminal embed post-pass, NULL rows only) + extend test |
| T12 | Controller: full lint + scoped-coverage sweep (budgeted, NOT optional) |
| T13 | Controller: gated real-Voyage constructed smoke + resolver E2E → wiki subagent → single push → Linear Done |

**Waves:**

- **Wave A (parallel — pairwise-disjoint):** T1 (image swap, controller-driven — see its note), T2 (migration 026 — author only; controller migrates it into `mythrun_test` AFTER T1's fresh-DB re-verify), T3 (`embed.ts`, mocked-fetch), T4 (`config.ts` + `types.ts`), T5 (`VOYAGE_API_KEY` env + TF). Fully non-overlapping. **Ordering constraint:** T2's migration must NOT be applied to `mythrun_test` until T1 has swapped the image and the controller has re-verified the suite on a fresh pgvector DB — otherwise every test fails on `CREATE EXTENSION vector`. The controller sequences: T1 image swap + re-verify → apply T2 → Wave B.
- **Wave B:** T6 (`world-retrieval.ts` repo + `updateEmbedding`). Depends on T2 migrated into `mythrun_test` (the vector columns + HNSW index must exist for the SQL tests). Solo — it's the SQL substrate everything else reads.
- **Wave C (parallel — disjoint files):** T7 (`search.ts`), T8 (`graph.ts`), T9 (`embed-write.ts` + `index.ts` + backfill script). All three depend on T3/T4/T6 (build against the pinned signatures; typecheck is the authority once siblings land). T7 imports `embedQuery` (T3) + `world-retrieval` reads (T6) + types (T4); T8 imports `world-retrieval` graph reads (T6) + types (T4); T9 imports `embedDocuments` (T3) + `updateEmbedding` (T6) + config (T4).
- **Wave D (sequenced after T9):** T10 (world-gen embed stage — imports `embedWorld` from T9), T11 (character-integration post-pass — imports `embedWorld` from T9). T10 and T11 touch disjoint files and can run in parallel with each other once T9 lands.
- **Wave E (controller-run):** T12 lint + scoped coverage → T13 smoke + wiki + push + close.

---

### Task 1: pgvector image swap + fresh-DB suite re-verify (§10) — HARD PRECONDITION

**Files:**
- Modify: `docker-compose.yml` (the `postgres` service `image:`)
- Modify: `.github/workflows/deploy.yml` (the build job's `services.postgres.image`)

This is the precondition for the ENTIRE suite, not just MYT-71 — migration 026's `CREATE EXTENSION vector` runs in `global-setup.ts`'s `runMigrations` against `mythrun_test` for every test process. Swap the image to `pgvector/pgvector:pg16` (Debian-based; bundles the `vector` extension). The `postgres-init/` mounts (`01-create-test-db.sql`) and the `mythrun_test` bootstrap are unaffected (same entrypoint contract). **Do this BEFORE applying migration 026.**

- [ ] **Step 1:** In `docker-compose.yml`, change the `postgres` service `image: postgres:16-alpine` → `image: pgvector/pgvector:pg16`. Keep `command`, `ports`, `environment`, `volumes`, `healthcheck` unchanged (`pg_isready` works identically on the Debian image).
- [ ] **Step 2:** In `.github/workflows/deploy.yml`, change the build job's `services.postgres.image: postgres:16-alpine` → `pgvector/pgvector:pg16` (line ~38). Leave the env (`POSTGRES_USER/PASSWORD/DB`) and the `DATABASE_URL_TEST` unchanged.
- [ ] **Step 3 (controller — the fresh-DB re-verify, BEFORE migration 026):** recreate the local DB from scratch so it's a FRESH pgvector container (warm-vs-fresh trap — `reference_warm_local_vs_fresh_ci_db`): `pnpm db:down && docker volume rm mythrun_pgdata 2>/dev/null; pnpm db:up` (wait for healthcheck), then `pnpm db:migrate` (through 025 — 026 not authored/applied yet) and run the FULL backend suite `pnpm --filter @mythrun/backend test`. **Assert the existing ~2800 tests still pass on `pgvector/pgvector:pg16` with NO 026 present** — this isolates "the image swap is benign" from "026 works," so a later red is unambiguously about 026, not the base image.
- [ ] **Step 4:** Confirm the image ships pgvector ≥ 0.8 (for `iterative_scan`): `docker compose exec postgres psql -U mythrun -d mythrun_dev -c "SELECT default_version FROM pg_available_extensions WHERE name='vector';"`. Record the version. If < 0.8, FLAG it (the resolver's `iterative_scan` SET LOCAL must fall back to exact scan — see Task 6/7) — do NOT silently proceed.
- [ ] **Step 5:** Report DONE with the suite count + the pgvector version. (No code commit from the implementer; the controller commits the two image lines.)

---

### Task 2: migration `026_world_retrieval.sql` (§3)

**Files:**
- Create: `backend/migrations/026_world_retrieval.sql`

026 is the next free number (025 = `character_ledger`, the highest at draft time — verified). Author VERBATIM from §3. **No top-level `BEGIN`/`COMMIT`** (the runner wraps the file); **no `CREATE INDEX CONCURRENTLY`** (forbidden inside the runner's tx — plain `CREATE INDEX … USING hnsw` is the only valid form).

- [ ] **Step 1: Write the migration:**

```sql
-- backend/migrations/026_world_retrieval.sql
-- MYT-71 §3 — pgvector substrate for the world-store retrieval resolver.
--
-- PRIVILEGE: the migrate role holds rds_superuser on RDS (migration 001 runs
-- `CREATE EXTENSION pgcrypto` through it), so CREATE EXTENSION vector is
-- authorized with no parameter-group change. PRECONDITION (§10): local docker +
-- CI Postgres must run pgvector/pgvector:pg16 — stock postgres:16-alpine does
-- NOT bundle `vector` (it bundles pgcrypto, a DIFFERENT contrib bundle, so 001
-- passing is no evidence `vector` is available). Task 1 swaps the image first.
--
-- Runner wraps this file in a single BEGIN/COMMIT; NO top-level transaction
-- control here, and NO CREATE INDEX CONCURRENTLY (it cannot run in a tx).
CREATE EXTENSION IF NOT EXISTS vector;

-- Embeddings live on the rows they describe. Nullable — backfillable; a NULL
-- embedding row is simply unsearchable until (re-)embedded, never a crash (§4.3).
-- `embedded_at` lets the backfill find rows whose content changed after
-- embedding (drift detection), not only NULL rows.
ALTER TABLE facts    ADD COLUMN embedding vector(512), ADD COLUMN embedded_at TIMESTAMPTZ;
ALTER TABLE entities ADD COLUMN embedding vector(512), ADD COLUMN embedded_at TIMESTAMPTZ;

-- HNSW (not IVFFlat): higher recall, no training step, correct for the
-- INCREMENTAL inserts the Scribe does at session end (IVFFlat needs a populated
-- table to train its lists). Cosine ops. NULL embeddings are not indexed.
CREATE INDEX idx_facts_embedding    ON facts    USING hnsw (embedding vector_cosine_ops);
CREATE INDEX idx_entities_embedding ON entities USING hnsw (embedding vector_cosine_ops);
```

- [ ] **Step 2: Apply + verify** (controller applies into `mythrun_test` AND the local dev DB after Task 1's fresh-DB re-verify): `pnpm db:migrate`, then confirm: `\d facts` / `\d entities` show the `embedding vector(512)` + `embedded_at timestamptz` columns; `\di idx_facts_embedding idx_entities_embedding` show the HNSW indexes; `SELECT extversion FROM pg_extension WHERE extname='vector';` returns ≥ 0.8.
- [ ] **Step 3:** Report DONE with the verified object list. **Flag if 025 is no longer the highest** at draft time (another worktree may have claimed 026) — do NOT silently renumber; check in.

---

### Task 3: the Voyage wrapper — `backend/src/llm/embed.ts` (§4.1)

**Files:**
- Create: `backend/src/llm/embed.ts`
- Test: `backend/src/llm/__tests__/embed.test.ts`

A thin first-party `fetch` to Voyage's REST `/v1/embeddings`, paralleling `ai.ts`'s posture (split timeouts via `AbortController`, bounded retry). NO third-party SDK. Tested by mocking the `fetch` boundary (inject `fetch` or `vi.stubGlobal('fetch', …)` — implementer's call; the test asserts the REQUEST shape and the response handling, so a `fetch` injected via a deps arg is cleanest and avoids global-stub bleed). Reads model/dim/types/timeouts/batch caps from `world/retrieval/config.ts` (T4) — NEVER hardcode them.

Surface:
- `embedDocuments(texts: string[]): Promise<number[][]>` — batched by BOTH `VOYAGE_BATCH_MAX_INPUTS` AND a `char/4` token estimate vs `VOYAGE_BATCH_MAX_TOKENS`; `input_type: 'document'`; `VOYAGE_DOC_TIMEOUT_MS`.
- `embedQuery(text: string): Promise<number[]>` — single input; `input_type: 'query'`; `VOYAGE_QUERY_TIMEOUT_MS`.
- Both: send `output_dimension: VOYAGE_OUTPUT_DIMENSION` (512); assert each returned vector's `.length === EMBED_DIM` and THROW a typed error on mismatch; bounded retry-with-backoff on HTTP 429.

- [ ] **Step 1: Failing test** (mock `fetch`):

```ts
// backend/src/llm/__tests__/embed.test.ts
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createVoyageEmbedder } from '../embed.js'
import { EMBED_DIM, VOYAGE_EMBED_MODEL } from '../../world/retrieval/config.js'

const vec = (fill: number): number[] => Array.from({ length: EMBED_DIM }, () => fill)

function okResponse(vectors: number[][]): Response {
  return new Response(
    JSON.stringify({ data: vectors.map((embedding, index) => ({ embedding, index })), usage: { total_tokens: 7 } }),
    { status: 200, headers: { 'content-type': 'application/json' } },
  )
}

describe('embed.ts', () => {
  let fetchMock: ReturnType<typeof vi.fn>
  beforeEach(() => { fetchMock = vi.fn() })

  it('embedQuery sends input_type=query, output_dimension=512, Bearer auth, and the model', async () => {
    fetchMock.mockResolvedValue(okResponse([vec(0.1)]))
    const e = createVoyageEmbedder({ apiKey: 'k', fetchImpl: fetchMock as unknown as typeof fetch })
    const out = await e.embedQuery('hello')
    expect(out).toHaveLength(EMBED_DIM)
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect(url).toBe('https://api.voyageai.com/v1/embeddings')
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer k')
    const body = JSON.parse(init.body as string)
    expect(body).toMatchObject({ model: VOYAGE_EMBED_MODEL, input_type: 'query', output_dimension: EMBED_DIM })
    expect(body.input).toEqual(['hello'])
  })

  it('embedDocuments uses input_type=document and returns one vector per text', async () => {
    fetchMock.mockResolvedValue(okResponse([vec(0.1), vec(0.2)]))
    const e = createVoyageEmbedder({ apiKey: 'k', fetchImpl: fetchMock as unknown as typeof fetch })
    const out = await e.embedDocuments(['a', 'b'])
    expect(out).toHaveLength(2)
    const body = JSON.parse((fetchMock.mock.calls[0] as [string, RequestInit])[1].body as string)
    expect(body.input_type).toBe('document')
  })

  it('chunks a large document batch by BOTH the input-count cap and the token estimate (>1 request)', async () => {
    fetchMock.mockResolvedValue(okResponse([vec(0.1)]))
    // exceed VOYAGE_BATCH_MAX_INPUTS so chunking fires; assert >1 fetch call
    const e = createVoyageEmbedder({ apiKey: 'k', fetchImpl: fetchMock as unknown as typeof fetch })
    const many = Array.from({ length: 1500 }, (_, i) => `doc-${String(i)}`)
    fetchMock.mockImplementation(async (_u, init: RequestInit) => {
      const b = JSON.parse(init.body as string) as { input: string[] }
      return okResponse(b.input.map(() => vec(0.1)))
    })
    await e.embedDocuments(many)
    expect(fetchMock.mock.calls.length).toBeGreaterThan(1)
  })

  it('THROWS when a returned vector length != EMBED_DIM (dim drift guard)', async () => {
    fetchMock.mockResolvedValue(okResponse([[0.1, 0.2, 0.3]])) // 3 != 512
    const e = createVoyageEmbedder({ apiKey: 'k', fetchImpl: fetchMock as unknown as typeof fetch })
    await expect(e.embedQuery('x')).rejects.toThrow(/dimension|EMBED_DIM|512/i)
  })

  it('retries with backoff on HTTP 429 then succeeds', async () => {
    fetchMock
      .mockResolvedValueOnce(new Response('rate limited', { status: 429 }))
      .mockResolvedValueOnce(okResponse([vec(0.1)]))
    const e = createVoyageEmbedder({ apiKey: 'k', fetchImpl: fetchMock as unknown as typeof fetch, sleepImpl: async () => undefined })
    const out = await e.embedQuery('x')
    expect(out).toHaveLength(EMBED_DIM)
    expect(fetchMock.mock.calls.length).toBe(2)
  })

  it('throws a typed error on a non-429 non-200 (e.g. 401)', async () => {
    fetchMock.mockResolvedValue(new Response('unauthorized', { status: 401 }))
    const e = createVoyageEmbedder({ apiKey: 'k', fetchImpl: fetchMock as unknown as typeof fetch })
    await expect(e.embedQuery('x')).rejects.toThrow()
  })
})
```

- [ ] **Step 2: Run — FAIL** (`Cannot find module '../embed.js'`).
- [ ] **Step 3: Implement.** Sketch (adjust to typecheck — the authority):

```ts
// backend/src/llm/embed.ts
//
// MYT-71 §4.1 — the Voyage embeddings wrapper. A plain fetch to the REST
// /v1/embeddings endpoint; NO third-party SDK. Asymmetric input types
// (document for stored rows, query for searches), split timeouts (write-path
// generous, query-path tight), bounded 429 backoff, and a hard length-assert
// against EMBED_DIM so a model/dim drift fails loud instead of writing a
// wrong-width vector. Config (model, dim, batch caps, timeouts) comes from
// world/retrieval/config.ts — never hardcoded here.

import { logger } from './logger.js'
import {
  EMBED_DIM, VOYAGE_EMBED_MODEL, VOYAGE_OUTPUT_DIMENSION,
  VOYAGE_INPUT_TYPE_DOC, VOYAGE_INPUT_TYPE_QUERY,
  VOYAGE_BATCH_MAX_INPUTS, VOYAGE_BATCH_MAX_TOKENS,
  VOYAGE_DOC_TIMEOUT_MS, VOYAGE_QUERY_TIMEOUT_MS,
  VOYAGE_MAX_RETRIES_429,
} from '../world/retrieval/config.js'

const VOYAGE_URL = 'https://api.voyageai.com/v1/embeddings'

export class VoyageEmbedError extends Error {}

export interface VoyageEmbedder {
  embedDocuments(texts: readonly string[]): Promise<number[][]>
  embedQuery(text: string): Promise<number[]>
}

interface EmbedderOpts {
  readonly apiKey: string
  readonly fetchImpl?: typeof fetch
  readonly sleepImpl?: (ms: number) => Promise<void>
}

// char/4 token estimate (mechanical — Voyage's binding limit is tokens).
function estimateTokens(s: string): number { return Math.ceil(s.length / 4) }

// Greedy chunking by BOTH the input-count cap and the token-estimate cap.
function chunkByCounts(texts: readonly string[]): string[][] { /* … */ }

export function createVoyageEmbedder(opts: EmbedderOpts): VoyageEmbedder {
  const doFetch = opts.fetchImpl ?? fetch
  const sleep = opts.sleepImpl ?? ((ms) => new Promise((r) => setTimeout(r, ms)))

  async function call(input: string[], inputType: string, timeoutMs: number): Promise<number[][]> {
    const ac = new AbortController()
    const timer = setTimeout(() => ac.abort(), timeoutMs)
    try {
      for (let attempt = 0; ; attempt++) {
        const res = await doFetch(VOYAGE_URL, {
          method: 'POST',
          headers: { Authorization: `Bearer ${opts.apiKey}`, 'content-type': 'application/json' },
          body: JSON.stringify({ model: VOYAGE_EMBED_MODEL, input, input_type: inputType, output_dimension: VOYAGE_OUTPUT_DIMENSION }),
          signal: ac.signal,
        })
        if (res.status === 429 && attempt < VOYAGE_MAX_RETRIES_429) {
          await sleep(2 ** attempt * 500)
          continue
        }
        if (!res.ok) throw new VoyageEmbedError(`voyage ${String(res.status)}`)
        const json = (await res.json()) as { data: { embedding: number[] }[] }
        const vectors = json.data.map((d) => d.embedding)
        for (const v of vectors) {
          if (v.length !== EMBED_DIM) {
            throw new VoyageEmbedError(`voyage returned dimension ${String(v.length)}, expected EMBED_DIM ${String(EMBED_DIM)}`)
          }
        }
        return vectors
      }
    } finally {
      clearTimeout(timer)
    }
  }

  return {
    embedDocuments: async (texts) => {
      const out: number[][] = []
      for (const chunk of chunkByCounts(texts)) {
        out.push(...(await call(chunk, VOYAGE_INPUT_TYPE_DOC, VOYAGE_DOC_TIMEOUT_MS)))
      }
      return out
    },
    embedQuery: async (text) => {
      const [v] = await call([text], VOYAGE_INPUT_TYPE_QUERY, VOYAGE_QUERY_TIMEOUT_MS)
      if (v === undefined) throw new VoyageEmbedError('voyage returned no embedding')
      return v
    },
  }
}
```

(Implementer: wire `logger.warn` on each 429 retry and on a terminal failure so the write-path/turn-path have a grep target. The `estimateTokens`/`chunkByCounts` bodies are mechanical — fully unit-cover them. `void logger` if a lint no-unused fires before you wire it.)

- [ ] **Step 4: Run — PASS.** Report DONE.

---

### Task 4: `config.ts` + `types.ts` (§9, §5, §6)

**Files:**
- Create: `backend/src/world/retrieval/config.ts` + test `backend/src/world/retrieval/__tests__/config.test.ts`
- Create: `backend/src/world/retrieval/types.ts` (+ a compile-only / shape test if the implementer wants — types alone need no runtime test, but `index.ts`'s re-export is tested in T9; a minimal `types.test.ts` asserting a constructed object conforms is fine for coverage hygiene)

The §9 constants table + the resolver result types. **The match-vs-mint score threshold is NOT here** (MYT-73's model-calibrated constant).

- [ ] **Step 1: Failing config test:**

```ts
// backend/src/world/retrieval/__tests__/config.test.ts
import { describe, expect, it } from 'vitest'
import {
  VOYAGE_EMBED_MODEL, EMBED_DIM, VOYAGE_OUTPUT_DIMENSION,
  VOYAGE_INPUT_TYPE_DOC, VOYAGE_INPUT_TYPE_QUERY,
  VOYAGE_BATCH_MAX_INPUTS, VOYAGE_BATCH_MAX_TOKENS,
  VOYAGE_DOC_TIMEOUT_MS, VOYAGE_QUERY_TIMEOUT_MS, VOYAGE_MAX_RETRIES_429,
  HNSW_EF_SEARCH, HNSW_ITERATIVE_SCAN,
  SEARCH_LORE_DEFAULT_LIMIT, SEARCH_LORE_MAX_LIMIT,
  GRAPH_DEFAULT_DEPTH, GRAPH_MAX_DEPTH,
} from '../config.js'

describe('world/retrieval/config', () => {
  it('pins the §9 embedding constants', () => {
    expect(VOYAGE_EMBED_MODEL).toBe('voyage-4-lite')
    expect(EMBED_DIM).toBe(512)
    expect(VOYAGE_OUTPUT_DIMENSION).toBe(512)
    expect(VOYAGE_INPUT_TYPE_DOC).toBe('document')
    expect(VOYAGE_INPUT_TYPE_QUERY).toBe('query')
  })
  it('pins the batch + timeout knobs (doc generous, query tight)', () => {
    expect(VOYAGE_BATCH_MAX_INPUTS).toBeLessThanOrEqual(1000)
    expect(VOYAGE_BATCH_MAX_TOKENS).toBeGreaterThan(0)
    expect(VOYAGE_DOC_TIMEOUT_MS).toBeGreaterThan(VOYAGE_QUERY_TIMEOUT_MS)
    expect(VOYAGE_MAX_RETRIES_429).toBeGreaterThan(0)
  })
  it('pins the search + graph bounds', () => {
    expect(SEARCH_LORE_DEFAULT_LIMIT).toBe(10)
    expect(SEARCH_LORE_MAX_LIMIT).toBe(50)
    expect(GRAPH_DEFAULT_DEPTH).toBe(2)
    expect(GRAPH_MAX_DEPTH).toBe(5)
    expect(HNSW_ITERATIVE_SCAN).toBe('relaxed_order')
    expect(HNSW_EF_SEARCH).toBeGreaterThan(0)
  })
})
```

- [ ] **Step 2: Run — FAIL.**
- [ ] **Step 3: Implement `config.ts`** — the §9 table verbatim. `VOYAGE_BATCH_MAX_INPUTS = 1000` (the Voyage cap); `VOYAGE_BATCH_MAX_TOKENS` set conservatively under the 1M model limit (e.g. `120_000` — generous headroom, never the binding constraint at this corpus scale); `VOYAGE_DOC_TIMEOUT_MS` generous (e.g. `60_000`), `VOYAGE_QUERY_TIMEOUT_MS` tight (e.g. `5_000` — it runs on MYT-72's turn path); `VOYAGE_MAX_RETRIES_429` (e.g. `3`). Comment each with its §-rationale. **Re-verify `VOYAGE_EMBED_MODEL` against Voyage's live model list at build time (runbooks-must-be-executed)** — pin the comment.
- [ ] **Step 4: Implement `types.ts`:**

```ts
// backend/src/world/retrieval/types.ts
//
// MYT-71 §5/§6 — the resolver result types. Consumed by MYT-72 (tool wrapping)
// and MYT-73 (Scribe match-vs-mint). accessLevel is the EXISTING AccessLevel
// from repo/facts.ts (known | discoverable | secret) — never a re-declared
// public/private union. Score = 1 - cosine_distance, range [-1, 1].

import type { AccessLevel, NarrativeStatus } from '../../repo/facts.js'
import type { EntityType } from '../../repo/entities.js'

/** A semantic-search hit — a fact OR an entity, merged + re-ranked (§5). */
export interface LoreHit {
  readonly source: 'fact' | 'entity'
  readonly factId?: string
  readonly entityId: string
  readonly entityName: string
  readonly topic?: string
  readonly content: string
  readonly accessLevel: AccessLevel
  readonly narrativeStatus?: NarrativeStatus
  /** 1 - cosine_distance, range [-1, 1]. Calibration is model-specific; the
   *  match-vs-mint threshold lives in MYT-73, NOT here. */
  readonly score: number
}

/** A canon entity candidate for the Scribe match-vs-mint path (MYT-73). */
export interface EntityCandidate {
  readonly entityId: string
  readonly name: string
  readonly entityType: EntityType
  readonly score: number
}

/** A reachable character from charactersKnownTo (a SET — one row per entity,
 *  min depth). PCs included (the resolver over-pulls). */
export interface KnownCharacter {
  readonly entityId: string
  readonly name: string
  readonly entityType: EntityType
  readonly depth: number
}

/** A node in factionTree's containment subtree. `truncated` on the result set
 *  (not per-node) signals the subtree was deeper than GRAPH_MAX_DEPTH. */
export interface FactionNode {
  readonly entityId: string
  readonly name: string
  readonly entityType: EntityType
  readonly parentId: string | null
  readonly depth: number
}
```

(`EntityType` is exported from `repo/entities.ts` — confirm it covers `'pc'`? It does NOT (`EntityType = 'npc'|'location'|'faction'|'item'`); `'pc'` was added at the DB CHECK level in 016 but the TS type was not widened. **`KnownCharacter.entityType` and `factionTree` rows can carry `'pc'` at runtime** for the graph paths that include PCs. FLAG: see Spec ambiguities #2 — the implementer must widen a local `GraphEntityType = EntityType | 'pc'` for the graph result types, or the graph SQL's `entity_type` read won't typecheck against the narrow `EntityType`. Do NOT widen `repo/entities.ts`'s `EntityType` — that ripples into insert paths. `searchLore`/`findSimilarEntities` exclude `pc`, so `LoreHit`/`EntityCandidate` keep the narrow `EntityType`.)

- [ ] **Step 5: Run — PASS.** Report DONE.

---

### Task 5: `VOYAGE_API_KEY` across env + TF surfaces (§4.4)

**Files:**
- Modify: `backend/src/config/env.ts` (+ extend `backend/src/config/__tests__/env.test.ts`)
- Modify: `backend/src/__tests__/setup-env.ts`, `backend/.env.development`, `backend/.env.development.example`
- Modify: `infra/environments/staging/main.tf`, `infra/modules/serving/main.tf`, `infra/modules/serving/variables.tf`

`loadEnv()` is the boot gate for BOTH the API and the worker, so a required-and-missing key crashloops both — the key MUST be required and present on both task-defs.

- [ ] **Step 1: Failing env test** (extend `env.test.ts`): a valid `VOYAGE_API_KEY` set → `loadEnv().voyageApiKey` returns it; unset/empty → `loadEnv()` throws `/VOYAGE_API_KEY is required/`. (Mirror the existing `validateAnthropicApiKey` test shape.) **Decide the prefix-assert posture:** Voyage keys carry a `pa-` prefix. The Anthropic/Stripe validators assert prefix. Per `feedback_runbooks_must_be_executed`, **confirm the live Voyage key prefix at implementation time** before asserting it — if confirmed `pa-`, assert it (`validateVoyageApiKey` mirrors `validateAnthropicApiKey`'s prefix check); if unconfirmed, assert only non-empty (a wrong prefix-assert that rejects a valid key is worse than no assert). FLAG the choice in the PR note.
- [ ] **Step 2: Implement `env.ts`:** add `readonly voyageApiKey: string` to `Env`; add `validateVoyageApiKey(raw)` mirroring `validateAnthropicApiKey` (required-non-empty + the confirmed prefix); call it in `loadEnv()` and add `voyageApiKey` to the frozen return object.
- [ ] **Step 3: setup-env + dotenv files:**
  - `setup-env.ts`: add `process.env.VOYAGE_API_KEY ??= 'pa-test-baseline-for-setup-env'` (or the confirmed prefix) alongside the other baselines (~line 37).
  - `backend/.env.development`: add `VOYAGE_API_KEY=<the real dev key, or pa-REPLACE_ME>` (the local dev value — if a real key exists, Miklos pastes it; this is a human-action point if absent — see Task 13).
  - `backend/.env.development.example`: add `VOYAGE_API_KEY=pa-REPLACE_ME_dev_only` with a `# VOYAGE_API_KEY pulls from the Voyage dashboard` comment (mirroring the ANTHROPIC line at ~26-29).
- [ ] **Step 4: TF surfaces:**
  - `infra/environments/staging/main.tf`: add `"voyage-api-key"` to the `manual_secret_names` list (line ~17-20). The `aws_secretsmanager_secret_version` PLACEHOLDER + `ignore_changes = [secret_string]` (line ~41-48) then provisions it as a placeholder secret — **document the out-of-band value population** (a placeholder boots but 401s on first embed; the real value is set via `aws secretsmanager put-secret-value` — record this as a Task-13 human-action / runbook line).
  - `infra/modules/serving/main.tf`: add `{ name = "VOYAGE_API_KEY", valueFrom = var.manual_secret_arns["voyage-api-key"] }` to the `common_secrets` local (line ~164-169) — this puts it on BOTH task-defs (both reference `local.common_secrets`).
  - `infra/modules/serving/variables.tf`: add `"voyage-api-key"` to the `manual_secret_arns` validation `for k in [...]` list (line ~118-123) AND update the `error_message` + the `description` ("Must contain keys: anthropic-api-key, stripe-secret-key, stripe-webhook-secret, voyage-api-key").
- [ ] **Step 5: Run** the env test + `pnpm --filter @mythrun/backend typecheck` — PASS. (TF is not in the typecheck/test gate; the controller validates TF with `terraform validate` in the staging dir during Task 13 prep if a real plan is run — but TF changes do NOT deploy in this issue's push; flag the "green Deploy needed" follow-up per `feedback_required_env_three_surfaces` + `reference_tf_ci_taskdef_split`: after this lands, run `gh workflow run Deploy` to roll the new task-def revision, never a force-rollover.) Report DONE.

**Implementer note (feedback_required_env_three_surfaces):** the new required env var must hit `loadEnv()` + `setup-env.ts` + the TF task-def in lockstep, then a green Deploy rolls the revision. Missing any one leaves CI silently red or staging stale. The CI build job (`deploy.yml`) runs backend tests with `setup-env.ts`'s baseline, so Step 3's `setup-env` line is what keeps CI green.

---

### Task 6: `repo/world-retrieval.ts` + `updateEmbedding` (§5, §6, §7)

**Files:**
- Create: `backend/src/repo/world-retrieval.ts` + test `backend/src/repo/__tests__/world-retrieval.test.ts`
- Modify: `backend/src/repo/entities.ts`, `backend/src/repo/facts.ts` (add `updateEmbedding` to the `*Ns` binders) + extend `backend/src/repo/__tests__/entities.test.ts` / `facts.test.ts`

The heavy SQL lives here (the `*Ns(c)` binder pattern). All over-pulling — NO `access_level` predicate. World-scoping for facts is the entities-join (`facts` has no `world_id`); for graph it's inherited from same-world endpoints. **Vector tests use hand-injected deterministic `vector(512)` literals** (`'[f1,…,f512]'::vector`, generated programmatically — unit vectors along chosen axes) so cosine order is exactly predictable; the resolver/test SETs `iterative_scan`/exact scan so order is index-independent.

The binder exposes (signatures the implementer pins; build the SQL against §5/§6):
- `searchFacts(worldId, queryVecLiteral, limit): Promise<readonly LoreFactDbHit[]>` — `JOIN facts f JOIN entities e ON e.id = f.entity_id WHERE e.world_id = $1 AND f.embedding IS NOT NULL ORDER BY f.embedding <=> $2 LIMIT $3`, selecting `f.id, e.id, e.name, f.topic, f.content, f.access_level, f.narrative_status, (1 - (f.embedding <=> $2)) AS score`.
- `searchEntities(worldId, queryVecLiteral, limit, entityType?): Promise<readonly LoreEntityDbHit[]>` — `entities WHERE world_id=$1 AND entity_type <> 'pc' AND embedding IS NOT NULL` (+ optional `AND entity_type = $n`); LEFT JOIN `prose_kernels` is NOT needed at READ time (the prose is baked into the embedding at WRITE time) — read selects `id, name, entity_type, access_level, (1 - (embedding <=> $2)) AS score`. (Used by BOTH `searchLore`'s entity arm and `findSimilarEntities`, which passes the `entityType` filter and reads the `EntityCandidate` subset.)
- `charactersKnownTo(rootEntityId, maxDepth): Promise<readonly KnownCharacterDbRow[]>` — the recursive CTE over `relationships` (both directions via a `UNION` of source↔target), cycle-safe `path` array, `DISTINCT ON (entity_id)` min depth. (The `nameFilter` is applied in `graph.ts`, NOT here — it's a normalized post-filter, mechanical; OR apply it here as a `lower(btrim(name)) = lower(btrim($n))` — implementer's call, but pin it ONE place; the spec frames it as a post-filter, so `graph.ts` is the home.)
- `factionTree(rootEntityId, maxDepth): Promise<readonly FactionNodeDbRow[]>` — the recursive CTE over `entity_hierarchy` (parent→child), depth-bounded; the `truncated` determination (did any node hit `maxDepth`?) is computed in `graph.ts` from the rows OR the CTE returns one extra depth level so `graph.ts` can detect truncation — pin in `graph.ts` (T8).

The query-tx SET: each vector read runs in a tx that does `SET LOCAL hnsw.iterative_scan = $ITERATIVE_SCAN` (relaxed_order) before the SELECT, so the world post-filter doesn't starve the top-k (§3). If Task 1 found pgvector < 0.8, fall back to `SET LOCAL enable_indexscan = off` (exact scan) — gate on a config flag. **The binder takes a `ClientLike`; the tx scoping is the orchestration layer's (search.ts/graph.ts via `repo.transaction` or a read-only tx helper).** Decide: the cleanest is for `world-retrieval.ts` methods to accept an already-SET client, and `search.ts`/`graph.ts` to wrap the call in a short read tx that issues the `SET LOCAL` first. Pin that seam in the binder doc-comment.

`updateEmbedding` on entities/facts:
```ts
// on entitiesNs(c) and factsNs(c):
updateEmbedding: async (id: string, vecLiteral: string): Promise<number> => {
  const r = await c.query(
    `UPDATE entities SET embedding = $1::vector, embedded_at = now() WHERE id = $2`,
    [vecLiteral, id],
  )
  return r.rowCount ?? 0
},
```
(facts mirror with `UPDATE facts`. The `vecLiteral` is the `'[f1,…]'` string form produced by `embed-write.ts` from the `number[]`. Keep the binder canonical; do NOT add a non-`*Ns` shim unless a non-binder caller appears — `embed-write.ts` calls `repo.entities.updateEmbedding` / `tx.entities.updateEmbedding`.)

- [ ] **Step 1: Failing test** (scoped-fixture, real PG — read `backend/src/__tests__/CONVENTIONS.md` + an existing `repo/__tests__/*.test.ts` header first). Seed two worlds; in world A seed entities (npc/location/faction/item + one `pc`) with hand-injected `vector(512)` literals along chosen axes, facts on those entities (across all three tiers: `known`/`discoverable`/`secret`), a relationship graph (incl. a deliberate cycle + a diamond), and an `entity_hierarchy` subtree. Assert:
  1. `searchFacts(worldA, qVec, 10)` ranks facts by cosine, returns ALL tiers, score = `1 - distance`, and **never returns a worldB fact** (cross-world isolation).
  2. `searchEntities(worldA, qVec, 10)` excludes the `pc` entity, ranks by cosine, never returns worldB.
  3. `searchEntities` with `entityType='npc'` filters to npc.
  4. the `limit` is honored.
  5. `charactersKnownTo(root, 3)` traverses BOTH directions, is cycle-safe (the cycle doesn't loop), dedups the diamond's shared node to ONE row at min depth, respects `maxDepth`.
  6. `factionTree(root, 5)` returns the subtree shape with correct `parentId`/`depth`.
  7. `repo.entities.updateEmbedding(id, lit)` / `repo.facts.updateEmbedding(id, lit)` set `embedding` + `embedded_at` (assert the row's `embedded_at IS NOT NULL` after).
- [ ] **Step 2: Run — FAIL.**
- [ ] **Step 3: Implement** the binder + the two `updateEmbedding` methods. Generate the test vector literals with a helper (`unitVec(axis: number): string` → `'[0,…,1,…,0]'`) so the cosine ordering is hand-verifiable.
- [ ] **Step 4: Run — PASS.** Report DONE.

**Implementer note:** the `<=>` operator is cosine DISTANCE; `1 - (embedding <=> $q)` is the score (`[-1,1]`). Parameterize the query vector as a `::vector` cast on a text param (`$2::vector`) — pg has no native vector param binding, so pass the `'[…]'` string and cast. The `path` array in the recursive CTE accumulates `entity_id`s; the both-direction edge expansion is a `UNION ALL` of (source→target) and (target→source) rows in the recursive term.

---

### Task 7: `world/retrieval/search.ts` — `searchLore`, `findSimilarEntities` (§5, §8)

**Files:**
- Create: `backend/src/world/retrieval/search.ts` + test `backend/src/world/retrieval/__tests__/search.test.ts`

Orchestration: embed (via `embed.ts`, OUTSIDE any tx) → `world-retrieval` query (in a short read tx that SETs `iterative_scan`) → shape `LoreHit[]` / `EntityCandidate[]`. **`searchLore` is TOTAL** (embed/infra failure → `[]` + `logger.warn`). **`findSimilarEntities` THROWS on embed failure** (canon write path — no duplicate-mint on a blip).

- `searchLore(worldId, queryText, { limit }): Promise<LoreHit[]>` — `embedQuery(queryText)` → vector literal → `searchFacts` ∪ `searchEntities` → merge + re-rank by `score` desc → `slice(0, limit)`. `limit` defaults `SEARCH_LORE_DEFAULT_LIMIT`, capped `SEARCH_LORE_MAX_LIMIT`. Fact hits map `source:'fact'` (with `factId`, `topic`, `narrativeStatus`); entity hits map `source:'entity'` (no `factId`/`topic`/`narrativeStatus`). On ANY thrown error (embed or query) → `logger.warn` + return `[]`.
- `findSimilarEntities(worldId, text, { limit, entityType? }): Promise<EntityCandidate[]>` — `embedQuery(text)` → `searchEntities(worldId, vec, limit, entityType)` → map to `EntityCandidate`. On embed failure → **THROW** (do NOT catch). Canon-only; world-scoped; `entity_type <> 'pc'`.

Deps: inject the `VoyageEmbedder` + a `ClientLike`/pool + `logger` (constructor-injected deps object, so the test mocks `embedQuery` to a fixed vector + uses real-PG rows). The tx-SET seam (the `SET LOCAL hnsw.iterative_scan`) lives here (or in a tiny shared `withVectorScan(client, fn)` helper in `world-retrieval.ts` — implementer's call; pin it ONE place).

- [ ] **Step 1: Failing test** (mock `embedQuery` to a fixed vector + real-PG rows via scoped fixture, mirroring T6's seed):
  1. `searchLore` returns merged facts ∪ entities ordered by score; a fact AND an entity both appear; the merge re-ranks correctly.
  2. `searchLore` excludes `pc` entities, returns all three tiers.
  3. `searchLore` with `embedQuery` rejecting → returns `[]` and logs warn (totality).
  4. `searchLore` honors `limit` (and caps at `SEARCH_LORE_MAX_LIMIT`).
  5. `findSimilarEntities` returns `EntityCandidate[]` ranked, `entity_type <> 'pc'`, optional `entityType` filter applied.
  6. `findSimilarEntities` with `embedQuery` rejecting → **THROWS** (assert `.rejects`).
  7. cross-world: `searchLore(worldA)` never returns a worldB row (the invariant — exercised through the real query).
- [ ] **Step 2: Run — FAIL.**
- [ ] **Step 3: Implement.** Keep each function under 50 lines; extract the merge/shape helpers.
- [ ] **Step 4: Run — PASS.** Report DONE.

---

### Task 8: `world/retrieval/graph.ts` — `charactersKnownTo`, `factionTree` (§6)

**Files:**
- Create: `backend/src/world/retrieval/graph.ts` + test `backend/src/world/retrieval/__tests__/graph.test.ts`

Orchestration over the T6 recursive-CTE reads. NO embedding (no LLM). **Graph functions propagate DB errors** (no degradation contract — flagged for MYT-72, which catches them in its tool-error handling). Over-pulling across tiers; PCs included.

- `charactersKnownTo(entityId, { nameFilter?, maxDepth? }): Promise<KnownCharacter[]>` — `maxDepth` defaults `GRAPH_DEFAULT_DEPTH`, capped `GRAPH_MAX_DEPTH`. Call `repo.worldRetrieval.charactersKnownTo(entityId, depth)`; apply `nameFilter` as a normalized post-filter (`lower(btrim(name)) === lower(btrim(nameFilter))` in JS — mechanical) if set; map to `KnownCharacter`. (The result is already a SET via the binder's `DISTINCT ON`.)
- `factionTree(entityId): Promise<{ nodes: FactionNode[]; truncated: boolean }>` — call the binder at `GRAPH_MAX_DEPTH` (+1 probe level so truncation is detectable); if any node would exceed `GRAPH_MAX_DEPTH`, set `truncated: true` and drop the over-depth nodes; map to `FactionNode`. (Pin the return shape — the spec says `factionTree → FactionNode[]` with a `truncated` flag; a `{ nodes, truncated }` object is the clean way to carry both. FLAG: see Spec ambiguities #3 — the spec's signature `→ FactionNode[]` and "a `truncated: true` flag" are slightly in tension; `{ nodes, truncated }` resolves it without a sentinel node.)

- [ ] **Step 1: Failing test** (scoped fixture — seed via T6's graph + hierarchy):
  1. `charactersKnownTo` both-direction traversal (a target-side-only edge is reachable).
  2. depth-bounding (a node beyond `maxDepth` is absent; default depth = 2).
  3. cycle-safety (a deliberate cycle terminates).
  4. diamond dedup (the shared node appears once at min depth).
  5. `nameFilter` (case-insensitive, trimmed) narrows correctly.
  6. PCs are included (a `pc` neighbor appears).
  7. `factionTree` returns the subtree shape (parentId/depth correct); a subtree deeper than `GRAPH_MAX_DEPTH` returns `truncated: true` with the over-depth nodes dropped.
- [ ] **Step 2: Run — FAIL.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run — PASS.** Report DONE.

---

### Task 9: `embed-write.ts` (`embedWorld`) + `index.ts` + the backfill command (§4.3)

**Files:**
- Create: `backend/src/world/retrieval/embed-write.ts` + test `backend/src/world/retrieval/__tests__/embed-write.test.ts`
- Create: `backend/src/world/retrieval/index.ts` (the resolver surface MYT-72/73 import) + a re-export test
- Create: `backend/scripts/world-embed-backfill.ts` + add the `world:embed-backfill` script to `backend/package.json`

`embedWorld(worldId, { force? })`: read NULL/stale-embedding content via the repo (facts: the entity-joined content; entities: `name || ' ' || COALESCE(prose_kernel.content,'')`, `entity_type <> 'pc'`), `embedDocuments` in batches, then write each batch's `embedding` + `embedded_at` via `repo.{entities,facts}.updateEmbedding`. **The Voyage call runs OUTSIDE any transaction** (MYT-55) — embed a batch (no tx), then write that batch (a short write-only tx or per-row UPDATE). Returns a summary `{ embedded, leftNull, voyageErrors }` (the §I2 detection signal the world-gen stage logs). The `number[]` → `'[…]'` literal conversion lives here (a `toVectorLiteral(v: number[]): string` helper).

Two read shapes the repo must expose (add to `world-retrieval.ts` in T6 OR here — pin in T6; these are reads `embedWorld` needs):
- `listFactsToEmbed(worldId, force): Promise<{ id, content }[]>` — facts joined to entities for world scope, `embedding IS NULL` (or all, with `force`).
- `listEntitiesToEmbed(worldId, force): Promise<{ id, text }[]>` — entities `entity_type <> 'pc'`, `name || prose_kernel.content`, `embedding IS NULL` (or all, with `force`).

(Implementer: these two reads belong in `world-retrieval.ts` — go back and add them in T6's binder; this task consumes them. If T6 already landed, add them as a small additive edit and re-run T6's test, OR pin them in T6's plan step now. **Decision: list them in T6's binder surface** — update the T6 file-ownership accordingly; they're disjoint methods on the same binder.)

`index.ts`: re-export `searchLore`, `findSimilarEntities` (search.ts), `charactersKnownTo`, `factionTree` (graph.ts), `embedWorld` (embed-write.ts), and the types. This is the surface MYT-72/73 import.

Backfill `scripts/world-embed-backfill.ts` (`pnpm world:embed-backfill [--world <id> | --all] [--force]`): builds a pool + repo + a `VoyageEmbedder` from `env.voyageApiKey`, runs `embedWorld` per world (NULL rows by default; `--force` re-embeds all). Idempotent on NULL selection. `--all --force` is a deliberate full re-embed (a real Voyage rate/spend event — documented in the script header).

- [ ] **Step 1: Failing test** (mock the `VoyageEmbedder`'s `embedDocuments` to fixed vectors + real-PG rows):
  1. `embedWorld` reads NULL-embedding facts + entities, calls `embedDocuments` (assert the Voyage call is OUTSIDE a tx — e.g. the mock records that no open client is held; practically: assert `embedDocuments` is called with the batch and the UPDATEs land after), writes `embedding` + `embedded_at` on each.
  2. `embedWorld` excludes `pc` entities.
  3. `embedWorld` skips already-embedded rows (NULL selection) unless `force`.
  4. the returned summary `{ embedded, leftNull, voyageErrors }` reflects the run.
  5. batching: >`VOYAGE_BATCH_MAX_INPUTS` rows → `embedDocuments` invoked appropriately (the wrapper chunks internally, so `embedWorld` may call once with the full list — pin: `embedWorld` passes the full list to `embedDocuments`, which chunks; assert the writes cover all rows).
  6. `index.ts` re-exports the five functions + types (a shape/smoke test).
- [ ] **Step 2: Run — FAIL.**
- [ ] **Step 3: Implement** `embed-write.ts` (Voyage-call-outside-tx structure: gather rows → `embedDocuments(allTexts)` → zip results to ids → write in a short tx), `index.ts`, and the backfill script.
- [ ] **Step 4: Run — PASS.** Report DONE.

**Implementer note (MYT-55 — `reference_transaction_scope_just_writes`):** NEVER hold a PG connection idle across the Voyage round-trip. The pattern is: (a) read the rows-to-embed (read tx or pool), (b) `await embedDocuments(...)` with NO open client, (c) write the embeddings (short write tx or per-row UPDATE). The write tx must scope to JUST the writes.

---

### Task 10: the world-gen embed stage — TOTAL terminal stage (§4.3)

**Files:**
- Create: `backend/src/llm/prep/stages/embed-world.ts` + test
- Modify: `backend/src/llm/prep/world-gen-processor.ts` (`WORLD_GEN_STAGES` + the dispatch arm) + extend `world-gen-processor.test.ts`
- Modify: `backend/src/llm/prep/streaming-extractor.ts` (the `WorldGenStage` union)
- Modify: `backend/src/llm/ai.ts` (the `VALID_STAGES` set)
- Modify: `backend/src/sse/derive-phase.ts` (the `WORLDGEN_STAGES` dev-tool taxonomy — the 4th lockstep list)

Append a NEW terminal stage `'embed_world'` to `WORLD_GEN_STAGES`, running AFTER `coherence_pass` (the last content stage) and before `worlds.status → 'complete'`. **It is a TOTAL stage** — the loop contract is "any thrown error → `handleStageError` → world `failed`," so the stage **catches ALL Voyage/embed errors internally, logs, leaves rows NULL, and ALWAYS returns a successful `StageDispatchResult` with `costUsd:0, inputTokens:0, outputTokens:0`** (Voyage spend is off the Anthropic cap). On completion it emits a structured summary log `{ event: 'world_gen.embed_world', worldId, embedded, leftNull, voyageErrors }`.

**Lockstep stage lists (all FOUR MUST gain `'embed_world'`):**
1. `WORLD_GEN_STAGES` in `world-gen-processor.ts` (append after `'coherence_pass'`).
2. the `WorldGenStage` union in `streaming-extractor.ts` (append `| 'embed_world'`).
3. `VALID_STAGES` in `ai.ts` (add `'embed_world'`). It routes NO `ai.ts` LLM call, but the lists are lockstep.
4. `WORLDGEN_STAGES` in `sse/derive-phase.ts` (append after `'coherence_pass'`). REQUIRED: the embed stage writes a `pipeline_runs` row (claimStage/markStageCompleted), and `derive-phase`'s `stageScope` drops any stage not in its lists to `'unknown'` — which would make `embed_world` invisible to the dev-tool phase panel AND let `derivePhase` read world-gen as "done" at `coherence_pass` while embedding still runs. Adding it classifies the stage `'worldgen'` and orders it last.

The dispatch arm in `world-gen-processor.ts`'s `dispatchStage`: when `stage === 'embed_world'`, build a `VoyageEmbedder` from `deps` (the processor needs `env.voyageApiKey` — thread it into `WorldGenDeps` as `readonly voyageApiKey: string`, set at boot in `server.ts`/`worker.ts` wiring alongside `costCapUsd`) and call `runEmbedWorldStage(repo, { worldId, voyageApiKey })`, which wraps `embedWorld` in a total try/catch and returns `wrapLegacyStage({ costUsd: 0, inputTokens: 0, outputTokens: 0 })`.

- [ ] **Step 1: Failing test** (`embed-world.test.ts`, mock `embedWorld` / the `VoyageEmbedder`):
  1. `runEmbedWorldStage` returns `{ costUsd: 0, inputTokens: 0, outputTokens: 0, ... }` on success, embeds the world's NULL rows.
  2. **Total stage:** `embedWorld` THROWING (a Voyage error) → the stage CATCHES it, logs `voyageErrors > 0`, leaves rows NULL, and STILL returns a successful `StageDispatchResult` (`costUsd: 0`) — does NOT rethrow.
  3. the summary log is emitted with `{ worldId, embedded, leftNull, voyageErrors }`.
  4. (processor test, extend) `WORLD_GEN_STAGES` ends with `'embed_world'` after `'coherence_pass'`; the dispatch arm routes it; a world reaches `markComplete` even when the embed stage left rows NULL (total-stage end-to-end through the loop).
  5. (lockstep) `VALID_STAGES` (ai.ts) and the `WorldGenStage` union (streaming-extractor) both include `'embed_world'` — a type-level + `extractStage('embed_world')` round-trip assertion.
  6. (lockstep) `derivePhase` classifies a `pipeline_runs` row with `stage: 'embed_world'` as scope `'worldgen'`, not `'unknown'` — extend `derive-phase.test.ts` (or assert `WORLDGEN_STAGES` includes `'embed_world'` after `'coherence_pass'` if the suite tests the constant directly).
- [ ] **Step 2: Run — FAIL.**
- [ ] **Step 3: Implement** the stage + the three lockstep edits + the `WorldGenDeps.voyageApiKey` thread. The dispatch arm sketch:

```ts
  if (stage === 'embed_world') {
    const cost = await runEmbedWorldStage(repo, {
      worldId: ctx.world.id,
      voyageApiKey: deps.voyageApiKey,
      logger: deps.logger,
    })
    return wrapLegacyStage(cost) // always { costUsd: 0, inputTokens: 0, outputTokens: 0 }
  }
```
`runEmbedWorldStage` body: build the embedder, `try { const summary = await embedWorld(...); logger.info({ event: 'world_gen.embed_world', worldId, ...summary }) } catch (err) { logger.warn({ event: 'world_gen.embed_world_failed', worldId, err }) }` then `return { costUsd: 0, inputTokens: 0, outputTokens: 0 }`.

- [ ] **Step 4: Run — PASS** + `pnpm --filter @mythrun/backend typecheck`. Report DONE.

**Implementer note:** the processor's boot wiring (`server.ts` / `worker.ts` where `createWorldGenProcessor` is constructed) must now pass `voyageApiKey: env.voyageApiKey`. Grep for `createWorldGenProcessor(` call sites and thread it (additive). If a call site is in a file another wave owns, FLAG it — but world-gen-processor construction is self-contained to the worker/server boot, distinct from this issue's other files.

---

### Task 11: character-integration embed post-pass (§4.3)

**Files:**
- Modify: `backend/src/llm/prep/character-integration-processor.ts` (terminal embed step, NULL rows only) + extend its test

`character-integration` inserts new facts on existing world NPCs (PC-backstory canon) after world-gen. Those ship NULL-embedded, so the same `embedWorld`-style embed step (NULL rows only — no `force`) runs as the TERMINAL step of the character-integration processor, AFTER `runCharacterIntegrationStage` succeeds and `markStageCompleted`. It is TOTAL the same way (a Voyage error must not fail the integration — the facts are already committed; catch + log).

The processor needs the world id (it has `campaignId` + the stage's result). Resolve the `worldId` from the campaign (the processor already builds `repo`; `repo.campaigns.loadWorldGenContext(campaignId)` or a lighter `repo.campaigns.getWorldId(campaignId)` returns it). The processor also needs `voyageApiKey` — thread it into `CharacterIntegrationProcessorDeps` (additive), set at the boot wiring alongside `pool`/`publishEvent`.

- [ ] **Step 1: Failing test** (extend `character-integration-processor.test.ts`, mock the embedder):
  1. after a successful integration, the embed post-pass runs `embedWorld(worldId)` (NULL rows only) — assert the new integration facts get `embedding`/`embedded_at` set (via a mock recording the call, or a real-PG assertion if the test seeds rows).
  2. a Voyage error in the post-pass does NOT fail the integration (the stage already `markStageCompleted`'d; the post-pass catch logs + returns) — the job still completes cleanly.
  3. the post-pass is NOT reached on the terminal-failure path (it runs only after success).
- [ ] **Step 2: Run — FAIL.**
- [ ] **Step 3: Implement** — after the success block's `publishEvent('stage-completed')`, add a total try/catch embed step:

```ts
    // MYT-71 §4.3: embed the new integration facts (PC-backstory canon on
    // existing NPCs) so the world is searchable-on-completion. NULL rows only;
    // TOTAL — a Voyage error must not fail an already-committed integration.
    try {
      const worldId = await repo.campaigns.getWorldIdForCampaign(campaignId) // confirm method name
      const embedder = createVoyageEmbedder({ apiKey: deps.voyageApiKey })
      const summary = await embedWorld(repo, { worldId, embedder })
      logger.info({ event: 'character_integration.embed', campaignId, worldId, ...summary }, 'integration embed post-pass')
    } catch (err) {
      logger.warn({ event: 'character_integration.embed_failed', campaignId, err }, 'integration embed post-pass failed (non-fatal)')
    }
```
(Confirm the campaign→worldId repo read exists or add a small one; `loadWorldGenContext` already returns `world_id` — reuse it rather than minting a new method if it's the cheapest path.)

- [ ] **Step 4: Run — PASS** + typecheck. Report DONE.

**Implementer note:** thread `voyageApiKey` into `CharacterIntegrationProcessorDeps` and its boot construction (grep `createCharacterIntegrationProcessor(`). Additive.

---

### Task 12 (controller): full lint + scoped-coverage sweep — BUDGETED, not optional

Implementers run only their own test files; the debt is known (feedback_implementers_skip_lint_and_coverage).

- [ ] `pnpm --filter @mythrun/backend lint` — full list (NO head-truncation); dispatch ONE lint-fix subagent for the batch (watch `no-non-null-assertion` + `no-deprecated`; `max-lines` 400 / `max-lines-per-function` 100 — split `world-retrieval.ts` if the recursive-CTE SQL + the four reads + `updateEmbedding` push it past 400).
- [ ] Scoped coverage per new/modified source (feedback_scoped_coverage_for_iteration — NEVER full `test:coverage` during iteration): `pnpm vitest run <tests> --coverage --coverage.include='<source>'` for: `embed.ts`, `world/retrieval/{config,types,search,graph,embed-write,index}.ts`, `repo/world-retrieval.ts`, `repo/entities.ts` (the new `updateEmbedding` arm), `repo/facts.ts` (same), `stages/embed-world.ts`, `world-gen-processor.ts` (the new dispatch arm + `WORLD_GEN_STAGES`), `character-integration-processor.ts` (the post-pass), `config/env.ts` (the validator), `scripts/world-embed-backfill.ts`. Dispatch a coverage-fill subagent for genuine gaps (real tests > c8-ignore; c8-ignore ONLY the v8 finally-boundary + genuinely-defensive arms, with a rationale comment — `reference_binder_coverage_couples_to_consumer`).
- [ ] Full `pnpm --filter @mythrun/backend typecheck && lint && test` green before T13.

---

### Task 13 (controller): gated real-Voyage constructed smoke + resolver E2E → wiki → single push → close

Wire-level, per spec §11 + `feedback_dev_tool_e2e_smoke_required` (curl/psql/node script against a REAL `VOYAGE_API_KEY`; no browser). Smoke = plumbing (does the live API shape + dim + round-trip work?), NOT eval (feedback_smoke_vs_eval). **Gated on `VOYAGE_API_KEY` presence — skips cleanly when absent.**

- [ ] **Human-action gate:** confirm a real `VOYAGE_API_KEY` exists in `backend/.env.development`. If absent, this is a Miklos-action point (paste a Voyage dashboard key) — surface it; do NOT fabricate a key. (The mocked unit suite + typecheck are already green from T12; the smoke is the only step that needs the live key.)
- [ ] **Constructed real-Voyage smoke (§11):** a small node script (or a `*.smoke.ts` gated on `VOYAGE_API_KEY`) that: embeds two real strings with the ASYMMETRIC types — one near the query (`document`), one far (`document`) — stores them as `vector(512)` on seeded fact/entity rows in `mythrun_dev` (or a scratch world), then `embedQuery` the query string and runs `searchLore`/the raw cosine search → **assert the near one ranks first**. Proves the live API shape + the 512 dim + the document/query asymmetry + the round-trip. (Mocks can't catch a real API drift — this is the whole point.)
- [ ] **Resolver E2E against a real generated world:** run a real world-gen through the pipeline (dev tool create-campaign → watch it reach `complete`) and assert: (a) the `embed_world` stage's summary log appears (`world_gen.embed_world` with `embedded > 0, leftNull = 0`); (b) `SELECT count(*) FROM facts WHERE embedding IS NOT NULL` and `… FROM entities WHERE entity_type <> 'pc' AND embedding IS NOT NULL` are non-zero (psql); (c) a `searchLore(worldId, '<a concept from the world>')` returns ranked hits spanning facts AND entities, including `secret`-tier rows (over-pull); (d) `charactersKnownTo`/`factionTree` return real graph structure. Then run a character-integration (add a PC) and assert the new integration facts get embedded (the post-pass).
- [ ] **Cross-world isolation, live:** seed a second world; assert `searchLore(worldA)` never returns a worldB row (the tested invariant, confirmed against real data).
- [ ] Fix what the smoke finds (it WILL find something — a Voyage request-shape mismatch, a `::vector` cast issue, a dim-assert misfire, the iterative_scan SET, a prompt/read drift), re-run. Per `feedback_prompt_schema_co_evolution`, watch for read-vs-write content drift (the entity embedding text must be the same `name || prose_kernel.content` shape at write AND the read's world scope).
- [ ] **Wiki LAST** (feedback_wiki_sync_comes_after_dev_tool_and_test_fixes): dispatch the AUTHORING.md wiki subagent (parameterized MYT-71) AFTER any smoke-found fixes. `wiki:build/check` need `DATABASE_URL` sourced (feedback_wiki_accept_drift_is_not_the_first_question — read each drifted page's narrative before accept-drift).
- [ ] Single `git push` (the pre-push gate runs full coverage/lint/typecheck/test ~5+ min — batch all commits, push once: feedback_pushes_are_expensive). `world/retrieval/**` + `repo/**` + `scripts/**` are NOT dev-tool/contract-route triggers, so `dev-tool:verify` does not require a live backend for this push.
- [ ] **TF follow-up (NOT in this push's deploy):** the `VOYAGE_API_KEY` secret + task-def change needs a green `gh workflow run Deploy` to roll the new revision, and the staging Secrets Manager `voyage-api-key` value must be populated out-of-band (`aws secretsmanager put-secret-value`) BEFORE that deploy or staging 401s on first embed (`reference_tf_ci_taskdef_split` + `feedback_required_env_three_surfaces`). Surface this as the explicit post-merge runbook line — it's a human/ops action, not silently assumed done.
- [ ] Flip MYT-71 → Done in Linear (feedback_push_and_close — standing auth).

---

## Self-review notes (run before handing to beads)

- **Spec coverage:** §1 over-pull-no-tier-filter → enforced in T6 (no `access_level` predicate in any SQL) + T7/T8 (no filter in orchestration) + asserted in T6/T7 tests (all three tiers). §2 v1 scope (pgvector + graph; spatial/text-to-SQL deferred) → T6/T7/T8 only; no spatial, no escape-hatch code. §3 migration 026 → T2 (+ T1 image precondition). §4.1 Voyage wrapper → T3 (+ T4 config). §4.2 what gets embedded (facts.content; entities name+prose_kernel, exclude pc) → T6 reads + T9 embedWorld. §4.3 backfill + world-gen post-pass + character-integration post-pass → T9 (embedWorld + backfill) + T10 (total stage) + T11 (integration post-pass). §4.4 the secret (both task-defs, full TF) → T5. §5 pgvector substrate (searchLore facts∪entities total; findSimilarEntities canon-only throws) → T7 (+ T6 SQL). §6 graph substrate (recursive CTE, both-direction, cycle-safe, DISTINCT ON, truncated flag) → T8 (+ T6 CTEs). §7 interface/file layout → the file map (T3/T4/T6/T7/T8/T9). §8 error handling (searchLore total, findSimilarEntities throws, graph propagates) → T7/T8 + tests. §9 config → T4. §10 infra precondition (image swap, fresh-DB verify, iterative_scan) → T1 + T2 + T6/T7. §11 testing (hand-injected vectors, mocked-fetch wrapper, gated real-Voyage smoke, cross-world isolation) → T6/T3/T13. §12 file map → all tasks. §13 resolved decisions + §15 review corrections → folded throughout (AccessLevel import T4/T6, facts-no-world_id join T6, pc exclusion T6/T7, voyage-4-lite@512 T4, searchLore ranks entities T6/T7, findSimilarEntities throws T7, total stage costUsd:0 T10, Voyage-outside-tx T9, character-integration embed T11, both task-defs + full TF T5, image swap T1).
- **Type-consistency chain:** `VoyageEmbedder` (T3) consumed by T7 (`embedQuery`) + T9/T10/T11 (`embedDocuments`). The §9 config constants (T4) consumed by T3 (timeouts/batch/dim) + T6/T7 (limits/iterative_scan) + T8 (depths). `AccessLevel`/`NarrativeStatus`/`EntityType` (repo/facts.ts, repo/entities.ts) → `LoreHit`/`EntityCandidate`/`KnownCharacter`/`FactionNode` (T4 types) → returned by T7/T8. `world-retrieval` binder methods (T6) consumed by T7 (search reads), T8 (graph reads), T9 (`updateEmbedding` + the list-to-embed reads). `embedWorld` (T9) consumed by T10 (stage) + T11 (integration). `env.voyageApiKey` (T5) consumed by T9 backfill + T10/T11 boot wiring. **Known judgment point:** `EntityType` does NOT include `'pc'` at the TS level (016 widened only the DB CHECK) — the graph result types need a local `GraphEntityType = EntityType | 'pc'`; do NOT widen `repo/entities.ts` (Spec ambiguity #2). typecheck is the authority on every SDK/pg shape.
- **Wave non-overlap verified:** Wave A files {docker-compose.yml + deploy.yml (T1), 026.sql (T2), embed.ts (T3), config.ts + types.ts (T4), env.ts + setup-env.ts + .env files + 3 TF files (T5)} are pairwise disjoint. Wave B (T6: world-retrieval.ts + entities.ts + facts.ts) is solo. Wave C files {search.ts (T7), graph.ts (T8), embed-write.ts + index.ts + backfill + package.json (T9)} are pairwise disjoint. Wave D files {embed-world.ts + world-gen-processor.ts + streaming-extractor.ts + ai.ts (T10), character-integration-processor.ts (T11)} are disjoint. **One cross-wave note:** T9 needs two list-to-embed reads on the T6 binder — they're pinned into T6's surface (the file-ownership row for T6 owns `world-retrieval.ts`, so the reads land there in Wave B; T9 only consumes them). No two tasks write the same file.

## Spec ambiguities / contradictions found while drafting (NOT silently resolved — listed per the dispatch instruction)

1. **The `embed_world` stage and the SSE phase / wire-event surface (§4.3 vs the processor's event model).** Every existing `WORLD_GEN_STAGES` entry publishes `stage-started` / `stage-completed` Redis events (the loop does this around every stage, including the embed stage — so the embed stage WILL emit `stage-started`/`stage-completed` for `'embed_world'`). But `sse/derive-phase.ts` maps stage names → user-facing phases, and the embed stage is internal plumbing (not a content phase the user should see narrated). The spec says the stage emits a structured SUMMARY LOG (not a phase), and is silent on whether `derive-phase.ts` needs an `'embed_world'` arm or whether the existing default handles an unmapped stage gracefully. **I did NOT add a `derive-phase.ts` edit** (the spec's §12 file map omits it, and the stage's signal is the summary log, not a phase). **Flagging:** the implementer must confirm `derive-phase.ts` tolerates an unmapped `'embed_world'` stage-completed event (most likely it does — it maps known stages and ignores others) — if it throws/mis-renders on an unknown stage, that's a one-line additive arm. Worth a check during T10, not a silent assumption.

2. **`EntityType` (TS) excludes `'pc'` but the graph paths include PCs (§3 vs §6).** Migration 016 widened the DB `entity_type` CHECK to include `'pc'`, but `repo/entities.ts`'s `EntityType = 'npc'|'location'|'faction'|'item'` was NOT widened (PCs are inserted via `insertPc` which bakes the literal, bypassing the type). `charactersKnownTo`/`factionTree` INCLUDE PCs and read `entity_type` from the graph rows, so their result types (`KnownCharacter.entityType`, `FactionNode.entityType`) can carry `'pc'` at runtime — which won't typecheck against the narrow `EntityType`. I pinned a LOCAL `GraphEntityType = EntityType | 'pc'` for the graph result types (T4/T8) rather than widening `repo/entities.ts`'s `EntityType` (which would ripple into the insert/validation paths that intentionally exclude `pc`). **Flagging** because the spec types `KnownCharacter`/`FactionNode` with `entityType` but doesn't name the type — and `searchLore`/`findSimilarEntities` (which EXCLUDE pc) keep the narrow `EntityType`, so the codebase ends with two entity-type widths. That's correct (the exclusion is meaningful) but worth an explicit confirmation that a local widened alias is the intended shape, not a `repo/entities.ts` change.

3. **`factionTree` return shape: `FactionNode[]` + a `truncated` flag (§6).** §6 types `factionTree(entityId) → FactionNode[]` AND says "a subtree deeper than `GRAPH_MAX_DEPTH` returns a partial result with a `truncated: true` flag." A bare `FactionNode[]` has nowhere to carry a set-level `truncated` flag without a sentinel node (ugly) or putting `truncated` on every node (misleading — it's a property of the result, not a node). I pinned `factionTree → { nodes: FactionNode[]; truncated: boolean }`. **Flagging** as a minor signature divergence from the literal `→ FactionNode[]` — both satisfy the requirement; `{ nodes, truncated }` is the clean carrier. If the reviewer prefers the flag on `FactionNode` (per-node `truncated`, true only on the deepest retained nodes), that's a taste call — but it's less clean. Not silently resolved.

4. **Voyage Authorization header + free-tier claim not re-confirmed from the live docs page.** The spec pins `Authorization: Bearer $VOYAGE_API_KEY` and a "200M free tokens/acct" claim (§4.1). The WebFetch of `docs.voyageai.com/reference/embeddings-api` confirmed the request/response BODY shape, the model list (voyage-4-lite present), the 1024-default / 512-supported dims, the 1000-input cap, and the 1M-token per-request limit — but the fetched excerpt did NOT surface the Authorization header form or the free-tier token allowance (those live on a different docs page — authentication / pricing). The `Bearer` form is the Voyage standard and almost certainly correct, and the free-tier figure is not load-bearing for correctness. **Flagging** per `feedback_runbooks_must_be_executed`: the implementer MUST re-confirm the `Bearer` header (Voyage authentication docs) AND the live `voyage-4-lite` model id at implementation time, and the Voyage-key PREFIX for `validateVoyageApiKey` (T5) — I did not hardcode the `pa-` prefix-assert without confirmation (a wrong prefix-assert rejects a valid key). The smoke (T13) is the backstop that catches any of these against the real API before ship.

5. **Where the `SET LOCAL hnsw.iterative_scan` lives (the binder vs the orchestration tx).** §3 says the resolver "sets `hnsw.iterative_scan = 'relaxed_order'` (`SET LOCAL` in the query tx)." The repo binder takes a `ClientLike` and holds canonical SQL; whether the `SET LOCAL` is issued by the binder method itself (each method opens its own tx + SET) or by the orchestration layer (`search.ts`/`graph.ts` wrap the binder call in a read tx that SETs first) is not pinned. I pinned the orchestration layer (a `withVectorScan(client, fn)` helper) so the binder stays a pure SQL surface and the SET is issued ONCE per logical query — but flagging because if pgvector < 0.8 (Task 1's check), the fallback is `SET LOCAL enable_indexscan = off` (exact scan), and that branch needs a config flag the orchestration reads. Low-risk, but the SET-placement seam is a real decision the spec leaves open; T6's binder doc-comment must name the chosen home so T7/T8 build against it consistently.
