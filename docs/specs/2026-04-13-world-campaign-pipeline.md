# World & Campaign Pipeline Sub-Spec

> **Type**: Sub-spec (conforms to Production Architecture Overview)
> **Date**: 2026-04-13
> **Status**: Draft
> **Parent**: `2026-04-06-production-architecture-overview.md`
> **Depends on**: Backend Core (schema, repository, BullMQ worker skeleton), Auth & Users (user identity), Billing (world_gen credit debit)
> **Scope**: Rewrite of the prep engine pipeline for the new world/campaign model. World gen pipeline, campaign setup pipeline (with parallel per-player character creation), world forking, BullMQ job orchestration, pipeline status API. Ports proven prompt templates and Zod schemas from the prototype with minimal changes.

---

## Table of Contents

1. [Overview](#1-overview)
2. [Pipeline Architecture](#2-pipeline-architecture)
3. [World Gen Pipeline](#3-world-gen-pipeline)
4. [Campaign Setup Pipeline](#4-campaign-setup-pipeline)
5. [World Forking](#5-world-forking)
6. [BullMQ Job Orchestration](#6-bullmq-job-orchestration)
7. [LLM Client Reuse](#7-llm-client-reuse)
8. [Pipeline Status and Progress](#8-pipeline-status-and-progress)
9. [API Routes](#9-api-routes)
10. [What Ports From the Prototype](#10-what-ports-from-the-prototype)
11. [Out of Scope](#11-out-of-scope)

---

## 1. Overview

The pipeline system generates worlds and sets up campaigns. It is the most LLM-intensive part of Mythrun — a full world gen costs $3-5 in API calls, and each player's character creation costs $1-2.

### What Changed From the Prototype

| Aspect | Prototype | Production |
|--------|-----------|-----------|
| Scope | Single `campaign_id` for everything | `world_id` for world gen, `campaign_id` for campaign setup |
| Execution | Fire-and-forget `void` promises | BullMQ job queue with retries, dead letter, back-pressure |
| Character creation | One player, sequential | 2-5 players, parallel per-player |
| Database | Sync SQLite (`better-sqlite3`) | Async Postgres (`pg`) |
| Process | Same process as API server | Separate Worker ECS service |
| Cost tracking | In-memory accumulation | Redis counters + Postgres persistence |
| Credit gate | None | World gen deducts `world_gen` credit; session start deducts `session` credit |

### What Didn't Change

- Stage logic and prompt templates (proven through months of iteration)
- Zod schemas for LLM output validation
- 3-tier repair chain (primary model → Haiku → Sonnet)
- Canonical names system (prevents LLM name drift between stages)
- Random table roller (universal tables for NPC trait seeds)
- Pipeline state machine (pending → running → completed | failed)

---

## 2. Pipeline Architecture

Two pipelines operating on different scopes:

```
USER CREATES A WORLD
        │
        ▼
┌─────────────────────────────────────────┐
│  World Gen Pipeline (world_id scope)     │
│                                          │
│  concept_intake                          │
│      ↓                                   │
│  world_and_factions                      │
│      ↓                                   │
│  locations_and_npcs                      │
│      ↓                                   │
│  starting_situation                      │
│      ↓                                   │
│  random_tables                           │
│                                          │
│  → World status: 'complete'              │
└─────────────────────────────────────────┘

USER CREATES A CAMPAIGN (from a world)
        │
        ▼
┌─────────────────────────────────────────┐
│  Campaign Setup Pipeline (campaign_id)   │
│                                          │
│  world_fork (if from shared world)       │
│      ↓                                   │
│  ┌── Player 1 ──┐  ┌── Player 2 ──┐     │
│  │ location_sel  │  │ location_sel  │    │
│  │ char_concept  │  │ char_concept  │    │
│  │ char_sheet    │  │ char_sheet    │    │
│  │ char_integr.  │  │ char_integr.  │    │
│  └───────────────┘  └───────────────┘    │
│      ↓ (all players done)                │
│  materialize_relationships               │
│      ↓                                   │
│  continuity_check                        │
│      ↓                                   │
│  → Campaign status: 'active'             │
│  → World snapshot captured               │
└─────────────────────────────────────────┘
```

---

## 3. World Gen Pipeline

### Stages

All stages operate on `world_id`. Each stage reads prior outputs from Postgres (never in-memory), calls the LLM via `generateStructured`, validates against a Zod schema, and persists results.

#### Stage 1: `concept_intake`

- **Input**: `worlds.concept` (freeform text from the user)
- **Output**: `WorldConcept` — name, tone, themes, geography, politics, era, tensions, follow-up questions
- **Persists**: Updates `worlds` table columns
- **Model**: Configurable per `getModelForStage('concept_intake')` (default: Opus)
- **Prompt**: `concept-intake.txt` (ported from prototype)

#### Stage 2: `world_and_factions`

- **Input**: `WorldConcept` + canonical names
- **Output**: 3 regions, 3 factions with relationships, secrets, goals
- **Persists**: Creates `entities` (type=location, type=faction) + `prose_kernels` + `facts`. Updates `worlds.world_overview`
- **Model**: Configurable (default: Opus)
- **Prompt**: `world-and-factions.txt` (ported)

#### Stage 3: `locations_and_npcs`

- **Input**: `WorldConcept`, factions output, canonical names, 6 NPC name seeds, 6 NPC trait seeds (rolled from universal tables)
- **Output**: 6 locations, 6 NPCs, referenced locations, cross-faction connections
- **Persists**: Creates entities + prose kernels + facts + relationships + entity_hierarchy
- **Model**: Configurable (default: Opus)
- **Prompt**: `locations-and-npcs.txt` (ported)

#### Stage 4: `starting_situation`

- **Input**: All prior world data + canonical names
- **Output**: 3 location hooks (location_name, why_interesting)
- **Persists**: Updates `worlds.starting_situations` (JSON)
- **Model**: Configurable (default: Opus)
- **Prompt**: `starting-situation.txt` (ported)

#### Stage 5: `random_tables`

- **Input**: `WorldConcept` + seed tables from `data/tables/seed-tables.json`
- **Output**: 2 campaign-specific d20 tables (20 entries each)
- **Persists**: Creates `random_tables` + `random_table_entries`
- **Model**: Configurable (default: Haiku)
- **Prompt**: `random-tables.txt` (ported)

### Credit Gate

Before starting the world gen pipeline, the API deducts one `world_gen` credit from the owner's ledger (atomic debit, same pattern as session credits). If insufficient credits, return 402.

### Completion

When all 5 stages complete: set `worlds.status = 'complete'`. The world is now ready for campaign creation.

---

## 4. Campaign Setup Pipeline

### Pre-requisites

- A completed world (`worlds.status = 'complete'`)
- At least one player with a character concept submitted
- Campaign owner has session credits (not checked here — checked at session start)

### Stage: `world_fork` (conditional)

Only runs if the campaign is based on a shared world (`campaign.source_world_id IS NOT NULL`). See section 5.

### Per-Player Character Stages (Parallel)

Each player runs these 4 stages independently and in parallel:

#### `location_selection` (no LLM)
- **Input**: Player's chosen starting location name
- **Persists**: Creates a fact on the location entity marking it as the player's starting location

#### `character_concept`
- **Input**: WorldConcept, starting location, player's character concept + reason for being here
- **Output**: Name, class suggestion, level, species, background, backstory, personality
- **Persists**: Creates `characters` row (placeholder stats) + updates `campaigns` record
- **Model**: Configurable (default: Opus)

#### `character_sheet`
- **Input**: Character concept + SRD reference data
- **Output**: Ability scores, HP, AC, skills, features, equipment, spells
- **Validation**: Standard array check, proficiency bonus validation. Up to 3 retries with error injection.
- **Persists**: Updates `characters` + creates sub-table rows
- **Model**: Configurable (default: Opus)

#### `character_integration`
- **Input**: WorldConcept, character concept, factions, NPCs, starting location
- **Output**: Prose kernel, NPC relationships, faction standings, starting facts
- **Persists**: Creates PC entity (type=npc), links to character, creates relationships + facts
- **Model**: Configurable (default: Opus)

### Parallel Execution Model

When the campaign owner triggers character creation:
1. Each player who has submitted their concept gets a parallel BullMQ job
2. All per-player jobs run concurrently (one BullMQ job per player, each runs 4 stages sequentially)
3. A "barrier" job waits for all per-player jobs to complete
4. Post-creation stages run after the barrier

```
Player 1 job: location_sel → concept → sheet → integration ─┐
Player 2 job: location_sel → concept → sheet → integration ─┤
Player 3 job: location_sel → concept → sheet → integration ─┤
                                                             ↓
                                                     [barrier: all done]
                                                             ↓
                                              materialize_relationships
                                                             ↓
                                                     continuity_check
```

### Post-Creation Stages (Sequential, After All Players)

#### `materialize_relationships` (no LLM)
- Same logic as prototype: converts implicit relationships stored as facts into explicit `relationships` rows
- Now also materializes relationships for ALL player characters (not just one)

#### `continuity_check`
- **Input**: Full serialized world state (now including multiple PCs) + entity ID table
- **Output**: Array of `WorldFix` operations
- **Persists**: Executes fixes via the operations engine
- **Model**: Configurable (default: Opus)

### Completion

After continuity check: set `campaigns.status = 'active'`, capture a `post_pipeline` world snapshot.

### Additional Campaign Status Transitions

- `setup → archived` — Owner manually archives a campaign before pipeline completes (e.g., abandoned setup).
- `setup → failed` — Pipeline failure exhausts retries (all BullMQ attempts for a stage fail). The campaign is marked `failed` and the owner can retry or delete.

---

## 5. World Forking

When a campaign uses a shared world (from the marketplace or another user's public world):

### Fork Procedure

1. Create a new `worlds` row:
   - `source_world_id` = original world ID
   - Copy all metadata columns (name, tone, themes, etc.)
   - `status = 'complete'` (the fork is immediately ready)
   - `is_public = false` (forks are private)

2. Deep-copy all world content with new UUIDs:
   - `entities` → new IDs, same `world_id` = fork's ID
   - `prose_kernels` → new IDs, linked to new entity IDs
   - `facts` → new IDs, linked to new entity IDs
   - `relationships` → new IDs, linked to new entity IDs
   - `entity_hierarchy` → new IDs, linked to new entity IDs
   - `random_tables` → new IDs + `random_table_entries`

3. Build an ID mapping table (old UUID → new UUID) used to rewrite foreign key references during the copy.

4. Point the campaign at the forked world: `campaigns.world_id = fork.id`

5. Increment `fork_count` on the source world (separate transaction, not in the copy transaction — per architecture overview decision).

### Implementation

The fork is a single Postgres transaction containing INSERT...SELECT statements that generate new UUIDs and remap references:

```sql
-- Simplified: actual implementation uses a CTE chain or temp table for the ID mapping
WITH entity_map AS (
  INSERT INTO entities (id, world_id, entity_type, name, ...)
  SELECT gen_random_uuid(), $forkWorldId, entity_type, name, ...
  FROM entities WHERE world_id = $sourceWorldId
  RETURNING id AS new_id, (SELECT id FROM entities WHERE ...) AS old_id
)
INSERT INTO prose_kernels (id, entity_id, content, ...)
SELECT gen_random_uuid(), entity_map.new_id, pk.content, ...
FROM prose_kernels pk
JOIN entity_map ON pk.entity_id = entity_map.old_id;
```

The exact SQL will be worked out during implementation. The key constraint: the entire fork must be atomic (one transaction). A partial fork is worse than no fork.

### Fork Cost

Forking is free (no LLM calls). The deep copy is pure SQL. The cost was paid by whoever generated the original world.

---

## 6. BullMQ Job Orchestration

### Queue Architecture

Two queues on the batch Redis instance:

| Queue | Purpose | Concurrency |
|-------|---------|-------------|
| `world-gen` | World generation pipeline jobs | 3 (limit concurrent Anthropic API load) |
| `campaign-setup` | Campaign setup jobs (per-player + post-creation) | 5 |

### Job Types

#### `world-gen` Queue

```typescript
interface WorldGenJob {
  type: 'world-gen'
  worldId: string
  userId: string  // for credit attribution
  startFromStage?: string  // for resume after failure
}
```

One job per world. The worker runs all 5 stages sequentially within the job. If a stage fails, the job fails and BullMQ handles retry.

#### `campaign-setup` Queue

```typescript
interface CharacterCreationJob {
  type: 'character-creation'
  campaignId: string
  worldId: string
  userId: string  // the player
  characterConcept: string
  startingLocationName: string
  reasonForBeingHere: string
}

interface PostCreationJob {
  type: 'post-creation'
  campaignId: string
  worldId: string
  waitForJobs: string[]  // BullMQ job IDs of all character-creation jobs
}
```

### Retry Strategy

| Failure Type | Retry | Backoff |
|-------------|-------|---------|
| Anthropic API error (rate limit, 5xx) | 3 attempts | Exponential: 30s, 60s, 120s |
| Zod validation failure (after repair chain) | 2 attempts | Fixed: 10s (re-roll with different LLM temperature) |
| Postgres error | 2 attempts | Fixed: 5s |
| Unknown error | 1 attempt | Fixed: 30s |

After max retries: job moves to dead letter queue. Pipeline stage is marked `failed` in `pipeline_runs`. User sees the failure in the pipeline status UI with an error message and a "Retry" button.

### Back-Pressure

Per architecture overview: the API checks queue depth before accepting new pipeline jobs. If `world-gen` queue has >20 pending jobs, return `503 Service Unavailable` with `Retry-After: 60`.

### Stalled Job Detection

BullMQ's built-in stall detection: if a job doesn't send a heartbeat within 30 seconds, it's considered stalled and re-queued. The worker sends heartbeats between stages:

```typescript
async function processWorldGen(job: Job<WorldGenJob>) {
  for (const stage of WORLD_GEN_STAGES) {
    await runStage(stage, job.data)
    await job.updateProgress(stageIndex / totalStages)  // heartbeat + progress
  }
}
```

---

## 7. LLM Client Reuse

The LLM client (`createLlmClient`) is reused from the prototype with minimal changes:

- Same `generateStructured` interface with 3-tier repair chain
- Same `streamConversation` for session prep streaming
- Same `loadTemplate` + `interpolateTemplate` for prompt templates
- Same cost tracking via `onCallComplete` callback

Changes:
- `wrapClientForStage` now writes usage to `pipeline_runs` via async Postgres (not sync SQLite)
- Model selection via `getModelForStage` reads from Postgres `settings` table (cached in memory with TTL)
- The client instance is created once per Worker process and shared across all jobs

---

## 8. Pipeline Status and Progress

### Status Model

Pipeline status is derived from `pipeline_runs` rows, same as the prototype:

```typescript
type PipelinePhase = 'not_started' | 'world_gen' | 'character_creation' | 'complete' | 'failed'
```

### Real-Time Progress

The prototype used 3-second polling. The production system uses **Redis pub/sub** for real-time updates:

1. When a stage status changes, the worker publishes to `pipeline:{worldId}:progress` (or `pipeline:{campaignId}:progress`)
2. The API server subscribes to this channel for any client that has the pipeline status page open
3. Updates are pushed to the client via Server-Sent Events (SSE) on `GET /api/worlds/:id/status/stream` or `GET /api/campaigns/:id/status/stream`

Fallback: the polling endpoint (`GET /api/worlds/:id/status`) still works for clients that don't support SSE.

### Session Prep (Streaming)

Session prep generation uses the same SSE streaming pattern as the prototype:
1. `POST /api/campaigns/:id/session-prep` → starts generation, returns SSE stream
2. Deltas streamed as `data: {"type":"delta","text":"..."}` events
3. On completion: `data: {"type":"done","ftContext":"...","sdPlaybook":"..."}`
4. FT context validated for secret leakage via Haiku AI call (per ZFC)
5. Persisted to `session_preps` table + world snapshot captured

Session prep runs on the API service (not the Worker) because it needs to stream directly to the client's HTTP connection.

---

## 9. API Routes

### World Routes

| Method | Path | Auth | Purpose |
|--------|------|------|---------|
| POST | `/api/worlds` | JWT | Create a new world (deducts world_gen credit, enqueues world-gen job) |
| GET | `/api/worlds/:id` | JWT + world access | Get world details with entities |
| GET | `/api/worlds/:id/status` | JWT + world access | Get pipeline status (polling) |
| GET | `/api/worlds/:id/status/stream` | JWT + world access | Pipeline status (SSE stream) |
| POST | `/api/worlds/:id/resume` | JWT + owner | Resume a failed pipeline |
| GET | `/api/worlds/public` | JWT | List public worlds (for marketplace browsing) |
| GET | `/api/worlds/mine` | JWT | List worlds created by the current user |

### Campaign Routes

| Method | Path | Auth | Purpose |
|--------|------|------|---------|
| POST | `/api/campaigns` | JWT | Create a campaign from a world (optionally fork) |
| GET | `/api/campaigns/:id` | Member | Get campaign details |
| GET | `/api/campaigns/:id/status` | Member | Campaign pipeline status (polling) |
| GET | `/api/campaigns/:id/status/stream` | Member | Campaign pipeline status (SSE) |
| GET | `/api/campaigns/:id/starting-situations` | Member | Get starting location hooks |
| POST | `/api/campaigns/:id/characters` | Member | Submit character creation input |
| GET | `/api/campaigns/:id/characters` | Member | List all characters in the campaign |
| GET | `/api/campaigns/:id/characters/:charId` | Member | Get character with full details |
| GET | `/api/campaigns/:id/hierarchy` | Member | Entity parent-child hierarchy |
| GET | `/api/campaigns/:id/random-tables` | Member | Random tables with entries |
| POST | `/api/campaigns/:id/session-prep` | Member | Generate session prep (SSE stream) |
| GET | `/api/campaigns/:id/session-preps` | Member | List all session preps |
| GET | `/api/campaigns/:id/session-preps/:prepId` | Member | Get specific session prep |
| DELETE | `/api/campaigns/:id` | Owner | Delete campaign |
| POST | `/api/campaigns/:id/reset-prep` | Owner | Reset session preps |
| POST | `/api/campaigns/:id/reset-to-session/:n` | Owner | Reset to specific session (restore snapshot) |
| POST | `/api/campaigns/:id/archive` | Owner | Archive campaign (transitions setup/active → archived) |

---

## 10. What Ports From the Prototype

### Ported As-Is (minimal adaptation)

| Artifact | Source | Adaptation |
|----------|--------|-----------|
| `concept-intake.txt` | `backend/src/llm/prompts/` | None |
| `world-and-factions.txt` | Same | None |
| `locations-and-npcs.txt` | Same | None |
| `starting-situation.txt` | Same | None |
| `random-tables.txt` | Same | None |
| `character-concept.txt` | Same | None |
| `character-sheet.txt` | Same | None |
| `character-integration.txt` | Same | Update to handle multiple PCs in the world |
| `continuity-check.txt` | Same | Update to check multiple PCs for cross-character consistency |
| `session-prep.txt` | Same | Update to include multiple PCs in world state |
| All Zod schemas (`worldConceptSchema`, etc.) | `backend/src/prep/stages/` | None — same validation |
| Schema helpers (`flexString`, `flexStringArray`) | `backend/src/prep/schema-helpers.ts` | None |
| Template system (`loadTemplate`, `interpolateTemplate`) | `backend/src/llm/templates.ts` | None |
| Universal tables (appearance, personality, etc.) | `backend/src/data/tables/universal/` | Copied as-is |
| Seed tables (`seed-tables.json`) | `backend/src/data/tables/` | Copied as-is |
| SRD reference data | `backend/src/data/srd/` | Copied as-is |
| Canonical names builder | `backend/src/prep/stage-dispatch.ts` | Adapted for `world_id` |
| Random table roller | `backend/src/tables/roller.ts` | None |
| Operations engine (for continuity check) | `backend/src/prep/operations.ts` | Async pg |
| World state serializer | `backend/src/prep/serializer.ts` | Adapted for multiple PCs |

### Rewritten (new architecture)

| Component | Why |
|-----------|-----|
| Orchestrator (`runWorldGenPipeline`, `runCharacterCreation`) | BullMQ jobs, world_id scope, parallel character creation |
| Persisters (all) | Async Postgres, world_id instead of campaign_id |
| Loaders (all) | Async Postgres queries |
| Status derivation | Separate world and campaign phases |
| Pipeline status API | SSE streaming instead of 3s polling |
| Session prep streaming | Same pattern, new routes, Haiku-based validation |
| Snapshot capture/restore | Async Postgres, adapted for multiple characters |

---

## 11. Out of Scope

| Feature | Deferred To |
|---------|------------|
| World marketplace (browsing, ratings, payouts) | Future marketplace sub-spec |
| Between-session world observer | Future — the architecture supports it, but not at launch |
| Hierarchical location generation (region > settlement > place) | Future prompt revision, no schema change needed |
| Interactive character creation (Q&A loop) | Future — single-shot for launch |
| World editing UI (manually modify entities/facts) | Future |
| Pipeline cancellation (abort a running world gen) | Future — kill the BullMQ job |
| Prompt A/B testing framework | Future |
