# MYT-71 — World-Store Retrieval Substrates & Curated Query Tools (Design)

> **Linear:** MYT-71 · **Milestone:** Session Runtime + Combat L1
> **Spec refs:** Multiplayer Session Runtime §17.4–§17.7 (world-knowledge lookups, channels, the resolver mechanism, write-authority)
> **Builds on:** the shipped world schema (entities/facts/relationships/entity_hierarchy/prose_kernels, migrations 001 + 014 + 016), the repo layer, the world-gen pipeline (`WORLD_GEN_STAGES`), the `llm/` abstraction.
> **Brainstormed:** 2026-06-14 with Miklos. All §13 decisions are his calls at the design gate. §15 records blind-review round 1 (Great libraries — 0 showstoppers; ~25 grounded corrections folded).

## 1. Goal & posture

Make the world store queryable for the lookup resolver. MYT-71 builds a **resolver library** — typed, deterministic query functions over the world store — plus the embedding write-path that makes semantic search possible. It is the foundation of the world-knowledge spine: MYT-72 wraps these functions as the `world_fact_lookup` tool family (FT routing + the ST gate); MYT-73's Scribe reuses them at write time for entity resolution (match-vs-mint).

**MYT-71 wires nothing into the FT tool registry or the ST gate.** The deliverable is callable functions returning typed rows, consumed by later issues. The MYT-71/72 cut: routing (which tool + args) is the FT's reasoning, built in MYT-72; *execution* (deterministic parameterized SQL that cannot hallucinate a column — §17.6's TAG / constraint-injection) is MYT-71.

**Load-bearing posture — the resolver over-pulls freely, secrets included (§17.4).** There is **no `access_level` predicate** anywhere in this layer: `searchLore` returns `known`, `discoverable`, *and* `secret` rows ranked purely by relevance. The safety boundary is the ST gate downstream (MYT-72), which is *allowed* secrets — "the resolver may over-pull freely… it must find what is *relevant*, not what is *safe*." Building any tier filter here is the wrong boundary and a bug. (Note the live tier vocabulary is `known | discoverable | secret`, renamed from `public/private/secret` in migration 014 — see §3.)

**Done when (Linear):** each substrate answers its query type deterministically, queries span all tiers, and (deferred — see §2) the escape hatch is sandboxed.

## 2. v1 scope & deferrals

**In v1 — the two data-ready, high-value substrates:**
1. **pgvector** — semantic search over **facts and entities** ("what's known about the gods"; entity match-vs-mint for the Scribe). The only true vector-RAG component.
2. **Graph traversal** — recursive-CTE relationship/hierarchy walks ("does X know anyone named Y", faction trees).

Both run on data that exists today (`facts`, `relationships`, `entity_hierarchy` are populated by world-gen) and are exactly what MYT-72's lookup flow and MYT-73's Scribe need.

**Deferred:**
- **Spatial substrate → MYT-78** ("World geography…"). Not a query-function gap: a fictional world has no coordinate data and the prep pipeline produces none, so "settlements near here" needs a geography-*representation + generation* design that reaches into world-gen. Its own brainstorm → spec → plan cycle. Depends on this issue; not a blocker for MYT-72/73/74.
- **Text-to-SQL escape hatch → CUT** (no bead). Curated tools have the LLM *route* to engineer-authored, frozen, tested queries (it can't touch table/join/predicate); text-to-SQL has the LLM *author* the query body, which is why it carries the entire read-only-role / timeout / row-cap / restricted-view sandbox and why its join/filter accuracy is too low for correctness-sensitive work. pgvector covers fuzzy/semantic; curated tools cover anticipated structured queries; the right response to an *unanticipated* structured query is "write the N+1th curated tool," not open arbitrary SQL. Reintroduce only if a concrete, recurring query appears the curated set genuinely cannot absorb.

## 3. Schema — migration 026

```sql
-- pgvector. RDS Postgres 16 supports it as an extension (no shared_preload).
-- PRIVILEGE: the migrate role already holds rds_superuser — migration 001 runs
-- `CREATE EXTENSION pgcrypto` through it on RDS, so the privilege chain for
-- `CREATE EXTENSION vector` is proven (bootstrap-databases.sh grants it). §10.
-- PRECONDITION (§10): local docker + CI Postgres must run a pgvector-capable
-- image; stock postgres:16-alpine does NOT bundle this extension (it DOES bundle
-- pgcrypto, so 001 passing is no evidence vector is available).
CREATE EXTENSION IF NOT EXISTS vector;

-- Embeddings live on the rows they describe. Nullable — backfillable; a NULL
-- embedding row is simply unsearchable until (re-)embedded, never a crash (§4.3).
-- `embedded_at` lets the backfill find rows whose content changed after embedding
-- (drift detection), not only NULL rows (§4.3).
ALTER TABLE facts    ADD COLUMN embedding vector(512), ADD COLUMN embedded_at TIMESTAMPTZ;
ALTER TABLE entities ADD COLUMN embedding vector(512), ADD COLUMN embedded_at TIMESTAMPTZ;

-- HNSW (not IVFFlat): higher recall, no training step, correct for the
-- INCREMENTAL inserts the Scribe does at session end (IVFFlat needs a populated
-- table to train its lists). Cosine ops. NULL embeddings are not indexed.
CREATE INDEX idx_facts_embedding    ON facts    USING hnsw (embedding vector_cosine_ops);
CREATE INDEX idx_entities_embedding ON entities USING hnsw (embedding vector_cosine_ops);
```

**Live-schema facts the resolver must honor (migration drift since 001 — see `reference_world_schema_drift_since_001`):**
- **`facts.access_level` / `entities.access_level` = `known | discoverable | secret`** (renamed in 014). `LoreHit.accessLevel` (§5) is typed as the existing `AccessLevel` from `repo/facts.ts` — never a re-declared `public/private` union.
- **`facts` has NO `world_id`.** World scope is `facts → entities → entities.world_id` (§5). `relationships`/`entity_hierarchy` likewise inherit world scope from same-world endpoints.
- **`entities.entity_type` includes `'pc'`** (added 016) — the `pc` exclusion in §4.2/§5 is therefore meaningful, not dead code.

**Filtered-ANN posture (load-bearing).** Every `searchLore` runs `… WHERE e.world_id = $1` (§5), and the HNSW index is global. pgvector applies the world filter as a *post-filter* on the ANN candidate set (`hnsw.ef_search`), so as worlds accumulate a `LIMIT k` search can under-return in-world rows. **Decision:** per-world corpora are small (hundreds–low-thousands of rows, §4.1), so the resolver sets `hnsw.iterative_scan = 'relaxed_order'` (`SET LOCAL` in the query tx; requires pgvector ≥ 0.8 — verify the image ships it) so the world filter doesn't starve results, and the §11 test asserts **in-world** recall (a fixture with rows in two worlds; `searchLore(worldA)` never returns a worldB row and returns the full in-world top-k). If the image predates 0.8, fall back to an exact scan (the index is forward-looking at this corpus scale). `EMBED_DIM` must equal the model's actual output dim (asserted at write time, §4.1) and the `vector(N)` column width.

The `512` dimension is **migration-baked** (column type + index). It is independent of the model *id*: any 512-dim model is a swap-and-re-embed with no migration (§4.1).

## 4. Embeddings — the Voyage write-path

### 4.1 Provider & model
**Voyage AI** — Anthropic's recommended embeddings partner — via a **thin first-party wrapper** (`backend/src/llm/embed.ts`), a plain `fetch` to Voyage's REST `/v1/embeddings` through our own abstraction. No third-party embedding SDK. Model **`voyage-3.5-lite` at 512-dim** (the current lite model; `voyage-3-lite` is superseded — "strictly better in all aspects" per Voyage's own docs; verify the current lite model at implementation time per the runbooks-must-be-executed rule). A config constant, never hardcoded at call sites.

**Two independent knobs (the escape hatch, stated correctly):** (a) **model swap at fixed 512-dim** — pure re-embed, no migration (the modern lite models are Matryoshka, so 512 is a native output dim); (b) **dimension change** — a column + HNSW migration. Don't conflate them. The wrapper asserts the returned vector length === `EMBED_DIM` and fails loud on mismatch.

**Asymmetric input types (retrieval quality):** stored rows embed with `input_type: "document"`; query strings with `input_type: "query"`. The wrapper exposes:
- `embedDocuments(texts: string[]): Promise<number[][]>` — **batched by BOTH an input-count cap and a token-estimate cap** (Voyage's real per-request limit is tokens, not the 1,000-input cap; a `char/4` estimate is fine — mechanical). Used by the write-path.
- `embedQuery(text: string): Promise<number[]>` — single, used by `searchLore`/`findSimilarEntities`.

**Timeouts are split by path:** `VOYAGE_DOC_TIMEOUT_MS` (generous — the write-path is offline/async-tolerant) vs `VOYAGE_QUERY_TIMEOUT_MS` (tight — `embedQuery` runs on MYT-72's turn path; a long stall before the FT's blank-narrate is a broken turn). A bounded **retry with backoff on 429** (write *and* query share one `VOYAGE_API_KEY`, so the write-burst at world-gen and the query-burst at turn time contend; the wrapper must backoff, not hammer).

### 4.2 What gets embedded
- **Facts** — `content`. (All facts; `access_level` is irrelevant to embedding — over-pull is downstream.)
- **Entities** — `name` + the entity's `prose_kernel.content` (LEFT JOIN; entities without a kernel embed name alone). **Scope to world-lore types** (`npc`, `location`, `faction`, `item`); **exclude `pc`** (a valid `entity_type` since migration 016) — player characters are not world lore and must not surface in `searchLore`/`findSimilarEntities`.

### 4.3 Generation: backfill + world-gen post-pass + character-integration post-pass
- **Write functions** (`backend/src/world/retrieval/embed-write.ts`): `embedWorld(worldId)` — read NULL/stale-embedding content via the repo, `embedDocuments` in batches, write the `embedding` + `embedded_at` columns via new repo `updateEmbedding` methods on `entities`/`facts`. **The Voyage call runs OUTSIDE any transaction** (the MYT-55 idle-in-tx lesson — `reference_transaction_scope_just_writes`): embed a batch (no tx), then write that batch's embeddings (a short write-only tx or per-row `UPDATE`). Never hold a PG connection idle across the Voyage round-trip.
- **World-gen post-pass — a TOTAL terminal stage** appended to `WORLD_GEN_STAGES` (`world-gen-processor.ts`), running **after `coherence_pass`** (the last content stage) and before `worlds.status → 'complete'`. The stage-loop contract is "any thrown error → `handleStageError` → world `failed`," so the embed stage **catches all Voyage/embed errors internally, logs, leaves the rows NULL, and ALWAYS returns a successful `StageDispatchResult` with `costUsd: 0, inputTokens: 0, outputTokens: 0`** — Voyage spend is deliberately *not* on the Anthropic cost cap (it's ~sub-cent per world; §4.4). It must be added to `ai.ts`'s `VALID_STAGES`/`WorldGenStage` union and the diagnostic enums (it routes no `ai.ts` LLM call, but the lists are lockstep). On completion it emits a structured summary log `{ worldId, embedded, leftNull, voyageErrors }` (the §I2 detection signal — a `complete` world with `leftNull > 0` is silently unsearchable otherwise).
- **Character-integration post-pass.** `character-integration` is a *separate processor* that runs after world-gen and **inserts new facts on existing world NPCs** (PC-backstory canon). Those would ship NULL-embedded, so the same `embedWorld`-style embed step (NULL rows only) runs as the terminal step of the character-integration processor too — otherwise "searchable on completion" is false for any world that went through character creation.
- **Backfill command** (`scripts/world-embed-backfill.ts`, `pnpm world:embed-backfill [--world <id> | --all] [--force]`): embeds NULL-embedding (and, with `--force`, all) rows — runs as the app DB role (UPDATE), idempotent on NULL selection. `--all --force` is a deliberate full re-embed (a real Voyage rate/spend event — documented as such).

### 4.4 The new secret
`VOYAGE_API_KEY` is a new required secret. **`loadEnv()` is the boot gate for *every* process** (API and worker both call it), so a required-and-missing field crashloops *both*. Decision: add it to the shared `common_secrets` list so it's present on **both** task-defs and required in `loadEnv` (the API needs it *to boot*, even though only the worker tier *uses* it — correcting the earlier "API doesn't need it" framing). Surfaces, in lockstep (the env-three-surfaces rule), are larger than three:
1. `config/env.ts` — the loadEnv schema + a `validateVoyageApiKey` (mirroring the Anthropic/Stripe validators).
2. the test/CI setup-env script + `backend/.env.development` **and `.env.development.example`** (a new required key breaks fresh clones otherwise).
3. `infra/environments/staging/main.tf` `manual_secret_names` (declare the Secrets Manager secret — it's NOT in the current 3-key list) **+ populate its value out-of-band** (the version is a `PLACEHOLDER` with `ignore_changes`; a placeholder boots but 401s on first embed), `infra/modules/serving/main.tf` `common_secrets`, **and `infra/modules/serving/variables.tf`'s expected-keys validation** (it hard-asserts the secret set and fails `terraform plan` otherwise).
Then a green Deploy (`gh workflow run Deploy`, never a force-rollover) rolls the new task-def revision.

## 5. The pgvector substrate

Functions in `backend/src/world/retrieval/search.ts`, parameterized SQL in `repo/world-retrieval.ts`, all **over-pulling across all tiers** (no `access_level` predicate):

- **`searchLore(worldId, queryText, { limit })` → `LoreHit[]`** — the FT lore-lookup path (MYT-72). Embeds the query (`embedQuery`), cosine-ranks **facts ∪ entities** for the world — facts via `JOIN facts f JOIN entities e ON e.id = f.entity_id WHERE e.world_id = $1 AND f.embedding IS NOT NULL`, entities via `entities WHERE world_id = $1 AND entity_type <> 'pc' AND embedding IS NOT NULL` — merged and re-ranked by score. Ranking **entities too** is load-bearing: the §17.4 exemplar "what's known about the gods" is best served by an entity's `prose_kernel`, which lives only in the entity embedding, not in any fact row. Returns `{ source: 'fact' | 'entity', factId?, entityId, entityName, topic?, content, accessLevel, narrativeStatus?, score }` ordered by score; `limit` defaults to `SEARCH_LORE_DEFAULT_LIMIT`, capped `SEARCH_LORE_MAX_LIMIT`. **`searchLore` is TOTAL** — an embed/infra failure returns `[]` + `logger.warn` (a lookup miss MYT-72 narrates as a blank, §17.4 — never a throw on the turn path). **World-scoping is a tested invariant** (§11): a fact/entity in world B never appears in `searchLore(worldA, …)`.
- **`findSimilarEntities(worldId, text, { limit, entityType? })` → `EntityCandidate[]`** — the Scribe match-vs-mint path (MYT-73). Embeds `text`, cosine-ranks `entities` (world-scoped, `entity_type <> 'pc'`, optional `entityType` filter), returns `{ entityId, name, entityType, score }`. **Canon-only** — it ranks committed `entities`; intra-session working-set resolution is MYT-73's concern (§17.7: working-set resolution is "small-scope and cheap," string-match, not pgvector). **NOT total on the write path:** an embed failure **throws** (this runs at session end, off the latency budget) — returning `[]` would be indistinguishable from "no similar entity" and would silently **mint duplicate canon** on a transient Voyage blip. The asymmetry vs `searchLore` is deliberate: a turn-path read degrades gracefully; a canon write must not corrupt on a blip.

**Score = `1 - cosine_distance`, range `[-1, 1]`** (1 = identical, 0 = orthogonal). The value's *calibration* is model-specific, so MYT-73's match-vs-mint **threshold is a config constant calibrated against the production model**, re-tuned on any model/dim change — that threshold lives in MYT-73, not here (§14).

## 6. The graph substrate — recursive CTE, not ltree

**Decision (§13.3):** one recursive-CTE traversal over the existing edge tables handles both the general social graph (`relationships`) and the strict containment tree (`entity_hierarchy`), no new extension, no materialized-path column. Functions in `backend/src/world/retrieval/graph.ts`, parameterized SQL in `repo/world-retrieval.ts`, **over-pulling across tiers** (no `access_level`/`encountered` filter). World scope is inherited from edges connecting same-world entities (a stated invariant).

- **`charactersKnownTo(entityId, { nameFilter?, maxDepth? })` → `KnownCharacter[]`** — "does X know anyone named Y." Recursive walk over `relationships` from `entityId`, **traversing edges in both directions** (a deliberate v1 simplification — every `relationship_type` is treated as an undirected connection; type-aware directionality is the §13.4 later refinement). Bounded by `maxDepth` (`GRAPH_DEFAULT_DEPTH`, capped `GRAPH_MAX_DEPTH`); **cycle-safe** via a `path` array (`WHERE NOT next = ANY(path)`); **`DISTINCT ON (entityId)` keeping the minimum depth** so the result is a *set* of reachable characters (one row each), not a multiset of paths (the diamond graph A→B,A→C,B→D,C→D returns D once). `nameFilter` is a normalized post-filter (trim + case-fold — mechanical, not fuzzy). PCs **are** included (PCs are real graph members; the resolver over-pulls — MYT-72's tool wrapping is where any player-facing filtering lands).
- **`factionTree(entityId)` → `FactionNode[]`** — the containment subtree rooted at a faction/location entity. Recursive walk over `entity_hierarchy` (parent→child; `child_entity_id UNIQUE` → a strict tree, no cycle risk). Returns `{ entityId, name, entityType, parentId, depth }`. A subtree deeper than `GRAPH_MAX_DEPTH` returns a partial result with a `truncated: true` flag rather than silently dropping nodes.

The graph functions return entity/edge structure only; fact *content* comes from `searchLore`. Clean separation: graph = "who/what is connected"; vector = "what is known."

## 7. The resolver library interface

```
backend/src/world/retrieval/
  search.ts        # searchLore, findSimilarEntities (pgvector orchestration)
  graph.ts         # charactersKnownTo, factionTree (recursive-CTE orchestration)
  embed-write.ts   # embedWorld + the backfill helper (write-path, tx-scoped per §4.3)
  types.ts         # LoreHit, EntityCandidate, KnownCharacter, FactionNode
  config.ts        # the §9 constants
  index.ts         # the resolver surface MYT-72/73 import
backend/src/llm/embed.ts          # the Voyage wrapper (embedDocuments/embedQuery)
backend/src/repo/world-retrieval.ts  # the parameterized vector + recursive-CTE SQL
```

DB access stays in the repo layer: the heavy SQL (cosine rank + the world join, recursive CTEs) lives in `world-retrieval`; `entities.ts`/`facts.ts` gain `updateEmbedding`. The `world/retrieval/` functions are orchestration — embed (via `llm/embed.ts`, outside any tx) → repo query → shape typed results. MYT-72 imports `index.ts` and wraps each function as a `world_fact_lookup` tool; MYT-73 imports `findSimilarEntities` + `embedWorld`.

## 8. Error handling & determinism

- **`searchLore` is total** (embed/infra failure → `[]` + warn — the FT narrates a blank). **`findSimilarEntities` throws on embed failure** (a canon write path — failure must be distinguishable from no-match). **Graph functions propagate DB errors** (no LLM, no degradation contract). **This asymmetry is intentional and flagged for MYT-72** (which wraps `charactersKnownTo` as a turn-path tool and must catch its throws in its own tool-error handling rather than assume uniform totality).
- **Determinism.** Given fixed embeddings, every function is deterministic SQL — same inputs, same ordered rows. The only non-determinism is the Voyage embedding, isolated to the wrapper and mockable at the `fetch` boundary.
- **Write-path isolation.** Embedding generation never blocks or fails world-gen / character-integration (§4.3 total stage); the backfill is idempotent.

## 9. Config (`world/retrieval/config.ts`)

| Constant | Value | Why |
|---|---|---|
| `VOYAGE_EMBED_MODEL` | `'voyage-3.5-lite'` | current lite model; never hardcoded at call sites; verify-at-build |
| `EMBED_DIM` | `512` | must equal the `vector(N)` column AND the model's output dim (asserted at write) |
| `VOYAGE_INPUT_TYPE_DOC` / `_QUERY` | `'document'` / `'query'` | asymmetric retrieval |
| `VOYAGE_BATCH_MAX_INPUTS` / `_MAX_TOKENS` | `1000` / model token cap | batch by the binding (token) limit, not a fixed count |
| `VOYAGE_DOC_TIMEOUT_MS` / `_QUERY_TIMEOUT_MS` | generous / tight | write-path vs turn-path |
| `HNSW_EF_SEARCH` / `ITERATIVE_SCAN` | tuned / `'relaxed_order'` | filtered-ANN recall (§3) |
| `SEARCH_LORE_DEFAULT_LIMIT` / `_MAX` | `10` / `50` | result bounds |
| `GRAPH_DEFAULT_DEPTH` / `_MAX` | `2` / `5` | traversal bounds (cost + cycle guard) |

(The match-vs-mint **score threshold** is NOT here — it's MYT-73's model-calibrated constant, §5/§14.)

## 10. Infra & precondition (the pgvector image)

`CREATE EXTENSION vector` requires a pgvector-capable Postgres everywhere the migration runs:
- **Local docker** (`docker-compose.yml`): swap `postgres:16-alpine` → `pgvector/pgvector:pg16` (Debian-based; the `postgres-init/` mounts and the `mythrun_test` bootstrap are unaffected). Worktree DBs inherit it. Note: `pgcrypto` ships in alpine's contrib, so migration 001 passing today is *no* evidence `vector` is available — they're different bundles.
- **CI**: the deploy.yml build job's Postgres service must use the same pgvector image, or migration 026 fails on a **freshly-created** CI DB (verify on a fresh container — a warm local dev DB that already has the extension masks it; the warm-vs-fresh trap).
- **RDS (staging/prod)**: pgvector is in the RDS Postgres 16 supported-extensions list; the migrate role holds `rds_superuser` (proven — 001 runs `CREATE EXTENSION pgcrypto` through it), so `CREATE EXTENSION vector` is authorized with no parameter-group change. Confirm against the live RDS as a precondition (`SELECT * FROM pg_available_extensions WHERE name='vector'`).

## 11. Testing

- **Resolver SQL (real PG, scoped fixtures, no Voyage):** seed entities/facts with **hand-injected deterministic `vector(512)` literals** in the `'[f1,…,f512]'::vector` text form, generated programmatically (unit-ish vectors along chosen axes — not hand-authored) so cosine ordering is exactly predictable; with `iterative_scan`/exact scan so the ordering is index-independent. Assert `searchLore`/`findSimilarEntities` rank order, the `facts ∪ entities` merge, the `pc` exclusion, over-pull across **all three tiers** (`known/discoverable/secret` fixtures), the `limit` cap, and **cross-world isolation** (a world-B row never surfaces in a `searchLore(worldA)`). Graph: seed a relationship graph + hierarchy; assert `charactersKnownTo` depth-bounding, both-direction traversal, cycle-safety (a deliberate cycle), the **diamond-graph dedup** (`DISTINCT ON entityId`), `nameFilter`, and `factionTree` subtree shape + the `truncated` flag — all over-pulling across tiers.
- **Voyage wrapper (`embed.ts`):** mock the `fetch` boundary; assert request shape (model, `input_type` doc-vs-query, the dual count/token batch chunking, dim assertion on the response), the split timeouts, and the 429-backoff retry.
- **Orchestration:** mock `embedQuery` to a fixed vector + real-PG rows → assert end-to-end ranking, `searchLore`'s empty-on-embed-failure totality, and `findSimilarEntities` **throwing** on embed failure.
- **Write-path:** `embedWorld` batches + writes `embedding` + `embedded_at` (mocked embed) outside a tx; the world-gen embed stage is **total** (a Voyage throw leaves NULL rows, returns success, world reaches `complete`, summary log emitted); the character-integration post-pass embeds its new NULL rows; the backfill touches NULL (and `--force` all) rows.
- **Constructed smoke (real Voyage, gated on `VOYAGE_API_KEY`):** embed two real strings (one near the query, one far) with the **asymmetric** doc/query types → store → cosine-search → assert the near one ranks first. Proves the live API shape + dim + the document/query asymmetry + the round-trip — mocks can't catch a real API drift.
- 100% coverage gate; lint error rules (`no-non-null-assertion`, `no-deprecated`), `max-lines` 400 / `max-lines-per-function` 100.

## 12. File-level change map

| File | Change |
|---|---|
| `backend/migrations/026_world_retrieval.sql` | Create — extension, embedding + `embedded_at` columns, HNSW indexes (§3) |
| `backend/src/llm/embed.ts` | Create — the Voyage wrapper (§4.1) |
| `backend/src/world/retrieval/{search,graph,embed-write,types,config,index}.ts` | Create — the resolver library (§5–§9) |
| `backend/src/repo/world-retrieval.ts` | Create — vector (facts∪entities, world-joined) + recursive-CTE SQL (§7) |
| `backend/src/repo/entities.ts`, `repo/facts.ts` | `updateEmbedding` (embedding + `embedded_at`) (§7) |
| `backend/src/llm/prep/stages/embed-world.ts` (+ `world-gen-processor.ts`, `ai.ts` `VALID_STAGES`/`WorldGenStage`) | Create the TOTAL terminal embed stage; register it everywhere the stage lists are lockstep (§4.3) |
| `backend/src/llm/prep/character-integration-processor.ts` | Terminal embed post-pass for its new NULL rows (§4.3) |
| `backend/scripts/world-embed-backfill.ts` (+ `package.json` script) | Create — the backfill command (§4.3) |
| `backend/src/config/env.ts` | `VOYAGE_API_KEY` + `validateVoyageApiKey` (§4.4) |
| setup-env script · `backend/.env.development` · `backend/.env.development.example` | `VOYAGE_API_KEY` (§4.4) |
| `infra/environments/staging/main.tf` (`manual_secret_names` + value population) · `infra/modules/serving/main.tf` (`common_secrets`) · `infra/modules/serving/variables.tf` (expected-keys validation) | the secret across all TF surfaces (§4.4) |
| `docker-compose.yml` (+ CI deploy.yml PG service) | `postgres:16-alpine` → `pgvector/pgvector:pg16` (§10) |

## 13. Resolved decisions (design gate, 2026-06-14)

1. **v1 = pgvector + graph only.** Spatial → MYT-78; text-to-SQL → cut (no bead).
2. **Voyage AI** via a first-party REST wrapper; **`voyage-3.5-lite` / 512-dim** (verify-current-at-build), document/query asymmetric input types. Model id and dimension are independent knobs (model swap = re-embed only; dim = migration).
3. **Recursive CTE, not ltree**, for both graph and hierarchy.
4. **Graph v1 treats all relationship types as an undirected connection**; typed directionality is a later refinement.
5. **Embed write-path = backfill + a TOTAL world-gen terminal post-pass + a character-integration post-pass** (new worlds searchable on completion incl. PC-backstory facts); the Scribe reuses it at session end. The embed stage catches Voyage errors internally, reports `costUsd: 0` (Voyage spend off the Anthropic cap), and emits a NULL-embedding summary log. Voyage call outside any tx.
6. **Resolver over-pulls across ALL tiers — no `access_level` filter** (tier vocab is `known/discoverable/secret`). The ST gate (MYT-72) is the safety boundary.
7. **Entity embedding excludes `pc`**; graph traversal includes PCs (over-pull).
8. **`searchLore` ranks facts ∪ entities** (entity `prose_kernel` lore is load-bearing for "what's known about X"). **`findSimilarEntities` is canon-only and throws on embed failure** (no duplicate-mint on a blip).
9. **MYT-71 ships the resolver library only** — no FT-tool/ST-gate wiring (MYT-72), no Scribe write-reconciliation (MYT-73).
10. **`VOYAGE_API_KEY` is required and present on both task-defs** (loadEnv is the boot gate for every process); full TF + example-env surfaces.
11. **pgvector precondition**: local docker + CI + RDS; the docker image swap is part of this issue; filtered-ANN handled via `iterative_scan`/exact-scan at this corpus scale.

## 14. The MYT-71/72/73 boundary (for the reviewer)

- **MYT-71 (this):** the substrates + the resolver functions + the embedding write-path. No tool registry, no ST gate, no turn-path wiring. `findSimilarEntities` is **canon-only**; the match-vs-mint **threshold** is MYT-73's calibrated constant, not here.
- **MYT-72:** wraps `searchLore`/`charactersKnownTo`/… as the `world_fact_lookup` tool family; the FT routing; the skill-gate (DM channel = PC skill, NPC channel = NPC stats, §17.5); the ST gate that relays vetted knowledge back to the FT (the single safety boundary). Must catch graph-function throws (the §8 totality asymmetry).
- **MYT-73:** the Scribe reuses `findSimilarEntities` + `embedWorld` for match-vs-mint and the multi-substrate commit at session end (§17.7), resolving working-set ∪ canon (working-set resolution is its own concern).

## 15. Blind-review round 1 record (Great libraries, Opus)

Four reviewers — data-integrity/SQL (Alexandria), retrieval/embeddings (Pergamon), architecture/interface (Nalanda), ops/infra/cost (Timbuktu). Strict-rubric outcome: **0 showstoppers; ~25 grounded corrections folded; no second round.** Every reviewer affirmed the load-bearing architecture (over-pull-no-tier-filter boundary, the resolver-library cut, ZFC/TAG, HNSW-over-IVFFlat, the deferrals). The round's value was live-code grounding — the spec had drifted from migration 001:

- **Schema drift (×3 convergent):** `access_level` is `known/discoverable/secret` (014), `facts` has no `world_id` (scope via the entities join — else cross-world results), `entities.entity_type` includes `pc` (016). Folded into §1/§3/§5 + saved as `reference_world_schema_drift_since_001`.
- **Retrieval quality:** `voyage-3-lite` superseded by `voyage-3.5-lite` (same dim, strictly better; model/dim decoupled); `searchLore` must rank entities too (prose_kernel lore); batch by tokens not a 1000-cap; score range `[-1,1]`; split doc/query timeouts + 429 backoff.
- **Write-path/contract:** the embed stage must be a TOTAL stage (the `WORLD_GEN_STAGES` loop fails the world on any throw) reporting `costUsd:0`; Voyage call outside any tx (MYT-55); character-integration's later facts need embedding too; `findSimilarEntities` must throw (not `[]`) on embed failure or it mints duplicate canon.
- **Infra:** `VOYAGE_API_KEY` crashloops both API+worker via `loadEnv` ("API doesn't need it" was wrong → on both task-defs); the TF surfaces are more than three (env/staging `manual_secret_names` + value population, `variables.tf` validation, `.env.development.example`); NULL-embedding observability + launch rate-limit posture. The `CREATE EXTENSION` privilege concern was resolved in-round (the `pgcrypto` precedent proves `rds_superuser`).
