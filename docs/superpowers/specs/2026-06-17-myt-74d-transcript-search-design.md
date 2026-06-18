# MYT-74d — Transcript Search

> **Status:** approved at brainstorm 2026-06-17. The **fourth and final** decomposed piece of Linear issue MYT-74 (74a-c shipped). **Independent** of 74a-c — it reads `session_messages`, which is public by construction. The authoritative scope is the multiplayer-session-runtime spec (§"The player wiki + transcript search").

**Goal:** give players an in-session lookback — search the player-facing transcript ("what did Bram say about the ledger", "what happened with the harbourmaster") across a campaign's sessions, with relevance-ranked, highlighted hits.

---

## Where this sits

MYT-74 decomposed into four pieces; this is the last. 74a built the session-end lifecycle + reconcile, 74b the post-session analysis/handoff, 74c the campaign wiki + tier promotion. 74d is the **transcript-search API** — orthogonal to the reconcile lifecycle (it reads the raw `session_messages` log, not canon). It is a sibling player-read surface to the 74c wiki: member-readable, campaign-scoped, no UI (a Frontend ticket owns the search box).

**The corpus.** `session_messages` holds the player-facing transcript, but the rows split into two shapes. The **prose-bearing** types — FT narration (`dm_text`) and player messages (`player_message`) — store human-readable text. The **mechanical** types (`skill_check`, `dice_roll`, `world_fact_lookup`, and the MYT-70 party-ledger tool rows) store `JSON.stringify(...)` blobs (`{toolCallId, input, output}`), not prose — see `session/transcript-codec.ts`. **Search indexes and returns only the prose-bearing types** (`dm_text`, `player_message`); the mechanical JSON rows are excluded (D7). Indexing a JSON blob would tokenize field names/UUIDs as spurious match terms and return un-renderable highlighted-JSON snippets — the opposite of a "what did X say" lookback. The readable narration of a roll or a ledger change already lives in the adjacent `dm_text` prose, so excluding the JSON rows loses nothing a player would search for. Explicitly **not** in the corpus either: the debug `st_evaluation` / `scribe_result` streams — those are not in `session_messages` at all (they ride separate channels). This corpus is **public by construction**: the FT operates under enforced ignorance (never narrates a secret), the ST's sanctioned reveals are public once narrated, and the [[DM CORRECTION:]] marker is an FT *input* direction that never persists into the FT's *output* content (`persistTurn` stores `assistantToRows(this.assistant)`, the rendered prose). There is nothing to tier-filter — so unlike the wiki, search **cannot leak a secret**.

---

## In / out of scope

**In scope.** (1) A **full-text index** on `session_messages.content` (a generated `tsvector` column + a **partial** GIN index over the prose-bearing types, migration 029). (2) A **campaign-scoped, session-filterable search** repo read over the prose-bearing corpus (Postgres FTS via `websearch_to_tsquery`, relevance-ranked, `ts_headline` snippet, speaker attribution, pagination). (3) A **member-readable route** `GET /api/campaigns/:campaignId/transcript/search`.

**Out of scope.** Semantic / embedding search (FTS is v1; the transcript is large and embedding every row is a cost/pipeline burden the literal-recall use case doesn't need — a documented later enhancement). The **search UI** (a Frontend ticket — 74d is the data/API layer). An **NL→query AI step** (`websearch_to_tsquery` parses the player's raw query mechanically). **Inline surrounding-context** in the result (the UI fetches context via the existing message replay — `listAfterSeq` — on click). A **user-selectable message-type filter** param (the corpus is fixed to the two prose types `dm_text` + `player_message` per D7; the result still carries `messageType` so the UI can distinguish/filter those two client-side — a *server-side selectable* filter is YAGNI for v1).

---

## Decisions

- **D1 — Postgres full-text search, not embeddings.** A `tsvector` GIN index + `websearch_to_tsquery`. Cheap, fast, no embedding pipeline, no per-message Voyage cost. Fits the literal-recall use case ("what did X say", names/items/places) the spec describes. The canon search stack (Voyage + pgvector) stays for canon; the transcript gets FTS. Semantic search is a deferred enhancement (§out of scope).
- **D2 — Campaign-wide, session-filterable.** Search all the campaign's sessions by default (the story so far — "what happened with Y" spans sessions); an optional `sessionId` narrows to one session ("in-session lookback"). `session_messages` carries only `session_id`, so the query joins `sessions` to scope by `campaign_id` and to surface `session_number`. Search **intentionally ignores `sessions.status`** — `ended` and `crashed` sessions' transcripts are part of "the story so far" and remain searchable (unlike the WS connect path, which gates on `status='active'`; the lookback has no such gate).
- **D3 — Hit + highlight snippet; context on click.** Each hit returns the matched message + a `ts_headline` snippet (why it matched) + speaker + locators (`sessionNumber`, `sessionId`, `seq`, `createdAt`). The UI renders a result list and jumps to full context via the existing replay (`listAfterSeq`) on click — no second context query in the search itself. Bounded payload; defers context-rendering to the Frontend ticket.
- **D4 — No AI step (ZFC-compatible).** `websearch_to_tsquery('english', $q)` parses the player's raw query (phrases, `-exclude`, `or`) mechanically. Search is structural retrieval, not reasoning — ZFC's mechanical-computation exception, like dice math or movement ranges. No Haiku query-reformulation.
- **D5 — Not a `pipelineRoute`.** The campaign-pipeline routes (status, prep-status, world-snapshot, wiki) are gated on the gen pipeline and grouped in `PIPELINE_ROUTES`. Transcript search is **session-runtime data**, not gen-pipeline status, and has no stage gate — so it is NOT marked `config.pipelineRoute`. The contract ripple for a **non-pipeline** member route is just **two** files: `contract/backend-routes.ts` (the bypass-boot route-drift list) + `dev-tool/verify-registry.ts` `EXEMPT_ROUTES` (the dev-tool route-exhaustion invariant validates against `BACKEND_ROUTES`). It does **NOT** touch `dev-tool/coverage.json`, `pipeline-routes.ts`, or the `app-pipeline-contract` mock — those are **pipeline-only**: `dev-tool:check` validates `coverage.json` `exempt.routes` against `PIPELINE_ROUTES`, so adding a non-pipeline route there is always a `dev-tool:check` failure (the MYT-74c `/wiki` route IS a pipelineRoute, which is why it legitimately appears in `coverage.json` — `/transcript/search` is not). (Corrects the pipeline-route-contract-ripple lesson: the five-surface ripple applies to `pipelineRoute:true` routes; a non-pipeline route ripples to only these two.)
- **D6 — Public corpus → no tier filter.** The only structural guard is the `campaign_id` join: a member can search only their own campaign's transcript (no cross-campaign bleed). `requireCampaignMember` gates the route; the join scopes the rows. There is no `access_level` on `session_messages` and nothing to filter — the spec's "public by construction" property is the safety.
- **D7 — Search the prose-bearing transcript only.** The searchable corpus is the prose-bearing message types — `dm_text` and `player_message` — defined by a `SEARCHABLE_MESSAGE_TYPES` constant in the repo. The mechanical types (`skill_check`, `dice_roll`, `world_fact_lookup`, ledger tool rows) store `JSON.stringify` blobs, not prose (§"The corpus"), so they are excluded both from the **partial** GIN index (its `WHERE` predicate, §1) and from the query's `message_type` filter (§2). This keeps the index lean (no JSON-token bloat), guarantees every returned `content`/`snippet` is human-readable, and matches the literal-recall use case ("what did X say"). The migration's partial-index predicate and the repo's `SEARCHABLE_MESSAGE_TYPES` must stay in **lockstep** — a §5 test EXPLAINs the query and asserts the partial index is used, pinning the coupling.

---

## 1. Storage — migration 029

```sql
-- 029_session_messages_fts.sql — MYT-74d
-- Full-text search over the player-facing transcript. A generated tsvector
-- column (auto-maintained on insert; the transcript is append-only, so no update
-- churn) + a PARTIAL GIN index over only the prose-bearing message types
-- (D7) — mechanical JSON rows (skill_check/dice_roll/world_fact_lookup/ledger)
-- are not indexed. No CONCURRENTLY: the migration runner wraps each file in a
-- transaction.
ALTER TABLE session_messages
  ADD COLUMN content_tsv tsvector GENERATED ALWAYS AS (to_tsvector('english', content)) STORED;

CREATE INDEX idx_session_messages_content_tsv
  ON session_messages USING GIN (content_tsv)
  WHERE message_type IN ('dm_text', 'player_message');
```

The `'english'` config stems + tokenizes prose; proper nouns ("Bram", "the Obsidian Cabal") tokenize fine. The column is `GENERATED … STORED`, so Postgres maintains it — no application write path changes (`appendDmTurn` / `append` are untouched).

**Migration cost / rollout.** This lands **pre-launch**, while `session_messages` is empty or near-empty — so the `ADD COLUMN … GENERATED … STORED` (a full table rewrite under `ACCESS EXCLUSIVE`) and the GIN build are effectively free. The migration runner sets `statement_timeout = 0` (no self-abort) and `lock_timeout = '30s'` (bounds lock *acquisition* only), so against a *populated* production table this rewrite would block live `append`/`appendDmTurn` writers for its full duration. It is not run against a populated table here; if a comparable column-add is ever needed post-launch, it requires a different rollout (online backfill / batched), not this in-transaction form. The partial-index predicate's literal list must mirror the repo's `SEARCHABLE_MESSAGE_TYPES` (D7).

---

## 2. The search read — `repo/transcript-search.ts`

A new repo namespace (a focused sibling of `session-messages.ts`), one method:

```ts
export interface TranscriptHit {
  readonly sessionId: string
  readonly sessionNumber: number
  readonly seq: number
  readonly messageType: string
  readonly userId: string | null      // resolved to a speaker by the route
  readonly content: string
  readonly snippet: string             // ts_headline highlight
  readonly createdAt: Date
}

export interface SearchTranscriptArgs {
  readonly campaignId: string
  readonly query: string               // the player's raw query
  readonly sessionId?: string          // optional narrow to one session
  readonly limit: number
  readonly offset: number
}

// searchTranscript(c, args): Promise<readonly TranscriptHit[]>
```

The SQL binds `websearch_to_tsquery('english', $q)` once via a `CROSS JOIN LATERAL` row source, and computes `ts_headline` in an **outer** query over the rank-filtered-and-paginated inner result — so the expensive per-row headline re-parse runs **only for the ≤ `limit` rows actually returned**, never for the full match set (the planner may otherwise evaluate a top-level `ts_headline` before `LIMIT`):

```sql
SELECT sub.session_id, sub.session_number, sub.seq, sub.message_type, sub.user_id, sub.content,
       ts_headline('english', sub.content, sub.tsq,
                   'StartSel=<mark>,StopSel=</mark>,MaxFragments=2,MaxWords=18,MinWords=5') AS snippet,
       sub.created_at
  FROM (
    SELECT sm.session_id, s.session_number, sm.seq, sm.message_type, sm.user_id,
           sm.content, sm.created_at, q.tsq,
           ts_rank(sm.content_tsv, q.tsq) AS rank
      FROM session_messages sm
      JOIN sessions s ON s.id = sm.session_id
      CROSS JOIN LATERAL websearch_to_tsquery('english', $2) AS q(tsq)
     WHERE s.campaign_id = $1
       AND ($3::uuid IS NULL OR sm.session_id = $3)
       AND sm.message_type IN ('dm_text', 'player_message')   -- SEARCHABLE_MESSAGE_TYPES; matches the partial-index predicate (D7)
       AND sm.content_tsv @@ q.tsq
     ORDER BY rank DESC, sm.created_at DESC, sm.session_id, sm.seq DESC
     LIMIT $4 OFFSET $5
  ) sub
 ORDER BY sub.rank DESC, sub.created_at DESC, sub.session_id, sub.seq DESC
```

Two correctness details in the `ORDER BY`: `ts_rank DESC, created_at DESC` is **not a total order** — `appendDmTurn` writes every row of one DM turn in a single multi-VALUES `INSERT`, so they share one `created_at`, and equal-length terse rows tie on `ts_rank` to the digit. The `, session_id, seq DESC` tiebreaker makes the sort **total** (`(session_id, seq)` is unique), so `LIMIT/OFFSET` pagination can't skip or duplicate rows across pages. The inner query ranks, filters, and paginates; the outer query re-applies the same total order and adds `ts_headline` only for the surviving page. The `message_type IN (...)` predicate matches the §1 partial-index `WHERE`, so the planner uses `idx_session_messages_content_tsv`.

An empty/whitespace `query` (or one `websearch_to_tsquery` reduces to empty) yields zero hits — the route rejects empty `q` upfront (§3), so the method itself just runs the query. The `sessionId?` bind coalesces `undefined → null` at the call site (`$3 = args.sessionId ?? null`) — node-pg rejects `undefined`, and under `exactOptionalPropertyTypes` an absent optional is `undefined` (the repo's established `?? null` pattern).

**Speaker attribution (three-way).** The route resolves each hit's `userId` → speaker using the campaign's `user_id → character name` map (one read — `repo.characters.listForCampaign(campaignId)`). Because the corpus is now `dm_text` + `player_message` only, there are exactly three cases, mirroring the validated WS replay path (`routes/ws-session.ts`, `DEPARTED_AUTHOR_NAME`):

1. **`null` `userId`** (DM-authored: `dm_text`) → `"DM"`.
2. **non-null `userId` present in the map** (`player_message` from an active member) → the speaking character's name.
3. **non-null `userId` absent from the map** (a player who has since left the campaign — `listForCampaign` joins through `campaign_characters`, so a departed author drops out) → a `"Former player"`-style placeholder, **not** `"DM"`. Collapsing a departed player's line into `"DM"` is a "who said it" mis-attribution; reuse the replay's `DEPARTED_AUTHOR_NAME` constant for one source of truth.

The route shapes the wire result as `{ …hit, speaker }` (dropping the raw `userId`).

---

## 3. The route — `GET /api/campaigns/:campaignId/transcript/search`

In `routes/campaigns.ts` (or a focused sibling route module if the campaigns file is large — verify during planning), member-readable:

- **Auth:** `preHandler: requireCampaignMember(repo)` (any member).
- **Querystring (Zod):** `q` (required, non-empty after trim → else `400 { code: 'invalid_query' }`); `sessionId?` (uuid); `limit?` (default 20, capped ~50); `offset?` (default 0, capped — e.g. ≤ 500 — so a deep offset can't force an unbounded rank-sort; the relevance-ranked lookback is a shallow-page UX, keyset pagination deferred).
- **Handler:** resolve `campaign → worldId`? Not needed (transcript is campaign-scoped, not world). Fetch the campaign's `userId→name` map; call `repo.transcriptSearch.searchTranscript({campaignId, query: q, sessionId, limit, offset})`; map each hit to `{ sessionId, sessionNumber, seq, messageType, speaker, content, snippet, createdAt }`; `reply.send({ hits, query: q, limit, offset })`.
- **No stage gate** (the transcript is session-runtime data; a fresh campaign with no sessions returns `{ hits: [] }`, not a 409).
- **Rate limit:** per-user. Mirror the **`wiki`** route's `keyGenerator` (`requireDbUser(req).id` with an `ip` fallback — the exact member-read-per-user precedent at `campaigns.ts`; the sibling `status` route is per-IP, *not* the right model). A modest cap (e.g. 30/min — search is heavier than the 60/min member polls: an `O(matches)` rank-sort plus `ts_headline` per returned row).
- **Contract:** add to `contract/backend-routes.ts` + the dev-tool `EXEMPT_ROUTES` (`verify-registry.ts`) — a player route, no dev-tool panel. Do **NOT** add it to `dev-tool/coverage.json` (pipeline-only — `dev-tool:check` validates that manifest against `PIPELINE_ROUTES`) or `pipeline-routes.ts` (D5).

---

## 3a. Performance characteristics & known limitations

These are accepted at launch scale (a campaign's transcript is thousands of prose rows) and named here so they're deliberate, not discovered:

- **`ts_rank` sort is `O(matches)`, not `O(limit)`.** The partial GIN index answers the `@@` membership predicate, but `ts_rank` is computed per matching row, so a campaign-wide search on a frequent term sorts the whole match set before `LIMIT`. Fine at launch; if a long-running campaign ever makes this hot, the mitigations are a recency pre-filter or a candidate-set cap (deferred). The outer-query `ts_headline` (§2) already bounds the *headline* cost to the returned page.
- **Deep `OFFSET` re-scans.** `LIMIT/OFFSET` re-scans skipped rows; the §3 `offset` cap (≤ 500) bounds it. Keyset pagination is deferred — the relevance-ranked lookback is a first-page UX.
- **No fuzzy / prefix matching.** `websearch_to_tsquery` matches whole stemmed lexemes, so a partial name or misspelling returns nothing. This is the literal-recall v1 scope (consistent with the embeddings deferral); `pg_trgm`/semantic recall is a documented later enhancement, not a v1 gap.

## 4. Enforced ignorance

The corpus is **public by construction** (§Where this sits) — there is no `access_level` on `session_messages`, the FT never narrates secrets, and the debug ST/Scribe streams are not in the table. So search has nothing to tier-filter and cannot leak a secret. The structural guards that DO hold:

- **Campaign scoping:** the `s.campaign_id = $1` join restricts results to the caller's own campaign; `requireCampaignMember` proves membership. A member cannot search another campaign's transcript.
- **No bypass:** there is no tier/bypass parameter on this route (nothing to widen).

The §5 tests assert the scoping guard (a member of campaign A searching gets zero rows from campaign B, even for a shared query term — the one cross-campaign-bleed surface this read introduces) and two defense-in-depth invariants the "public by construction" property rests on: the **prose-only corpus** (mechanical JSON rows excluded, so a hit's `content` is always player-readable) and the **correction-row** assertion (a `[[DM CORRECTION:]]`-derived row returns only the FT's player-facing retcon prose, never the literal marker).

---

## 5. Testing

- **Migration (029):** after migrate, `session_messages` has a `content_tsv` column of type `tsvector`; the partial GIN index `idx_session_messages_content_tsv` exists; inserting a `dm_text`/`player_message` row populates `content_tsv` (`@@ websearch_to_tsquery` matches a term in the content).
- **Pinned schema contract (the recurring per-migration step):** update `src/db/__tests__/migrate-schema.test.ts` — append `029_session_messages_fts.sql` to the pinned migration list **and** insert `idx_session_messages_content_tsv` (sorted) into `EXPECTED_IDX_NAMES`. The index matches the test's `LIKE 'idx_%'` filter, so the full coverage suite's `toEqual` fails without both. (Per `reference_migrate_schema_pin_per_migration` — scoped tests pass; only the full suite catches this.)
- **Repo (`searchTranscript`, real PG):** seed a campaign with two sessions of `dm_text` + `player_message` rows. A term that appears in session 1 and 2 returns both (campaign-wide), ranked; the `sessionId` filter narrows to one session; `ts_headline` snippet wraps the matched term in `<mark>`; relevance ranking orders a many-hit row above a single-hit row; `limit`/`offset` paginate; a query matching nothing → `[]`; a multi-word **phrase of content words** (`websearch_to_tsquery('english', '"obsidian cabal"')` — *not* a stopword phrase like `"the ledger"`, which reduces to a single lexeme) matches adjacency; a `-term` excludes rows with that term.
- **Prose-only corpus (D7):** seed a mechanical row (`skill_check`/`dice_roll`/`world_fact_lookup`) whose JSON `content` contains the search term; assert it is **not** returned (excluded by the partial index + the `message_type` filter), so no hit ever carries a raw-JSON `content`/`snippet`.
- **Partial-index coupling (lockstep guard):** `EXPLAIN` the query and assert a `Bitmap Index Scan on idx_session_messages_content_tsv` — pins the migration's partial predicate to the repo's `SEARCHABLE_MESSAGE_TYPES` (a drift to a seq scan is caught here, not in production latency).
- **Total-order pagination (determinism):** seed several rows that tie on both `ts_rank` and `created_at` (a single `appendDmTurn` turn shares one `created_at`); page through with `limit=1`/increasing `offset` and assert the full set is returned exactly once, no skips or duplicates (the `(session_id, seq)` tiebreaker).
- **Cross-campaign isolation (the leak surface):** seed two campaigns whose transcripts share a term; `searchTranscript({campaignId: A, …})` returns ONLY campaign A's rows (the `campaign_id` join holds). A `sessionId` belonging to campaign B passed with `campaignId: A` returns `[]` (the `AND`-ed predicates can only narrow within the campaign).
- **Correction-row invariant (defense-in-depth, pins "public by construction"):** seed a `dm_text` row authored from a turn with a `[[DM CORRECTION:]]` direction; assert the returned `content`/`snippet` is the FT's player-facing retcon prose and contains **no** literal `[[DM CORRECTION` marker (the marker is an FT input, never persisted output). Cheap, and it pins the invariant the whole feature rests on.
- **Route (real PG):** a member `GET …/transcript/search?q=…` → `200` with ranked `{ hits }`, each carrying `speaker` (a player row → the character name; a DM row → `"DM"`), `snippet`, `sessionNumber`, `seq`; the `sessionId` filter works; empty `q` → `400 invalid_query`; a non-member → `403`; pagination params honored; a fresh campaign (no sessions) → `200 { hits: [] }`.
- **Attribution (three-way):** a `player_message` from an active member resolves to the speaking character's name; the **same author after leaving the campaign** (removed from `campaign_characters`, so absent from `listForCampaign`) resolves to the `"Former player"` placeholder, **not** `"DM"`; a `dm_text` row (null `user_id`) resolves to `"DM"`.

No real-LLM smoke (there is no LLM in this path — FTS is deterministic). A gated DB smoke is optional; the real-PG repo + route tests are the proof. (Per `feedback_smoke_vs_eval`: there's no LLM output to eval here.)

---

## 6. Out of scope (restated)

Semantic/embedding transcript search (FTS is v1), the search UI (Frontend), an NL→query AI step, inline surrounding-context, a *user-selectable* message-type filter param (the corpus is fixed to the two prose types). 74d gives players a fast, relevance-ranked, public-by-construction lookback over their campaign's transcript.
