# MYT-71 — World-Store Retrieval Substrates & Curated Query Tools (Design)

> **Linear:** MYT-71 · **Milestone:** Session Runtime + Combat L1
> **Spec refs:** Multiplayer Session Runtime §17.4–§17.6 (world-knowledge lookups, channels, the resolver mechanism)
> **Builds on:** the shipped world schema (entities/facts/relationships/entity_hierarchy/prose_kernels, migration 001), the repo layer, the world-gen pipeline (`WORLD_GEN_STAGES`), the `llm/` abstraction.
> **Brainstormed:** 2026-06-14 with Miklos. All §12 decisions are his calls at the design gate. §13 records blind-review round 1.

## 1. Goal & posture

Make the world store queryable for the lookup resolver. MYT-71 builds a **resolver library** — typed, deterministic query functions over the world store — plus the embedding write-path that makes semantic search possible. It is the foundation of the world-knowledge spine: MYT-72 wraps these functions as the `world_fact_lookup` tool family (FT routing + the ST gate); MYT-73's Scribe reuses them at write time for entity resolution (match-vs-mint).

**MYT-71 wires nothing into the FT tool registry or the ST gate.** The deliverable is callable functions returning typed rows, consumed by later issues. The MYT-71/72 cut: routing (which tool + args) is the FT's reasoning, built in MYT-72; *execution* (deterministic parameterized SQL that cannot hallucinate a column — §17.6's TAG / constraint-injection) is MYT-71.

**Load-bearing posture — the resolver over-pulls freely, secrets included (§17.4).** No `access_level` filtering anywhere in this layer: `searchLore` returns public *and* secret facts ranked purely by relevance. The safety boundary is the ST gate downstream (MYT-72), which is *allowed* secrets — "the resolver may over-pull freely… it must find what is *relevant*, not what is *safe*." Building any tier filter here is the wrong boundary and a bug.

**Done when (Linear):** each substrate answers its query type deterministically, queries span all tiers, and (deferred — see §2) the escape hatch is sandboxed.

## 2. v1 scope & deferrals

**In v1 — the two data-ready, high-value substrates:**
1. **pgvector** — semantic search over facts and entities ("what's known about the gods"; entity match-vs-mint for the Scribe). The only true vector-RAG component.
2. **Graph traversal** — recursive-CTE relationship/hierarchy walks ("does X know anyone named Y", faction trees).

Both run on data that exists today (`facts`, `relationships`, `entity_hierarchy` are populated by world-gen) and are exactly what MYT-72's lookup flow and MYT-73's Scribe need.

**Deferred:**
- **Spatial substrate → MYT-78** ("World geography…"). Not a query-function gap: a fictional world has no coordinate data and the prep pipeline produces none, so "settlements near here" needs a geography-*representation + generation* design (Euclidean coords vs region-containment vs travel-graph) that reaches into world-gen. Its own brainstorm → spec → plan cycle. Depends on this issue; not a blocker for MYT-72/73/74.
- **Text-to-SQL escape hatch → CUT** (no bead). The conceptual distinction (§12.6): curated tools have the LLM *route* to engineer-authored, frozen, tested queries (it can't touch table/join/predicate); text-to-SQL has the LLM *author* the query body, which is why it carries the entire read-only-role / timeout / row-cap / restricted-view sandbox and why its join/filter accuracy is too low for correctness-sensitive work. pgvector covers fuzzy/semantic; curated tools cover anticipated structured queries; text-to-SQL would only serve *unanticipated structured* queries — and the right response to those is almost always "write the N+1th curated tool," not open arbitrary SQL. Reintroduce only if a concrete, recurring query appears that the curated set genuinely cannot absorb.

## 3. Schema — migration 026

```sql
-- pgvector. RDS Postgres 16 supports it as an extension (no shared_preload).
-- PRECONDITION (§10): local docker + CI Postgres must run a pgvector-capable
-- image; the stock postgres:16-alpine does NOT bundle the extension.
CREATE EXTENSION IF NOT EXISTS vector;

-- Embeddings live on the rows they describe (the spec: "embeddings on
-- entities/facts"). Nullable — backfillable; a NULL embedding row is simply
-- unsearchable until (re-)embedded, never a crash (§4 failure posture).
ALTER TABLE facts    ADD COLUMN embedding vector(512);
ALTER TABLE entities ADD COLUMN embedding vector(512);

-- HNSW (not IVFFlat): higher recall, no training step, and correct for the
-- INCREMENTAL inserts the Scribe will do at session end (IVFFlat needs a
-- populated table to train its lists). Cosine ops — Voyage vectors are
-- normalized; `<=>` is cosine distance. NULL embeddings are simply not indexed.
CREATE INDEX idx_facts_embedding    ON facts    USING hnsw (embedding vector_cosine_ops);
CREATE INDEX idx_entities_embedding ON entities USING hnsw (embedding vector_cosine_ops);
```

The `512` dimension is **migration-baked** (the column type + index). It pairs with the model choice in §4; changing it later is a re-embed migration, so it is a deliberate decision, not a config flip.

## 4. Embeddings — the Voyage write-path

### 4.1 Provider & model
**Voyage AI** — Anthropic's recommended embeddings partner — via a **thin first-party wrapper** (`backend/src/llm/embed.ts`), a plain `fetch` to Voyage's REST `/v1/embeddings` through our own abstraction. No third-party embedding SDK (keeps the single-abstraction-layer convention; sidesteps vetting a community AI-SDK provider). Model **`voyage-3-lite`, 512-dim** — ample for a single world's corpus (hundreds–low-thousands of rows); a config constant, never hardcoded at call sites. (Bumping to `voyage-3`/1024-dim for quality is a re-embed migration, recorded as a known knob.)

**Asymmetric input types (retrieval quality):** stored rows embed with `input_type: "document"`; query strings embed with `input_type: "query"`. The wrapper exposes:
- `embedDocuments(texts: string[]): Promise<number[][]>` — batched (Voyage accepts up to 128 inputs / request; `VOYAGE_BATCH_SIZE`), used by the write-path.
- `embedQuery(text: string): Promise<number[]>` — single, used by `searchLore`/`findSimilarEntities`.

Timeout (`VOYAGE_TIMEOUT_MS`) + a bounded retry; errors propagate to callers, which decide the failure posture (§4.3).

### 4.2 What gets embedded
- **Facts** — `content`. (All facts; access_level is irrelevant to embedding — over-pull is downstream.)
- **Entities** — `name` + the entity's `prose_kernel.content` (joined; entities without a kernel embed name alone). **Scope to world-lore types** (`npc`, `location`, `faction`, `item`); **exclude `pc`** — player characters are not world lore and must not surface in `searchLore`/`findSimilarEntities`.

### 4.3 Generation: backfill + world-gen post-pass
- **Write functions** (`backend/src/world/retrieval/embed-write.ts`): `embedEntities(worldId)` / `embedFacts(worldId)` (or a unified `embedWorld(worldId)`) — read content via the repo, `embedDocuments` in batches, write the `embedding` column via a new repo `updateEmbedding` method on `entities`/`facts`.
- **World-gen post-pass**: a new terminal stage appended to `WORLD_GEN_STAGES` (`world-gen-processor.ts`), running **after** entities/facts are final (after `coherence-pass`/`entity-consolidation`) and before `worlds.status → 'complete'`. So every newly generated world is searchable the moment it completes. The plan pins the exact slot.
- **Backfill command** (`scripts/world-embed-backfill.ts`, `pnpm world:embed-backfill [--world <id> | --all]`): embeds NULL-embedding rows — for existing dev worlds and any row a Voyage failure left NULL.
- **Failure posture**: a Voyage failure in the write-path is **non-fatal to world-gen** — log, leave the embedding NULL, move on (the world still completes; it is re-embeddable via backfill). A NULL-embedding row is unsearchable, never a crash. The Scribe reuses the same write functions at session end (MYT-73) under the same posture.

### 4.4 The new secret
`VOYAGE_API_KEY` is a new required secret. It must land on **all three surfaces in lockstep** (the env-three-surfaces rule): `config/env.ts` (loadEnv schema), the test/CI setup-env script, and `infra/modules/serving/main.tf` (the ECS task-def secret, sourced from Secrets Manager) — followed by a green Deploy to roll the new task-def revision. Plus local `backend/.env.development`. The world-gen worker and the backfill command are the consumers; the API server does not need it at launch (lookups run in the worker tier).

## 5. The pgvector substrate

Two functions (`backend/src/world/retrieval/search.ts`), both **over-pulling across all tiers**, both **total** (an embed failure → empty result + log, never a throw — MYT-72 runs these on the turn path):

- **`searchLore(worldId, queryText, { limit })` → `LoreHit[]`** — the FT lore-lookup path (MYT-72). Embeds the query (`embedQuery`), cosine-ranks `facts` (`embedding <=> $queryVec`, `WHERE embedding IS NOT NULL`), returns `{ factId, entityId, entityName, topic, content, accessLevel, narrativeStatus, score }` ordered by similarity. `limit` defaults to `SEARCH_LORE_DEFAULT_LIMIT`, capped at `SEARCH_LORE_MAX_LIMIT`.
- **`findSimilarEntities(worldId, text, { limit, entityType? })` → `EntityCandidate[]`** — the Scribe match-vs-mint path (MYT-73). Embeds `text`, cosine-ranks `entities` (excluding `pc`, optional `entityType` filter), returns `{ entityId, name, entityType, score }`. This is "match-vs-mint via name + pgvector similarity" (§17.7); MYT-73 thresholds the score to decide match-vs-create.

Score is `1 - cosine_distance` (higher = closer), surfaced so downstream consumers threshold/rank without re-deriving.

## 6. The graph substrate — recursive CTE, not ltree

**Decision (§12.3):** one recursive-CTE traversal over the existing edge tables handles both the general social graph (`relationships`) and the strict containment tree (`entity_hierarchy`), with no new extension and no materialized-path column to maintain. ltree would only help the strict hierarchy and adds a column to keep in sync on every relationship write — not worth it for one world's social graph.

Functions (`backend/src/world/retrieval/graph.ts`), parameterized SQL in a `repo/world-retrieval.ts` binder, **over-pulling across tiers** (no `encountered`/`access_level` filter):

- **`charactersKnownTo(entityId, { nameFilter?, maxDepth? })` → `KnownCharacter[]`** — "does X know anyone named Y." Recursive walk over `relationships` from `entityId`, **traversing edges in both directions** (a relationship implies mutual acquaintance regardless of the stored source→target direction), bounded by `maxDepth` (`GRAPH_DEFAULT_DEPTH`, capped `GRAPH_MAX_DEPTH`), **cycle-safe** (a `path` array in the CTE with `WHERE NOT next = ANY(path)`). Returns reachable entities `{ entityId, name, entityType, relationshipPath, depth }`, optionally filtered by normalized `nameFilter` (trim + case-fold, like the skill-check/rules-lawyer name match — mechanical, not fuzzy). v1 treats every relationship type as a connection; a typed filter is a later refinement (§12.4).
- **`factionTree(entityId)` → `FactionNode[]`** — the containment subtree rooted at a faction/location entity. Recursive walk over `entity_hierarchy` (parent→child; `child_entity_id` is UNIQUE → a strict tree, so no cycle risk, but the depth cap still applies as a guard). Returns `{ entityId, name, entityType, parentId, depth }`.

The graph functions return entity/edge structure only; fact *content* comes from `searchLore`. Clean separation: graph = "who/what is connected"; vector = "what is known."

## 7. The resolver library interface

```
backend/src/world/retrieval/
  search.ts        # searchLore, findSimilarEntities (pgvector orchestration)
  graph.ts         # charactersKnownTo, factionTree (recursive-CTE orchestration)
  embed-write.ts   # embedWorld + the backfill helper (write-path)
  types.ts         # LoreHit, EntityCandidate, KnownCharacter, FactionNode
  config.ts        # the §9 constants
  index.ts         # the resolver surface MYT-72/73 import
backend/src/llm/embed.ts          # the Voyage wrapper (embedDocuments/embedQuery)
backend/src/repo/world-retrieval.ts  # the parameterized vector + recursive-CTE SQL
```

DB access stays in the repo layer (CLAUDE.md): the heavy SQL (cosine rank, recursive CTEs) lives in the `world-retrieval` binder; `entities.ts`/`facts.ts` gain an `updateEmbedding` method. The `world/retrieval/` functions are orchestration — embed (via `llm/embed.ts`) → repo query → shape typed results. MYT-72 imports `index.ts` and wraps each function as a `world_fact_lookup` tool; MYT-73 imports `findSimilarEntities` + `embedWorld`.

## 8. Error handling & determinism

- **Total query functions.** `searchLore`/`findSimilarEntities` catch an embed/infra failure → return `[]` + `logger.warn` (a lookup miss the FT narrates as a blank, §17.4 — never a thrown error on MYT-72's turn path). Graph functions are pure SQL; a DB error propagates (no LLM, no graceful-degradation contract needed — the caller's tx/error handling applies).
- **Determinism.** Given fixed embeddings, every function is deterministic SQL — same inputs, same ordered rows. The only non-determinism is the Voyage embedding itself (a model call), isolated to the wrapper and mockable at the `fetch` boundary for tests.
- **Write-path isolation.** Embedding generation never blocks or fails world-gen (§4.3); the backfill is idempotent (only touches NULL rows, or `--force` re-embeds).

## 9. Config (`world/retrieval/config.ts`)

| Constant | Value | Why |
|---|---|---|
| `VOYAGE_EMBED_MODEL` | `'voyage-3-lite'` | model id, never hardcoded at call sites |
| `EMBED_DIM` | `512` | must equal the `vector(N)` column; migration-baked |
| `VOYAGE_INPUT_TYPE_DOC` / `_QUERY` | `'document'` / `'query'` | asymmetric retrieval |
| `VOYAGE_BATCH_SIZE` | `128` | Voyage's per-request input cap |
| `VOYAGE_TIMEOUT_MS` | `30_000` | write-path is offline/async-tolerant |
| `SEARCH_LORE_DEFAULT_LIMIT` / `_MAX` | `10` / `50` | result bounds |
| `GRAPH_DEFAULT_DEPTH` / `_MAX` | `2` / `5` | traversal bounds (cost + cycle guard) |

## 10. Infra & precondition (the pgvector image)

`CREATE EXTENSION vector` requires a pgvector-capable Postgres everywhere the migration runs:
- **Local docker** (`docker-compose.yml`): swap `postgres:16-alpine` → `pgvector/pgvector:pg16` (Debian-based; the `postgres-init/` mounts and the `mythrun_test` bootstrap are unaffected). Worktree DBs inherit it.
- **CI**: the deploy.yml build job's Postgres service must use the same pgvector image, or migration 026 fails on a fresh CI DB (the CI-provisions-every-infra-dep rule; this is exactly a "green local, red CI" trap — verify on a freshly-created DB).
- **RDS (staging/prod)**: pgvector is in the RDS Postgres 16 supported-extensions list; `CREATE EXTENSION vector` works without a parameter-group change. Confirm against the live RDS instance before the deploy; no `shared_preload_libraries` edit is needed for pgvector.

## 11. Testing

- **Resolver SQL (real PG, scoped fixtures, no Voyage):** seed entities/facts with **hand-injected deterministic `vector(512)` literals** (e.g. unit-ish vectors along chosen axes) so cosine ordering is exactly predictable; assert `searchLore`/`findSimilarEntities` return the expected rank order, the `pc` exclusion, the over-pull across all access levels, and the `limit` cap. Graph: seed a relationship graph + hierarchy; assert `charactersKnownTo` depth-bounding, both-direction traversal, cycle-safety (a deliberate cycle), `nameFilter`, and `factionTree` subtree shape — all over-pulling across tiers.
- **Voyage wrapper (`embed.ts`):** mock the `fetch` boundary; assert request shape (model, `input_type` doc-vs-query, batch chunking at `VOYAGE_BATCH_SIZE`, dim), response parsing, timeout, the bounded retry.
- **Orchestration:** mock `embedQuery` to a fixed vector + real-PG seeded rows → assert end-to-end ranking and the empty-on-embed-failure total posture.
- **Write-path:** `embedWorld` batches + writes the columns (mocked embed); the backfill only touches NULL rows; the world-gen post-pass stage runs after persist and is non-fatal on a Voyage throw.
- **Constructed smoke (real Voyage, gated on `VOYAGE_API_KEY` presence):** embed two real strings (one semantically near the query, one far) → store → cosine-search → assert the near one ranks first. Proves the live API shape + dim + the document/query asymmetry + the round-trip — the mocks can't catch a real API drift (the constructed-state-smoke lesson).
- 100% coverage gate; lint error rules (`no-non-null-assertion`, `no-deprecated`), `max-lines` 400 / `max-lines-per-function` 100. No `.max()` on any LLM-prose field (n/a here — no generated prose).

## 12. File-level change map

| File | Change |
|---|---|
| `backend/migrations/026_world_retrieval.sql` | Create — extension, embedding columns, HNSW indexes (§3) |
| `backend/src/llm/embed.ts` | Create — the Voyage wrapper (§4.1) |
| `backend/src/world/retrieval/{search,graph,embed-write,types,config,index}.ts` | Create — the resolver library (§5–§9) |
| `backend/src/repo/world-retrieval.ts` | Create — parameterized vector + recursive-CTE SQL (§7) |
| `backend/src/repo/entities.ts`, `repo/facts.ts` | `updateEmbedding` method (§7) |
| `backend/src/llm/prep/stages/embed-world.ts` (+ `world-gen-processor.ts`) | Create the terminal embed stage; append to `WORLD_GEN_STAGES` (§4.3) |
| `backend/scripts/world-embed-backfill.ts` (+ `package.json` script) | Create — the backfill command (§4.3) |
| `backend/src/config/env.ts` | `VOYAGE_API_KEY` in the loadEnv schema (§4.4) |
| the setup-env script + `infra/modules/serving/main.tf` | `VOYAGE_API_KEY` surfaces + the TF task-def secret (§4.4) |
| `docker-compose.yml` (+ CI deploy.yml PG service) | `postgres:16-alpine` → `pgvector/pgvector:pg16` (§10) |

## 13. Resolved decisions (design gate, 2026-06-14)

1. **v1 = pgvector + graph only.** Spatial → MYT-78 (a geography feature, not a query function); text-to-SQL → cut (no bead).
2. **Voyage AI** over OpenAI / local, via a first-party REST wrapper (no third-party embedding SDK). `voyage-3-lite` / 512-dim, document/query asymmetric input types. Dim is migration-baked.
3. **Recursive CTE, not ltree**, for both the relationship graph and the hierarchy — one mechanism, no extension, no materialized-path maintenance.
4. **Graph v1 treats all relationship types as a connection**; a typed filter is a later refinement.
5. **Embed write-path = backfill + a world-gen terminal post-pass** (new worlds searchable on completion); the Scribe reuses it at session end. Voyage failure is non-fatal (NULL + backfillable), never crashes world-gen.
6. **Resolver over-pulls across ALL tiers — no access_level filter in this layer.** The ST gate (MYT-72) is the safety boundary. Tier-filtering here would be a bug.
7. **Entity embedding excludes `pc`** (player characters are not world lore).
8. **MYT-71 ships the resolver library only** — no FT-tool/ST-gate wiring (MYT-72), no Scribe write-reconciliation (MYT-73).
9. **pgvector precondition**: local docker + CI + RDS all need the extension; the docker image swap is part of this issue.

## 14. The MYT-71/72/73 boundary (for the reviewer)

- **MYT-71 (this):** the substrates + the resolver functions + the embedding write-path. No tool registry, no ST gate, no turn-path wiring.
- **MYT-72:** wraps `searchLore`/`charactersKnownTo`/… as the `world_fact_lookup` tool family; the FT routing; the skill-gate (DM channel = PC skill, NPC channel = NPC stats, §17.5); the ST gate that relays vetted knowledge back to the FT (the single safety boundary).
- **MYT-73:** the Scribe reuses `findSimilarEntities` + `embedWorld` for match-vs-mint entity resolution and the multi-substrate commit at session end (§17.7).
