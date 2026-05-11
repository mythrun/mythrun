# World & Campaign Pipeline Sub-Spec

> **Type**: Sub-spec (conforms to Production Architecture Overview)
> **Date**: 2026-04-13
> **Amended**: 2026-05-11 (Prep Pipeline milestone scoping pass — fork deferral, character portability, streaming entity events, dev tool, BullMQ worker provisioning, LLM client realignment to MYT-44, post-MYT-43 cost tracking)
> **Status**: Amended; ready for Linear-issue decomposition
> **Parent**: `2026-04-06-production-architecture-overview.md`
> **Depends on**:
> - Backend Core schema as actually migrated (migrations 001–008) — note: requires a schema migration to make characters portable (see §11).
> - Auth & Users — `request.user.sub` → `users.id` via `repo.users.getByCognitoSub` is the established pattern. Bypass plugin's `x-mythrun-dev-sub` header is used by the dev tool.
> - Billing — `credit_ledger` debit pattern (atomic SERIALIZABLE / advisory lock), `credit_type='world_gen'` already in the CHECK constraint.
> - MYT-43 billing metering — per-call `event: 'llm.call'` log emission from the LLM middleware is the data plane; this milestone consumes the same emission path into `pipeline_runs`.
> - MYT-44 LLM client — Vercel AI SDK v6 + tier-named `HAIKU`/`SONNET`/`OPUS` model constants + `logAndNormalizeMiddleware`. This milestone extends MYT-44 with `wrapStream` middleware + `streamObject` patterns.
> - MYT-45 rate limiting — all new prep routes declare `config.rateLimit` per the established `@fastify/rate-limit` + Redis pattern; expensive routes (world create, campaign create) opt into per-sub `keyGenerator`.
> - Infrastructure & DevOps — Worker ECS service is provisioned at `desired_count=0` today; this milestone flips it to 1 once `dist/worker.js` carries real BullMQ wiring (per Infrastructure spec §3.2 amendment).
> **Scope**: Production rewrite of the prep engine for the new world/campaign model. World gen pipeline, campaign setup pipeline (parallel per-player character creation), BullMQ worker wiring, pipeline status API with streaming entity events, dev tool front-end for manual end-to-end testing. Ports proven prompt templates + Zod schemas + universal/seed tables from the prototype; all orchestration / persistence / streaming is new.

---

## Table of Contents

1. [Overview](#1-overview)
2. [Pipeline Architecture](#2-pipeline-architecture)
3. [World Gen Pipeline](#3-world-gen-pipeline)
4. [Campaign Setup Pipeline](#4-campaign-setup-pipeline)
5. [World Forking (deferred)](#5-world-forking-deferred)
6. [BullMQ Worker + Job Orchestration](#6-bullmq-worker--job-orchestration)
7. [LLM Client (extends MYT-44)](#7-llm-client-extends-myt-44)
8. [Pipeline Status, Streaming, and Entity Events](#8-pipeline-status-streaming-and-entity-events)
9. [API Routes](#9-api-routes)
10. [What Ports From the Prototype](#10-what-ports-from-the-prototype)
11. [Schema Changes Required](#11-schema-changes-required)
12. [Dev Tool Front-End](#12-dev-tool-front-end)
13. [Out of Scope](#13-out-of-scope)

---

## 1. Overview

The pipeline system generates worlds and sets up campaigns. It is the most LLM-intensive part of Mythrun — a full world gen costs ~$3–5 in API calls, and each player's character creation costs ~$1–2. The Prep Pipeline milestone takes Mythrun from "no production prep code" to "user can create a world, attach a campaign to it, run multi-player character creation, and reach session-ready state, exercised end-to-end through a dev tool."

### Day-One Launch Posture

- **One world → one campaign** at launch. The `campaigns.world_id` FK is fully decoupled in the schema, but the launch UX creates a world and a campaign on it in one flow. A user reusing an existing world for a second campaign is schema-supported, but the picker UI does not ship.
- **World forking deferred.** No cross-user fork at launch. The schema columns (`worlds.source_world_id`, `worlds.fork_count`, `worlds.is_public`) stay inert. See §5 for what the schema permits and what is explicitly *not* built.
- **Characters are user-owned with campaign-membership join** so future cross-campaign portability works without a schema migration. Day-one behavior is identical to "characters are campaign-bound" — every character is fresh in its one campaign. See §11.
- **Multi-player character creation IS day-one.** 2–5 players in parallel, BullMQ-fan-out + barrier + multi-PC post-stages.
- **SSE streaming with entity-level events** for live graph UI is day-one. See §8.
- **BullMQ worker** is provisioned and wired in *this* milestone (the existing `dist/worker.js` is a no-op shell at `desired_count=0`; flipping to 1 with real wiring is part of the work). See §6.
- **Dev tool front-end** is day-one for manual end-to-end testing — explicitly a throwaway development tool, NOT the real player frontend. See §12.
- **Snapshot capture / `reset-to-session` moves out of this milestone** to Session Runtime, where the consumer (live play) lives.

### What Changed From the Prototype

| Aspect | Prototype | Production |
|--------|-----------|-----------|
| Scope | Single `campaign_id` for everything | `world_id` for world gen, `campaign_id` for campaign setup |
| Execution | Fire-and-forget `void` promises | BullMQ job queue with retries, dead letter, back-pressure, idempotent per-stage retries |
| Character creation | One player, sequential | 2–5 players, parallel per-player + barrier |
| Database | Sync SQLite (`better-sqlite3`) | Async Postgres (`pg`) |
| Process | Same process as API server | Separate Worker ECS service (provisioned 2026-04 at `desired_count=0`; this milestone flips to 1 with real wiring) |
| LLM client | Hand-rolled `generateStructured` + 3-tier prompt-repair chain | Vercel AI SDK v6 (`ai` + `@ai-sdk/anthropic`) via MYT-44's wrapper layer; retry/structured-output handled by SDK; no in-house repair chain |
| Cost tracking | In-memory accumulation | `pipeline_runs.input_tokens / output_tokens / cost_usd` written per stage by the same `event: 'llm.call'` log emission path MYT-43 already uses for session usage |
| Credit gate | None | World gen deducts `world_gen` credit pre-enqueue; session start deducts `session` credit (in Session Runtime) |
| Streaming UX | None (3-second polling) | SSE with entity-level events parsed from partial JSON deltas; live graph populates as the LLM streams |
| Character ownership | Campaign-bound | User-owned with `campaign_characters` join (schema-ready for future cross-campaign portability) |

### What Didn't Change

- Stage logic and prompt templates (proven through months of iteration; multi-PC edits flagged in §10)
- Zod schemas for LLM output validation
- Canonical names system (prevents LLM name drift between stages)
- Random table roller (universal tables for NPC trait seeds)
- Pipeline state machine (`pending → running → completed | failed`)

### What's Cut Compared to the Prototype

- **No in-house 3-tier prompt-repair chain.** MYT-44 uses Vercel AI SDK's built-in retry (`maxRetries: 3`, exponential backoff). On structured-output failure after retries, the SDK throws `AI_NoObjectGeneratedError`, which MYT-44's middleware maps to `LlmStructuredOutputError`. The prep worker catches that and either retries the stage (BullMQ-driven) or fails the job. The prototype's "primary fails → Haiku repairs JSON → Sonnet repairs JSON" cascade is *not* ported — it's an open question whether we re-introduce it as a custom Vercel middleware if structured-output failures prove costly in practice. Tracked as a possible follow-up; not a launch dependency.

---

## 2. Pipeline Architecture

Two pipelines operating on different scopes. Stages marked **★** stream entity-level events to the SSE channel; see §8.

```
USER CREATES A WORLD
        │  (debit 1 world_gen credit, enqueue world-gen job)
        ▼
┌─────────────────────────────────────────┐
│  World Gen Pipeline (world_id scope)     │
│                                          │
│  concept_intake                          │
│      ↓                                   │
│  world_and_factions ★                    │
│      ↓                                   │
│  locations_and_npcs ★                    │
│      ↓                                   │
│  starting_situation                      │
│      ↓                                   │
│  random_tables                           │
│                                          │
│  → worlds.status = 'complete'            │
└─────────────────────────────────────────┘

USER CREATES A CAMPAIGN (from the world they just generated)
        │
        ▼
┌─────────────────────────────────────────┐
│  Campaign Setup Pipeline (campaign_id)   │
│                                          │
│  (no world_fork at launch — see §5)      │
│                                          │
│  ┌── Player 1 ──┐  ┌── Player 2 ──┐ ... │
│  │ location_sel  │  │ location_sel  │    │
│  │ char_concept  │  │ char_concept  │    │
│  │ char_sheet    │  │ char_sheet    │    │
│  │ char_integr.★ │  │ char_integr.★ │    │
│  └───────────────┘  └───────────────┘    │
│      ↓ (barrier: all per-player done)    │
│  materialize_relationships               │
│      ↓                                   │
│  continuity_check                        │
│      ↓                                   │
│  → campaigns.status = 'active'           │
└─────────────────────────────────────────┘
```

Snapshot capture and `reset-to-session` are owned by Session Runtime, not this milestone. The campaign emerges from this pipeline in `active` state with all entities, prose kernels, facts, and relationships materialized; the first session creates its own snapshots.

---

## 3. World Gen Pipeline

### Stages

All stages operate on `world_id`. Each stage reads prior outputs from Postgres (never in-memory), calls the LLM via the MYT-44 wrapper layer (`generateObject` for non-streaming stages, `streamObject` for the two streaming stages), validates against a Zod schema, and persists results. Per-stage state is tracked in `pipeline_runs` (one row per `(world_id, stage)` per user, enforced by the existing unique index).

Model selection uses MYT-44's tier-named constants — `HAIKU` / `SONNET` / `OPUS` from `backend/src/llm/models.ts`. There is no per-stage runtime override at launch; the default mapping below is hard-coded in `pipeline-config.ts`. The `settings` table can host per-stage overrides later without a schema change, but the launch milestone does not ship that surface.

#### Stage 1: `concept_intake`

- **Input**: `worlds.concept` (freeform text from the user)
- **Output**: `WorldConcept` — name, tone, themes, geography, politics, era, tensions, follow-up questions
- **Persists**: Updates `worlds` columns (`name`, `tone`, `themes`, `geography_summary`, `political_summary`, `era`, `key_tensions`, `follow_up_questions`)
- **Model**: `OPUS`
- **Prompt**: `concept-intake.txt` (ported from prototype)
- **Streaming**: No — short structured output; no entity-level events to emit

#### Stage 2: `world_and_factions` ★ streams entity events

- **Input**: `WorldConcept` + canonical names
- **Output**: 3 regions, 3 factions with relationships, secrets, goals
- **Persists**: Creates `entities` (type=location, type=faction) + `prose_kernels` + `facts`. Updates `worlds.world_overview`.
- **Model**: `OPUS`
- **Prompt**: `world-and-factions.txt` (ported)
- **Streaming**: Yes — uses `streamObject`. Emits `entity-added` events as regions and factions stabilize during the stream. See §8.

#### Stage 3: `locations_and_npcs` ★ streams entity events

- **Input**: `WorldConcept`, factions output, canonical names, 6 NPC name seeds, 6 NPC trait seeds (rolled from universal tables)
- **Output**: 6 locations, 6 NPCs, referenced locations, cross-faction connections
- **Persists**: Creates entities + prose kernels + facts + relationships + entity_hierarchy
- **Model**: `OPUS`
- **Prompt**: `locations-and-npcs.txt` (ported)
- **Streaming**: Yes — `streamObject`. Highest-volume graph stage; entity events fire most heavily here. Cross-references (NPC → location, NPC → faction) emit only after both endpoints have stabilized client-side. See §8.

#### Stage 4: `starting_situation`

- **Input**: All prior world data + canonical names
- **Output**: 3 location hooks (location_name, why_interesting)
- **Persists**: Updates `worlds.starting_situations` (JSON)
- **Model**: `OPUS`
- **Prompt**: `starting-situation.txt` (ported)
- **Streaming**: No — short JSON, no graph entities

#### Stage 5: `random_tables`

- **Input**: `WorldConcept` + seed tables from `data/tables/seed-tables.json`
- **Output**: 2 campaign-specific d20 tables (20 entries each)
- **Persists**: Creates `random_tables` + `random_table_entries` (note: schema has `random_tables.world_id`, not `campaign_id`, per arch overview §4.4)
- **Model**: `HAIKU`
- **Prompt**: `random-tables.txt` (ported)
- **Streaming**: No

### Credit Gate

Before enqueuing the world-gen BullMQ job, the API atomically debits one `world_gen` credit from the owner's ledger. The pattern matches MYT-43's session-credit debit:

1. Resolve `request.user.sub → users.id` via `repo.users.getByCognitoSub`.
2. Open a transaction. Take a transaction-scoped advisory lock keyed by `users.id` to serialize concurrent debits for the same user.
3. `SELECT COALESCE(SUM(amount), 0) FROM credit_ledger WHERE user_id=$1 AND credit_type='world_gen' AND (expires_at IS NULL OR expires_at > now())`. If `< 1`, ROLLBACK and return `402 Payment Required + {code: 'insufficient_credits', creditType: 'world_gen'}`.
4. INSERT the `worlds` stub row (status='generating') and the negative `credit_ledger` row (`amount=-1, source_type='debit', source_purchase_id=NULL, source_billing_history_id=NULL` — the `credit_ledger_source_link_chk` CHECK requires both source FK columns NULL for `source_type='debit'`).
5. COMMIT.
6. **After commit:** enqueue the BullMQ `world-gen` job against `redisBatch`. Postgres-then-Redis ordering is intentional — Redis enqueue is not transactional with Postgres, so the only durable-then-recoverable order is "debit committed, then enqueue."

**Failure modes:**
- Step 5 commit fails: nothing happened. Return 500. No debit; no orphaned anything.
- Step 6 enqueue fails (Redis blip): the debit committed but no job runs. The world stays in `status='generating'` forever; the user sees the orphan via `GET /api/worlds/mine`. Operator-facing recovery: `POST /api/worlds/:id/resume` re-enqueues idempotently (no second debit; the stub row exists and the credit was already taken).
- We do not auto-refund at launch — refunds for orphaned debits are an operator action, applied as a new positive `credit_ledger` row with `source_type='refund'` and `source_billing_history_id` linking to a billing-history audit row (per migration 007's refund-routing scheme).

### Per-World Cost Cap

Every world-gen job carries a hard cost ceiling. The Worker tracks per-run cost by summing `pipeline_runs.cost_usd` for the job's `(world_id, user_id)` after each stage write. If cumulative cost exceeds the cap (launch default: **$10 USD**), the Worker circuit-breaks: marks the current stage `failed` with a typed error (`world_gen_cost_cap_exceeded`), refuses retries, and surfaces the failure in pipeline status. This caps the blast radius of a runaway LLM stage (corrupted prompt template, model returning massive payloads, etc.).

The cost cap is a hard backstop, not the steady-state budget — a typical world gen is $3–5. The cap value is held in `settings.world_gen_cost_cap_usd` and read at worker boot with TTL refresh.

### Idempotency on Stage Retries

When BullMQ retries a job that's already made partial progress, completed stages must not double-persist. Each stage is gated by `pipeline_runs.status`:

- Job picks up: for each stage in order, read the `pipeline_runs` row. If `status='completed'`, skip the LLM call AND the persister, advance to the next stage.
- If `status='running'` and `started_at < now() - 60s`: the previous attempt stalled mid-stage. Reset to `pending` and re-execute (idempotent persisters — each one starts with a DELETE for the stage's prior outputs by `(world_id, stage)`, then inserts).
- If `status='pending'` or never inserted: execute normally.
- After successful stage write: `UPDATE pipeline_runs SET status='completed', completed_at=now()` *within the same transaction* as the stage's persister.

The unique index `idx_pipeline_runs_unique` on `COALESCE(world_id, campaign_id), stage, COALESCE(user_id, sentinel)` guarantees one row per stage per scope; UPSERT-or-update on the first insert avoids duplicate rows under retry.

### Completion

When all 5 stages complete: set `worlds.status = 'complete'`. The world is now ready for campaign creation.

---

## 4. Campaign Setup Pipeline

### Pre-requisites

- A completed world (`worlds.status = 'complete'`)
- At least one player with a character concept submitted (campaign owner counts as a player)
- Campaign owner has session credits — *checked at session start, not here.* The campaign-setup pipeline does not debit credits.

### No `world_fork` Stage At Launch

The campaign creation flow always uses the world the owner just generated (`campaigns.world_id = the world they just made`). The `world_fork` stage from the original spec only fired when `campaign.source_world_id IS NOT NULL` — that condition never holds at launch (forks deferred per §5). The stage is removed from the pipeline; the schema columns `worlds.source_world_id`, `worlds.fork_count`, and `worlds.is_public` stay inert.

### Per-Player Character Stages (Parallel BullMQ Fan-Out)

Each player runs these 4 stages independently and in parallel. Each player gets one BullMQ job that runs all four stages sequentially within itself. Multiple per-player jobs run concurrently across the campaign.

#### `location_selection` (no LLM)
- **Input**: Player's chosen starting location name (from the world's location list — frontend renders the world's locations and the player picks one)
- **Persists**: Creates a fact on the chosen location entity marking it as the player's starting location

#### `character_concept`
- **Input**: WorldConcept, starting location, player's character concept text + reason for being here
- **Output**: Name, class suggestion, level, species, background, backstory, personality
- **Persists**: Creates a `characters` row scoped to (`user_id`, this character's portable shape) with placeholder stats, and inserts a `campaign_characters` join row tying the character to this campaign. Updates `campaigns` record metadata.
- **Model**: `OPUS`
- **Prompt**: `character-concept.txt` (ported)

#### `character_sheet`
- **Input**: Character concept + SRD reference data
- **Output**: Ability scores, HP, AC, skills, features, equipment, spells
- **Validation**: Standard array check, proficiency bonus validation. Vercel SDK's `maxRetries: 3` covers schema-fail retries; `LlmStructuredOutputError` after exhaustion fails the stage.
- **Persists**: Updates `characters` portable fields + creates `character_skills` / `character_features` / `character_equipment` / `character_spells` rows
- **Model**: `OPUS`
- **Prompt**: `character-sheet.txt` (ported)

#### `character_integration` ★ streams entity events
- **Input**: WorldConcept, character concept, factions, NPCs, starting location
- **Output**: Prose kernel, NPC relationships, faction standings, starting facts
- **Persists**: Creates a PC `entities` row (type=`npc`) tied to *this campaign's world*, links `characters.entity_id` to it, creates `relationships` + `facts` rows. The PC entity, prose kernel, and relationships are world-scoped — these don't travel if the character later ports to another campaign; they'd be re-generated by re-running this stage in the new world.
- **Model**: `OPUS`
- **Prompt**: `character-integration.txt` (ported, with multi-PC content updates — see §10)
- **Streaming**: Yes — emits a PC-node + relationship edges as they stabilize, so the dev-tool / future-frontend graph updates live during the player's character integration.

### Parallel Execution Model

When the campaign owner triggers character creation (all players have submitted concepts):

1. The API enqueues one `character-creation` BullMQ job per player onto the `campaign-setup` queue.
2. The API also enqueues a `post-creation` barrier job with `waitForJobs` referencing the per-player job IDs.
3. Per-player jobs run concurrently up to the queue's concurrency cap (5 — see §6). Each job runs its 4 stages sequentially with `pipeline_runs` row tracking per stage. Per-stage `user_id` is set to the player's `users.id` so the unique index admits one row per `(campaign_id, stage, user_id)`.
4. The barrier job polls BullMQ for completion of all per-player jobs (or subscribes via QueueEvents); when all are `completed`, it kicks off the post-creation stages.

```
Player 1 job: location_sel → concept → sheet → integration ★ ─┐
Player 2 job: location_sel → concept → sheet → integration ★ ─┤
Player 3 job: location_sel → concept → sheet → integration ★ ─┤
                                                               ↓
                                                       [barrier: all done]
                                                               ↓
                                                materialize_relationships
                                                               ↓
                                                       continuity_check
```

If a per-player job fails after exhausted BullMQ retries, the barrier remains pending; the owner sees the per-player failure in pipeline status and can retry just that player's job (resume endpoint — see §9). The other completed per-player jobs do not re-run.

### Post-Creation Stages (Sequential, After Barrier)

#### `materialize_relationships` (no LLM)
- Converts implicit relationships stored as facts into explicit `relationships` rows for every PC × NPC pair touched during character integration.
- `user_id` for this stage's `pipeline_runs` row is NULL (campaign-scoped, not player-scoped).

#### `continuity_check`
- **Input**: Full serialized world state (multiple PCs included) + entity ID table
- **Output**: Array of `WorldFix` operations
- **Persists**: Executes fixes via the operations engine (ported)
- **Model**: `OPUS`
- **Prompt**: `continuity-check.txt` (ported, with multi-PC content updates — see §10)
- **`user_id`** for this stage's `pipeline_runs` row is NULL

### Completion

After continuity check: set `campaigns.status = 'active'`. Snapshot capture is owned by Session Runtime.

### Campaign Status Transitions

- `setup → active` — happy path; continuity_check completed
- `setup → archived` — owner manually archives a campaign before the pipeline completes (e.g., abandoned setup). Migration 001 enum is `('setup', 'active', 'archived')`. No `'failed'` state today; pipeline failure leaves the campaign at `setup` with the per-stage failure visible via `pipeline_runs`. Adding `'failed'` to the enum is a possible follow-up if operator UX demands it; not in launch scope.

---

## 5. World Forking (deferred)

**Day-one: world forking is not built.** The launch UX is one world → one campaign, generated together in the same flow. Cross-user fork (where User B's campaign clones User A's world) and marketplace browsing are explicitly out of scope for this milestone.

**Schema readiness** — the relevant columns exist in migration 001 and stay inert at launch:

| Column | Schema state | Launch behavior |
|---|---|---|
| `worlds.source_world_id` | nullable `REFERENCES worlds(id)` | Always NULL |
| `worlds.fork_count` | `INTEGER NOT NULL DEFAULT 0` | Always 0 |
| `worlds.is_public` | `BOOLEAN NOT NULL DEFAULT false` | Always false |
| `campaigns.world_id` | `NOT NULL REFERENCES worlds(id)` | Set to the world the owner just generated |
| `campaigns.source_world_id` | nullable `REFERENCES worlds(id)` | Always NULL |
| `world_marketplace` | table exists per migration 001 | No rows inserted; no reads |

The `campaigns.world_id` FK is genuinely decoupled — a single user could in principle attach two campaigns to one world, and the schema accepts it. The launch UI does not expose that path. When fork lands, the work is purely additive (a new pipeline stage, a marketplace browsing surface, a deep-copy SQL transaction), with no schema migrations and no breaking changes to the pipeline orchestration.

This is the only fork-related work in this milestone:
- Leave the inert columns alone.
- Keep `GET /api/worlds/mine` (returns worlds the user owns; trivial at launch since most users have ≤ 1 world).
- Do not build `GET /api/worlds/public`, marketplace listing, or the deep-copy SQL.

---

## 6. BullMQ Worker + Job Orchestration

### Worker ECS Service — Provisioned, Flipped to Live This Milestone

The Worker ECS service is already provisioned (Infrastructure spec §3), running `node dist/worker.js` at `desired_count = 0`. The current `backend/src/worker.ts` is a no-op shell: it boots, pings `redisBatch`, idles forever. This milestone fills in the real wiring:

1. Add BullMQ worker registration in `backend/src/worker.ts` against `redisBatch`. Two `Worker` instances (one per queue), shared connection pool to RDS via `pg.Pool`.
2. Wire the MYT-44 LLM client into the worker process — same `models.ts` + middleware + error taxonomy as the API uses today, plus the new `wrapStream` middleware coverage from §7.
3. Wire the worker's `/health` HTTP server (port 3001 per Infrastructure §3.1) to report BullMQ + Redis + Postgres connectivity.
4. CI green deploy registers the new task definition revision; manual `terraform apply` flips `aws_ecs_service.worker.desired_count` from 0 → 1.

The worker uses the same image, same env vars, same secrets as the API; it differs only in `command` (`dist/worker.js` instead of `dist/server.js`) and the absence of an ALB target group.

### Queue Architecture

Two queues on the **batch** Redis instance (`redisBatch` in `AppDeps`):

| Queue | Purpose | Concurrency |
|-------|---------|-------------|
| `world-gen` | World generation pipeline jobs | 3 (limits concurrent Opus + Sonnet streams against Anthropic) |
| `campaign-setup` | Campaign setup jobs (per-player + barrier + post-creation) | 5 |

`redisRealtime` is reserved for the hot request path (rate limiting today, WS session state once Session Runtime ships); BullMQ stays on `redisBatch` so queue churn doesn't compete with rate-limit INCRs for connection slots.

### Worker Process Redis Connections

`ioredis` connections cannot be shared across BullMQ's roles. The worker process opens against `redisBatch`:

- 1 connection per `Worker` instance (so: 2 — one for `world-gen`, one for `campaign-setup`)
- 1 connection for a `Queue` instance (enqueuing follow-up jobs from inside a job — e.g., the barrier job's continuation)
- 1 connection for `QueueEvents` (the barrier uses this to await per-player completions; preferred over polling)

Plus one connection against `redisRealtime` for `PUBLISH`-ing entity-event SSE messages to the channels described in §8. This is a new wire for the worker — `backend/src/worker.ts` today only opens `redisBatch`. The amendment to AppDeps for the worker mirrors the API's pattern (both `redisRealtime` and `redisBatch` exposed via the same factory).

Total: 4 connections on `redisBatch`, 1 connection on `redisRealtime` per worker process. Well within `cache.t4g.micro` capacity (default `maxclients = 65000`).

The API process opens its own `Queue` instances against `redisBatch` for enqueueing world-gen + per-player + barrier jobs, plus the existing `redisRealtime` connection used for SUB on SSE-attached requests.

### Job Types

#### `world-gen` Queue

```typescript
interface WorldGenJob {
  type: 'world-gen'
  worldId: string
  userId: string  // owner; for credit attribution + pipeline_runs.user_id
}
```

One job per world. The worker runs all 5 stages sequentially within the job. The job is idempotent on retry: stages with `pipeline_runs.status='completed'` are skipped (see §3 Idempotency). The original spec's `startFromStage?` field is dropped — idempotency via `pipeline_runs` makes it redundant and harder to reason about.

#### `campaign-setup` Queue

```typescript
interface CharacterCreationJob {
  type: 'character-creation'
  campaignId: string
  worldId: string
  userId: string  // the player whose character is being created
  characterConceptText: string
  startingLocationEntityId: string  // entity_id of the chosen location, not name (avoids ambiguity)
  reasonForBeingHere: string
}

interface PostCreationJob {
  type: 'post-creation'
  campaignId: string
  worldId: string
  waitForJobs: readonly string[]  // BullMQ job IDs of all character-creation jobs for this campaign
}
```

The `startingLocationEntityId` is an entity UUID, not a name. The API resolves the player's location selection to an entity at submit time so the worker has unambiguous identity (the name might collide with another location in the world).

### Retry Strategy

| Failure Class | Detected via | Attempts | Backoff |
|---|---|---|---|
| Anthropic rate limit (`LlmRateLimitedError`) | MYT-44 error taxonomy | 3 | Exponential: 30s, 60s, 120s |
| Anthropic overload / 5xx (`LlmOverloadedError`) | Same | 3 | Exponential: 30s, 60s, 120s |
| Structured-output failure (`LlmStructuredOutputError`) | Same — Vercel SDK's `maxRetries:3` already exhausted internally | 2 | Fixed: 10s (re-roll the whole stage) |
| Postgres transient error | `pg` error codes (40P01 deadlock, 40001 serialization) | 2 | Fixed: 5s |
| Cost cap exceeded (`world_gen_cost_cap_exceeded`) | Per-stage cost-cap check (§3) | 0 | n/a — circuit-breaker |
| Auth misconfig (`LlmAuthError`) | MYT-44 error taxonomy | 0 | Operator-only fix |
| Unknown error | Default | 1 | Fixed: 30s |

After max retries: job moves to dead-letter queue (BullMQ `failed` state). `pipeline_runs.status='failed'`, `error` column populated with the typed error class. The pipeline status surface reports the failure with the typed code so the dev tool / future frontend can render a precise message.

### Back-Pressure

The API checks queue depth before debiting credits + enqueuing. If `world-gen` queue has > 20 *waiting* jobs (not active), return `503 Service Unavailable` with `Retry-After: 60` and **do not debit** the world_gen credit. Same surface for `campaign-setup` at > 30 waiting jobs.

### Stalled Job Detection

BullMQ's built-in: if a job doesn't send a heartbeat within 30 seconds, it's considered stalled and re-queued. The worker sends heartbeats between stages:

```typescript
async function processWorldGen(job: Job<WorldGenJob>) {
  for (const stage of WORLD_GEN_STAGES) {
    await runStage(stage, job.data)
    await job.updateProgress(stageIndex / totalStages)  // heartbeat + progress
  }
}
```

For long-running *streaming* stages (`world_and_factions`, `locations_and_npcs`, `character_integration`), the heartbeat fires per chunk arrival, not per stage — see §8 streaming loop.

---

## 7. LLM Client (extends MYT-44)

This milestone does **not** introduce a new LLM client — it consumes and extends MYT-44's wrapper layer (Vercel AI SDK v6 + `@ai-sdk/anthropic` + `wrapLanguageModel` middleware + typed error classes + prompt loader).

### What MYT-44 Already Ships

- `backend/src/llm/models.ts` — `HAIKU`, `SONNET`, `OPUS` tier-named `wrapLanguageModel`-wrapped constants. Model IDs pinned via `CLAUDE.md`.
- `backend/src/llm/middleware.ts` — `logAndNormalizeMiddleware(modelId)` wraps `doGenerate`, emits `event: 'llm.call'` log line with `{ model, inputTokens, outputTokens, totalTokens, latencyMs, finishReason, sessionId?, userId? }` on success, `event: 'llm.error'` on failure. Threads context via `providerOptions.mythrun = { sessionId, userId }`.
- `backend/src/llm/errors.ts` — 7 typed Mythrun error classes + `mapToMythrunError(err)`.
- `backend/src/llm/prompts.ts` — `loadPrompt(area, name, vars?)` reads `.txt` templates from `backend/src/llm/prompts/<area>/<name>.txt`, interpolates `{{vars}}`, caches per-process.
- `backend/src/llm/schemas/` — Zod schema registry; this milestone adds the prep-pipeline schemas alongside the existing `profanity.ts`.

### What This Milestone Adds to the LLM Layer

#### 7.1 `wrapStream` middleware coverage

MYT-44 deliberately deferred streaming. The streaming stages in this pipeline (`world_and_factions`, `locations_and_npcs`, `character_integration`) need it. Extend `logAndNormalizeMiddleware` with a `wrapStream` implementation:

- Records start timestamp at stream open.
- On each `text-delta` / `object` event, forwards transparently.
- On stream completion, emits a single `event: 'llm.call'` log line with aggregated tokens (Vercel SDK reports usage on the final event of the stream).
- On stream error, emits `event: 'llm.error'`, maps to Mythrun error, throws.
- Threads `providerOptions.mythrun = { worldId, campaignId?, userId?, stage }` so log lines attribute cost to the right pipeline run.

The stage-level cost tracker reads the log line and writes `pipeline_runs.input_tokens / output_tokens / cost_usd` for the `(scope_id, stage)` row.

#### 7.2 `streamObject` call pattern

The three streaming stages call `streamObject({ model, schema, system, prompt, providerOptions, maxRetries })`. The worker iterates `result.partialObjectStream` (Vercel's incremental-parse stream of best-effort partial JSON trees) and runs the entity-extraction loop described in §8.

#### 7.3 Per-stage cost tracking

A small helper (`recordPipelineUsage(pool, { runId, scopeId, stage, usage })`) writes the per-stage token + cost row. Called once per stage at completion (success or failure). Cost computed as `(input_tokens / 1e6) × input_rate_per_million + (output_tokens / 1e6) × output_rate_per_million` from the same rate map MYT-43 maintains. No second source of truth — both code paths import the rate map.

### What's Dropped From the Original Spec

- **`createLlmClient` / `generateStructured` / `wrapClientForStage`** — the prototype's hand-rolled SDK wrapper. Vercel SDK supersedes; not ported.
- **3-tier prompt-repair chain (primary → Haiku → Sonnet)** — Vercel SDK's `maxRetries` covers transient retries. Structured-output failures throw `LlmStructuredOutputError` which the worker handles via BullMQ stage retry. The prototype's "ask Haiku to fix the malformed JSON" pattern is *not* ported. If structured-output failures prove costly in practice, re-introducing it as a custom Vercel `transformParams` middleware is a follow-up; not a launch dependency.
- **Per-process LLM client instance** — Vercel's model constants are module-scoped already; no factory needed.
- **`getModelForStage` reading from `settings`** — runtime model selection is a non-launch feature. The hard-coded mapping in `pipeline-config.ts` plus a `settings` override hook is the launch shape; the override hook is wired but the only writer is a manual `UPDATE settings` for ops use. No admin UI.

---

## 8. Pipeline Status, Streaming, and Entity Events

### Status Model

Pipeline status is derived from `pipeline_runs` rows. Two scope axes (world-gen + campaign-setup) compose into a phase:

```typescript
type PipelinePhase =
  | 'not_started'
  | 'world_gen'            // world-gen job running or pending
  | 'world_gen_failed'     // world-gen exhausted retries
  | 'world_ready'          // world complete, no campaign yet
  | 'character_creation'   // at least one character-creation job running
  | 'post_creation'        // barrier waiting / post-stages running
  | 'complete'             // campaign.status = 'active'
  | 'failed'               // unrecoverable
```

### Real-Time Progress via SSE

The API exposes two SSE endpoints:

- `GET /api/worlds/:id/status/stream` — open while a world is generating
- `GET /api/campaigns/:id/status/stream` — open while a campaign is setting up

Server-side, both subscribe to a Redis pub/sub channel on `redisRealtime`:

- `pipeline:world:{worldId}` for world-gen events
- `pipeline:campaign:{campaignId}` for campaign-setup events

The worker publishes events to those channels; the API forwards each message to all attached SSE subscribers for the given scope. SSE is the only realtime surface — there is **no polling fallback**. Clients that need a one-shot snapshot use the non-streaming `GET /api/worlds/:id/status` / `GET /api/campaigns/:id/status` endpoint, which reads `pipeline_runs` directly and returns the current phase + per-stage state. (Used by the dev tool on initial page load, then SSE for live updates.)

### Event Type Union

Every SSE event has the shape `{ type, ...payload }`. The full union for both channels:

```typescript
type PipelineEvent =
  | { type: 'phase'; phase: PipelinePhase }
  | { type: 'stage-started'; stage: string; userId?: string; startedAt: string }
  | { type: 'stage-completed'; stage: string; userId?: string; durationMs: number; costUsd: number }
  | { type: 'stage-failed'; stage: string; userId?: string; errorCode: string; willRetry: boolean }
  | { type: 'stage-reset'; stage: string; userId?: string }   // streaming Zod-fail → re-roll; UI drops this stage's entities
  | { type: 'entity-added'; stage: string; synthKey: string; entityKind: EntityKind; data: Partial<EntityShape> }
  | { type: 'entity-updated'; synthKey: string; patch: Partial<EntityShape> }
  | { type: 'edge-added'; stage: string; synthKey: string; from: string; to: string; kind: string; data: Partial<EdgeShape> }
  | { type: 'finalized'; mapping: Record<string, string> }   // synthKey → real UUID, emitted after stage persister commits
  | { type: 'cost-update'; cumulativeUsd: number }
  | { type: 'job-failed'; jobType: 'world-gen' | 'character-creation' | 'post-creation'; errorCode: string }

type EntityKind = 'location' | 'faction' | 'npc' | 'pc'
```

`stage-started` / `stage-completed` / `stage-failed` fire for **every** stage. `entity-added` / `entity-updated` / `edge-added` / `stage-reset` / `finalized` fire only for the streaming stages (★ in §3 + §4).

### Streaming + Entity Extraction Loop

For each streaming stage:

```
1.  Worker calls llm.streamObject({ model: OPUS, schema, system, prompt, providerOptions })
2.  Worker iterates result.partialObjectStream (yields incremental partial-parse trees)
3.  After each delta:
      - diff partialTree against lastEmitted state
      - for each new entry at a graph-bearing array path:
          if entry.name field is closed AND not yet emitted:
              synthKey = `${stage}/${arrayPath}/${index}`
              publish entity-added { stage, synthKey, kind, data }
              mark emitted[synthKey] = currentSnapshot
      - for each previously-emitted entry whose snapshot grew:
          publish entity-updated { synthKey, patch }
      - heartbeat job.updateProgress so BullMQ doesn't think we stalled
4.  Stream completes → Vercel SDK returns final result.object (full validated tree)
5.  Worker persists final tree to Postgres (entities + prose_kernels + facts + relationships)
6.  Worker publishes finalized { mapping: synthKey → real UUID } so the client swaps its synthetic keys for persisted IDs
7.  pipeline_runs row → status='completed', cost_usd written from the aggregated log line
```

**"Name field closed" detection** — Vercel's `partialObjectStream` already emits well-formed best-effort trees; an entry is considered emitable when its `name` field is a non-empty string AND at least one other field has begun (so we know we're past the `{ "name": ...,` boundary, not mid-write of the name). Edge cases of LLM emitting a placeholder name then revising are handled by `entity-updated`.

### Synthetic Stable Keys

During streaming the entity has no Postgres UUID. The client needs a stable identifier so subsequent `entity-updated` events land on the same graph node. The worker assigns:

```
synthKey = `${stage}/${arrayPath}/${index}`
```

Examples:
- `world_and_factions/regions/0`
- `world_and_factions/factions/2`
- `locations_and_npcs/npcs/4`

Stable across all events for the same array index. When persistence completes, the `finalized` event emits the full mapping so the client can swap the graph's internal IDs to the real UUIDs (or just retain the synthKeys for the lifetime of the page).

### Rollback Semantics (Zod-fail re-roll)

If `streamObject` ultimately fails Zod validation and BullMQ retries the stage, the client has seen entities that won't exist in the final world. The worker emits a `stage-reset` event before re-rolling; the client drops all `entity-added` / `edge-added` events bearing that stage's prefix and prepares to receive fresh ones. UX caveat: entities pop in, then vanish, then come back differently. Truthful to what's happening.

### Cross-Reference Ordering (Edges)

Stage 3 NPCs reference factions and locations. The worker emits `edge-added` only after both `entity-added` for `from` and `to` have already fired. Two options for enforcement:
- Defer edge emission until the streaming pass completes — emit all edges at end of stream. Simplest; rules out edge-flicker.
- Track unresolved edges in a buffer; flush each as soon as both endpoints exist.

Launch picks option 1 (deferred edge emission). Faster to implement, no buffer correctness concerns; the small UX cost is edges appearing in a burst at stage end rather than progressively.

### Worker → API Bridge

The worker writes events to `redisRealtime` via `PUBLISH`. The API process holds one persistent subscriber per active SSE connection (subscribed to the channel for the worldId/campaignId the client is watching). On client disconnect, the API tears down the subscription.

Connection-leak safeguards:
- API tracks open SSE connections per process; metrics emitted hourly.
- Server-side timeout on SSE connections: 30 minutes idle without an event → close. Client reconnects + resyncs via the non-streaming status endpoint.

### Session Prep (Streaming) — Out of This Milestone

Session prep generation is invoked at session start, not as part of the prep pipeline. It is owned by Session Runtime. The original spec's session-prep streaming pattern (FT-context-with-Haiku-leak-validation) is dropped from this milestone's surface and moved to Session Runtime. The `session_preps` table stays in the schema; no inserts happen until that milestone ships.

---

## 9. API Routes

All routes opt in to rate limiting per MYT-45 (`config.rateLimit: { max, timeWindow, keyGenerator? }`). World/campaign create are tight and per-sub keyed (the threat is one user blowing the credit-check by burst-creating). SSE stream routes are looser since they hold one connection per pipeline. List/read routes are at the default per-IP rate.

### World Routes

| Method | Path | Auth | Rate limit | Purpose |
|--------|------|------|---|---------|
| POST | `/api/worlds` | JWT + onboarded | 5/min per-sub | Create a world. Validates concept, debits 1 `world_gen` credit, enqueues `world-gen` job. |
| GET | `/api/worlds/:id` | JWT + onboarded + (owner or member of a campaign on this world) | 60/min per-IP | Get world details + entities |
| GET | `/api/worlds/:id/status` | JWT + onboarded + access | 60/min per-IP | One-shot pipeline status snapshot (no streaming) |
| GET | `/api/worlds/:id/status/stream` | JWT + onboarded + access | 10/min per-IP (rate-limits the *connection-open* rate, not events) | SSE stream — emits the §8 event union |
| POST | `/api/worlds/:id/resume` | JWT + onboarded + owner | 5/min per-sub | Re-enqueue a failed world-gen job (idempotent — picks up at first non-completed stage) |
| GET | `/api/worlds/mine` | JWT + onboarded | 30/min per-IP | List worlds owned by the current user. Trivial at launch (≤1 active world per typical user). |

**Cut from original spec:** `GET /api/worlds/public` — marketplace browsing is deferred with the rest of the fork story (§5).

### Campaign Routes

| Method | Path | Auth | Rate limit | Purpose |
|--------|------|------|---|---------|
| POST | `/api/campaigns` | JWT + onboarded | 5/min per-sub | Create a campaign on a world the user owns. No fork. |
| GET | `/api/campaigns/:id` | Member | 60/min per-IP | Get campaign details + members + characters |
| GET | `/api/campaigns/:id/status` | Member | 60/min per-IP | One-shot campaign-setup status snapshot |
| GET | `/api/campaigns/:id/status/stream` | Member | 10/min per-IP | SSE stream |
| GET | `/api/campaigns/:id/starting-situations` | Member | 30/min per-IP | Three location hooks from the world's `starting_situations` |
| POST | `/api/campaigns/:id/characters` | Member | 5/min per-sub | Submit this player's character concept (one per `(campaign_id, user_id)`). When all members have submitted, the owner can trigger creation. |
| POST | `/api/campaigns/:id/start-character-creation` | Owner | 2/min per-sub | Fan out per-player BullMQ jobs + enqueue barrier. Returns the per-player job IDs. |
| GET | `/api/campaigns/:id/characters` | Member | 30/min per-IP | List all characters in this campaign + their portable shape |
| GET | `/api/campaigns/:id/characters/:charId` | Member | 30/min per-IP | One character with full details (skills/features/equipment/spells) |
| GET | `/api/campaigns/:id/hierarchy` | Member | 30/min per-IP | Entity parent-child hierarchy (graph layout helper) |
| GET | `/api/campaigns/:id/random-tables` | Member | 30/min per-IP | Random tables + entries |
| DELETE | `/api/campaigns/:id` | Owner | 5/min per-sub | Delete (cascade) |
| POST | `/api/campaigns/:id/archive` | Owner | 5/min per-sub | Archive (transitions `setup → archived`) |

**Cut from original spec (moved to Session Runtime):**
- `POST /api/campaigns/:id/session-prep` — session prep generation
- `GET /api/campaigns/:id/session-preps` — session prep listing
- `GET /api/campaigns/:id/session-preps/:prepId` — single session prep
- `POST /api/campaigns/:id/reset-prep` — session-prep reset
- `POST /api/campaigns/:id/reset-to-session/:n` — snapshot restore

The `session_preps` and `world_snapshots` tables stay in the schema; they get no writes until Session Runtime ships.

### Resume Endpoint Behavior

`POST /api/worlds/:id/resume`:

1. Owner-only.
2. Reads `pipeline_runs` for `(world_id, *)`. If all stages are `completed`, return 200 + `{ already_complete: true }`.
3. If any stage is `failed`: reset the failed stage to `pending`, re-enqueue the `world-gen` job. Idempotency (§3) means already-completed stages skip.
4. If any stage is `running` and `started_at < now() - 60s`: same as failed (stalled). If `running` and recent: 409 + `{ code: 'job_still_running' }`.

There is no `POST /api/campaigns/:id/resume` endpoint at launch — campaign-setup resume is implicit by re-running `POST /api/campaigns/:id/start-character-creation`; the API fans out only for players whose per-player `pipeline_runs.status != 'completed'`.

---

## 10. What Ports From the Prototype

### Ported With Minimal Adaptation

| Artifact | Source (prototype) | Production location | Adaptation |
|----------|--------|----|----|
| `concept-intake.txt` | `backend/src/llm/prompts/` | `backend/src/llm/prompts/prep/concept-intake.txt` | None |
| `world-and-factions.txt` | Same | `prep/world-and-factions.txt` | None |
| `locations-and-npcs.txt` | Same | `prep/locations-and-npcs.txt` | None |
| `starting-situation.txt` | Same | `prep/starting-situation.txt` | None |
| `random-tables.txt` | Same | `prep/random-tables.txt` | None |
| `character-concept.txt` | Same | `prep/character-concept.txt` | None |
| `character-sheet.txt` | Same | `prep/character-sheet.txt` | None |
| `character-integration.txt` | Same | `prep/character-integration.txt` | **Multi-PC content rewrite** — prototype assumed a single PC; the prompt must now reason about every existing PC in the world (their concept, factions, locations) so NPC reactions and relationship facts are coherent across the party. This is real prompt-engineering work, not a port. |
| `continuity-check.txt` | Same | `prep/continuity-check.txt` | **Multi-PC content rewrite** — same reason. The check must surface inconsistencies *between* PCs (Player A is wanted by faction X; Player B is sworn to faction X; the prompt didn't see Player A when generating Player B's integration). |
| All Zod schemas (`worldConceptSchema`, etc.) | `backend/src/prep/stages/` | `backend/src/llm/schemas/prep/*.ts` alongside MYT-44's existing `profanity.ts` | Same validation |
| Schema helpers (`flexString`, `flexStringArray`) | `backend/src/prep/schema-helpers.ts` | `backend/src/llm/schemas/helpers.ts` | None |
| Universal tables (appearance, personality, etc.) | `backend/src/data/tables/universal/` | `backend/src/data/tables/universal/` | Copied as-is |
| Seed tables (`seed-tables.json`) | `backend/src/data/tables/` | Same | Copied as-is |
| SRD reference data | `backend/src/data/srd/` | Same | Copied as-is |
| Canonical names builder | `backend/src/prep/stage-dispatch.ts` | `backend/src/prep/canonical-names.ts` | Adapted for `world_id` scope |
| Random table roller | `backend/src/tables/roller.ts` | Same | None |
| Operations engine (for continuity check) | `backend/src/prep/operations.ts` | `backend/src/prep/operations.ts` | Async `pg` |
| World state serializer | `backend/src/prep/serializer.ts` | Same | Adapted for multiple PCs |

### Rewritten (New Architecture)

| Component | Why |
|-----------|-----|
| Orchestrator (`runWorldGenPipeline`, `runCharacterCreation`) | BullMQ jobs, `world_id` scope, parallel character creation, idempotent stage retries via `pipeline_runs` |
| Persisters (all) | Async Postgres, `world_id` instead of `campaign_id`, idempotent (DELETE-then-INSERT keyed on `(scope_id, stage)`) |
| Loaders (all) | Async Postgres queries |
| Status derivation | Two scope axes (world / campaign) compose into a phase; SSE event union from §8 |
| Pipeline status API | SSE-only realtime + non-streaming one-shot snapshot |
| Streaming entity extraction | New — `streamObject` + partial-JSON-driven entity events |

### Not Ported

| Component | Why dropped |
|---|---|
| `createLlmClient`, `generateStructured`, `wrapClientForStage` | MYT-44's Vercel SDK layer supersedes |
| 3-tier prompt-repair chain (primary → Haiku → Sonnet) | Vercel SDK's `maxRetries` + BullMQ stage retry covers transient + structured-output failure. Possible future re-introduction as a custom middleware if data shows it's needed. |
| 3-second polling | Replaced by SSE-only |
| Session prep streaming | Moved to Session Runtime milestone |
| Snapshot capture, snapshot restore | Moved to Session Runtime milestone |
| `pipeline_status` table (if the prototype had one) | Derived from `pipeline_runs` |

---

## 11. Schema Changes Required

The current schema (migrations 001–008) is mostly correct for this milestone. Two changes are required:

### 11.1 Character portability — migration 009 (planned)

The current `characters` table has `campaign_id UUID NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE`. Per the day-one launch posture, characters must be user-owned with a join table for campaign membership so future cross-campaign portability works without a follow-up migration.

Required changes:

```sql
-- 009_character_portability.sql

-- characters becomes user-owned. campaign_id is removed; user_id becomes NOT NULL.
ALTER TABLE characters ALTER COLUMN user_id SET NOT NULL;
ALTER TABLE characters DROP CONSTRAINT characters_campaign_id_fkey;
ALTER TABLE characters DROP COLUMN campaign_id;

-- New join table for campaign membership of characters.
CREATE TABLE campaign_characters (
  id UUID PRIMARY KEY,
  campaign_id UUID NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
  character_id UUID NOT NULL REFERENCES characters(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  joined_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (campaign_id, character_id),
  UNIQUE (campaign_id, user_id)  -- one character per user per campaign at launch
);

CREATE INDEX idx_campaign_characters_user ON campaign_characters(user_id);
CREATE INDEX idx_campaign_characters_character ON campaign_characters(character_id);

-- Existing dependents that reference characters.campaign_id (e.g., session_participants)
-- already reference characters.id directly; no changes needed there.
```

Greenfield: no production data to migrate; the `characters` table is empty.

Companion code change: `repo.characters` API gains `listForCampaign(campaignId)`, `addToCampaign(campaignId, characterId)`, `findUserCharacterForCampaign(userId, campaignId)`. Callers stop using `characters.campaign_id` (which no longer exists).

### 11.2 Campaign status enum — possibly migration 010

If operator UX during launch surfaces a real need to distinguish "abandoned setup" from "pipeline failed and stuck," extend `campaigns.status` CHECK constraint to admit `'failed'`. Not a blocker for launch — pipeline failures are visible via `pipeline_runs.status='failed'`. Tracked as a possible follow-up.

No other schema changes are needed by this milestone. Worlds, entities, prose_kernels, facts, relationships, entity_hierarchy, random_tables, random_table_entries, pipeline_runs, characters' sub-tables (skills/features/equipment/spells) all carry the right shape from migration 001.

---

## 12. Dev Tool Front-End

The dev tool is a throwaway development utility built in this milestone so the engineer (and only the engineer) can exercise the prep pipeline end-to-end before the real player frontend exists. It is **explicitly NOT a prototype of the real frontend.** No components built here are intended to survive into the production UI.

### 12.1 Scope of the Dev Tool

- Trigger world creation against either the local dev API or the deployed staging API.
- Watch a world generate in real time — phase + per-stage progress + the live entity graph populating as `entity-added` events arrive over SSE.
- Trigger campaign creation on that world, configure 2–5 players (impersonating different dev-sub identities), submit character concepts, kick off parallel character creation, watch each player's character integration stream.
- Inspect the final world: list entities, prose kernels, facts, relationships, random tables.
- Trigger resume of a failed pipeline.

### 12.2 Architecture

A single Vite-built SPA at `backend/dev-tool/` (sibling of `backend/src/`). Visual treatment styled after the wiki (`docs/wiki/`) — terse, single-column, monospace headings, minimal chrome. Tech stack details are not load-bearing; pick whatever works. Use bare SVG circles + lines for the graph (force-directed if convenient; static positions are fine). Do **not** reuse any code from the dev tool in the eventual production frontend.

The tool runs in two modes:
- **Local dev** — `pnpm dev:dev-tool` boots Vite on a local port; calls `http://localhost:3000/api/*`.
- **Staging** — same SPA, deployed to staging at a distinct URL (exact hosting / path TBD during implementation — S3+CloudFront under a dev-only subdomain, or served from the API ALB under `/dev-tool/`, whichever is least friction). Production deploys do **not** include the dev tool.

The tool has an environment switcher at the top of the page (a dropdown selecting which API base URL to call). Both modes call the live API and live SSE endpoints.

### 12.3 Auth in the Dev Tool

The dev tool reuses the existing bypass-plugin auth path (`x-mythrun-dev-sub` header), already wired for development. The tool stores the active "dev user" identity in `localStorage` and lets the user switch between fake identities (`dev-user-1`, `dev-user-2`, …) — this is how multi-player flows are exercised by one human. The plugin's 6-layer defense ensures the bypass header is rejected in production environments; the dev tool's production build path is excluded from production deploys regardless.

### 12.4 Hard Boundaries

- The dev tool ships to staging; it does **not** ship to production.
- It uses the same routes as the real frontend will — no special "dev-tool" routes added to the API.
- It does not maintain its own state model; it reads from `GET /status` on load and SSE thereafter.
- Code is not factored for reuse. When the real frontend lands, the dev tool stays as an internal debugging surface; the production app is a clean build.

---

## 13. Out of Scope

| Feature | Deferred To |
|---------|------------|
| World forking (cross-user, marketplace) | Future fork sub-spec; schema columns inert at launch (§5) |
| World marketplace (browsing, ratings, payouts) | Future marketplace sub-spec |
| `GET /api/worlds/public` route | Folded into the fork deferral |
| `GET /api/worlds/mine` picker UX | Backend route stays trivial; no picker UI |
| Session prep generation | Session Runtime milestone |
| Snapshot capture / restore / `reset-to-session` | Session Runtime milestone |
| Between-session world observer | Future — architecture supports it, not at launch |
| Hierarchical location generation (region > settlement > place) | Future prompt revision, no schema change needed |
| Interactive character creation (Q&A loop) | Future — single-shot for launch |
| World editing UI (manually modify entities/facts) | Future |
| Pipeline cancellation (abort a running world gen mid-stream) | Future — kill the BullMQ job |
| Prompt A/B testing framework | Future |
| Per-stage runtime model override admin UI | Future — manual `UPDATE settings` works for ops use at launch |
| Auto-refund on stuck-job dead-letter | Future — operator-action at launch |
| Re-introduction of 3-tier prompt-repair chain | Future, only if structured-output failure rates justify it |
| The "real" player frontend | Frontend milestone (separate from this) — the dev tool is NOT a precursor |
