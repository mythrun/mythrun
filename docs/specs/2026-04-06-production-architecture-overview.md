# Mythrun Production Architecture Overview

> **Type**: Architecture overview spec
> **Date**: 2026-04-06
> **Updated**: 2026-04-08 (scaling review + unit economics + schema fixes)
> **Status**: Draft
> **Scope**: High-level production architecture defining system topology, data model, interface contracts, and sub-project boundaries. Each sub-system gets its own detailed spec that must conform to this document.

---

## Table of Contents

1. [Context and Goals](#1-context-and-goals)
2. [Sub-Project Decomposition](#2-sub-project-decomposition)
3. [System Topology](#3-system-topology)
4. [Data Model](#4-data-model)
5. [Interface Contracts](#5-interface-contracts)
6. [Combat Engine Architecture](#6-combat-engine-architecture)
7. [Error Handling, Observability, and Hardening](#7-error-handling-observability-and-hardening)
8. [LLM Security](#8-llm-security)
9. [Data Privacy](#9-data-privacy)
10. [Decisions Log](#10-decisions-log)

---

## 1. Context and Goals

Mythrun is an AI-powered single-player D&D 5e experience that needs to become a production multi-player product.

### Scale Projections

The profitability target is ~1,000 monthly active paying users. Concurrency projections based on D&D usage patterns:

| Metric | Value | Rationale |
|--------|-------|-----------|
| MAU (target) | 1,000-3,000 | 1K for profitability, 3K as year-one ceiling |
| DAU/MAU ratio | 10-15% | D&D is weekly/biweekly, not daily |
| DAU | 100-450 | Lower engagement frequency than typical SaaS |
| Active play window | ~6 hours/day (6pm-midnight, peaks Fri-Sun) | D&D scheduling patterns |
| Session duration | 2-4 hours average | Standard tabletop session length |
| Peak concurrent sessions | 50-200 | DAU x (session_duration / play_window) |
| Players per session | 2-5 (avg ~3) | Multiplayer party size |
| Peak concurrent WebSocket connections | 150-600 | Sessions x avg players |
| Weekend peak vs weekday | 3-5x | Friday-Sunday evenings dominate |

**Architecture target: 200-500 concurrent sessions at peak.** The architecture supports scaling beyond this via Terraform parameter changes, but launch sizing and redundancy target this range.

### Cost Model Warning

Analysis of the per-session LLM cost structure revealed that **the current session model may be unprofitable at the spec's initial pricing estimates.** Per-turn LLM costs (ST evaluation + FT streaming + Scribe extraction + skill checks) are higher than initially estimated when using Opus for Scribe and ST. The exact cost depends heavily on prompt caching strategy, model choices per stage, and Scribe batching frequency.

**Action required during sub-spec development:** The Multiplayer Session Architecture and Billing sub-specs must include detailed token cost modeling per turn, with specific optimizations (Scribe model selection, Scribe batching frequency, prompt caching strategy). Session pack pricing must be validated against actual per-session LLM costs before launch. This is the single most important business viability constraint.

The current codebase is a well-built prototype with solid domain logic (dual-thinker session model, prep engine pipeline, world store) but zero production infrastructure (no auth, SQLite, single-process, in-memory state).

### Launch Requirements

- **Multi-player sessions**: 2-5 players per campaign with simultaneous chat, AI DM with hybrid trigger (@DM explicit + smart auto-detect), typing indicators, real-time shared narrative
- **Full 5e combat engine**: Mechanically enforced combat with AI-generated voxel battlemaps, initiative/movement/action economy, integrated with DM narration. Leverage existing open-source 5e rules engines where possible.
- **Authentication**: Google + Discord OAuth2 via AWS Cognito
- **Billing**: Session-pack model via Stripe. Campaign owner pays. Free trial (one session in a pre-built world, time-capped, ends on narrative cliffhanger)
- **World/campaign separation**: Worlds are templates; campaigns are personalized forks. Architecture supports a future world marketplace where creators earn payouts when others use their worlds
- **Reliability**: Fast, trustworthy, no flakiness. Users need to feel they can depend on it
- **Frontend redesign**: Premium UI with pixel/voxel design language, Apple-like onboarding, Claude-style chat experience, serif typography, combat mode with Three.js voxel renderer. Requires a proper routing library, code-splitting at module boundaries (lazy-load Three.js/combat, Stripe/billing), and WebSocket reconnection with exponential backoff.
- **Infrastructure**: AWS (ECS Fargate, RDS Postgres, ElastiCache Redis, ALB, Cognito, S3/CloudFront). Terraform IaC. GitHub Actions CI/CD

### Constraints

- Solo developer (with AI assistance), full-time, targeting ~1 month
- **LLM costs are 85-95% of total operating costs** ($1-3 per session in API calls vs ~$140-360/mo infrastructure). Token efficiency is the primary cost lever, not infrastructure optimization.
- No Kubernetes. Managed services wherever possible to minimize ops overhead
- No free standalone features at launch (e.g., free combat engine). Free users incur LLM costs with low conversion rates (2-5%). The free trial session is the acquisition funnel.

### Foundational Principle: Zero Framework Cognition (ZFC)

All application code follows **Zero Framework Cognition** (Steve Yegge, 2025): the application is a thin, deterministic orchestration shell that delegates ALL reasoning and semantic analysis to AI models.

**What code does:** IO, plumbing, schema validation, mechanical computation (dice, movement math), policy enforcement (rate limits, budgets), state management, structured error handling.

**What AI does:** Every decision involving understanding text, classifying intent, resolving ambiguity, detecting patterns in natural language, or making judgment calls. This includes: DM trigger classification, entity resolution, secret leakage detection, content moderation, complexity assessment, and any form of "does this text mean X?"

**The rule:** If you're writing code that tries to "understand" text — regex matching on LLM output, keyword-based routing, heuristic classification — that's a ZFC violation. Call Haiku instead. It's cheap (~$0.80/MTok input) and handles edge cases across languages that pattern matching never will.

**Exceptions:** Explicit UI commands (`@DM` literal match), structural validation (JSON schema, type guards), and mechanical computation (dice rolls, distance calculations) are code, not AI.

This principle is non-negotiable and applies to every sub-spec. See: https://steve-yegge.medium.com/zero-framework-cognition-a-way-to-build-resilient-ai-applications-56b090ed3e69

### ZFC Cost Optimization: Tiered Inference with Confidence-Based Escalation

ZFC delegates reasoning to AI, but not all reasoning needs the most expensive model. Mythrun uses a **tiered inference** pattern (also called cascading inference or model routing): a cheap, fast model (Haiku) handles the initial classification, and only escalates to a more capable model when needed.

The escalation signal is twofold: (1) the classification result itself (e.g., "high complexity"), and (2) **Haiku's confidence**. Low-confidence responses always escalate — Haiku saying "I'm not sure" is a valid and important signal.

| Decision Point | Haiku (Tier 1) | Escalates To | Escalation Trigger |
|---------------|----------------|-------------|-------------------|
| DM trigger + complexity | "Should DM respond? Complexity?" | Slow Thinker (Opus) | High complexity OR low confidence |
| Scribe triage | "Any notable world-state changes?" | Full Scribe extraction (Sonnet) | Yes + entities identified |
| Direction leakage check | "Does this leak secrets?" | Block direction, log for review | Yes OR low confidence |
| Content moderation | "Is this message appropriate?" | Full moderation review | Flagged OR low confidence |
| Combat trigger detection | "Is combat starting?" | Full combat initiation | Yes |

**For the DM trigger specifically:** the Haiku classifier outputs `{ shouldRespond: boolean, complexity: 'low' | 'high', confidence: number }`. Low-complexity + high-confidence turns skip the Slow Thinker entirely — the Fast Thinker responds directly. This saves 5-15 seconds of latency and the Opus API cost per turn. The ST still runs periodically (every N turns) even during low-complexity stretches to maintain narrative oversight.

This pattern is generalizable. Any new decision point in the system should first ask: "Can Haiku handle this cheaply? What's the escalation path if it can't?"

---

## 2. Sub-Project Decomposition

### Full Rewrite, Not Migration

The existing codebase is a developer-facing prototype. The production application is a **full rewrite** in a clean repository, informed by the prototype's domain logic and LLM prompt templates. There is no production data to migrate. The prototype's value is in the validated design decisions (dual-thinker model, enforced ignorance, pre-generated DC tables, world store design) and the LLM prompt templates — not in the code itself.

The decomposition is ordered by dependency. Each sub-project gets its own detailed spec.

### Pre-Build: Design

| # | Sub-Project | Description | Depends On |
|---|-------------|-------------|------------|
| 0a | **UX Design** | Player-facing flows and interactions: campaign/world creation, character creation, the play session, billing/credits, invite flow. This is NOT a frontend implementation spec — it defines what the player experiences, which determines what APIs the backend must serve. | Nothing |

### Week 0: Ops Foundation

| # | Sub-Project | Description | Depends On |
|---|-------------|-------------|------------|
| 0b | **Ops Foundation** | VPC topology, secrets management (AWS Secrets Manager), CI/CD pipeline (GitHub Actions -> ECR -> ECS), staging + prod environments, deployment strategy, CloudWatch logging baseline | Nothing (can parallelize with UX Design) |

### Phase 1: Backend Foundation

| # | Sub-Project | Description | Depends On |
|---|-------------|-------------|------------|
| 1 | **Backend Core** | New Node.js + Fastify project. Postgres schema (all tables), async repository layer (`pg`), server skeleton, health checks, Docker image, first deploy to staging. The ECS/RDS/Redis infrastructure (already spec'd) is applied as part of this deploy. | Ops Foundation, UX Design (for API surface) |
| 2 | **Auth & Users** | Cognito integration, JWT middleware, ticket-based WebSocket auth, user registration, campaign ownership, invite system with codes | Backend Core |
| 3 | **Billing & Cost Controls** | Stripe integration, credit ledger, session packs, token-budget metering, free trial with cliffhanger, checkout flow, webhook handler. Built early because billing gates everything — you can't test sessions without credits. | Auth |

### Phase 2: Game Engine

| # | Sub-Project | Description | Depends On |
|---|-------------|-------------|------------|
| 4 | **World & Campaign Pipeline** | Prep engine rebuilt: world gen stages, campaign fork, character creation stages, continuity check. LLM prompt templates reused from prototype. New persistence layer, BullMQ job queue. | Backend Core |
| 5 | **Multiplayer Session Runtime** | SessionController, FastThinker, SlowThinker, Scribe, SkillCheck, DiceEngine. Redis session state, pub/sub, distributed locks, DM trigger system, WebSocket rooms, typing indicators, message sequencing. | Auth, Pipeline |
| 6 | **Combat Engine** | Debug-mode combat shell first, then full 5e rules engine (leveraging open-source engines), AI map generation, combat state management, combat-to-narrative handoff. Voxel renderer is a frontend concern. | Session Runtime |

### Phase 3: User Experience

| # | Sub-Project | Description | Depends On |
|---|-------------|-------------|------------|
| 7 | **Frontend** | Full React application from scratch. New design system (pixel aesthetic, serif typography), routing, state management, auth flow, billing UI, campaign/world creation, character creation, multiplayer chat, combat UI (Three.js voxel renderer), reconnection, code-splitting. Built to the UX Design spec. | All of Phase 2, UX Design |
| 8 | **Observability & Hardening** | Structured logging, metrics, alarms, rate limiting, input validation, security headers, graceful shutdown, content moderation hooks. | Backend Core |

### Build Order Notes

- UX Design and Ops Foundation can happen in parallel (design doesn't need infrastructure)
- Phase 1 is strictly sequential (Core -> Auth -> Billing)
- Phase 2: Pipeline (4) can start as soon as Backend Core is done. Session Runtime (5) needs Auth. Combat (6) needs Session Runtime.
- Phase 3: Frontend can start component-by-component as backend APIs become available, but the full integration is last
- Observability (8) is woven in throughout, with a dedicated hardening pass before launch
- **Reusable from prototype:** LLM prompt templates (`.txt` files), Zod schemas for LLM output validation, universal random table data (JSON), SRD reference data. These are copied into the new repo, not rewritten.
- **Not reusable:** SQLite schema/repository, sync API patterns, single-player SessionController, dev-tool UI, Fastify route handlers (new API surface from UX design)

---

## 3. System Topology

### Services

**Backend API Service** (Node.js + Fastify, ECS Fargate)
- Serves REST API and WebSocket connections
- Runs in 2+ container instances behind an ALB
- Stateless -- all session state in Redis, all persistent data in Postgres
- Each instance handles any request for any user (no sticky sessions for HTTP; WebSocket uses Redis pub/sub for cross-instance messaging)

**Pipeline Worker Service** (Node.js, ECS Fargate -- separate from API)
- Runs BullMQ workers for world-gen and campaign-setup pipelines
- Separate ECS service so long-running Opus pipeline calls don't compete for CPU/memory with WebSocket connections and API requests
- Shares the same Docker image as the API service, started with a different entrypoint

**PostgreSQL** (RDS)
- All persistent data: users, worlds, campaigns, entities, facts, sessions, billing
- Connection pooling via `pg` library (10-15 connections per container). At launch scale (1-3 containers), this uses ~30 of ~80 available connections on `db.t4g.micro` — no proxy needed.
- **Scale-up trigger**: Add RDS Proxy (~$22/mo) when auto-scaling exceeds 6+ containers (60+ connections). This is unlikely before 3,000+ MAU.
- Async query execution (replacing better-sqlite3's synchronous API)
- Automated backups with point-in-time recovery (35-day retention)

**Redis** (ElastiCache, single instance at launch)
- **Session state**: Active SessionController state serialized to Redis. Any container can pick up any session
- **Pub/sub**: WebSocket message routing across containers
- **Distributed locks**: Prevent concurrent DM responses (heartbeat-extended)
- **Rate limiting**: Per-user request counters with TTL
- **Message sequencing**: Per-session monotonic sequence numbers
- **BullMQ job queues**: Pipeline stage execution with retries and dead letter queue
- **Caching**: Pipeline status, campaign metadata, hot entity reads
- Configuration: `maxmemory-policy: volatile-lru` (amended 2026-04-21 — see Decisions Log). Under memory pressure, evict the least-recently-used TTL'd keys (session state) rather than refusing all writes. Session state is TTL'd at 4 hours and checkpointed to Postgres every 5 minutes, so eviction costs at most 0–5 minutes of history on reconnect. Loud failure across BullMQ + rate limiting + pub/sub + session state (which `noeviction` would cause) is a worse user experience than degraded session history on the oldest idle sessions.
- Launch: single `cache.t4g.micro` node, no replica. A single node handles pub/sub + BullMQ + session state comfortably at 200-500 concurrent sessions.
- **Scale-up trigger**: Split into two instances (real-time vs batch) if monitoring shows pub/sub latency spikes during pipeline runs. Both instances use `maxmemory-policy: volatile-lru`. Add a replica for Multi-AZ failover when session count justifies the cost (~$23/mo).

**Stripe** (external)
- Payment processing for session packs
- Webhooks for payment confirmation (`checkout.session.completed`)
- Customer portal for payment method management

**AWS Cognito** (managed)
- OAuth2 identity provider (Google + Discord)
- JWT issuance and validation
- User pool management
- Free for the first 50K monthly active users

**S3 + CloudFront** (static hosting)
- Frontend assets (JS, CSS, fonts, SVGs, voxel assets)
- CloudFront CDN for global distribution and caching

**AWS Secrets Manager**
- All secrets: Anthropic API key, Stripe secret key + webhook signing secret, RDS database password, Redis auth tokens, Cognito client secret
- ECS task definitions reference secrets by ARN (not environment variables)
- IAM policy on ECS task role grants `secretsmanager:GetSecretValue` only for specific secret ARNs

### Network Topology

```
Browser ──HTTPS──> CloudFront (CDN) ──> S3 (static frontend assets)
Browser ──HTTPS──> ALB ──> ECS Fargate: API Service (REST + WebSocket)
                          |──> RDS Proxy ──> RDS PostgreSQL
                          |──> ElastiCache Redis
                          |──> Anthropic API (via NAT Gateway)
                          |──> Stripe API (via NAT Gateway)
                   ECS Fargate: Worker Service (BullMQ pipelines)
                          |──> (same RDS, Redis, Anthropic connections)
                          (no ALB target group; pulls jobs from Redis;
                           internal /health on a sidecar port — not internet-facing)
```

VPC topology, subnet layout, security groups, NAT Gateway configuration, and auto-scaling policies are defined in the Infrastructure sub-spec.

### Deployment Strategy

**Blue/green deployments** via ECS. On deploy:
1. New task set (green) starts alongside old (blue)
2. ALB health checks confirm green is healthy
3. Traffic shifts to green
4. Blue receives SIGTERM with **120-second deregistration delay** (sufficient for in-flight LLM calls)
5. Blue runs graceful shutdown (see section 7.4)

**ALB Configuration:**
- Idle timeout: **3600 seconds** (prevents dropping WebSocket connections during long read pauses)
- WebSocket ping/pong keepalives at **30-second intervals** from the server

---

## 4. Data Model

### 4.1 World/Campaign Separation

The fundamental architectural change: **Worlds and Campaigns are separate entities.**

- A **World** is a template containing setting content: entities, factions, locations, NPCs, prose kernels, facts, relationships, random tables, starting situations
- A **Campaign** is a personalized fork of a World for a specific party. It references a world (which it owns) and contains campaign-specific data: characters, sessions, session preps, snapshots

**Pipeline flow:**
1. **World Gen Pipeline** creates a World (concept_intake -> world_and_factions -> locations_and_npcs -> starting_situation -> random_tables)
2. **Campaign Setup Pipeline** forks the world (if from a shared source) and runs per-player character stages (location_selection -> character_concept -> character_sheet -> character_integration) then campaign-wide stages (materialize_relationships -> continuity_check)

**Fork mechanics** (when creating a campaign from a shared world):
1. Create a new `worlds` row with `source_world_id` pointing to the original
2. Deep-copy all entities, prose kernels, facts, relationships, hierarchy, random tables -- new UUIDs, same content
3. Create the campaign pointing to the forked world
4. Run character creation stages against the forked world
5. Increment `fork_count` on the source world
6. Record attribution for future creator payouts

As play progresses, the Scribe mutates the campaign's forked world. The original template stays pristine.

### 4.2 Schema Conventions

**UUIDv7 for all primary keys.** UUIDv7 (RFC 9562) is time-ordered, which prevents B-tree index fragmentation that UUIDv4 causes at scale (random insertion = page splits = poor cache locality). All `gen_random_uuid()` calls below should use UUIDv7 generation (Postgres 17's `gen_random_uuid_v7()`, the `pg_uuidv7` extension, or application-side generation). This is a one-line change now; impossible to fix for existing rows later.

**NUMERIC(10,6) for all money columns.** Never `REAL` (float4). Floating-point accumulation errors compound when summing thousands of small values ($0.003 per LLM call). Use `NUMERIC(10,6)` or integer microdollars.

**Composite indexes from day one.** Adding indexes to 100M+ row tables later requires hours of `CREATE INDEX CONCURRENTLY` under I/O pressure. Required indexes defined in section 4.7.

### 4.3 New Tables

#### `users`
```sql
CREATE TABLE users (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  cognito_sub TEXT NOT NULL UNIQUE,
  email TEXT NOT NULL UNIQUE,
  display_name TEXT NOT NULL,
  avatar_url TEXT,
  auth_provider TEXT NOT NULL CHECK (auth_provider IN ('google', 'discord')),
  free_trial_used BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
```

#### `worlds`
```sql
CREATE TABLE worlds (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  created_by UUID NOT NULL REFERENCES users(id),
  source_world_id UUID REFERENCES worlds(id) ON DELETE SET NULL,
  name TEXT NOT NULL,
  concept TEXT NOT NULL,
  tone TEXT,
  themes TEXT,
  geography_summary TEXT,
  political_summary TEXT,
  era TEXT,
  key_tensions TEXT,
  world_overview TEXT,
  follow_up_questions TEXT,
  starting_situations TEXT,
  is_public BOOLEAN NOT NULL DEFAULT false,
  fork_count INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'generating' CHECK (status IN ('generating', 'complete', 'failed')),
  language TEXT NOT NULL DEFAULT 'en',
  moderation_status TEXT NOT NULL DEFAULT 'unreviewed' CHECK (moderation_status IN ('unreviewed', 'approved', 'flagged', 'removed')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
```

#### `campaigns` (revised -- slimmed down)
```sql
CREATE TABLE campaigns (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  world_id UUID NOT NULL REFERENCES worlds(id) ON DELETE CASCADE,
  source_world_id UUID REFERENCES worlds(id) ON DELETE SET NULL,
  created_by UUID NOT NULL REFERENCES users(id),
  name TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'setup' CHECK (status IN ('setup', 'active', 'archived')),
  language TEXT NOT NULL DEFAULT 'en',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
```

#### `campaign_members`
```sql
CREATE TABLE campaign_members (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  campaign_id UUID NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role TEXT NOT NULL CHECK (role IN ('owner', 'player')),
  invite_accepted BOOLEAN NOT NULL DEFAULT false,
  joined_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(campaign_id, user_id)
);
```

#### `campaign_invites`
```sql
CREATE TABLE campaign_invites (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  campaign_id UUID NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
  created_by UUID NOT NULL REFERENCES users(id),
  invite_code TEXT NOT NULL UNIQUE,
  max_uses INTEGER,
  uses INTEGER NOT NULL DEFAULT 0,
  expires_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
```

#### `session_participants`
```sql
CREATE TABLE session_participants (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id UUID NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES users(id),
  character_id UUID NOT NULL REFERENCES characters(id),
  joined_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(session_id, user_id)
);
```

#### `purchases`

Schema lives in `docs/specs/2026-04-13-backend-core.md` (canonical). MYT-42 ships migration 007 that re-creates this table with `lookup_key TEXT NOT NULL` (closed enum from `backend/src/billing/lookup-keys.ts`) replacing the legacy `session_pack_size INTEGER`.

#### `session_usage` (post-MYT-43)
```sql
CREATE TABLE session_usage (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id UUID NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  campaign_id UUID NOT NULL REFERENCES campaigns(id),
  user_id UUID NOT NULL REFERENCES users(id),
  input_tokens INTEGER NOT NULL DEFAULT 0,
  output_tokens INTEGER NOT NULL DEFAULT 0,
  cache_write_tokens INTEGER NOT NULL DEFAULT 0,
  cache_read_tokens INTEGER NOT NULL DEFAULT 0,
  estimated_cost_usd NUMERIC(10,6) NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX idx_session_usage_one_per_session ON session_usage (session_id);
```
One row per session; `recordUsage` UPSERTs cumulatively per LLM call. Replaces the pre-MYT-43 token-budget-enforcement model (the dropped `budget_limit_tokens` column).

#### `world_marketplace` (schema-ready, not built at launch)
```sql
CREATE TABLE world_marketplace (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  world_id UUID NOT NULL UNIQUE REFERENCES worlds(id) ON DELETE CASCADE,
  listing_title TEXT NOT NULL,
  listing_description TEXT NOT NULL,
  tags TEXT[],
  creator_payout_cents INTEGER NOT NULL DEFAULT 0,
  listed_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
```

#### `credit_ledger` (replaces `users.session_credits` integer)
```sql
CREATE TABLE credit_ledger (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  amount INTEGER NOT NULL,
  source_type TEXT NOT NULL CHECK (source_type IN ('purchase', 'subscription', 'gift', 'trial', 'refund', 'debit')),
  source_id UUID,
  granted_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at TIMESTAMPTZ
);
```
Current balance: `SELECT COALESCE(SUM(amount), 0) FROM credit_ledger WHERE user_id = $1 AND (expires_at IS NULL OR expires_at > now())`. Session debit is an INSERT of a negative-amount row with `source_type = 'debit'`. This supports future subscriptions (monthly credit grants with expiry), gifting (`source_type = 'gift'`, different `user_id` as purchaser), and refunds — without schema migration.

#### `session_messages` (replaces `sessions.transcript` JSON blob)
```sql
CREATE TABLE session_messages (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id UUID NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  seq INTEGER NOT NULL,
  user_id UUID,
  message_type TEXT NOT NULL,
  content TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_session_messages_session_seq ON session_messages(session_id, seq);
```
Append-only: new messages are INSERTed, never UPDATEd. This eliminates the full-rewrite-on-checkpoint problem (the old design rewrote a 300KB+ JSON blob every 5 minutes per session). Reconnection replay becomes `SELECT * FROM session_messages WHERE session_id = $1 AND seq > $lastSeen ORDER BY seq`. The `sessions.transcript` column is removed.

#### `moderation_flags` (schema-ready for future moderation system)
```sql
CREATE TABLE moderation_flags (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  target_type TEXT NOT NULL CHECK (target_type IN ('world', 'session_message', 'user')),
  target_id UUID NOT NULL,
  reporter_id UUID REFERENCES users(id),
  reason TEXT NOT NULL,
  severity TEXT NOT NULL CHECK (severity IN ('low', 'medium', 'high', 'critical')),
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'reviewed', 'actioned', 'dismissed')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  resolved_at TIMESTAMPTZ
);
```

### 4.4 Modified Existing Tables

#### `entities` -- `campaign_id` becomes `world_id`
```sql
ALTER TABLE entities RENAME COLUMN campaign_id TO world_id;
ALTER TABLE entities ADD CONSTRAINT entities_world_fk FOREIGN KEY (world_id) REFERENCES worlds(id) ON DELETE CASCADE;
```

All tables that currently reference entities via foreign keys (prose_kernels, facts, relationships, entity_hierarchy) need no schema change -- they reference `entities.id`, not `campaign_id` directly.

#### `characters` -- add `user_id`
```sql
ALTER TABLE characters ADD COLUMN user_id UUID REFERENCES users(id);
```
One character per user per campaign. The existing `campaign_id` stays.

#### `entities` -- add `modified_by_play`
```sql
ALTER TABLE entities ADD COLUMN modified_by_play BOOLEAN NOT NULL DEFAULT false;
```
Set to `true` by the Scribe when an entity is modified during play. Enables future marketplace world updates to propagate to forks — only unmodified entities can be safely updated from the source world.

#### `sessions` -- remove `transcript` column
The `transcript` TEXT column is replaced by the `session_messages` table (append-only, see above). The `sessions` table retains `summary`, `st_running_summary`, and `handoff` columns.

#### `pipeline_runs` -- split by scope
World-gen stages use `world_id`. Character creation stages use `campaign_id`. Add a `world_id` column:
```sql
ALTER TABLE pipeline_runs ADD COLUMN world_id UUID REFERENCES worlds(id) ON DELETE CASCADE;
-- campaign_id becomes nullable (character stages use it, world stages don't)
ALTER TABLE pipeline_runs ALTER COLUMN campaign_id DROP NOT NULL;
```

#### `random_tables` -- move to `world_id`
```sql
ALTER TABLE random_tables RENAME COLUMN campaign_id TO world_id;
```

#### `session_preps`, `world_snapshots`, `sessions` -- stay on `campaign_id`
These are campaign-specific, not world-level.

#### `settings` -- scope TBD in sub-specs
The current global `settings` table (storing model config as JSON) remains for system-wide defaults. Whether model config becomes per-user, per-campaign, or stays global is a product decision deferred to the relevant sub-spec. The schema supports any of these via an additional scope column or separate override tables.

### 4.4 Key Relationships

```
User ──creates──> World ──(fork)──> World (personalized copy)
User ──creates──> Campaign ──references──> World (the fork)
User ──member of──> Campaign (via campaign_members, role: owner|player)
User ──has──> Character (per campaign)
User ──has──> purchases
Campaign ──has──> Sessions
Session ──has──> session_participants (multiple users + characters)
Session ──has──> session_usage (cost tracking)
Campaign ──has──> campaign_invites (shareable codes)
World ──has──> Entities, ProseKernels, Facts, Relationships, Hierarchy, RandomTables
Campaign ──has──> SessionPreps, WorldSnapshots
World (source) ──attributed via──> campaign.source_world_id (for marketplace payouts)
```

### 4.7 Required Indexes

These must be created at schema setup time, not retrofitted later.

```sql
-- Entity queries by world and type (hot path for Scribe, ST, session loading)
CREATE INDEX idx_entities_world_type ON entities(world_id, entity_type);

-- Fact queries filtered by access level and narrative status (Scribe, ST)
CREATE INDEX idx_facts_entity_access_status ON facts(entity_id, access_level, narrative_status);

-- Session messages ordered replay (reconnection, transcript loading)
CREATE INDEX idx_session_messages_session_seq ON session_messages(session_id, seq);

-- Credit balance lookups
CREATE INDEX idx_credit_ledger_user ON credit_ledger(user_id, expires_at);

-- Existing indexes from the current schema carry over (idx_entities_campaign renamed to idx_entities_world, etc.)
```

### 4.8 Ownership and Access Control

Every query that touches campaign/world data is filtered by ownership:

- **Read campaign data**: User must be in `campaign_members` for that campaign
- **Modify campaign** (delete, reset, settings): User must have `role = 'owner'`
- **Start a session**: User must be a member; campaign owner must have a positive session-credit balance (`SELECT COALESCE(SUM(amount), 0) FROM credit_ledger WHERE user_id=$1 AND credit_type='session' AND (expires_at IS NULL OR expires_at > now())`). Trial credits are granted at registration as part of that balance, not a separate gate.
- **Read world data**: Allowed if the world is public (`is_public = true`) OR the user owns a campaign that references the world
- **Modify world data**: Only via campaign pipeline stages (no direct world editing for shared worlds)

### 4.9 Who Pays for Sessions

The **campaign owner** pays. Credits are tracked via the `credit_ledger` table.

**Check balance:**
```sql
SELECT COALESCE(SUM(amount), 0) AS balance
FROM credit_ledger
WHERE user_id = $1 AND (expires_at IS NULL OR expires_at > now());
```

**Debit a session credit** (atomic — uses a serializable transaction or advisory lock to prevent double-spend):
```sql
INSERT INTO credit_ledger (id, user_id, amount, source_type, granted_at)
VALUES (gen_random_uuid(), $1, -1, 'debit', now());
```

Full flow:
1. Verify the requesting user is a campaign member
2. Look up the campaign owner
3. Compute owner's session-credit balance (`SELECT COALESCE(SUM(amount), 0) FROM credit_ledger WHERE user_id=$1 AND credit_type='session' AND (expires_at IS NULL OR expires_at > now())`). Trial credits are part of that balance, granted at registration (not at session-start).
4. If balance > 0: insert debit row (the first call to `repo.sessions.recordUsage` lazily inserts the `session_usage` row on first LLM call). Else: return 402 Payment Required + `{code: 'insufficient_credits', available, required}`.

---

## 5. Interface Contracts

### 5.1 Auth Middleware

Every HTTP route and WebSocket upgrade passes through auth middleware:

- **HTTP**: Extracts JWT from `Authorization: Bearer <token>` header
- **WebSocket**: Uses a **ticket-based upgrade pattern** (see 5.2 below) -- the JWT is never passed in the URL
- Validates against Cognito's JWKS endpoint (public key cached in memory with TTL)
- Attaches `request.user: { id: string, email: string, displayName: string }` to the request object
- Returns 401 for missing/invalid/expired tokens

**Public routes** (no auth): `GET /health`, `/auth/callback/*` (OAuth callbacks), `POST /webhooks/stripe` (verified by Stripe signature).

**Ownership checks** are factored into a per-route preHandler (`requireCampaignMember`) that runs once per request — see Auth & Users spec §8 for the full design. The middleware establishes identity (`request.dbUser`, attached by `requireOnboarded`); the preHandler checks authorization and decorates `request.campaignMember`:
```
const member = await repo.campaigns.getMembership(campaignId, request.dbUser.id)
if (!member?.inviteAccepted) return reply.code(403).send({ code: 'not_campaign_member' })
if (role && member.role !== role) return reply.code(403).send({ code: `not_campaign_${role}` })
```

### 5.2 WebSocket Protocol (Multiplayer)

**Connection flow (ticket-based auth):**
1. Client calls `POST /api/sessions/:id/ws-ticket` with JWT in `Authorization: Bearer` header (sessionId in URL)
2. Server validates JWT + onboarded user + suspended_at + campaign membership, then generates a 256-bit nonce, stores it in Redis (`${MYTHRUN_ENV}:${REGION_PREFIX}:ws:ticket:<nonce>`) with **30-second TTL** mapped to `{userId, sessionId, campaignId}`
3. Server returns `{ ticket, expiresAt }` — `expiresAt` is informational only
4. Client connects to `wss://host/ws/session/:sessionId?ticket=<nonce>`
5. Server calls `consumeWsTicket` which atomically `GETDEL`s the key and returns the bound payload (or null)
6. Server re-validates campaign membership with `repo.campaigns.getMembership(payload.campaignId, payload.userId)` — the ticket alone proves membership at *mint time*, not upgrade time
7. If `consumeWsTicket` returns null (consumed, expired, missing): reject the upgrade with 401. If it throws (Redis transient): respond 503 — operationally distinguishable.

This prevents JWT leakage into ALB access logs, CloudWatch logs, and browser history. The nonce is single-use and short-lived.

**Message ordering:** All messages (player and DM) receive a server-assigned **monotonic sequence number** via `Redis INCR` on `session:{campaignId}:seq`. Clients render messages in sequence order, not arrival order. On reconnect, the client sends its last-seen sequence number and the server replays from that point.

**Server -> Client message types:**

| Type | Fields | Purpose |
|------|--------|---------|
| `session_ready` | (none) | Session initialized, ready for play |
| `text_delta` | `text, seq` | Streaming DM prose (broadcast to all) |
| `player_joined` | `userId, displayName, characterName` | A player connected |
| `player_left` | `userId` | A player disconnected |
| `player_message` | `userId, displayName, text, seq` | Another player's chat message (broadcast) |
| `typing_start` | `userId, displayName` | A player started typing |
| `typing_stop` | `userId` | A player stopped typing |
| `dm_thinking` | (none) | DM is processing (after trigger, before streaming) |
| `skill_check` | `skill, context, roll, roll2?, roll_type, modifier, total, dc, outcome_tier, constraint, seq` | Skill check resolved |
| `dice_roll` | `count, sides, results[], total, seq` | Dice roll result |
| `turn_end` | `seq` | DM's response complete |
| `combat_start` | `initiative_order, map_state, seq` | Combat mode initiated |
| `combat_update` | `action, result, new_map_state, seq` | Combat state changed |
| `combat_end` | `combat_summary, seq` | Combat concluded (includes CombatSummary) |
| `session_end` | `reason, summary?, emerging_threads?, faction_updates?` | Session ended |
| `session_reconnect` | `messages: Array<{seq, ...}>, participants: Array<{userId, displayName, characterName}>, mode: 'exploration' \| 'combat', combatState: CombatState \| null, inFlightResponse: { text: string, seq: number } \| null` | Ordered history replay on reconnect |
| `session_budget_warning` | `percent_used` | Token budget approaching limit |
| `server_restart` | (none) | Server is restarting -- client should auto-reconnect |
| `st_evaluation` | `intervene, direction?, summary_update` | Debug: slow thinker result |
| `scribe_result` | `entity_matches, new_entities, fact_updates, ...` | Debug: scribe extraction |
| `auth_check` | `challenge: string` | Server requests auth re-validation (e.g., token refresh) |
| `reaction_window` | `combatantId: string, triggerAction: string, availableReactions: string[], timeoutMs: number, seq` | Server prompts a player for a reaction during combat |
| `error` | `message` | Error occurred |

**Client -> Server message types:**

| Type | Fields | Purpose |
|------|--------|---------|
| `player_message` | `text` | Chat message (server assigns seq + userId before broadcast) |
| `dm_invoke` | `text` | Explicitly invoke the DM (@DM) |
| `typing_start` | (none) | Broadcast typing indicator |
| `typing_stop` | (none) | Clear typing indicator |
| `roll_complete` | (none) | Roll animation finished |
| `end_session` | (none) | Request session end |
| `combat_action` | `type, combatantId: string, target?, position?, spellId?, spellLevel?: number, weaponId?` | Player's combat action |
| `auth_response` | `token: string` | Client responds to auth_check with a fresh token |
| `combat_move` | `position: {x, y, z}` | Token movement on map |

**Redis pub/sub**: All WebSocket messages for a campaign are published to `session:{campaignId}`. Every container subscribes to channels for sessions where it has connected clients. This enables Player A on Container 1 and Player B on Container 2 to communicate in real time.

### 5.3 DM Trigger System

The DM decides when to respond in multiplayer via a hybrid system:

**Explicit trigger**: Any `dm_invoke` message, or a `player_message` containing `@DM` or `@dm` -> DM always responds.

**Auto-trigger**: A lightweight LLM classifier (Haiku) evaluates recent messages after a **debounce window** (2-3 seconds of silence after the last player message) and decides whether a DM response is warranted. Auto-trigger fires when:
- A player describes an action requiring resolution ("I try to pick the lock")
- An NPC is directly addressed in dialogue ("I turn to the merchant and say...")
- No player has spoken for N seconds after the DM's last response (DM prompts to keep things moving)
- A combat trigger is detected (hostile action, ambush description)

If new messages arrive while the classifier is in-flight, the classifier call is cancelled and restarted with the fuller context.

**DM response flow** (replaces the current 1:1 turn model):
1. Trigger fires (explicit or auto)
2. Acquire distributed lock (`session:{campaignId}:lock` in Redis) -- see 5.4 for lock mechanics
3. Send `dm_thinking` to all clients
4. Run Slow Thinker evaluation
5. Stream Fast Thinker response to all clients
6. Fire Scribe asynchronously
7. Send `turn_end`
8. Release lock

### 5.4 Session State in Redis

Session state moves from in-memory to Redis, enabling any container to serve any session:

| Key | Value | TTL | Notes |
|-----|-------|-----|-------|
| `{region}:session:{campaignId}:state` | JSON: session metadata, participant list, status, mode | Refreshed on every interaction | Region prefix for future multi-region |
| `{region}:session:{campaignId}:ft_history` | JSON: FastThinker message history | Refreshed on every interaction | |
| `{region}:session:{campaignId}:summary` | String: ST running summary | Refreshed on every interaction | |
| `{region}:session:{campaignId}:combat` | JSON: CombatState (if in combat mode) | Refreshed on every interaction | |
| `{region}:session:{campaignId}:lock` | Distributed lock with heartbeat | Base: 120s, renewed every 15s | See lock mechanics below |
| `{region}:session:{campaignId}:usage` | Hash: fields `input_tokens`, `output_tokens` (incremented via HINCRBY) | Refreshed on every interaction | |
| `{region}:session:{campaignId}:seq` | Integer: monotonic message sequence counter | Refreshed on every interaction | |

**TTL strategy:** TTLs are refreshed on every player message, DM response, or any session interaction. This prevents key expiry during long but active sessions. Additionally, session state is **checkpointed to Postgres every 5 minutes** (transcript, running summary, usage). This means a Redis crash or eviction loses at most the last 5 minutes of session state, not the entire session.

**Distributed lock mechanics:**
- Base TTL: **120 seconds** (sufficient for slow LLM calls)
- The lock holder extends the TTL by **15 seconds** via a timer that fires every **15 seconds** while the DM response is being generated
- Lock implementation uses Redlock pattern with fencing tokens to prevent stale holders from writing
- **Stale lock detection:** A separate `session:{campaignId}:dm_responding` flag is set alongside the lock, with a **30-second TTL** renewed by the same 15-second heartbeat. If a new container sees that the lock is held but the `dm_responding` flag has expired, it knows the holder has crashed (the flag expired because the heartbeat stopped, even though the lock's longer TTL hasn't elapsed yet). The new container can break the lock and take over. This reduces the stale lock window from 120 seconds to ~30 seconds.
- **Break-lock protocol:** To break a stale lock, the new container: (1) deletes the existing lock key, (2) acquires a new lock with a new fencing token, (3) checks if a partial DM response was published (via the message sequence numbers). If a partial response exists, it sends a `turn_end` to clients so the partial response doesn't hang, then allows the next trigger to generate a fresh response.

**Redis criticality:** Redis is a **critical dependency**, not a degradable one. If Redis is unavailable:
- Multiplayer messaging between containers stops
- Session state cannot be read or written
- Distributed locks cannot be acquired
- Rate limiting stops
- Active sessions are disrupted

Mitigation: ElastiCache Multi-AZ with automatic failover. Typical failover time is 10-30 seconds.

On session end, all Redis state is persisted to Postgres (transcript, summary, usage) and the Redis keys are cleaned up.

### 5.5 Pipeline Contract

The pipeline splits into two entry points operating on different scopes:

**World Gen Pipeline** (operates on `world_id`):
```
concept_intake -> world_and_factions -> locations_and_npcs -> starting_situation -> random_tables
```

**Campaign Setup Pipeline** (operates on `campaign_id`, requires a completed world):
```
world_fork (if from shared world)
  -> [per player: location_selection -> character_concept -> character_sheet -> character_integration]
  -> materialize_relationships
  -> continuity_check
```

Character creation stages run once per player. The campaign-wide stages (`materialize_relationships`, `continuity_check`) run after all players have created their characters.

Pipeline execution moves from fire-and-forget promises to a proper job queue (BullMQ backed by Redis) with:
- Retries with exponential backoff
- Dead letter queue for permanently failed stages
- Concurrency limits to avoid Anthropic rate limits
- Progress tracking via Redis (replacing the 3-second polling pattern)
- **Back-pressure:** The API checks the BullMQ queue depth before accepting new pipeline jobs (world gen, campaign setup). If queue depth exceeds a configurable threshold (e.g., 20 pending jobs), the API returns `503 Service Unavailable` with a `Retry-After` header. This prevents unbounded queue growth during Anthropic rate limits or outages. Queue depth is exposed as a CloudWatch metric.

### 5.6 Billing Contract

**Session start gate:**
1. Verify user is a `campaign_member`
2. `repo.credits.tryDebitForSession(userId, sessionId)` — atomic decrement of campaign owner's session-credit balance + returns `consumedSourceType` (trial vs paid) for trial-mode UX. Trial credits are part of that balance, not a separate gate.
3. If `ok: false`: return 402 Payment Required + `{code: 'insufficient_credits', available, required}`
4. The `session_usage` row is lazily inserted on the first LLM call via `recordUsage`; no explicit start-row insert is needed.

**During session (post-MYT-43):**
- Each LLM call invokes `repo.sessions.recordUsage(sessionId, model, deltas)` which UPSERTs the per-session row in `session_usage` and returns the running totals.
- Wrap-up signaling (cost cap / FT context cap / ST narrative wrap) is computed inline by the Session Runtime from `recordUsage`'s return value — no separate Redis counter, no separate threshold-read round-trip. Cost cap is the **primary** session-end mechanism (signals ST, doesn't hard-halt).
- Per-call writes scale fine: ~7 ops/sec at 500 concurrent sessions.

**Free trial session specifics:**
- Trial credit is granted at registration (parent billing spec §7); the session-start path is unchanged.
- Uses a pre-built demo world (no world-gen cost)
- Time-capped at 45-60 minutes
- Reduced token budget
- At wind-down, ST is instructed to end on a narrative cliffhanger (not a satisfying conclusion)
- After trial ends, user is prompted to purchase à-la-carte SKUs or subscribe to a tier.

**Stripe integration:**
- `POST /api/billing/checkout` -- creates a Stripe checkout session. Body: `{ items: [{ lookup_key, quantity }] }`. Server resolves each `lookup_key` to a Stripe Price (validated by the boot probe per MYT-41). Price is never sent from the client.
- `POST /webhooks/stripe` -- handles `checkout.session.completed`, credits user's session/world-gen credits. Credit allocation happens ONLY in the webhook handler, never on the success redirect.
- `GET /api/billing/portal` -- returns a Stripe customer portal URL for managing subscription, payment methods, and invoice history.
- À-la-carte SKUs (`sku_session`, `sku_world`) are configurable in Stripe Dashboard, referenced from code by `lookup_key` per `backend/src/billing/lookup-keys.ts`. No fixed-size packs; sessions and worlds are sold one-at-a-time.

---

## 6. Combat Engine Architecture

### 6.1 Build Strategy: Debug Mode First

The combat system is built in two layers:

**Layer 1 (launch priority): Combat shell**
- Combat trigger detection (AI recognizes when combat should start)
- Transition to "combat mode" state
- Debug/manual resolution: system asks the DM (or a human in debug mode) for the outcome
- Human types outcome (e.g., "the PCs defeated the goblins, Arin took 12 damage")
- Post-combat state update (HP changes, conditions, narrative consequences)
- CombatSummary generation for narrative handoff
- Transition back to exploration/narrative mode

This validates the entire combat integration without any rules engine.

**Layer 2: Full 5e combat engine**
- Plugs in behind the same combat system interface:
  - `startCombat(context): Promise<CombatState>`
  - `submitAction(state, action): Promise<ActionResult>`
  - `getAvailableActions(state, combatantId): AvailableActions`
  - `endCombat(state, outcome): Promise<CombatSummary>`
  - `isInCombat(sessionState): boolean`
- Can be swapped in without touching the session controller or any other system
- Full mechanical enforcement, AI-generated voxel maps, combat UI
- Leverage existing open-source 5e rules engines (e.g., 5e-database, Open5e data, community rules implementations) to avoid building 320+ spells from scratch

### 6.2 Combat State Model

```typescript
interface CombatState {
  round: number
  activeIndex: number
  initiativeOrder: Combatant[]
  map: VoxelMap | null  // null in debug mode (Layer 1), required in full engine (Layer 2)
  log: CombatLogEntry[]
}

interface Combatant {
  id: string
  name: string
  type: 'pc' | 'npc' | 'monster'
  userId?: string
  position: { x: number; y: number; z: number }
  initiative: number
  hp: number
  maxHp: number
  temporaryHp: number
  ac: number
  conditions: ActiveCondition[]
  actionsRemaining: ActionEconomy
  concentratingOn: { spellId: string; targetIds: string[] } | null
  spellSlots: Record<number, { used: number; max: number }>
  features: CombatFeature[]  // class features with limited uses (Action Surge, etc.)
  resistances: DamageType[]
  vulnerabilities: DamageType[]
  immunities: DamageType[]
}

interface ActiveCondition {
  condition: ConditionType  // prone, grappled, restrained, etc.
  source: string  // combatant ID or spell ID that caused it
  duration: ConditionDuration
}

interface ConditionDuration {
  type: 'turns' | 'rounds' | 'concentration' | 'save' | 'permanent'
  remaining?: number
  saveAbility?: string  // for save-based durations
  saveDc?: number
}

interface CombatFeature {
  id: string
  name: string
  source: string  // class, species, etc.
  usesRemaining: number
  usesMax: number
  resetsOn: 'short_rest' | 'long_rest' | 'turn'
}

interface ActionEconomy {
  action: boolean
  bonusAction: boolean
  reaction: boolean
  movement: number  // feet remaining this turn
  freeObjectInteraction: boolean
}

interface VoxelMap {
  width: number
  height: number
  depth: number
  terrain: Uint8Array  // voxel grid: 0=empty, 1=floor, 2=wall, 3=obstacle, etc.
  tokens: Combatant[]
}

// Action resolution uses a stack model (like MTG) for reactions and triggers
interface ActionStack {
  entries: StackEntry[]  // top = next to resolve
}

interface StackEntry {
  action: CombatAction
  triggeredBy?: string  // stack entry ID that caused this
}
```

### 6.3 Rules Engine (Server-Side, Pure Functions)

The combat rules engine is a pure-function module: given a state and an action, it returns a new state and result. No side effects, fully testable, fully pluggable.

```typescript
interface CombatAction {
  combatantId: string
  type: 'move' | 'attack' | 'cast_spell' | 'dodge' | 'dash' | 'disengage' | 'help' | 'hide' | 'ready' | 'use_item' | 'use_feature'
  target?: string
  position?: Position
  spellId?: string
  spellLevel?: number  // for upcasting
  weaponId?: string
}

interface ActionResult {
  valid: boolean
  error?: string
  newState: CombatState
  events: CombatEvent[]  // for AI narration
  triggeredReactions: StackEntry[]  // go on the action stack
}
```

**What the rules engine enforces:**
- Movement speed limits, difficult terrain, opportunity attack triggers
- Attack rolls: range validation, advantage/disadvantage from conditions, attack roll + damage
- Spells: slot consumption, range, area of effect, concentration tracking (breaking on damage via CON save), upcasting
- Action economy: one action, one bonus action, one reaction, movement, free object interaction per turn
- Conditions: all 14 SRD conditions with cascading mechanical effects (stunned -> incapacitated -> STR/DEX save failure)
- Condition durations: turn-based, save-based, concentration-based
- Readied actions: stored as pending triggers, resolved via the action stack when triggered
- Death saves, unconscious, stabilization
- Cover and line-of-sight from map geometry

**Action stack**: Reactions and triggered effects use a stack model. When an action triggers a reaction (e.g., opportunity attack, Counterspell, Shield), the reaction is pushed onto the stack. The stack resolves top-down, and reactions can trigger further reactions (Counterspell countering Counterspell). This handles all recursive edge cases cleanly.

**What the AI DM handles:**
- Narrating combat events (1-2 sentences per action, streamed to chat)
- NPC/monster tactical decisions (which target, which ability)
- Describing environmental effects and flavor
- Ruling on creative actions that aren't standard 5e actions

### 6.4 AI + Combat Integration

**PC turn:**
1. Client shows available actions based on `ActionEconomy` and character abilities
2. Player selects action via combat UI (move token, click attack, select spell, etc.)
3. Server validates via rules engine (the client is untrusted -- all combat actions are validated server-side)
4. Server verifies `combatant.userId === request.user.id` and that it's this combatant's turn
5. Dice rolls happen server-side
6. Server broadcasts `combat_update` with results
7. AI DM narrates the action in chat (short, 1-2 sentences)

**NPC/Monster turn:**
1. AI DM decides the action via structured tool call (`combat_action`)
2. Server validates and resolves via rules engine
3. Server broadcasts `combat_update`
4. AI DM's narration streams to chat

### 6.5 Map Generation

AI-generated maps are foundational to the Mythrun combat experience. Template fallbacks are not acceptable -- if map generation fails, it is a bug to be fixed, not a feature to degrade.

When combat is triggered:

1. **AI describes the battlefield** via a tool call (`describe_battlefield`) producing structured JSON: room dimensions, features, entrances/exits, elevation, hazards
2. **Map compiler** (deterministic, not AI) translates the structured description into a `VoxelMap` using a library of voxel primitives (walls, pillars, stairs, tables, trees, boulders, etc.)
3. **Token placement**: PCs at the entrance, enemies per AI's tactical description

Prior art: MineBench demonstrates that LLMs can generate high-quality voxel structures. Mythrun's map requirements are less demanding than MineBench's test scenarios (bounded room-scale environments vs. open-world terrain).

The combat sub-spec will define the structured JSON schema for battlefield descriptions and the compiler's primitive library.

### 6.6 Combat-to-Narrative Handoff

When combat ends, the rules engine produces a `CombatSummary` that feeds back into the narrative system:

```typescript
interface CombatSummary {
  outcome: 'victory' | 'defeat' | 'flee' | 'surrender' | 'other'
  roundsElapsed: number
  casualties: Array<{ name: string; type: 'pc' | 'npc' | 'monster'; fate: 'dead' | 'unconscious' | 'fled' }>
  dramaticMoments: Array<{ description: string; combatantId: string }>  // crits, death save successes, last stands
  resourcesExpended: Array<{ combatantId: string; resource: string; amount: number }>  // spell slots, features used
  hpChanges: Array<{ combatantId: string; hpBefore: number; hpAfter: number }>
  conditionsApplied: Array<{ combatantId: string; condition: string; source: string }>
}
```

This summary is:
- Sent to clients as the `combat_summary` field in the `combat_end` message
- Fed into the **Slow Thinker's** context for post-combat narrative direction
- Fed into the **Fast Thinker's** context as a prose summary for narrative continuity
- Processed by the **Scribe** for fact extraction (NPC deaths, PC injuries, etc.)

### 6.7 SRD Data Requirements

Full 5e combat requires structured rules data from the SRD (open content):
- Weapon properties (damage dice, range, finesse, heavy, etc.)
- Spell definitions (range, area, damage, effects, concentration)
- Monster stat blocks (the `stat_blocks` table already exists)
- Condition mechanical effects
- Movement rules (difficult terrain, climbing, swimming costs)

This data will be sourced from existing open-source SRD datasets (5e-database API, Open5e data files) and stored in Postgres with automated validation tests. The combat sub-spec will define the import pipeline and validation suite.

### 6.8 Combat UI (Frontend)

- **Three.js** voxel renderer: isometric camera, low-detail Minecraft aesthetic
- **Split view**: voxel map takes center stage; chat narration panel pushed to the side
- **Turn indicator**: whose turn, remaining actions
- **Action palette**: buttons/hotbar for available actions based on character abilities and remaining action economy
- **Movement**: click-to-move with path preview, movement cost display, opportunity attack warnings
- **Targeting**: click enemy to target, shows range and hit probability
- **Initiative tracker**: vertical sidebar showing turn order with HP bars

---

## 7. Error Handling, Observability, and Hardening

### 7.1 Observability

**Structured logging**: Pino (Fastify's built-in) configured with JSON format, request ID, user ID, and campaign ID on every log line. Shipped to CloudWatch Logs via ECS `awslogs` log driver. Log retention: 30 days. LLM request/response bodies excluded from logs (log only metadata: duration, token count, model, cost).

**CloudWatch custom metrics:**
- Request latency (p50, p95, p99) per route
- Active WebSocket connections
- LLM call duration and token usage per stage
- Session starts/ends per hour
- Pipeline success/failure rate
- Credit purchases and consumption rate
- Error rate by category

**Alarms:**
- Error rate > 5% over 5 minutes
- LLM API error rate > 10% (Anthropic outage)
- Active sessions > capacity threshold
- Daily LLM spend exceeding budget

**Health check**: `GET /health` returns 200 if the service can reach Postgres and Redis. ALB uses this for routing and instance health.

### 7.2 Rate Limiting

Per-user rate limits enforced via Redis counters with TTL. These are initial ballpark values -- they will be tuned based on real usage patterns after launch.

| Endpoint Category | Limit | Window |
|-------------------|-------|--------|
| World generation | 3 | per hour |
| Campaign creation | 5 | per hour |
| Session start | 10 | per hour |
| WebSocket messages | 30 | per minute |
| API reads | 100 | per minute |
| API writes | 30 | per minute |

Rate limit responses return `429 Too Many Requests` with `Retry-After` header.

### 7.3 Input Validation

Move from manual `typeof` checks to Zod schemas on every route. Fastify supports schema-based validation natively. This provides:
- Request body validation with type-safe handlers
- Automatic 400 responses with structured error messages
- Request size limits (default 1MB, configurable per route)
- WebSocket messages already use Zod (extend to all client message types)

### 7.4 Graceful Shutdown

On `SIGTERM` (sent by ECS before container termination, with 120-second deregistration delay):
1. Stop accepting new connections (health check returns 503 -> ALB drains traffic)
2. For each active WebSocket: send `server_restart` (not `session_end`), persist session state to Redis + checkpoint transcript to Postgres
3. Wait for in-flight LLM calls to complete (30s timeout)
4. Flush pending Scribe operations
5. Close database connection pool
6. Close Redis connections
7. Exit cleanly

Clients receiving `server_restart` auto-reconnect with exponential backoff. The new container loads session state from Redis and sends `session_reconnect`.

### 7.5 Error Handling Strategy

| Failure | Response |
|---------|----------|
| Anthropic API down | Retry with exponential backoff (3 attempts, 1s/2s/4s). If all fail, send `error` to clients, pause session (preserving state in Redis). Session resumes when API recovers. |
| Postgres down | Health check fails -> ALB stops routing -> ECS replaces container. In-flight requests get 503. |
| Redis down (real-time) | **Critical failure.** Active sessions are disrupted. ElastiCache Multi-AZ failover (10-30s). Active sessions may need client reconnect after failover completes. |
| Container crash mid-session | Clients reconnect to any container. New container loads session state from Redis. Sends `session_reconnect` with history from last-seen sequence number. |
| LLM returns invalid structured output | Existing 3-tier repair chain (Haiku -> Sonnet -> throw). |
| Player disconnects | Session continues for other players. Disconnected player can reconnect anytime. |
| Token budget exceeded | ST forces graceful session end. No hard cutoff mid-response. |
| Stripe webhook failure | Stripe retries automatically. Idempotency via `stripe_payment_intent_id` UNIQUE constraint. |
| Concurrent DM trigger | Heartbeat-extended distributed lock ensures only one container processes at a time. Others queue or skip. |

### 7.6 Security

- **CORS**: Restrict `origin` to production domain(s) only -- exact match, no wildcard
- **Security headers**: Helmet middleware (CSP, HSTS, X-Frame-Options, X-Content-Type-Options). Actual header values defined in the Observability & Hardening sub-spec.
- **WebSocket auth**: Ticket-based (see 5.2). No JWT in URLs.
- **WebSocket origin validation**: Check `Origin` header on upgrade request
- **Stripe webhook verification**: Validate request signatures, reject replayed events. Price set server-side, never from client input.
- **Markdown sanitization**: Strip HTML from LLM output before rendering to prevent XSS
- **Request IDs**: UUID per request, propagated through all logs and LLM calls for distributed tracing
- **JWT validation**: Cached JWKS, token expiry enforcement, audience/issuer checks
- **Secrets management**: AWS Secrets Manager (see System Topology section)
- **Combat validation**: The client is untrusted. All combat actions are validated server-side: combatant ownership (`userId` match), turn order, spell/weapon/target validity, position bounds.

---

## 8. LLM Security

The LLM is an attack surface. Players will attempt prompt injection to extract NPC secrets, plot information, and hidden game state.

### 8.1 Enforced-Ignorance Boundary

The existing **enforced-ignorance** architecture is the primary defense: the Fast Thinker never receives secret or private facts. This is an architectural boundary (different LLM calls with different context), not a prompt-based instruction.

**Data flow documentation:**
- **Fast Thinker** receives: `ft_context` (public facts only, validated by `validateFtContext()`), player messages, stage directions from ST (the `direction` field)
- **Slow Thinker** receives: `sd_playbook` (contains secrets, triggers, hidden NPC motivations), running summary, recent exchanges, player message
- The ST's `direction` output is a 1-2 sentence instruction ("have the NPC become evasive") -- it must NOT contain the underlying secret itself

### 8.2 Stage Direction Filtering

The Slow Thinker's `direction` field is the bridge between the secret-aware ST and the ignorance-enforced FT. If the ST writes "reveal that the merchant is actually the assassin" in the direction, the FT now has secret information.

**Mitigation:** The ST system prompt explicitly instructs: stage directions describe behavior, not information. "The merchant becomes nervous and evasive" -- not "the merchant is secretly the assassin." The combat sub-spec and multiplayer sub-spec will define automated validation that the `direction` field does not leak secrets. Per ZFC, this validation uses an AI call (Haiku), not substring matching — Haiku receives the direction text and the list of secret facts and classifies whether any secret information is present or paraphrased. Substring matching is a ZFC violation: it misses paraphrasing, synonyms, and non-English content.

### 8.3 Adversarial Testing

Before launch, build an automated red-team test suite:
- A set of adversarial player messages designed to extract secrets (direct asks, social engineering, "debug mode" injection, Detect Thoughts-style requests)
- Run against the real pipeline (ST + FT)
- Assert that no secret-level facts appear in the FT's response
- Run as part of CI (not just once, but on every prompt template change)

---

## 9. Data Privacy

### 9.1 PII Inventory

| Data | Where Stored | Processor |
|------|-------------|-----------|
| Email, display name | Postgres `users` table, Cognito | AWS |
| Auth tokens | Cognito, Redis (short-lived) | AWS |
| Payment info | Stripe (never stored locally) | Stripe |
| Player messages | Postgres `sessions.transcript`, Redis (transient) | AWS, Anthropic (sent in LLM prompts) |
| Campaign content | Postgres (worlds, entities, facts) | AWS, Anthropic (sent in LLM prompts) |

### 9.2 Requirements

- **User deletion**: `DELETE /api/users/me` endpoint. Cascades: delete user record, anonymize transcript messages (replace with "[deleted user]"), cancel Stripe customer, delete Cognito account. Soft delete with 30-day hard-delete cron.
- **Data retention**: Transcripts older than 12 months are anonymized. Billing records retained for 7 years (legal requirement). Session usage data retained for 2 years.
- **Anthropic as data processor**: Player messages are sent to Anthropic's API. Ensure prompts do not include user emails or real names -- use opaque user IDs and display names only.
- **Privacy policy**: Required before launch. Must disclose: data collected, third-party processors (AWS, Anthropic, Stripe), retention periods, deletion rights.

---

## 10. Decisions Log

| Decision | Rationale |
|----------|-----------|
| **AWS over PaaS** | Solo dev needs reliability and control over WebSocket/long-running LLM behavior. ECS Fargate is the managed-container sweet spot. Docker-based = portable if we ever need to move. |
| **ECS Fargate over EC2** | No server management. Auto-scaling. Pay for what you use. Good WebSocket support. |
| **Separate API and Worker services** | Long-running pipeline Opus calls compete for CPU/memory with WebSocket connections. Separate ECS services prevent pipeline jobs from degrading live session performance. |
| **Postgres over SQLite** | Multi-writer, connection pooling, horizontal read scaling, proper transactions, managed backups via RDS. Required for concurrent users. |
| **Single Redis at launch, scale-up path defined** | One instance handles all workloads (pub/sub, BullMQ, session state, locks) comfortably at 200-500 concurrent sessions. Split to two instances if monitoring shows pub/sub latency during pipeline runs. Add replica for Multi-AZ when session count justifies $23/mo. |
| **No RDS Proxy at launch** | 1-3 containers use ~30 of ~80 available connections. Add RDS Proxy ($22/mo) when auto-scaling exceeds 6+ containers. |
| **Redis is critical, not degradable** | The entire architecture depends on Redis for session state, messaging, and coordination. At launch, a single-node failure means ~30 seconds of disruption (ElastiCache restart). Add Multi-AZ failover when revenue justifies it. |
| **Redis eviction policy: `volatile-lru`** (amended 2026-04-21) | Under memory pressure, evict least-recently-used TTL'd keys (session state) rather than refusing all writes (`noeviction`). Reversal of initial `noeviction` choice after cross-review: `noeviction` causes cascading failure across BullMQ, rate limiting, pub/sub, and session state writes simultaneously when memory fills — the entire Redis surface stops accepting writes. `volatile-lru` degrades gracefully: oldest idle session states are evicted first and reloaded from Postgres checkpoints (5-min cadence) on reconnect, worst-case losing 0-5 minutes of session history per evicted session. BullMQ / rate-limit / pub-sub keys have no TTLs and are preserved. The 80% memory alarm remains the intervention signal; `volatile-lru` keeps the system degraded-but-serving during the 5-10 min upgrade window rather than total write failure. |
| **Ticket-based WebSocket auth** | JWTs in URL query params leak to logs. Single-use upgrade tickets (10s TTL, consumed on use) prevent token leakage. Industry standard (Slack, Discord). |
| **Heartbeat-extended distributed locks** | 60s static TTL expires before Opus calls complete. Heartbeat renewal (15s interval, 120s base) keeps locks alive during long operations. |
| **Server-assigned message sequence numbers** | Multiplayer messages across containers have non-deterministic ordering. Monotonic sequence numbers (Redis INCR) provide a single source of ordering truth. |
| **Cognito for auth** | Managed OAuth2, free under 50K MAU, handles Google + Discord. No password storage. Token lifecycle (refresh, revocation) defined in auth sub-spec. |
| **World/campaign separation** | Worlds are reusable templates. Campaigns are personalized forks. Enables future marketplace where creators earn payouts. Avoids paying for redundant world generation. |
| **Campaign owner pays** | Clean billing model. Owner is the host. Players just need an account and an invite link. |
| **Atomic credit decrement** | Prevents race condition where concurrent requests double-spend credits. Single atomic SQL UPDATE with WHERE guard. |
| **Session-pack billing** | Sessions are a natural unit D&D players understand. Each session is individually profitable (price > API cost). Avoids subscription model where heavy users cost more than they pay. |
| **Free trial: cliffhanger ending** | Time-capped (45-60 min), pre-built demo world (no gen cost), ends on narrative cliffhanger to drive conversion. |
| **Hybrid DM trigger** | @DM for explicit invocation + Haiku auto-detect with debounce for organic moments. No regex fast-path (must support future multi-language). |
| **Combat: debug mode first** | Build the combat trigger/resolution interface before the rules engine. Validates integration without the most complex component. Same interface, swappable implementation. |
| **Full 5e mechanical enforcement** | Combat is a differentiator. Rules-correct mechanical combat with AI narration is something no other product does. Leverage open-source 5e engines to accelerate. |
| **AI-generated voxel maps (no template fallback)** | AI map generation is foundational, not optional. MineBench demonstrates LLM capability for voxel generation. If map gen fails, it's a bug to fix, not a feature to degrade. |
| **CombatSummary for narrative handoff** | Combat results must flow back into the narrative system (ST context, FT context, Scribe extraction). Without this, post-combat narration ignores what happened in combat. |
| **Action stack for combat reactions** | Readied actions and reactions (Counterspell chains, opportunity attacks, Shield) require recursive resolution. Stack model (like MTG) handles all edge cases cleanly. |
| **Blue/green deploys with server_restart** | Rolling updates kill WebSocket connections. Blue/green with connection draining + `server_restart` message type enables seamless deploys. |
| **ALB idle timeout 3600s** | Default 60s kills WebSocket connections during long read pauses. 3600s + 30s ping/pong keepalives prevent spurious disconnects. |
| **Terraform IaC** | All infrastructure defined in code. Reproducible, version-controlled, no console clicking. |
| **Rate limits are ballpark** | Initial values will be tuned based on real usage patterns after launch. |
| **Week 0: Ops Foundation** | VPC, secrets, CI/CD, and staging environment must exist before any application code is deployed. Infrastructure first, always. |
| **ZFC: Zero Framework Cognition** | All semantic analysis delegated to AI (Haiku for cheap decisions). No regex on LLM output, no keyword routing, no heuristic classification. Exceptions: @DM literal, schema validation, dice math. |
| **Deep-copy forks for now, copy-on-write later** | World forking deep-copies 500-800 rows per fork. At >1,000 forks of a single world or >10M entity rows, migrate to a shared-entity model with a campaign-specific overlay table for play modifications (keyed by `modified_by_play`). Until then, deep copy is simpler and correct. |
| **UUIDv7 for all primary keys** | UUIDv4 causes B-tree index fragmentation at scale (random insertion = page splits). UUIDv7 is time-ordered and append-only. One-line change now, impossible to fix for existing rows later. |
| **NUMERIC(10,6) for money, never REAL** | Floating-point accumulation errors compound when summing thousands of small LLM cost values. |
| **session_messages table replaces transcript JSON blob** | A 300KB JSON blob rewritten every 5 minutes per session doesn't scale. Append-only messages table eliminates full-rewrite checkpoints and makes reconnection replay a simple indexed query. |
| **credit_ledger replaces session_credits integer** | An integer counter can't support subscriptions, gifting, refunds, or expiry. A ledger table supports all future billing models without schema migration. |
| **language column on worlds and campaigns** | Defaults to 'en'. One column now prevents a painful i18n data migration later. |
| **modified_by_play on entities** | Enables future marketplace: world creators can push updates that propagate to forks, but only to entities that haven't been changed by play. |
| **moderation_status + moderation_flags tables** | Schema-ready for content moderation. No features built at launch, but the tables exist so the future moderation system doesn't require schema migration on high-traffic tables. |
| **Region prefix on Redis keys** | `{region}:session:{id}` costs nothing now and prevents key collisions when expanding to multi-region. |
| **VoxelMap optional in CombatState** | Debug mode (Layer 1) doesn't generate maps. Making it nullable avoids a type contract violation in the combat interface. |
| **Composite indexes from day one** | Adding indexes to 100M+ row tables requires hours of CREATE INDEX CONCURRENTLY under I/O pressure. Define them at schema creation time. |
| **LLM cost per session is the critical business metric** | Infrastructure is 1-5% of total costs at every scale. Token efficiency determines profitability. Sub-specs must include detailed token cost modeling. |
