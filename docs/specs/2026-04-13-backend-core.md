# Backend Core Sub-Spec

> **Type**: Sub-spec (conforms to Production Architecture Overview)
> **Date**: 2026-04-13
> **Status**: Draft
> **Parent**: `2026-04-06-production-architecture-overview.md`
> **Depends on**: `2026-04-07-week0-ops-foundation.md` (CI/CD, secrets), `2026-04-10-infrastructure-devops.md` (ECS, RDS, Redis config)
> **Scope**: New Node.js + Fastify project from scratch. Postgres schema, migration runner, async repository layer, server skeleton with health checks, Docker image, first deploy to staging. This is the foundation all other sub-projects build on.

---

## Table of Contents

1. [Overview](#1-overview)
2. [Project Setup](#2-project-setup)
3. [Schema Migration System](#3-schema-migration-system)
4. [Complete Postgres Schema](#4-complete-postgres-schema)
5. [Repository Layer](#5-repository-layer)
6. [Server Skeleton](#6-server-skeleton)
7. [Health Checks](#7-health-checks)
8. [First Deploy](#8-first-deploy)
9. [What This Sub-Spec Does NOT Build](#9-what-this-sub-spec-does-not-build)

---

## 1. Overview

This sub-spec produces a deployable backend that does almost nothing — but does it on real infrastructure. The deliverable is:

- A new Node.js + TypeScript + Fastify project in a clean repo
- A Postgres database with the full schema (all tables from the architecture overview)
- An async repository layer with typed methods for every table
- A server that starts, connects to Postgres and Redis, and responds to health checks
- A Docker image that deploys to staging via the CI/CD pipeline from Week 0

Everything after this (auth, billing, pipeline, sessions, combat) is built on top of this foundation.

### What Gets Reused From the Prototype

| Artifact | Reused? | Notes |
|----------|---------|-------|
| LLM prompt templates (`.txt` files) | Yes, copied | Validated through months of iteration |
| Zod schemas for LLM output | Yes, copied | worldConceptSchema, stEvaluationSchema, etc. |
| Universal random table data (JSON) | Yes, copied | appearance, personality, mannerisms, motivations, shop-quirks |
| SRD reference data | Yes, copied | Classes, species, backgrounds |
| Seed random tables | Yes, copied | regional_npc_quirks, travel_encounters |
| TypeScript types for DB entities | Rewritten | New types for new schema (worlds vs campaigns, credit_ledger, etc.) |
| Repository methods | Rewritten | Async pg, new schema, new tables |
| Server/routes | Rewritten | New API surface from UX spec |
| Pipeline stages | Rewritten in Pipeline sub-spec | Same logic, new persistence layer |
| Session runtime | Rewritten in Session sub-spec | Multiplayer, Redis-backed |
| Frontend | Rewritten in Frontend sub-spec | Complete redesign |

---

## 2. Project Setup

### Monorepo Structure

```
mythrun/
  backend/
    migrations/         # Numbered SQL files (outside src/ — never compiled)
    src/
      config/           # App config, model config
      db/
        repository.ts   # Async repository layer
        types.ts        # TypeScript types for all entities
        postgres.ts     # pg Pool setup (`createPgPool`)
        migrate.ts      # Migration runner
      llm/
        client.ts       # LLM abstraction (rewritten for async patterns)
        templates.ts    # Template loader (reused)
        prompts/        # .txt prompt templates (copied from prototype)
      server.ts         # Fastify server entry point
      worker.ts         # BullMQ worker entry point
      health.ts         # Health check endpoints
    tests/
    data/
      tables/           # Universal random tables (copied from prototype)
      srd/              # SRD reference data (copied from prototype)
    package.json
    tsconfig.json
    vitest.config.ts
    Dockerfile
  frontend/             # Separate, built in Frontend sub-spec
  infra/                # Terraform (from Week 0 + Infra specs)
  docker-compose.yml    # Local dev (from Week 0 spec)
  .env.development.example
  pnpm-workspace.yaml
  package.json
```

### Dependencies

| Package | Version | Purpose |
|---------|---------|---------|
| `fastify` | ^5.x | HTTP server |
| `@fastify/cors` | ^11.x | CORS middleware |
| `pg` | ^8.x | Postgres client (async) |
| `ioredis` | ^5.x | Redis client |
| `bullmq` | ^5.x | Job queue |
| `ws` | ^8.x | WebSocket server |
| `zod` | ^4.x | Schema validation |
| `@anthropic-ai/sdk` | ^0.x | Anthropic API client |
| `dotenv` | ^17.x | Env var loading |
| `pino` | (via Fastify) | Structured logging |

Dev: `typescript`, `vitest`, `tsx`, `eslint`, `typescript-eslint`, `@types/pg`, `@types/ws`.

### TypeScript Config

Same as prototype: `target: ES2024`, `module: NodeNext`, `moduleResolution: NodeNext`, `strict: true`, `noUncheckedIndexedAccess: true`.

### ESLint Config

Same strict rules as prototype, plus:
- `@typescript-eslint/no-floating-promises: error` — catches un-awaited async calls (critical for the sync-to-async transition)

---

## 3. Schema Migration System

### How It Works

Migrations are raw SQL files in `backend/migrations/` (sibling of `src/`, kept outside the TypeScript source tree so the compiler never touches them), named with a numeric prefix:

```
migrations/
  001_initial_schema.sql
  002_add_composite_indexes.sql
  003_seed_demo_world.sql
```

A `_migrations` table in Postgres tracks which files have been applied. The leading underscore marks it as infrastructure metadata (sorts to the bottom of `\dt`, signals "framework table, not domain"). The filename is the natural key — no surrogate id:

```sql
CREATE TABLE IF NOT EXISTS _migrations (
  version TEXT PRIMARY KEY,
  applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
```

### Migration Runner (`backend/src/db/migrate.ts`)

~30 lines of code:
1. Ensure `_migrations` table exists
2. Read all `.sql` files from `backend/migrations/`, sorted by name
3. Query `_migrations` for already-applied filenames (`version` column)
4. For each unapplied file, in order:
   a. Begin transaction
   b. Execute the SQL
   c. Insert the filename into `_migrations.version`
   d. Commit
5. Log each applied migration

The runner is called:
- At application startup (before the server starts listening)
- In the CI pipeline as a pre-deploy step (ensures staging/prod schemas are current)
- Manually via `pnpm migrate` for local development

### Migration Discipline

- Migrations are **append-only**. Never edit a migration that has been applied to staging or prod.
- Destructive changes (DROP COLUMN, DROP TABLE) require a two-step migration: first deprecate (stop reading), then remove in a later migration.
- Long-running migrations (large index creation) use `CREATE INDEX CONCURRENTLY` and must set `SET statement_timeout = 0` at the top of the file.
- Each migration file is idempotent where possible (use `IF NOT EXISTS`, `IF EXISTS` guards).

---

## 4. Complete Postgres Schema

All tables from the architecture overview spec, incorporating Razor's schema fixes (UUIDv7, NUMERIC for money, composite indexes, session_messages, credit_ledger).

### Migration 001: Initial Schema

```sql
-- Enable extensions
CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- UUIDv7 generation function (application-side is preferred, but this provides a DB-level fallback)
-- In practice, UUIDv7 is generated in application code using a library like 'uuid' v10+

-- Users
CREATE TABLE users (
  id UUID PRIMARY KEY,
  cognito_sub TEXT NOT NULL UNIQUE,
  email TEXT NOT NULL UNIQUE,
  display_name TEXT NOT NULL,
  username TEXT NOT NULL UNIQUE,
  avatar_url TEXT,
  auth_provider TEXT NOT NULL CHECK (auth_provider IN ('google', 'discord')),
  stripe_customer_id TEXT UNIQUE,
  free_trial_used BOOLEAN NOT NULL DEFAULT false,
  suspended_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Credit Ledger (replaces simple session_credits integer)
CREATE TABLE credit_ledger (
  id UUID PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  credit_type TEXT NOT NULL CHECK (credit_type IN ('session', 'world_gen')),
  amount INTEGER NOT NULL,
  source_type TEXT NOT NULL CHECK (source_type IN ('purchase', 'subscription', 'gift', 'trial', 'refund', 'debit')),
  source_id UUID,
  granted_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at TIMESTAMPTZ
);
CREATE INDEX idx_credit_ledger_user_type ON credit_ledger(user_id, credit_type, expires_at);

-- Worlds
CREATE TABLE worlds (
  id UUID PRIMARY KEY,
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

-- Campaigns
CREATE TABLE campaigns (
  id UUID PRIMARY KEY,
  world_id UUID NOT NULL REFERENCES worlds(id) ON DELETE CASCADE,
  source_world_id UUID REFERENCES worlds(id) ON DELETE SET NULL,
  created_by UUID NOT NULL REFERENCES users(id),
  name TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'setup' CHECK (status IN ('setup', 'active', 'archived')),
  language TEXT NOT NULL DEFAULT 'en',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Campaign Members
CREATE TABLE campaign_members (
  id UUID PRIMARY KEY,
  campaign_id UUID NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role TEXT NOT NULL CHECK (role IN ('owner', 'player')),
  invite_accepted BOOLEAN NOT NULL DEFAULT false,
  joined_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(campaign_id, user_id)
);

-- Campaign Invites
CREATE TABLE campaign_invites (
  id UUID PRIMARY KEY,
  campaign_id UUID NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
  created_by UUID NOT NULL REFERENCES users(id),
  invite_code TEXT NOT NULL UNIQUE,
  max_uses INTEGER,
  uses INTEGER NOT NULL DEFAULT 0,
  expires_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Stat Blocks
CREATE TABLE stat_blocks (
  id UUID PRIMARY KEY,
  name TEXT NOT NULL,
  cr TEXT,
  armor_class INTEGER NOT NULL,
  hit_points INTEGER NOT NULL,
  hit_dice TEXT,
  speed TEXT NOT NULL,
  str INTEGER NOT NULL,
  dex INTEGER NOT NULL,
  con INTEGER NOT NULL,
  int INTEGER NOT NULL,
  wis INTEGER NOT NULL,
  cha INTEGER NOT NULL,
  skills TEXT,
  senses TEXT,
  languages TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE stat_block_actions (
  id UUID PRIMARY KEY,
  stat_block_id UUID NOT NULL REFERENCES stat_blocks(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  action_type TEXT NOT NULL CHECK (action_type IN ('action', 'reaction', 'bonus_action', 'legendary')),
  description TEXT NOT NULL
);

-- Entities (belong to worlds, not campaigns)
CREATE TABLE entities (
  id UUID PRIMARY KEY,
  world_id UUID NOT NULL REFERENCES worlds(id) ON DELETE CASCADE,
  entity_type TEXT NOT NULL CHECK (entity_type IN ('npc', 'location', 'faction', 'item')),
  name TEXT NOT NULL,
  stat_block_id UUID REFERENCES stat_blocks(id) ON DELETE SET NULL,
  encountered BOOLEAN NOT NULL DEFAULT false,
  modified_by_play BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Prose Kernels
CREATE TABLE prose_kernels (
  id UUID PRIMARY KEY,
  entity_id UUID NOT NULL UNIQUE REFERENCES entities(id) ON DELETE CASCADE,
  content TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Facts
CREATE TABLE facts (
  id UUID PRIMARY KEY,
  entity_id UUID NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
  topic TEXT NOT NULL,
  access_level TEXT NOT NULL CHECK (access_level IN ('public', 'private', 'secret')),
  narrative_status TEXT NOT NULL CHECK (narrative_status IN ('undelivered', 'delivered', 'developed', 'resolved')),
  content TEXT NOT NULL,
  source TEXT NOT NULL DEFAULT 'prep',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Relationships
CREATE TABLE relationships (
  id UUID PRIMARY KEY,
  source_entity_id UUID NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
  target_entity_id UUID NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
  relationship_type TEXT NOT NULL,
  description TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Entity Hierarchy
CREATE TABLE entity_hierarchy (
  id UUID PRIMARY KEY,
  parent_entity_id UUID NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
  child_entity_id UUID NOT NULL UNIQUE REFERENCES entities(id) ON DELETE CASCADE
);

-- Random Tables
CREATE TABLE random_tables (
  id UUID PRIMARY KEY,
  world_id UUID NOT NULL REFERENCES worlds(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  category TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE random_table_entries (
  id UUID PRIMARY KEY,
  table_id UUID NOT NULL REFERENCES random_tables(id) ON DELETE CASCADE,
  roll_min INTEGER NOT NULL,
  roll_max INTEGER NOT NULL,
  content TEXT NOT NULL
);

-- Characters
CREATE TABLE characters (
  id UUID PRIMARY KEY,
  campaign_id UUID NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
  user_id UUID REFERENCES users(id),
  entity_id UUID REFERENCES entities(id) ON DELETE SET NULL,
  name TEXT NOT NULL,
  level INTEGER NOT NULL DEFAULT 1,
  class TEXT NOT NULL,
  species TEXT NOT NULL,
  background TEXT NOT NULL,
  str INTEGER NOT NULL,
  dex INTEGER NOT NULL,
  con INTEGER NOT NULL,
  int INTEGER NOT NULL,
  wis INTEGER NOT NULL,
  cha INTEGER NOT NULL,
  hit_points INTEGER NOT NULL,
  max_hit_points INTEGER NOT NULL,
  armor_class INTEGER NOT NULL,
  proficiency_bonus INTEGER NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE character_skills (
  id UUID PRIMARY KEY,
  character_id UUID NOT NULL REFERENCES characters(id) ON DELETE CASCADE,
  skill_name TEXT NOT NULL,
  proficiency_level TEXT NOT NULL CHECK (proficiency_level IN ('none', 'proficient', 'expertise'))
);

CREATE TABLE character_features (
  id UUID PRIMARY KEY,
  character_id UUID NOT NULL REFERENCES characters(id) ON DELETE CASCADE,
  feature_name TEXT NOT NULL,
  feature_source TEXT NOT NULL,
  description TEXT NOT NULL
);

CREATE TABLE character_equipment (
  id UUID PRIMARY KEY,
  character_id UUID NOT NULL REFERENCES characters(id) ON DELETE CASCADE,
  item_name TEXT NOT NULL,
  quantity INTEGER NOT NULL DEFAULT 1,
  equipped BOOLEAN NOT NULL DEFAULT false
);

CREATE TABLE character_spells (
  id UUID PRIMARY KEY,
  character_id UUID NOT NULL REFERENCES characters(id) ON DELETE CASCADE,
  spell_name TEXT NOT NULL,
  spell_level INTEGER NOT NULL,
  prepared BOOLEAN NOT NULL DEFAULT false
);

-- Sessions
CREATE TABLE sessions (
  id UUID PRIMARY KEY,
  campaign_id UUID NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
  session_number INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'ended', 'crashed')),
  started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  ended_at TIMESTAMPTZ,
  summary TEXT,
  st_running_summary TEXT,
  handoff TEXT
);

-- Session Messages (replaces transcript JSON blob)
CREATE TABLE session_messages (
  id UUID PRIMARY KEY,
  session_id UUID NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  seq INTEGER NOT NULL,
  user_id UUID,
  message_type TEXT NOT NULL,
  content TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Session Participants
CREATE TABLE session_participants (
  id UUID PRIMARY KEY,
  session_id UUID NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES users(id),
  character_id UUID NOT NULL REFERENCES characters(id),
  joined_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(session_id, user_id)
);

-- Pipeline Runs
CREATE TABLE pipeline_runs (
  id UUID PRIMARY KEY,
  world_id UUID REFERENCES worlds(id) ON DELETE CASCADE,
  campaign_id UUID REFERENCES campaigns(id) ON DELETE CASCADE,
  stage TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending', 'running', 'completed', 'failed')),
  error TEXT,
  started_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,
  input_tokens INTEGER DEFAULT 0,
  output_tokens INTEGER DEFAULT 0,
  cost_usd NUMERIC(10,6) DEFAULT 0,
  user_id UUID REFERENCES users(id),
  UNIQUE(COALESCE(world_id, campaign_id), stage, COALESCE(user_id, '00000000-0000-0000-0000-000000000000'))
);

-- World Snapshots
CREATE TABLE world_snapshots (
  id UUID PRIMARY KEY,
  campaign_id UUID NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
  label TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  data TEXT NOT NULL
);

-- Session Preps
CREATE TABLE session_preps (
  id UUID PRIMARY KEY,
  campaign_id UUID NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
  session_number INTEGER NOT NULL,
  ft_context TEXT NOT NULL,
  sd_playbook TEXT NOT NULL,
  snapshot_id UUID REFERENCES world_snapshots(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Session Usage (cost tracking)
CREATE TABLE session_usage (
  id UUID PRIMARY KEY,
  session_id UUID NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  campaign_id UUID NOT NULL REFERENCES campaigns(id),
  user_id UUID NOT NULL REFERENCES users(id),
  input_tokens INTEGER NOT NULL DEFAULT 0,
  output_tokens INTEGER NOT NULL DEFAULT 0,
  estimated_cost_usd NUMERIC(10,6) NOT NULL DEFAULT 0,
  budget_limit_tokens INTEGER NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Purchases
CREATE TABLE purchases (
  id UUID PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES users(id),
  stripe_payment_intent_id TEXT NOT NULL UNIQUE,
  session_pack_size INTEGER NOT NULL,
  amount_cents INTEGER NOT NULL,
  currency TEXT NOT NULL DEFAULT 'usd',
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'completed', 'failed', 'refunded')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- World Marketplace (schema-ready, not built at launch)
CREATE TABLE world_marketplace (
  id UUID PRIMARY KEY,
  world_id UUID NOT NULL UNIQUE REFERENCES worlds(id) ON DELETE CASCADE,
  listing_title TEXT NOT NULL,
  listing_description TEXT NOT NULL,
  tags TEXT[],
  creator_payout_cents INTEGER NOT NULL DEFAULT 0,
  listed_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Moderation Flags (schema-ready, not built at launch)
CREATE TABLE moderation_flags (
  id UUID PRIMARY KEY,
  target_type TEXT NOT NULL CHECK (target_type IN ('world', 'session_message', 'user')),
  target_id UUID NOT NULL,
  reporter_id UUID REFERENCES users(id),
  reason TEXT NOT NULL,
  severity TEXT NOT NULL CHECK (severity IN ('low', 'medium', 'high', 'critical')),
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'reviewed', 'actioned', 'dismissed')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  resolved_at TIMESTAMPTZ
);

-- Subscription Tiers (configuration)
CREATE TABLE subscription_tiers (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  stripe_price_id TEXT NOT NULL,
  session_credits_per_month INTEGER NOT NULL,
  world_gen_credits_per_month INTEGER NOT NULL,
  price_cents INTEGER NOT NULL,
  currency TEXT NOT NULL DEFAULT 'usd',
  is_active BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- User Subscriptions
CREATE TABLE user_subscriptions (
  id UUID PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  tier_id TEXT NOT NULL REFERENCES subscription_tiers(id),
  stripe_subscription_id TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL CHECK (status IN ('active', 'past_due', 'canceled', 'unpaid')),
  current_period_start TIMESTAMPTZ NOT NULL,
  current_period_end TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_user_subscriptions_user ON user_subscriptions(user_id);

-- Session Packs (configuration)
CREATE TABLE session_packs (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  session_credits INTEGER NOT NULL,
  world_gen_credits INTEGER NOT NULL DEFAULT 0,
  stripe_price_id TEXT NOT NULL,
  price_cents INTEGER NOT NULL,
  currency TEXT NOT NULL DEFAULT 'usd',
  is_active BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Stripe Event Idempotency
CREATE TABLE stripe_events (
  event_id TEXT PRIMARY KEY,
  event_type TEXT NOT NULL,
  processed_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Settings
CREATE TABLE settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
```

### Migration 002: Indexes

```sql
-- Entity queries by world and type (hot path for Scribe, ST, session loading)
CREATE INDEX idx_entities_world_type ON entities(world_id, entity_type);
CREATE INDEX idx_entities_world ON entities(world_id);

-- Fact queries filtered by access level and narrative status
CREATE INDEX idx_facts_entity ON facts(entity_id);
CREATE INDEX idx_facts_entity_access_status ON facts(entity_id, access_level, narrative_status);

-- Relationship lookups
CREATE INDEX idx_relationships_source ON relationships(source_entity_id);
CREATE INDEX idx_relationships_target ON relationships(target_entity_id);

-- Session messages ordered replay
CREATE INDEX idx_session_messages_session_seq ON session_messages(session_id, seq);

-- Campaign lookups
CREATE INDEX idx_campaigns_created_by ON campaigns(created_by);
CREATE INDEX idx_campaign_members_user ON campaign_members(user_id);
CREATE INDEX idx_campaign_members_campaign ON campaign_members(campaign_id);

-- Session lookups
CREATE INDEX idx_sessions_campaign ON sessions(campaign_id);
CREATE INDEX idx_session_preps_campaign ON session_preps(campaign_id);

-- Prevent duplicate active sessions per campaign
CREATE UNIQUE INDEX idx_sessions_one_active ON sessions(campaign_id) WHERE status = 'active';

-- Pipeline tracking
CREATE INDEX idx_pipeline_runs_world ON pipeline_runs(world_id);
CREATE INDEX idx_pipeline_runs_campaign ON pipeline_runs(campaign_id);

-- Random tables
CREATE INDEX idx_random_tables_world ON random_tables(world_id);

-- Characters
CREATE INDEX idx_characters_campaign ON characters(campaign_id);
CREATE INDEX idx_characters_user ON characters(user_id);

-- World snapshots
CREATE INDEX idx_world_snapshots_campaign ON world_snapshots(campaign_id);

-- Purchases
CREATE INDEX idx_purchases_user ON purchases(user_id);
```

### Migration 003: SRD Reference Tables

```sql
-- SRD Monsters
CREATE TABLE srd_monsters (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  size TEXT NOT NULL,
  type TEXT NOT NULL,
  alignment TEXT,
  ac INTEGER NOT NULL,
  ac_type TEXT,
  hp INTEGER NOT NULL,
  hit_dice TEXT NOT NULL,
  speed JSONB NOT NULL,
  str INTEGER NOT NULL,
  dex INTEGER NOT NULL,
  con INTEGER NOT NULL,
  int INTEGER NOT NULL,
  wis INTEGER NOT NULL,
  cha INTEGER NOT NULL,
  saving_throws JSONB,
  skills JSONB,
  damage_resistances TEXT[],
  damage_immunities TEXT[],
  damage_vulnerabilities TEXT[],
  condition_immunities TEXT[],
  senses JSONB,
  languages TEXT[],
  cr TEXT NOT NULL,
  xp INTEGER NOT NULL,
  special_abilities JSONB,
  actions JSONB,
  legendary_actions JSONB,
  reactions JSONB,
  data JSONB
);

-- SRD Spells
CREATE TABLE srd_spells (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  level INTEGER NOT NULL,
  school TEXT NOT NULL,
  casting_time TEXT NOT NULL,
  range TEXT NOT NULL,
  components TEXT NOT NULL,
  duration TEXT NOT NULL,
  concentration BOOLEAN NOT NULL DEFAULT false,
  description TEXT NOT NULL,
  higher_levels TEXT,
  damage JSONB,
  area_of_effect JSONB,
  save JSONB,
  classes TEXT[],
  data JSONB
);

-- SRD Conditions
CREATE TABLE srd_conditions (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT NOT NULL,
  mechanical_effects JSONB
);
```

---

## 5. Repository Layer

### Pattern

Async closure-based, same as prototype but with `pg.Pool`:

```typescript
import { Pool } from 'pg'

export function createRepository(pool: Pool) {
  return {
    users: {
      create: async (input: CreateUserInput): Promise<string> => { ... },
      getById: async (id: string): Promise<User | null> => { ... },
      getByCognitoSub: async (sub: string): Promise<User | null> => { ... },
      // ...
    },
    worlds: { ... },
    campaigns: { ... },
    entities: { ... },
    // ... all namespaces
  }
}

export type Repository = ReturnType<typeof createRepository>
```

### Namespaces and Key Methods

Each namespace corresponds to a table group. Methods listed are the initial surface — sub-specs will add methods as needed.

**`repo.users`**: `create`, `getById`, `getByCognitoSub`, `getByEmail`, `update`, `softDelete`

**`repo.creditLedger`**: `grant` (insert positive amount), `debit` (insert negative amount), `getBalance` (SUM with expiry filter), `getHistory`

**`repo.worlds`**: `create`, `getById`, `listByUser`, `update`, `updateStatus`, `incrementForkCount`, `fork(sourceWorldId, newWorldId)`

**`repo.campaigns`**: `create`, `getById`, `listByUser` (via campaign_members JOIN), `update`, `transferOwnership`

**`repo.campaignMembers`**: `add`, `get` (by campaign + user), `listByCampaign`, `listByUser`, `remove`, `updateRole`

**`repo.campaignInvites`**: `create`, `getByCode`, `incrementUses`, `deactivate`

**`repo.entities`**: `create`, `getById`, `listByWorld` (with optional type filter), `markEncountered`, `markModifiedByPlay`, `update`

**`repo.proseKernels`**: `create`, `getByEntity`, `update`

**`repo.facts`**: `create`, `listByEntity` (with access level filter), `updateByTopic`, `updateContent`, `updateNarrativeStatus`

**`repo.relationships`**: `create`, `listByEntity` (both directions)

**`repo.entityHierarchy`**: `setParent`, `getChildren`, `getParent`

**`repo.randomTables`**: `create`, `addEntry`, `getEntries`, `listByWorld`

**`repo.characters`**: `create`, `getById`, `getByCampaignAndUser`, `update`, `addSkill`, `addFeature`, `addEquipment`, `addSpell`, `getSkills`, `getFeatures`, `getEquipment`, `getSpells`

**`repo.sessions`**: `create`, `getById`, `getActiveByCampaign`, `update`, `updateRunningSummary`, `listByCampaign`

**`repo.sessionMessages`**: `append` (insert new message with next seq), `listBySession` (ordered by seq), `listAfterSeq` (for reconnection replay), `getNextSeq`

**`repo.sessionParticipants`**: `add`, `listBySession`, `remove`

**`repo.pipelineRuns`**: `initializeStages`, `listByWorld`, `listByCampaign`, `markRunning`, `markCompleted`, `markFailed`, `resetStage`

**`repo.snapshots`**: `create`, `getById`, `listByCampaign`, `getLatest`

**`repo.sessionPreps`**: `create`, `getById`, `getBySession`, `getLatest`, `listByCampaign`, `deleteAfterSession`, `deleteAll`

**`repo.sessionUsage`**: `create`, `update` (accumulate tokens), `getBySession`

**`repo.purchases`**: `create`, `getByPaymentIntent`, `updateStatus`, `listByUser`

**`repo.statBlocks`**: `create`, `getById`, `getActions`, `addAction`

**`repo.userSubscriptions`**: `create`, `getByUser`, `getByStripeId`, `update`

**`repo.subscriptionTiers`**: `getById`, `listActive`

**`repo.sessionPacks`**: `getById`, `listActive`

**`repo.stripeEvents`**: `exists` (check if event already processed), `record` (mark event as processed)

**`repo.srd`**: `getMonster`, `getSpell`, `getCondition`, `searchMonsters`, `searchSpells`

**`repo.settings`**: `get`, `set`

### UUIDv7 Generation

All UUIDs are generated application-side using a UUIDv7 library (e.g., `uuid` v10+ which supports UUIDv7, or the `uuidv7` package). The database receives pre-generated UUIDs — no `gen_random_uuid()` in SQL.

```typescript
import { uuidv7 } from 'uuidv7'

// In every create method:
const id = uuidv7()
await pool.query('INSERT INTO entities (id, ...) VALUES ($1, ...)', [id, ...])
return id
```

### Query Patterns

All queries use parameterized `$1, $2, ...` placeholders (never string interpolation). All methods return typed results using `as` assertions on the query result rows — same pattern as the prototype but with `pool.query()` instead of `db.prepare()`.

---

## 6. Server Skeleton

### Entry Point (`server.ts`)

```typescript
import Fastify from 'fastify'
import cors from '@fastify/cors'
import { createPool } from './db/pool.js'
import { runMigrations } from './db/migrate.js'
import { createRepository } from './db/repository.js'
import { createRedisClients } from './redis.js'
import { registerHealthRoutes } from './health.js'

export async function createServer() {
  // Connect to Postgres
  const pool = createPool()
  await runMigrations(pool)
  const repo = createRepository(pool)

  // Connect to Redis
  const redis = createRedisClients()

  // Create Fastify instance
  const app = Fastify({ logger: true })
  await app.register(cors, { origin: process.env.CORS_ORIGIN ?? true })

  // Register routes
  registerHealthRoutes(app, pool, redis)
  // Auth routes registered in Auth sub-spec
  // Billing routes registered in Billing sub-spec
  // Campaign/world routes registered in Pipeline sub-spec
  // Session/WebSocket routes registered in Session sub-spec

  // Graceful shutdown
  const shutdown = async () => {
    app.log.info('SIGTERM received, shutting down...')
    // Sub-specs add their shutdown logic here (WebSocket drain, etc.)
    await app.close()
    await pool.end()
    redis.quit()
    process.exit(0)
  }
  process.on('SIGTERM', shutdown)
  process.on('SIGINT', shutdown)

  return app
}

// Direct execution
const app = await createServer()
const port = Number(process.env.PORT ?? 3000)
await app.listen({ port, host: '0.0.0.0' })
```

### Worker Entry Point (`worker.ts`)

```typescript
import { createPool } from './db/pool.js'
import { runMigrations } from './db/migrate.js'
import { createRepository } from './db/repository.js'
import { createRedisClients } from './redis.js'
import { createHealthServer } from './health.js'
// BullMQ worker setup added in Pipeline sub-spec

async function main() {
  const pool = createPool()
  await runMigrations(pool)
  const repo = createRepository(pool)
  const redis = createRedisClients()

  // Minimal HTTP server for health checks (port 3001)
  const healthServer = createHealthServer(pool, redis, 3001)

  // BullMQ workers registered here by Pipeline sub-spec

  process.on('SIGTERM', async () => {
    // Close BullMQ workers gracefully
    healthServer.close()
    await pool.end()
    redis.quit()
    process.exit(0)
  })
}

main()
```

### Postgres Pool (`pool.ts`)

```typescript
import { Pool } from 'pg'

export function createPool(): Pool {
  return new Pool({
    connectionString: buildConnectionString(),
    max: process.env.DB_POOL_SIZE ? Number(process.env.DB_POOL_SIZE) : 10,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 5_000,
  })
}

function buildConnectionString(): string {
  const host = process.env.DB_HOST ?? 'localhost'
  const port = process.env.DB_PORT ?? '5432'
  const name = process.env.DB_NAME ?? 'mythrun'
  const user = process.env.DB_USER ?? 'mythrun'
  const password = process.env.DB_PASSWORD ?? 'mythrun_dev'
  return `postgresql://${user}:${password}@${host}:${port}/${name}`
}
```

### Redis Clients (`redis.ts`)

```typescript
import Redis from 'ioredis'

export function createRedisClients() {
  const url = process.env.REDIS_URL ?? 'redis://localhost:6379'
  const primary = new Redis(url)       // General commands
  const subscriber = new Redis(url)     // Pub/sub subscriber (dedicated connection)
  // BullMQ creates its own connections internally

  return {
    primary,
    subscriber,
    quit: () => { primary.quit(); subscriber.quit() }
  }
}
```

---

## 7. Health Checks

Two endpoints as defined in the Infrastructure spec:

**`GET /health/live`** — liveness (ECS container check):
- Returns 200 if the event loop is responsive
- No dependency checks
- Implementation: immediate JSON response `{ status: 'ok' }`

**`GET /health/ready`** — readiness (ALB target group check):
- Returns 200 if Postgres (`SELECT 1`) and Redis (`PING`) are reachable
- Returns 503 if either fails
- Response body: `{ status: 'ok', postgres: 'ok', redis: 'ok' }` or `{ status: 'degraded', postgres: 'ok', redis: 'error' }`

**`GET /health`** — alias for `/health/ready` (used by CI smoke test)

---

## 8. First Deploy

The Backend Core sub-spec is complete when:

1. The Docker image builds successfully in CI
2. `pnpm test` passes (health check tests, migration runner tests, basic repo CRUD tests)
3. `pnpm typecheck` passes
4. `pnpm lint` passes
5. The image deploys to staging ECS
6. `GET https://staging-api.mythrun.com/health` returns 200 with `{ status: 'ok', postgres: 'ok', redis: 'ok' }`
7. The Postgres schema is applied (all tables exist, all indexes created)

At this point, the server does nothing useful — it just proves the infrastructure pipeline works end-to-end: code -> build -> test -> image -> deploy -> healthy container talking to real Postgres and Redis.

---

## 9. What This Sub-Spec Does NOT Build

| Feature | Built In |
|---------|----------|
| Auth middleware, JWT validation, Cognito | Auth & Users sub-spec |
| Stripe integration, billing routes | Billing sub-spec |
| World gen pipeline, character creation pipeline | Pipeline sub-spec |
| Session controller, WebSocket, multiplayer | Session Runtime sub-spec |
| Combat engine, rules, maps | Combat sub-spec |
| Any frontend code | Frontend sub-spec |
| Custom CloudWatch metrics | Observability sub-spec |
| Rate limiting middleware | Observability sub-spec |
| LLM client implementation | Pipeline sub-spec (reuses prototype's client.ts pattern) |

The Backend Core is a blank canvas with plumbing. Everything interesting happens in the sub-specs that follow.
