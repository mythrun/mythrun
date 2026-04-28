# Repository Layer Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the foundation repository layer (`repo.users`, `repo.worlds`, `repo.campaigns`, `repo.sessions`) over the schema landed in MYT-33, so Auth/Billing/Sessions can call `repo.<namespace>.<method>` instead of raw `pool.query`.

**Architecture:** Closure-based factory `createRepo(pool)` returning `{ users, worlds, campaigns, sessions }`. Each namespace is one file under `backend/src/repo/`. Mappers convert snake_case rows to camelCase TS objects; UUIDv7s generated app-side via a single seam at `repo/uuidv7.ts`. Real-DB integration tests with TRUNCATE-based reset (migrations run once per file in `beforeAll`).

**Tech Stack:** TypeScript (strict + ESM + NodeNext + EOPT + noUncheckedIndexedAccess), `pg@^8.13`, `uuidv7@^1.0.2`, Vitest. PostgreSQL 16 via docker-compose locally + service container in CI.

**Spec:** `docs/superpowers/specs/2026-04-28-repository-layer-design.md`
**Parent:** `docs/specs/2026-04-13-backend-core.md` §5 (Repository Layer)

---

## File Structure

| Path | Status | Responsibility |
|------|--------|----------------|
| `backend/src/repo/uuidv7.ts` | NEW | One-line wrapper around the `uuidv7` package — testability seam |
| `backend/src/repo/types.ts` | NEW | Row interfaces (User, World, Campaign, Session) + Update input types |
| `backend/src/repo/mappers.ts` | NEW | snake_case row → camelCase TS object; narrowing helpers for enum-like CHECK columns |
| `backend/src/repo/users.ts` | NEW | `createUsersRepo(pool)` |
| `backend/src/repo/worlds.ts` | NEW | `createWorldsRepo(pool)` |
| `backend/src/repo/campaigns.ts` | NEW | `createCampaignsRepo(pool)` |
| `backend/src/repo/sessions.ts` | NEW | `createSessionsRepo(pool)` |
| `backend/src/repo/index.ts` | NEW | `createRepo(pool)` composing the four; exports `Repo` type |
| `backend/src/repo/__tests__/_helpers/reset-data.ts` | NEW | TRUNCATE helper for `beforeEach` data reset |
| `backend/src/repo/__tests__/mappers.test.ts` | NEW | Pure unit tests for mappers + narrowing helpers |
| `backend/src/repo/__tests__/users.test.ts` | NEW | Real-DB integration tests for users namespace |
| `backend/src/repo/__tests__/worlds.test.ts` | NEW | Real-DB integration tests for worlds namespace |
| `backend/src/repo/__tests__/campaigns.test.ts` | NEW | Real-DB integration tests for campaigns namespace |
| `backend/src/repo/__tests__/sessions.test.ts` | NEW | Real-DB integration tests for sessions namespace |
| `backend/src/app-deps.ts` | MODIFY | Add `repo: Repo` |
| `backend/src/server.ts` | MODIFY | Construct repo in both boot paths; thread to `buildApp` |
| `backend/src/db/migrate.ts` | MODIFY | Switch CLI block's `uuidv7` import to `../repo/uuidv7.js` |

---

## Task 1: `uuidv7.ts` seam + switch migrate.ts CLI to use it

**Files:**
- Create: `backend/src/repo/uuidv7.ts`
- Modify: `backend/src/db/migrate.ts` (one import line)
- Test: `backend/src/repo/__tests__/uuidv7.test.ts` (NEW)

> **Why this is task 1**: tiny standalone module, gets the seam in place, lets every later task `import { uuidv7 } from './uuidv7.js'` consistently.

- [ ] **Step 1: Write the failing test**

Create `backend/src/repo/__tests__/uuidv7.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { uuidv7 } from '../uuidv7.js'

describe('uuidv7', () => {
  it('produces a valid UUIDv7 string', () => {
    const id = uuidv7()
    // UUIDv7 format: 8-4-4-4-12 lowercase hex; version nibble (13th char) is '7'
    expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/)
  })

  it('produces time-ordered ids: a later call sorts after an earlier call', async () => {
    const a = uuidv7()
    await new Promise((r) => setTimeout(r, 2))
    const b = uuidv7()
    expect(a < b).toBe(true)
  })
})
```

- [ ] **Step 2: Run, expect FAIL**

```bash
cd backend && pnpm vitest run src/repo/__tests__/uuidv7.test.ts
```

Expected: module not found.

- [ ] **Step 3: Implement the wrapper**

Create `backend/src/repo/uuidv7.ts`:

```ts
import { uuidv7 as uuidv7Pkg } from 'uuidv7'

/**
 * UUIDv7 generator — time-ordered keys for B-tree locality on PK indexes.
 *
 * Wraps the `uuidv7` package as a single-line module so:
 *   1. Tests can vi.mock('./uuidv7.js') if deterministic IDs are needed.
 *   2. A future migration to a different UUIDv7 lib is a one-file change.
 *
 * Used by every repo create method and by the migration runner CLI's runId.
 */
export const uuidv7 = (): string => uuidv7Pkg()
```

- [ ] **Step 4: Run, expect PASS**

```bash
cd backend && pnpm vitest run src/repo/__tests__/uuidv7.test.ts && pnpm typecheck && pnpm lint
```

Both tests pass; typecheck + lint clean.

- [ ] **Step 5: Switch migrate.ts CLI to use the seam**

In `backend/src/db/migrate.ts`, find the import at line 7:

```ts
import { uuidv7 } from 'uuidv7'
```

Replace with:

```ts
import { uuidv7 } from '../repo/uuidv7.js'
```

The function call site (`const runId = uuidv7()`) is unchanged.

- [ ] **Step 6: Run all backend tests to verify nothing broke**

```bash
cd backend && pnpm test
```

Expected: full suite green (the existing 83 tests + the 2 new ones = 85). The migration runner's runId still resolves correctly through the wrapper.

- [ ] **Step 7: Commit**

```bash
git add backend/src/repo/uuidv7.ts backend/src/repo/__tests__/uuidv7.test.ts backend/src/db/migrate.ts
git commit -m "feat(myt-34): uuidv7 wrapper module + migrate.ts uses it"
```

---

## Task 2: Row types

**Files:**
- Create: `backend/src/repo/types.ts`

> **Note**: this task is types-only; no tests. The next task (mappers) exercises these types and tests them.

- [ ] **Step 1: Author the types**

Create `backend/src/repo/types.ts`:

```ts
// Row types match the camelCase TS surface. snake_case DbRow types live in
// mappers.ts where the conversion happens. Identity fields (cognitoSub,
// email, authProvider on User; etc.) are never part of Update types — see
// the spec §4.4.

export interface User {
  readonly id: string
  readonly cognitoSub: string
  readonly email: string
  readonly displayName: string
  readonly username: string
  readonly avatarUrl: string | null
  readonly authProvider: 'google' | 'discord'
  readonly stripeCustomerId: string | null
  readonly freeTrialUsed: boolean
  readonly suspendedAt: Date | null
  readonly createdAt: Date
  readonly updatedAt: Date
}

export interface CreateUserInput {
  readonly cognitoSub: string
  readonly email: string
  readonly displayName: string
  readonly username: string
  readonly avatarUrl?: string | null
  readonly authProvider: 'google' | 'discord'
}

// Spelled-out (not Partial<Pick<...>>) so exactOptionalPropertyTypes
// behavior is intentional. Each key omitted → field unchanged. For
// nullable columns, the spec's COALESCE pattern means null in the
// patch ALSO means "unchanged" (it's the sentinel for "no update").
// Clearing nullable fields is out of scope; spec §4.4 documents the
// limitation.
export interface UserUpdate {
  readonly displayName?: string
  readonly username?: string
  readonly avatarUrl?: string | null
  readonly stripeCustomerId?: string | null
  readonly freeTrialUsed?: boolean
}

export interface World {
  readonly id: string
  readonly createdBy: string
  readonly sourceWorldId: string | null
  readonly name: string
  readonly concept: string
  readonly tone: string | null
  readonly themes: string | null
  readonly geographySummary: string | null
  readonly politicalSummary: string | null
  readonly era: string | null
  readonly keyTensions: string | null
  readonly worldOverview: string | null
  readonly followUpQuestions: string | null
  readonly startingSituations: string | null
  readonly isPublic: boolean
  readonly forkCount: number
  readonly status: 'generating' | 'complete' | 'failed'
  readonly language: string
  readonly moderationStatus: 'unreviewed' | 'approved' | 'flagged' | 'removed'
  readonly createdAt: Date
  readonly updatedAt: Date
}

export interface CreateWorldInput {
  readonly createdBy: string
  readonly name: string
  readonly concept: string
  readonly sourceWorldId?: string | null
  readonly tone?: string | null
  readonly themes?: string | null
  readonly geographySummary?: string | null
  readonly politicalSummary?: string | null
  readonly era?: string | null
  readonly keyTensions?: string | null
  readonly worldOverview?: string | null
  readonly followUpQuestions?: string | null
  readonly startingSituations?: string | null
  readonly isPublic?: boolean
  readonly status?: 'generating' | 'complete' | 'failed'
  readonly language?: string
}

export interface WorldUpdate {
  readonly name?: string
  readonly concept?: string
  readonly tone?: string | null
  readonly themes?: string | null
  readonly geographySummary?: string | null
  readonly politicalSummary?: string | null
  readonly era?: string | null
  readonly keyTensions?: string | null
  readonly worldOverview?: string | null
  readonly followUpQuestions?: string | null
  readonly startingSituations?: string | null
  readonly isPublic?: boolean
  readonly moderationStatus?: 'unreviewed' | 'approved' | 'flagged' | 'removed'
  readonly language?: string
}

export interface Campaign {
  readonly id: string
  readonly worldId: string
  readonly sourceWorldId: string | null
  readonly createdBy: string
  readonly name: string
  readonly status: 'setup' | 'active' | 'archived'
  readonly language: string
  readonly createdAt: Date
  readonly updatedAt: Date
}

export interface CreateCampaignInput {
  readonly worldId: string
  readonly createdBy: string
  readonly name: string
  readonly sourceWorldId?: string | null
  readonly status?: 'setup' | 'active' | 'archived'
  readonly language?: string
}

export interface CampaignUpdate {
  readonly name?: string
  readonly status?: 'setup' | 'active' | 'archived'
  readonly language?: string
}

export interface Session {
  readonly id: string
  readonly campaignId: string
  readonly sessionNumber: number
  readonly status: 'active' | 'ended' | 'crashed'
  readonly startedAt: Date
  readonly endedAt: Date | null
  readonly summary: string | null
  readonly stRunningSummary: string | null
  readonly handoff: string | null
}

export interface CreateSessionInput {
  readonly campaignId: string
  readonly sessionNumber: number
  readonly status?: 'active' | 'ended' | 'crashed'
}

export interface SessionUpdate {
  readonly status?: 'active' | 'ended' | 'crashed'
  readonly endedAt?: Date | null
  readonly summary?: string | null
  readonly stRunningSummary?: string | null
  readonly handoff?: string | null
}
```

- [ ] **Step 2: Verify typecheck + lint**

```bash
cd backend && pnpm typecheck && pnpm lint
```

Both clean.

- [ ] **Step 3: Commit**

```bash
git add backend/src/repo/types.ts
git commit -m "feat(myt-34): row types for users/worlds/campaigns/sessions namespaces"
```

---

## Task 3: Mappers + narrowing helpers

**Files:**
- Create: `backend/src/repo/mappers.ts`
- Test: `backend/src/repo/__tests__/mappers.test.ts`

> **TDD**: write failing tests first; mappers are pure functions, easy to test in isolation.

- [ ] **Step 1: Write the failing tests**

Create `backend/src/repo/__tests__/mappers.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import {
  toUser,
  toWorld,
  toCampaign,
  toSession,
  type UserDbRow,
  type WorldDbRow,
  type CampaignDbRow,
  type SessionDbRow,
} from '../mappers.js'

const FIXED_DATE = new Date('2026-04-28T12:00:00.000Z')

const userRow: UserDbRow = {
  id: '019dccef-300b-7ebc-ac99-d08d3a765185',
  cognito_sub: 'google_12345',
  email: 'a@b.com',
  display_name: 'Alice',
  username: 'alice',
  avatar_url: 'https://example.com/a.png',
  auth_provider: 'google',
  stripe_customer_id: null,
  free_trial_used: false,
  suspended_at: null,
  created_at: FIXED_DATE,
  updated_at: FIXED_DATE,
}

describe('toUser', () => {
  it('maps every field from snake_case to camelCase', () => {
    const u = toUser(userRow)
    expect(u).toEqual({
      id: '019dccef-300b-7ebc-ac99-d08d3a765185',
      cognitoSub: 'google_12345',
      email: 'a@b.com',
      displayName: 'Alice',
      username: 'alice',
      avatarUrl: 'https://example.com/a.png',
      authProvider: 'google',
      stripeCustomerId: null,
      freeTrialUsed: false,
      suspendedAt: null,
      createdAt: FIXED_DATE,
      updatedAt: FIXED_DATE,
    })
  })

  it('preserves null on nullable columns', () => {
    const u = toUser({ ...userRow, avatar_url: null, suspended_at: null })
    expect(u.avatarUrl).toBeNull()
    expect(u.suspendedAt).toBeNull()
  })

  it('throws on unexpected auth_provider values', () => {
    expect(() => toUser({ ...userRow, auth_provider: 'apple' })).toThrow(/unexpected auth_provider/)
  })

  it('accepts both google and discord', () => {
    expect(toUser({ ...userRow, auth_provider: 'google' }).authProvider).toBe('google')
    expect(toUser({ ...userRow, auth_provider: 'discord' }).authProvider).toBe('discord')
  })
})

const worldRow: WorldDbRow = {
  id: '019dccef-300b-7ebc-ac99-d08d3a765199',
  created_by: '019dccef-300b-7ebc-ac99-d08d3a765185',
  source_world_id: null,
  name: 'Realm of X',
  concept: 'A grim world.',
  tone: null,
  themes: null,
  geography_summary: null,
  political_summary: null,
  era: null,
  key_tensions: null,
  world_overview: null,
  follow_up_questions: null,
  starting_situations: null,
  is_public: false,
  fork_count: 0,
  status: 'generating',
  language: 'en',
  moderation_status: 'unreviewed',
  created_at: FIXED_DATE,
  updated_at: FIXED_DATE,
}

describe('toWorld', () => {
  it('maps every field correctly', () => {
    const w = toWorld(worldRow)
    expect(w.id).toBe(worldRow.id)
    expect(w.createdBy).toBe(worldRow.created_by)
    expect(w.sourceWorldId).toBeNull()
    expect(w.geographySummary).toBeNull()
    expect(w.forkCount).toBe(0)
    expect(w.isPublic).toBe(false)
    expect(w.status).toBe('generating')
    expect(w.moderationStatus).toBe('unreviewed')
  })

  it('throws on unexpected status', () => {
    expect(() => toWorld({ ...worldRow, status: 'unknown' })).toThrow(/unexpected world status/)
  })

  it('throws on unexpected moderation_status', () => {
    expect(() => toWorld({ ...worldRow, moderation_status: 'pending' })).toThrow(/unexpected moderation_status/)
  })
})

const campaignRow: CampaignDbRow = {
  id: '019dccef-300b-7ebc-ac99-d08d3a76520a',
  world_id: '019dccef-300b-7ebc-ac99-d08d3a765199',
  source_world_id: null,
  created_by: '019dccef-300b-7ebc-ac99-d08d3a765185',
  name: 'My Campaign',
  status: 'setup',
  language: 'en',
  created_at: FIXED_DATE,
  updated_at: FIXED_DATE,
}

describe('toCampaign', () => {
  it('maps every field correctly', () => {
    const c = toCampaign(campaignRow)
    expect(c).toEqual({
      id: campaignRow.id,
      worldId: campaignRow.world_id,
      sourceWorldId: null,
      createdBy: campaignRow.created_by,
      name: 'My Campaign',
      status: 'setup',
      language: 'en',
      createdAt: FIXED_DATE,
      updatedAt: FIXED_DATE,
    })
  })

  it('throws on unexpected status', () => {
    expect(() => toCampaign({ ...campaignRow, status: 'paused' })).toThrow(/unexpected campaign status/)
  })
})

const sessionRow: SessionDbRow = {
  id: '019dccef-300b-7ebc-ac99-d08d3a76521b',
  campaign_id: '019dccef-300b-7ebc-ac99-d08d3a76520a',
  session_number: 1,
  status: 'active',
  started_at: FIXED_DATE,
  ended_at: null,
  summary: null,
  st_running_summary: null,
  handoff: null,
}

describe('toSession', () => {
  it('maps every field correctly', () => {
    const s = toSession(sessionRow)
    expect(s).toEqual({
      id: sessionRow.id,
      campaignId: sessionRow.campaign_id,
      sessionNumber: 1,
      status: 'active',
      startedAt: FIXED_DATE,
      endedAt: null,
      summary: null,
      stRunningSummary: null,
      handoff: null,
    })
  })

  it('throws on unexpected status', () => {
    expect(() => toSession({ ...sessionRow, status: 'paused' })).toThrow(/unexpected session status/)
  })
})
```

- [ ] **Step 2: Run, expect FAIL**

```bash
cd backend && pnpm vitest run src/repo/__tests__/mappers.test.ts
```

Expected: module not found.

- [ ] **Step 3: Implement the mappers**

Create `backend/src/repo/mappers.ts`:

```ts
import type { Campaign, Session, User, World } from './types.js'

// ─── DB row interfaces (snake_case, exactly as Postgres returns) ─────────────

export interface UserDbRow {
  readonly id: string
  readonly cognito_sub: string
  readonly email: string
  readonly display_name: string
  readonly username: string
  readonly avatar_url: string | null
  readonly auth_provider: string
  readonly stripe_customer_id: string | null
  readonly free_trial_used: boolean
  readonly suspended_at: Date | null
  readonly created_at: Date
  readonly updated_at: Date
}

export interface WorldDbRow {
  readonly id: string
  readonly created_by: string
  readonly source_world_id: string | null
  readonly name: string
  readonly concept: string
  readonly tone: string | null
  readonly themes: string | null
  readonly geography_summary: string | null
  readonly political_summary: string | null
  readonly era: string | null
  readonly key_tensions: string | null
  readonly world_overview: string | null
  readonly follow_up_questions: string | null
  readonly starting_situations: string | null
  readonly is_public: boolean
  readonly fork_count: number
  readonly status: string
  readonly language: string
  readonly moderation_status: string
  readonly created_at: Date
  readonly updated_at: Date
}

export interface CampaignDbRow {
  readonly id: string
  readonly world_id: string
  readonly source_world_id: string | null
  readonly created_by: string
  readonly name: string
  readonly status: string
  readonly language: string
  readonly created_at: Date
  readonly updated_at: Date
}

export interface SessionDbRow {
  readonly id: string
  readonly campaign_id: string
  readonly session_number: number
  readonly status: string
  readonly started_at: Date
  readonly ended_at: Date | null
  readonly summary: string | null
  readonly st_running_summary: string | null
  readonly handoff: string | null
}

// ─── Narrowing helpers ─────────────────────────────────────────────────────────
//
// CHECK constraints in the schema guarantee these column values are within
// known sets, but the helpers throw loudly if a future migration adds an
// option without updating the TS types. Defense in depth.

function toAuthProvider(v: string): 'google' | 'discord' {
  if (v !== 'google' && v !== 'discord') {
    throw new Error(`unexpected auth_provider value from DB: ${v}`)
  }
  return v
}

function toWorldStatus(v: string): 'generating' | 'complete' | 'failed' {
  if (v !== 'generating' && v !== 'complete' && v !== 'failed') {
    throw new Error(`unexpected world status value from DB: ${v}`)
  }
  return v
}

function toModerationStatus(v: string): 'unreviewed' | 'approved' | 'flagged' | 'removed' {
  if (v !== 'unreviewed' && v !== 'approved' && v !== 'flagged' && v !== 'removed') {
    throw new Error(`unexpected moderation_status value from DB: ${v}`)
  }
  return v
}

function toCampaignStatus(v: string): 'setup' | 'active' | 'archived' {
  if (v !== 'setup' && v !== 'active' && v !== 'archived') {
    throw new Error(`unexpected campaign status value from DB: ${v}`)
  }
  return v
}

function toSessionStatus(v: string): 'active' | 'ended' | 'crashed' {
  if (v !== 'active' && v !== 'ended' && v !== 'crashed') {
    throw new Error(`unexpected session status value from DB: ${v}`)
  }
  return v
}

// ─── Row mappers ──────────────────────────────────────────────────────────────

export function toUser(row: UserDbRow): User {
  return {
    id: row.id,
    cognitoSub: row.cognito_sub,
    email: row.email,
    displayName: row.display_name,
    username: row.username,
    avatarUrl: row.avatar_url,
    authProvider: toAuthProvider(row.auth_provider),
    stripeCustomerId: row.stripe_customer_id,
    freeTrialUsed: row.free_trial_used,
    suspendedAt: row.suspended_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

export function toWorld(row: WorldDbRow): World {
  return {
    id: row.id,
    createdBy: row.created_by,
    sourceWorldId: row.source_world_id,
    name: row.name,
    concept: row.concept,
    tone: row.tone,
    themes: row.themes,
    geographySummary: row.geography_summary,
    politicalSummary: row.political_summary,
    era: row.era,
    keyTensions: row.key_tensions,
    worldOverview: row.world_overview,
    followUpQuestions: row.follow_up_questions,
    startingSituations: row.starting_situations,
    isPublic: row.is_public,
    forkCount: row.fork_count,
    status: toWorldStatus(row.status),
    language: row.language,
    moderationStatus: toModerationStatus(row.moderation_status),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

export function toCampaign(row: CampaignDbRow): Campaign {
  return {
    id: row.id,
    worldId: row.world_id,
    sourceWorldId: row.source_world_id,
    createdBy: row.created_by,
    name: row.name,
    status: toCampaignStatus(row.status),
    language: row.language,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

export function toSession(row: SessionDbRow): Session {
  return {
    id: row.id,
    campaignId: row.campaign_id,
    sessionNumber: row.session_number,
    status: toSessionStatus(row.status),
    startedAt: row.started_at,
    endedAt: row.ended_at,
    summary: row.summary,
    stRunningSummary: row.st_running_summary,
    handoff: row.handoff,
  }
}
```

- [ ] **Step 4: Run, expect PASS**

```bash
cd backend && pnpm vitest run src/repo/__tests__/mappers.test.ts && pnpm typecheck && pnpm lint
```

All ~12 mapper tests pass; typecheck + lint clean.

- [ ] **Step 5: Commit**

```bash
git add backend/src/repo/mappers.ts backend/src/repo/__tests__/mappers.test.ts
git commit -m "feat(myt-34): row mappers + narrowing helpers for enum-like CHECK columns"
```

---

## Task 4: Test reset helper

**Files:**
- Create: `backend/src/repo/__tests__/_helpers/reset-data.ts`

> **Why this is its own task**: every namespace test file uses this. Build it once with a clear contract.

- [ ] **Step 1: Author the helper**

Create `backend/src/repo/__tests__/_helpers/reset-data.ts`:

```ts
import type { Pool } from 'pg'

/**
 * TRUNCATE all application tables to reset between tests.
 *
 * Faster than DROP SCHEMA + re-applying migrations (~5ms vs ~150ms).
 * Schema stays intact across tests; only data is reset. CASCADE handles
 * FK relationships so the order of tables in the list doesn't matter.
 *
 * As future tickets add namespaces and tables, extend this list. Keep
 * `_migrations` OUT — that's the runner's bookkeeping; truncating it
 * would force a re-application on the next runMigrations call.
 */
const TABLES = [
  // Identity / billing
  'users',
  'credit_ledger',
  'purchases',
  'user_subscriptions',
  'subscription_tiers',
  'session_packs',
  'stripe_events',

  // Worlds + entities
  'worlds',
  'entities',
  'prose_kernels',
  'facts',
  'relationships',
  'entity_hierarchy',
  'random_tables',
  'random_table_entries',

  // Campaigns + characters
  'campaigns',
  'campaign_members',
  'campaign_invites',
  'characters',
  'character_skills',
  'character_features',
  'character_equipment',
  'character_spells',

  // Sessions + ops
  'sessions',
  'session_messages',
  'session_participants',
  'session_preps',
  'session_usage',
  'pipeline_runs',
  'world_snapshots',
  'stat_blocks',
  'stat_block_actions',

  // SRD + misc
  'srd_monsters',
  'srd_spells',
  'srd_conditions',
  'world_marketplace',
  'moderation_flags',
  'settings',
] as const

export async function resetData(pool: Pool): Promise<void> {
  await pool.query(`TRUNCATE ${TABLES.join(', ')} RESTART IDENTITY CASCADE`)
}
```

- [ ] **Step 2: Verify typecheck + lint**

```bash
cd backend && pnpm typecheck && pnpm lint
```

Both clean.

- [ ] **Step 3: Commit**

```bash
git add backend/src/repo/__tests__/_helpers/reset-data.ts
git commit -m "test(myt-34): TRUNCATE-based reset helper for repo integration tests"
```

---

## Task 5: `users` namespace

**Files:**
- Create: `backend/src/repo/users.ts`
- Test: `backend/src/repo/__tests__/users.test.ts`

> **TDD**: tests first. The schema-parity test from MYT-33 already pins the schema; these tests pin the repo behavior on top of it.

- [ ] **Step 1: Write the failing tests**

Create `backend/src/repo/__tests__/users.test.ts`:

```ts
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import { fileURLToPath } from 'node:url'
import { resolve } from 'node:path'
import pino, { type DestinationStream } from 'pino'
import type { Pool } from 'pg'
import { createPgPool } from '../../db/postgres.js'
import { runMigrations } from '../../db/migrate.js'
import { guardTestDatabase } from '../../db/__tests__/guard-db.js'
import { createUsersRepo } from '../users.js'
import { resetData } from './_helpers/reset-data.js'

const databaseUrl = process.env.DATABASE_URL ?? ''
const here = fileURLToPath(import.meta.url)
const REAL_MIGRATIONS_DIR = resolve(here, '../../../../migrations')

function silentLogger(): ReturnType<typeof pino> {
  const sink: DestinationStream = { write: () => {} }
  return pino({ base: { component: 'migrate' }, serializers: { err: pino.stdSerializers.err } }, sink)
}

describe('users repo (integration)', () => {
  let pool: Pool

  beforeAll(async () => {
    await guardTestDatabase(databaseUrl)
    pool = createPgPool(databaseUrl, { max: 1 })
    // Drop+recreate schema, then run migrations once for this file.
    await pool.query('DROP EXTENSION IF EXISTS pgcrypto CASCADE')
    await pool.query('DROP SCHEMA public CASCADE')
    await pool.query('CREATE SCHEMA public')
    await pool.query('GRANT ALL ON SCHEMA public TO PUBLIC')
    await pool.query('GRANT ALL ON SCHEMA public TO CURRENT_USER')
    await runMigrations({ pool, migrationsDir: REAL_MIGRATIONS_DIR, logger: silentLogger() })
  })

  afterAll(async () => {
    await pool.end()
  })

  beforeEach(async () => {
    await resetData(pool)
  })

  const baseInput = {
    cognitoSub: 'google_12345',
    email: 'a@b.com',
    displayName: 'Alice',
    username: 'alice',
    authProvider: 'google' as const,
  }

  it('create returns a fully-populated user row', async () => {
    const repo = createUsersRepo(pool)
    const u = await repo.create(baseInput)
    expect(u.id).toMatch(/^[0-9a-f-]{36}$/)
    expect(u.cognitoSub).toBe('google_12345')
    expect(u.email).toBe('a@b.com')
    expect(u.displayName).toBe('Alice')
    expect(u.username).toBe('alice')
    expect(u.avatarUrl).toBeNull()
    expect(u.authProvider).toBe('google')
    expect(u.stripeCustomerId).toBeNull()
    expect(u.freeTrialUsed).toBe(false)
    expect(u.suspendedAt).toBeNull()
    expect(u.createdAt).toBeInstanceOf(Date)
    expect(u.updatedAt).toBeInstanceOf(Date)
  })

  it('getById returns the user when present', async () => {
    const repo = createUsersRepo(pool)
    const created = await repo.create(baseInput)
    const found = await repo.getById(created.id)
    expect(found).not.toBeNull()
    expect(found?.id).toBe(created.id)
  })

  it('getById returns null for unknown id', async () => {
    const repo = createUsersRepo(pool)
    const u = await repo.getById('019dccef-0000-7000-8000-000000000000')
    expect(u).toBeNull()
  })

  it('getByCognitoSub returns the user when present', async () => {
    const repo = createUsersRepo(pool)
    await repo.create(baseInput)
    const u = await repo.getByCognitoSub('google_12345')
    expect(u).not.toBeNull()
    expect(u?.email).toBe('a@b.com')
  })

  it('getByCognitoSub returns null for unknown sub', async () => {
    const repo = createUsersRepo(pool)
    const u = await repo.getByCognitoSub('nope')
    expect(u).toBeNull()
  })

  it('getByEmail returns the user when present', async () => {
    const repo = createUsersRepo(pool)
    await repo.create(baseInput)
    const u = await repo.getByEmail('a@b.com')
    expect(u?.username).toBe('alice')
  })

  it('update mutates supplied fields and bumps updatedAt', async () => {
    const repo = createUsersRepo(pool)
    const created = await repo.create(baseInput)
    // Sleep briefly to ensure updatedAt advances measurably.
    await new Promise((r) => setTimeout(r, 5))
    const updated = await repo.update(created.id, { displayName: 'Alicia' })
    expect(updated.displayName).toBe('Alicia')
    expect(updated.username).toBe('alice') // untouched
    expect(updated.updatedAt.getTime()).toBeGreaterThan(created.updatedAt.getTime())
  })

  it('update with all-undefined patch is a no-op (except updatedAt)', async () => {
    const repo = createUsersRepo(pool)
    const created = await repo.create(baseInput)
    await new Promise((r) => setTimeout(r, 5))
    const updated = await repo.update(created.id, {})
    expect(updated.displayName).toBe(created.displayName)
    expect(updated.username).toBe(created.username)
    expect(updated.updatedAt.getTime()).toBeGreaterThan(created.updatedAt.getTime())
  })

  it('update throws when the user does not exist', async () => {
    const repo = createUsersRepo(pool)
    await expect(repo.update('019dccef-0000-7000-8000-000000000000', { displayName: 'X' })).rejects.toThrow(
      /no user with id/,
    )
  })
})
```

- [ ] **Step 2: Run, expect FAIL**

```bash
cd backend && pnpm vitest run src/repo/__tests__/users.test.ts
```

Expected: module not found.

- [ ] **Step 3: Implement the namespace**

Create `backend/src/repo/users.ts`:

```ts
import { type Pool } from 'pg'
import { uuidv7 } from './uuidv7.js'
import { type CreateUserInput, type User, type UserUpdate } from './types.js'
import { toUser, type UserDbRow } from './mappers.js'

export function createUsersRepo(pool: Pool) {
  return {
    create: async (input: CreateUserInput): Promise<User> => {
      const id = uuidv7()
      const result = await pool.query<UserDbRow>(
        `INSERT INTO users (id, cognito_sub, email, display_name, username, avatar_url, auth_provider)
         VALUES ($1, $2, $3, $4, $5, $6, $7)
         RETURNING *`,
        [
          id,
          input.cognitoSub,
          input.email,
          input.displayName,
          input.username,
          input.avatarUrl ?? null,
          input.authProvider,
        ],
      )
      const row = result.rows[0]
      if (!row) throw new Error('users.create: INSERT returned no row')
      return toUser(row)
    },

    getById: async (id: string): Promise<User | null> => {
      const result = await pool.query<UserDbRow>('SELECT * FROM users WHERE id = $1', [id])
      const row = result.rows[0]
      return row ? toUser(row) : null
    },

    getByCognitoSub: async (sub: string): Promise<User | null> => {
      const result = await pool.query<UserDbRow>('SELECT * FROM users WHERE cognito_sub = $1', [sub])
      const row = result.rows[0]
      return row ? toUser(row) : null
    },

    getByEmail: async (email: string): Promise<User | null> => {
      const result = await pool.query<UserDbRow>('SELECT * FROM users WHERE email = $1', [email])
      const row = result.rows[0]
      return row ? toUser(row) : null
    },

    update: async (id: string, patch: UserUpdate): Promise<User> => {
      const result = await pool.query<UserDbRow>(
        `UPDATE users
            SET display_name       = COALESCE($2, display_name),
                username           = COALESCE($3, username),
                avatar_url         = COALESCE($4, avatar_url),
                stripe_customer_id = COALESCE($5, stripe_customer_id),
                free_trial_used    = COALESCE($6, free_trial_used),
                updated_at         = now()
          WHERE id = $1
          RETURNING *`,
        [
          id,
          patch.displayName ?? null,
          patch.username ?? null,
          patch.avatarUrl ?? null,
          patch.stripeCustomerId ?? null,
          patch.freeTrialUsed ?? null,
        ],
      )
      const row = result.rows[0]
      if (!row) throw new Error(`users.update: no user with id ${id}`)
      return toUser(row)
    },
  }
}
```

- [ ] **Step 4: Run, expect PASS**

```bash
cd backend && pnpm vitest run src/repo/__tests__/users.test.ts && pnpm typecheck && pnpm lint
```

All ~9 users tests pass; typecheck + lint clean.

- [ ] **Step 5: Commit**

```bash
git add backend/src/repo/users.ts backend/src/repo/__tests__/users.test.ts
git commit -m "feat(myt-34): users namespace — create, getById, getByCognitoSub, getByEmail, update"
```

---

## Task 6: `worlds` namespace

**Files:**
- Create: `backend/src/repo/worlds.ts`
- Test: `backend/src/repo/__tests__/worlds.test.ts`

> Worlds has slightly more methods (`updateStatus`, `incrementForkCount`, `listByUser`) and the most columns (~20). The `listByUser` query is `ORDER BY created_at DESC`.

- [ ] **Step 1: Write the failing tests**

Create `backend/src/repo/__tests__/worlds.test.ts`:

```ts
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import { fileURLToPath } from 'node:url'
import { resolve } from 'node:path'
import pino, { type DestinationStream } from 'pino'
import type { Pool } from 'pg'
import { createPgPool } from '../../db/postgres.js'
import { runMigrations } from '../../db/migrate.js'
import { guardTestDatabase } from '../../db/__tests__/guard-db.js'
import { createUsersRepo } from '../users.js'
import { createWorldsRepo } from '../worlds.js'
import { resetData } from './_helpers/reset-data.js'

const databaseUrl = process.env.DATABASE_URL ?? ''
const here = fileURLToPath(import.meta.url)
const REAL_MIGRATIONS_DIR = resolve(here, '../../../../migrations')

function silentLogger(): ReturnType<typeof pino> {
  const sink: DestinationStream = { write: () => {} }
  return pino({ base: { component: 'migrate' }, serializers: { err: pino.stdSerializers.err } }, sink)
}

const baseUserInput = {
  cognitoSub: 'google_99',
  email: 'owner@example.com',
  displayName: 'Owner',
  username: 'owner',
  authProvider: 'google' as const,
}

describe('worlds repo (integration)', () => {
  let pool: Pool

  beforeAll(async () => {
    await guardTestDatabase(databaseUrl)
    pool = createPgPool(databaseUrl, { max: 1 })
    await pool.query('DROP EXTENSION IF EXISTS pgcrypto CASCADE')
    await pool.query('DROP SCHEMA public CASCADE')
    await pool.query('CREATE SCHEMA public')
    await pool.query('GRANT ALL ON SCHEMA public TO PUBLIC')
    await pool.query('GRANT ALL ON SCHEMA public TO CURRENT_USER')
    await runMigrations({ pool, migrationsDir: REAL_MIGRATIONS_DIR, logger: silentLogger() })
  })

  afterAll(async () => {
    await pool.end()
  })

  beforeEach(async () => {
    await resetData(pool)
  })

  it('create returns a populated world with default status=generating', async () => {
    const users = createUsersRepo(pool)
    const worlds = createWorldsRepo(pool)
    const owner = await users.create(baseUserInput)
    const w = await worlds.create({ createdBy: owner.id, name: 'Realm', concept: 'A grim world.' })
    expect(w.id).toMatch(/^[0-9a-f-]{36}$/)
    expect(w.createdBy).toBe(owner.id)
    expect(w.name).toBe('Realm')
    expect(w.status).toBe('generating')
    expect(w.forkCount).toBe(0)
    expect(w.isPublic).toBe(false)
    expect(w.language).toBe('en')
    expect(w.moderationStatus).toBe('unreviewed')
  })

  it('getById returns null for unknown world', async () => {
    const worlds = createWorldsRepo(pool)
    expect(await worlds.getById('019dccef-0000-7000-8000-000000000000')).toBeNull()
  })

  it('listByUser returns DESC by createdAt', async () => {
    const users = createUsersRepo(pool)
    const worlds = createWorldsRepo(pool)
    const owner = await users.create(baseUserInput)
    const a = await worlds.create({ createdBy: owner.id, name: 'A', concept: 'first' })
    await new Promise((r) => setTimeout(r, 5))
    const b = await worlds.create({ createdBy: owner.id, name: 'B', concept: 'second' })
    const list = await worlds.listByUser(owner.id)
    expect(list.map((w) => w.id)).toEqual([b.id, a.id])
  })

  it('listByUser returns empty array for user with no worlds', async () => {
    const users = createUsersRepo(pool)
    const worlds = createWorldsRepo(pool)
    const owner = await users.create(baseUserInput)
    expect(await worlds.listByUser(owner.id)).toEqual([])
  })

  it('update bumps updatedAt and mutates supplied fields', async () => {
    const users = createUsersRepo(pool)
    const worlds = createWorldsRepo(pool)
    const owner = await users.create(baseUserInput)
    const w = await worlds.create({ createdBy: owner.id, name: 'A', concept: 'c' })
    await new Promise((r) => setTimeout(r, 5))
    const updated = await worlds.update(w.id, { name: 'A renamed', isPublic: true })
    expect(updated.name).toBe('A renamed')
    expect(updated.isPublic).toBe(true)
    expect(updated.concept).toBe('c')
    expect(updated.updatedAt.getTime()).toBeGreaterThan(w.updatedAt.getTime())
  })

  it('updateStatus moves a world through generating → complete', async () => {
    const users = createUsersRepo(pool)
    const worlds = createWorldsRepo(pool)
    const owner = await users.create(baseUserInput)
    const w = await worlds.create({ createdBy: owner.id, name: 'A', concept: 'c' })
    expect(w.status).toBe('generating')
    const completed = await worlds.updateStatus(w.id, 'complete')
    expect(completed.status).toBe('complete')
  })

  it('incrementForkCount adds 1 atomically', async () => {
    const users = createUsersRepo(pool)
    const worlds = createWorldsRepo(pool)
    const owner = await users.create(baseUserInput)
    const w = await worlds.create({ createdBy: owner.id, name: 'A', concept: 'c' })
    expect(w.forkCount).toBe(0)
    const bumped = await worlds.incrementForkCount(w.id)
    expect(bumped.forkCount).toBe(1)
    const bumped2 = await worlds.incrementForkCount(w.id)
    expect(bumped2.forkCount).toBe(2)
  })
})
```

- [ ] **Step 2: Run, expect FAIL**

```bash
cd backend && pnpm vitest run src/repo/__tests__/worlds.test.ts
```

Expected: `createWorldsRepo` not exported.

- [ ] **Step 3: Implement the namespace**

Create `backend/src/repo/worlds.ts`:

```ts
import { type Pool } from 'pg'
import { uuidv7 } from './uuidv7.js'
import { type CreateWorldInput, type World, type WorldUpdate } from './types.js'
import { toWorld, type WorldDbRow } from './mappers.js'

export function createWorldsRepo(pool: Pool) {
  return {
    create: async (input: CreateWorldInput): Promise<World> => {
      const id = uuidv7()
      const result = await pool.query<WorldDbRow>(
        `INSERT INTO worlds (
            id, created_by, source_world_id, name, concept,
            tone, themes, geography_summary, political_summary, era,
            key_tensions, world_overview, follow_up_questions, starting_situations,
            is_public, status, language
         ) VALUES (
            $1, $2, $3, $4, $5,
            $6, $7, $8, $9, $10,
            $11, $12, $13, $14,
            COALESCE($15, false),
            COALESCE($16, 'generating'),
            COALESCE($17, 'en')
         ) RETURNING *`,
        [
          id,
          input.createdBy,
          input.sourceWorldId ?? null,
          input.name,
          input.concept,
          input.tone ?? null,
          input.themes ?? null,
          input.geographySummary ?? null,
          input.politicalSummary ?? null,
          input.era ?? null,
          input.keyTensions ?? null,
          input.worldOverview ?? null,
          input.followUpQuestions ?? null,
          input.startingSituations ?? null,
          input.isPublic ?? null,
          input.status ?? null,
          input.language ?? null,
        ],
      )
      const row = result.rows[0]
      if (!row) throw new Error('worlds.create: INSERT returned no row')
      return toWorld(row)
    },

    getById: async (id: string): Promise<World | null> => {
      const result = await pool.query<WorldDbRow>('SELECT * FROM worlds WHERE id = $1', [id])
      const row = result.rows[0]
      return row ? toWorld(row) : null
    },

    listByUser: async (userId: string): Promise<World[]> => {
      const result = await pool.query<WorldDbRow>(
        `SELECT * FROM worlds WHERE created_by = $1 ORDER BY created_at DESC`,
        [userId],
      )
      return result.rows.map(toWorld)
    },

    update: async (id: string, patch: WorldUpdate): Promise<World> => {
      const result = await pool.query<WorldDbRow>(
        `UPDATE worlds
            SET name                 = COALESCE($2, name),
                concept              = COALESCE($3, concept),
                tone                 = COALESCE($4, tone),
                themes               = COALESCE($5, themes),
                geography_summary    = COALESCE($6, geography_summary),
                political_summary    = COALESCE($7, political_summary),
                era                  = COALESCE($8, era),
                key_tensions         = COALESCE($9, key_tensions),
                world_overview       = COALESCE($10, world_overview),
                follow_up_questions  = COALESCE($11, follow_up_questions),
                starting_situations  = COALESCE($12, starting_situations),
                is_public            = COALESCE($13, is_public),
                moderation_status    = COALESCE($14, moderation_status),
                language             = COALESCE($15, language),
                updated_at           = now()
          WHERE id = $1
          RETURNING *`,
        [
          id,
          patch.name ?? null,
          patch.concept ?? null,
          patch.tone ?? null,
          patch.themes ?? null,
          patch.geographySummary ?? null,
          patch.politicalSummary ?? null,
          patch.era ?? null,
          patch.keyTensions ?? null,
          patch.worldOverview ?? null,
          patch.followUpQuestions ?? null,
          patch.startingSituations ?? null,
          patch.isPublic ?? null,
          patch.moderationStatus ?? null,
          patch.language ?? null,
        ],
      )
      const row = result.rows[0]
      if (!row) throw new Error(`worlds.update: no world with id ${id}`)
      return toWorld(row)
    },

    updateStatus: async (id: string, status: 'generating' | 'complete' | 'failed'): Promise<World> => {
      const result = await pool.query<WorldDbRow>(
        `UPDATE worlds SET status = $2, updated_at = now() WHERE id = $1 RETURNING *`,
        [id, status],
      )
      const row = result.rows[0]
      if (!row) throw new Error(`worlds.updateStatus: no world with id ${id}`)
      return toWorld(row)
    },

    incrementForkCount: async (id: string): Promise<World> => {
      const result = await pool.query<WorldDbRow>(
        `UPDATE worlds SET fork_count = fork_count + 1, updated_at = now() WHERE id = $1 RETURNING *`,
        [id],
      )
      const row = result.rows[0]
      if (!row) throw new Error(`worlds.incrementForkCount: no world with id ${id}`)
      return toWorld(row)
    },
  }
}
```

- [ ] **Step 4: Run, expect PASS**

```bash
cd backend && pnpm vitest run src/repo/__tests__/worlds.test.ts && pnpm typecheck && pnpm lint
```

All ~7 worlds tests pass; typecheck + lint clean.

- [ ] **Step 5: Commit**

```bash
git add backend/src/repo/worlds.ts backend/src/repo/__tests__/worlds.test.ts
git commit -m "feat(myt-34): worlds namespace — create, getById, listByUser, update, updateStatus, incrementForkCount"
```

---

## Task 7: `campaigns` namespace

**Files:**
- Create: `backend/src/repo/campaigns.ts`
- Test: `backend/src/repo/__tests__/campaigns.test.ts`

> `listByUser` does the JOIN with `campaign_members` (filter `invite_accepted = true`). The campaign_members table exists from MYT-33; we use it in SQL but don't expose a campaignMembers API surface yet.

- [ ] **Step 1: Write the failing tests**

Create `backend/src/repo/__tests__/campaigns.test.ts`:

```ts
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import { fileURLToPath } from 'node:url'
import { resolve } from 'node:path'
import pino, { type DestinationStream } from 'pino'
import type { Pool } from 'pg'
import { createPgPool } from '../../db/postgres.js'
import { runMigrations } from '../../db/migrate.js'
import { guardTestDatabase } from '../../db/__tests__/guard-db.js'
import { uuidv7 } from '../uuidv7.js'
import { createUsersRepo } from '../users.js'
import { createWorldsRepo } from '../worlds.js'
import { createCampaignsRepo } from '../campaigns.js'
import { resetData } from './_helpers/reset-data.js'

const databaseUrl = process.env.DATABASE_URL ?? ''
const here = fileURLToPath(import.meta.url)
const REAL_MIGRATIONS_DIR = resolve(here, '../../../../migrations')

function silentLogger(): ReturnType<typeof pino> {
  const sink: DestinationStream = { write: () => {} }
  return pino({ base: { component: 'migrate' }, serializers: { err: pino.stdSerializers.err } }, sink)
}

const baseUserInput = {
  cognitoSub: 'g_owner',
  email: 'owner@x.com',
  displayName: 'Owner',
  username: 'owner',
  authProvider: 'google' as const,
}

async function addCampaignMember(
  pool: Pool,
  campaignId: string,
  userId: string,
  role: 'owner' | 'player',
  inviteAccepted: boolean,
): Promise<void> {
  await pool.query(
    `INSERT INTO campaign_members (id, campaign_id, user_id, role, invite_accepted)
     VALUES ($1, $2, $3, $4, $5)`,
    [uuidv7(), campaignId, userId, role, inviteAccepted],
  )
}

describe('campaigns repo (integration)', () => {
  let pool: Pool

  beforeAll(async () => {
    await guardTestDatabase(databaseUrl)
    pool = createPgPool(databaseUrl, { max: 1 })
    await pool.query('DROP EXTENSION IF EXISTS pgcrypto CASCADE')
    await pool.query('DROP SCHEMA public CASCADE')
    await pool.query('CREATE SCHEMA public')
    await pool.query('GRANT ALL ON SCHEMA public TO PUBLIC')
    await pool.query('GRANT ALL ON SCHEMA public TO CURRENT_USER')
    await runMigrations({ pool, migrationsDir: REAL_MIGRATIONS_DIR, logger: silentLogger() })
  })

  afterAll(async () => {
    await pool.end()
  })

  beforeEach(async () => {
    await resetData(pool)
  })

  it('create returns a populated campaign with default status=setup', async () => {
    const users = createUsersRepo(pool)
    const worlds = createWorldsRepo(pool)
    const campaigns = createCampaignsRepo(pool)
    const owner = await users.create(baseUserInput)
    const world = await worlds.create({ createdBy: owner.id, name: 'W', concept: 'c' })
    const c = await campaigns.create({ worldId: world.id, createdBy: owner.id, name: 'My Campaign' })
    expect(c.id).toMatch(/^[0-9a-f-]{36}$/)
    expect(c.worldId).toBe(world.id)
    expect(c.createdBy).toBe(owner.id)
    expect(c.status).toBe('setup')
    expect(c.language).toBe('en')
  })

  it('getById returns null for unknown campaign', async () => {
    const campaigns = createCampaignsRepo(pool)
    expect(await campaigns.getById('019dccef-0000-7000-8000-000000000000')).toBeNull()
  })

  it('listByUser returns campaigns where user is an accepted member', async () => {
    const users = createUsersRepo(pool)
    const worlds = createWorldsRepo(pool)
    const campaigns = createCampaignsRepo(pool)

    const owner = await users.create(baseUserInput)
    const player = await users.create({ ...baseUserInput, cognitoSub: 'g_p', email: 'p@x.com', username: 'player' })
    const world = await worlds.create({ createdBy: owner.id, name: 'W', concept: 'c' })

    const c1 = await campaigns.create({ worldId: world.id, createdBy: owner.id, name: 'C1' })
    const c2 = await campaigns.create({ worldId: world.id, createdBy: owner.id, name: 'C2' })

    // Player is accepted in c1, invited-but-not-accepted in c2.
    await addCampaignMember(pool, c1.id, player.id, 'player', true)
    await addCampaignMember(pool, c2.id, player.id, 'player', false)

    const list = await campaigns.listByUser(player.id)
    expect(list.map((c) => c.id)).toEqual([c1.id])
  })

  it('listByUser returns DESC by createdAt', async () => {
    const users = createUsersRepo(pool)
    const worlds = createWorldsRepo(pool)
    const campaigns = createCampaignsRepo(pool)
    const owner = await users.create(baseUserInput)
    const world = await worlds.create({ createdBy: owner.id, name: 'W', concept: 'c' })
    const a = await campaigns.create({ worldId: world.id, createdBy: owner.id, name: 'A' })
    await new Promise((r) => setTimeout(r, 5))
    const b = await campaigns.create({ worldId: world.id, createdBy: owner.id, name: 'B' })
    await addCampaignMember(pool, a.id, owner.id, 'owner', true)
    await addCampaignMember(pool, b.id, owner.id, 'owner', true)
    const list = await campaigns.listByUser(owner.id)
    expect(list.map((c) => c.id)).toEqual([b.id, a.id])
  })

  it('update mutates supplied fields and bumps updatedAt', async () => {
    const users = createUsersRepo(pool)
    const worlds = createWorldsRepo(pool)
    const campaigns = createCampaignsRepo(pool)
    const owner = await users.create(baseUserInput)
    const world = await worlds.create({ createdBy: owner.id, name: 'W', concept: 'c' })
    const c = await campaigns.create({ worldId: world.id, createdBy: owner.id, name: 'A' })
    await new Promise((r) => setTimeout(r, 5))
    const updated = await campaigns.update(c.id, { name: 'A renamed', status: 'active' })
    expect(updated.name).toBe('A renamed')
    expect(updated.status).toBe('active')
    expect(updated.updatedAt.getTime()).toBeGreaterThan(c.updatedAt.getTime())
  })
})
```

- [ ] **Step 2: Run, expect FAIL**

```bash
cd backend && pnpm vitest run src/repo/__tests__/campaigns.test.ts
```

- [ ] **Step 3: Implement the namespace**

Create `backend/src/repo/campaigns.ts`:

```ts
import { type Pool } from 'pg'
import { uuidv7 } from './uuidv7.js'
import { type Campaign, type CampaignUpdate, type CreateCampaignInput } from './types.js'
import { toCampaign, type CampaignDbRow } from './mappers.js'

export function createCampaignsRepo(pool: Pool) {
  return {
    create: async (input: CreateCampaignInput): Promise<Campaign> => {
      const id = uuidv7()
      const result = await pool.query<CampaignDbRow>(
        `INSERT INTO campaigns (id, world_id, source_world_id, created_by, name, status, language)
         VALUES (
            $1, $2, $3, $4, $5,
            COALESCE($6, 'setup'),
            COALESCE($7, 'en')
         ) RETURNING *`,
        [id, input.worldId, input.sourceWorldId ?? null, input.createdBy, input.name, input.status ?? null, input.language ?? null],
      )
      const row = result.rows[0]
      if (!row) throw new Error('campaigns.create: INSERT returned no row')
      return toCampaign(row)
    },

    getById: async (id: string): Promise<Campaign | null> => {
      const result = await pool.query<CampaignDbRow>('SELECT * FROM campaigns WHERE id = $1', [id])
      const row = result.rows[0]
      return row ? toCampaign(row) : null
    },

    listByUser: async (userId: string): Promise<Campaign[]> => {
      const result = await pool.query<CampaignDbRow>(
        `SELECT c.* FROM campaigns c
            JOIN campaign_members cm ON cm.campaign_id = c.id
          WHERE cm.user_id = $1 AND cm.invite_accepted = true
          ORDER BY c.created_at DESC`,
        [userId],
      )
      return result.rows.map(toCampaign)
    },

    update: async (id: string, patch: CampaignUpdate): Promise<Campaign> => {
      const result = await pool.query<CampaignDbRow>(
        `UPDATE campaigns
            SET name       = COALESCE($2, name),
                status     = COALESCE($3, status),
                language   = COALESCE($4, language),
                updated_at = now()
          WHERE id = $1
          RETURNING *`,
        [id, patch.name ?? null, patch.status ?? null, patch.language ?? null],
      )
      const row = result.rows[0]
      if (!row) throw new Error(`campaigns.update: no campaign with id ${id}`)
      return toCampaign(row)
    },
  }
}
```

- [ ] **Step 4: Run, expect PASS**

```bash
cd backend && pnpm vitest run src/repo/__tests__/campaigns.test.ts && pnpm typecheck && pnpm lint
```

All ~5 campaigns tests pass; typecheck + lint clean.

- [ ] **Step 5: Commit**

```bash
git add backend/src/repo/campaigns.ts backend/src/repo/__tests__/campaigns.test.ts
git commit -m "feat(myt-34): campaigns namespace — create, getById, listByUser (with members JOIN), update"
```

---

## Task 8: `sessions` namespace

**Files:**
- Create: `backend/src/repo/sessions.ts`
- Test: `backend/src/repo/__tests__/sessions.test.ts`

> `getActiveByCampaign` returns at most one row (the partial-unique index `idx_sessions_one_active` enforces this); the SQL has a defensive `LIMIT 1` for self-documentation.

- [ ] **Step 1: Write the failing tests**

Create `backend/src/repo/__tests__/sessions.test.ts`:

```ts
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import { fileURLToPath } from 'node:url'
import { resolve } from 'node:path'
import pino, { type DestinationStream } from 'pino'
import type { Pool } from 'pg'
import { createPgPool } from '../../db/postgres.js'
import { runMigrations } from '../../db/migrate.js'
import { guardTestDatabase } from '../../db/__tests__/guard-db.js'
import { createUsersRepo } from '../users.js'
import { createWorldsRepo } from '../worlds.js'
import { createCampaignsRepo } from '../campaigns.js'
import { createSessionsRepo } from '../sessions.js'
import { resetData } from './_helpers/reset-data.js'

const databaseUrl = process.env.DATABASE_URL ?? ''
const here = fileURLToPath(import.meta.url)
const REAL_MIGRATIONS_DIR = resolve(here, '../../../../migrations')

function silentLogger(): ReturnType<typeof pino> {
  const sink: DestinationStream = { write: () => {} }
  return pino({ base: { component: 'migrate' }, serializers: { err: pino.stdSerializers.err } }, sink)
}

const baseUserInput = {
  cognitoSub: 'g_owner',
  email: 'owner@x.com',
  displayName: 'Owner',
  username: 'owner',
  authProvider: 'google' as const,
}

async function makeCampaign(pool: Pool): Promise<{ campaignId: string }> {
  const users = createUsersRepo(pool)
  const worlds = createWorldsRepo(pool)
  const campaigns = createCampaignsRepo(pool)
  const owner = await users.create(baseUserInput)
  const world = await worlds.create({ createdBy: owner.id, name: 'W', concept: 'c' })
  const c = await campaigns.create({ worldId: world.id, createdBy: owner.id, name: 'C' })
  return { campaignId: c.id }
}

describe('sessions repo (integration)', () => {
  let pool: Pool

  beforeAll(async () => {
    await guardTestDatabase(databaseUrl)
    pool = createPgPool(databaseUrl, { max: 1 })
    await pool.query('DROP EXTENSION IF EXISTS pgcrypto CASCADE')
    await pool.query('DROP SCHEMA public CASCADE')
    await pool.query('CREATE SCHEMA public')
    await pool.query('GRANT ALL ON SCHEMA public TO PUBLIC')
    await pool.query('GRANT ALL ON SCHEMA public TO CURRENT_USER')
    await runMigrations({ pool, migrationsDir: REAL_MIGRATIONS_DIR, logger: silentLogger() })
  })

  afterAll(async () => {
    await pool.end()
  })

  beforeEach(async () => {
    await resetData(pool)
  })

  it('create returns a session with default status=active', async () => {
    const sessions = createSessionsRepo(pool)
    const { campaignId } = await makeCampaign(pool)
    const s = await sessions.create({ campaignId, sessionNumber: 1 })
    expect(s.id).toMatch(/^[0-9a-f-]{36}$/)
    expect(s.campaignId).toBe(campaignId)
    expect(s.sessionNumber).toBe(1)
    expect(s.status).toBe('active')
    expect(s.startedAt).toBeInstanceOf(Date)
    expect(s.endedAt).toBeNull()
  })

  it('getById returns null for unknown session', async () => {
    const sessions = createSessionsRepo(pool)
    expect(await sessions.getById('019dccef-0000-7000-8000-000000000000')).toBeNull()
  })

  it('getActiveByCampaign returns the active session', async () => {
    const sessions = createSessionsRepo(pool)
    const { campaignId } = await makeCampaign(pool)
    const created = await sessions.create({ campaignId, sessionNumber: 1 })
    const active = await sessions.getActiveByCampaign(campaignId)
    expect(active?.id).toBe(created.id)
  })

  it('getActiveByCampaign returns null when no active session', async () => {
    const sessions = createSessionsRepo(pool)
    const { campaignId } = await makeCampaign(pool)
    expect(await sessions.getActiveByCampaign(campaignId)).toBeNull()
  })

  it('getActiveByCampaign skips ended sessions', async () => {
    const sessions = createSessionsRepo(pool)
    const { campaignId } = await makeCampaign(pool)
    const s = await sessions.create({ campaignId, sessionNumber: 1 })
    await sessions.update(s.id, { status: 'ended', endedAt: new Date() })
    expect(await sessions.getActiveByCampaign(campaignId)).toBeNull()
  })

  it('update mutates supplied fields', async () => {
    const sessions = createSessionsRepo(pool)
    const { campaignId } = await makeCampaign(pool)
    const s = await sessions.create({ campaignId, sessionNumber: 1 })
    const updated = await sessions.update(s.id, { summary: 'a recap' })
    expect(updated.summary).toBe('a recap')
    expect(updated.status).toBe('active')
  })

  it('listByCampaign returns DESC by startedAt', async () => {
    const sessions = createSessionsRepo(pool)
    const { campaignId } = await makeCampaign(pool)
    const a = await sessions.create({ campaignId, sessionNumber: 1 })
    await sessions.update(a.id, { status: 'ended', endedAt: new Date() })
    await new Promise((r) => setTimeout(r, 5))
    const b = await sessions.create({ campaignId, sessionNumber: 2 })
    const list = await sessions.listByCampaign(campaignId)
    expect(list.map((s) => s.id)).toEqual([b.id, a.id])
  })

  it('partial-unique idx_sessions_one_active prevents two concurrent active sessions', async () => {
    const sessions = createSessionsRepo(pool)
    const { campaignId } = await makeCampaign(pool)
    await sessions.create({ campaignId, sessionNumber: 1 })
    await expect(sessions.create({ campaignId, sessionNumber: 2 })).rejects.toThrow()
  })
})
```

- [ ] **Step 2: Run, expect FAIL**

```bash
cd backend && pnpm vitest run src/repo/__tests__/sessions.test.ts
```

- [ ] **Step 3: Implement the namespace**

Create `backend/src/repo/sessions.ts`:

```ts
import { type Pool } from 'pg'
import { uuidv7 } from './uuidv7.js'
import { type CreateSessionInput, type Session, type SessionUpdate } from './types.js'
import { toSession, type SessionDbRow } from './mappers.js'

export function createSessionsRepo(pool: Pool) {
  return {
    create: async (input: CreateSessionInput): Promise<Session> => {
      const id = uuidv7()
      const result = await pool.query<SessionDbRow>(
        `INSERT INTO sessions (id, campaign_id, session_number, status)
         VALUES ($1, $2, $3, COALESCE($4, 'active'))
         RETURNING *`,
        [id, input.campaignId, input.sessionNumber, input.status ?? null],
      )
      const row = result.rows[0]
      if (!row) throw new Error('sessions.create: INSERT returned no row')
      return toSession(row)
    },

    getById: async (id: string): Promise<Session | null> => {
      const result = await pool.query<SessionDbRow>('SELECT * FROM sessions WHERE id = $1', [id])
      const row = result.rows[0]
      return row ? toSession(row) : null
    },

    getActiveByCampaign: async (campaignId: string): Promise<Session | null> => {
      // The partial-unique index idx_sessions_one_active guarantees at most
      // one active session per campaign. LIMIT 1 makes the contract self-
      // documenting at the SQL site.
      const result = await pool.query<SessionDbRow>(
        `SELECT * FROM sessions WHERE campaign_id = $1 AND status = 'active' LIMIT 1`,
        [campaignId],
      )
      const row = result.rows[0]
      return row ? toSession(row) : null
    },

    listByCampaign: async (campaignId: string): Promise<Session[]> => {
      const result = await pool.query<SessionDbRow>(
        `SELECT * FROM sessions WHERE campaign_id = $1 ORDER BY started_at DESC`,
        [campaignId],
      )
      return result.rows.map(toSession)
    },

    update: async (id: string, patch: SessionUpdate): Promise<Session> => {
      // sessions table has no updated_at column (only started_at + ended_at),
      // so this UPDATE doesn't include `updated_at = now()`.
      const result = await pool.query<SessionDbRow>(
        `UPDATE sessions
            SET status              = COALESCE($2, status),
                ended_at            = COALESCE($3, ended_at),
                summary             = COALESCE($4, summary),
                st_running_summary  = COALESCE($5, st_running_summary),
                handoff             = COALESCE($6, handoff)
          WHERE id = $1
          RETURNING *`,
        [
          id,
          patch.status ?? null,
          patch.endedAt ?? null,
          patch.summary ?? null,
          patch.stRunningSummary ?? null,
          patch.handoff ?? null,
        ],
      )
      const row = result.rows[0]
      if (!row) throw new Error(`sessions.update: no session with id ${id}`)
      return toSession(row)
    },
  }
}
```

- [ ] **Step 4: Run, expect PASS**

```bash
cd backend && pnpm vitest run src/repo/__tests__/sessions.test.ts && pnpm typecheck && pnpm lint
```

All ~8 sessions tests pass; typecheck + lint clean.

- [ ] **Step 5: Commit**

```bash
git add backend/src/repo/sessions.ts backend/src/repo/__tests__/sessions.test.ts
git commit -m "feat(myt-34): sessions namespace — create, getById, getActiveByCampaign, listByCampaign, update"
```

---

## Task 9: `index.ts` factory + AppDeps + server.ts wiring

**Files:**
- Create: `backend/src/repo/index.ts`
- Modify: `backend/src/app-deps.ts`
- Modify: `backend/src/server.ts`

> Composes the four namespaces. AppDeps gets `repo: Repo`. `server.ts` constructs the repo in both boot paths (real pool + stub pool that throws on use).

- [ ] **Step 1: Author `index.ts`**

Create `backend/src/repo/index.ts`:

```ts
import { type Pool } from 'pg'
import { createUsersRepo } from './users.js'
import { createWorldsRepo } from './worlds.js'
import { createCampaignsRepo } from './campaigns.js'
import { createSessionsRepo } from './sessions.js'

export function createRepo(pool: Pool) {
  return {
    users: createUsersRepo(pool),
    worlds: createWorldsRepo(pool),
    campaigns: createCampaignsRepo(pool),
    sessions: createSessionsRepo(pool),
  }
}

export type Repo = ReturnType<typeof createRepo>
```

- [ ] **Step 2: Modify `backend/src/app-deps.ts`**

Replace the file contents:

```ts
import type { Pool } from 'pg'
import type { Redis } from 'ioredis'
import type { Repo } from './repo/index.js'

export interface AppDeps {
  pg: Pool
  redisRealtime: Redis
  redisBatch: Redis
  repo: Repo
}
```

- [ ] **Step 3: Modify `backend/src/server.ts`**

In the boot-gate-on path inside `main()`, find the `buildApp({ pg: pgRef, ... })` call and add `repo` to the deps:

Before:
```ts
const app = buildApp({ pg: pgRef, redisRealtime: rTRRef, redisBatch: rTBRef })
```

After:
```ts
const repo = createRepo(pgRef)
const app = buildApp({ pg: pgRef, redisRealtime: rTRRef, redisBatch: rTBRef, repo })
```

In `fallbackStart`, find the `stubDeps: AppDeps` declaration and add `repo`:

Before:
```ts
const stubDeps: AppDeps = {
  pg: { end: () => Promise.resolve() } as unknown as Pool,
  redisRealtime: { quit: () => Promise.resolve('OK') } as unknown as Redis,
  redisBatch: { quit: () => Promise.resolve('OK') } as unknown as Redis,
}
```

After:
```ts
const stubPool = { end: () => Promise.resolve(), query: () => { throw new Error('repo unavailable: BOOT_GATE_ENABLED is off') } } as unknown as Pool
const stubDeps: AppDeps = {
  pg: stubPool,
  redisRealtime: { quit: () => Promise.resolve('OK') } as unknown as Redis,
  redisBatch: { quit: () => Promise.resolve('OK') } as unknown as Redis,
  repo: createRepo(stubPool),
}
```

Also add the import at the top of `server.ts`:

```ts
import { createRepo } from './repo/index.js'
```

- [ ] **Step 4: Verify all tests + typecheck + lint pass**

```bash
cd backend && pnpm typecheck && pnpm lint && pnpm test
```

Expected: existing 83 + Task 1's 2 + mappers ~12 + 4 namespace test files (~29 tests) = ~126 tests total. All green.

- [ ] **Step 5: Commit**

```bash
git add backend/src/repo/index.ts backend/src/app-deps.ts backend/src/server.ts
git commit -m "feat(myt-34): wire createRepo into AppDeps + server.ts (both boot paths)"
```

---

## Task 10: End-to-end verification + push + Linear close

> Per CLAUDE.md updated workflow ordering (myth-x49): wiki commits land BEFORE the final push so CI sees a consistent state.

- [ ] **Step 1: Final all-green check**

```bash
pnpm db:reset && pnpm db:migrate
pnpm typecheck && pnpm lint && pnpm test
```

Expected: full repo green (~126 backend tests + wiki + docs/* tests if any).

- [ ] **Step 2: Sanity-check that `pnpm dev` still starts**

```bash
cd backend && timeout 10 pnpm dev || true
```

Expected: the boot gate output runs, lands at `app.listen` on port 3000. (The timeout hard-stops after 10s; healthy boot is what we're checking, not long-run behavior.)

- [ ] **Step 3: Dispatch the wiki-update subagent**

Per `.claude/hooks/post-linear-close.sh` and `docs/wiki/AUTHORING.md` "Wiki Update Subagent Prompt":

Use the Agent tool with `subagent_type=general-purpose`, `model=opus`, parameterized with `linearIssueId=MYT-34`. The subagent will:
- Read the MYT-34 issue + walk diffs from the `54fbe48..HEAD`-equivalent range (or whatever the branch's first MYT-34 commit was)
- Update or extend wiki content under `docs/wiki/content/data/` (the Backend page or a new page on the repository layer pattern)
- Run `pnpm wiki:accept-drift` if needed
- Run `pnpm wiki:check`
- Commit locally — **do NOT push from inside the subagent**. Controller pushes everything together in Step 5.

The subagent's commit lands alongside the implementation commits.

- [ ] **Step 4: Verify wiki + tests still green**

```bash
pnpm wiki:check
pnpm typecheck && pnpm lint && pnpm test
```

All green.

- [ ] **Step 5: Push**

```bash
git push origin main
```

This pushes implementation + wiki as one event. CI's `wiki-check.yml` and `deploy.yml` both run on the consistent state.

- [ ] **Step 6: Flip Linear MYT-34 to Done**

Use `mcp__linear-server__save_issue` with `id=MYT-34` and `state=Done`. The post-close hook fires; since the wiki was already updated in Step 3, the hook's reminder serves only as a backstop.

- [ ] **Step 7: Close all MYT-34 implementation beads**

If beads were created at the task level during implementation, close them:

```bash
bd close <bead-id> [...]
```

(For this plan, the bead-per-task decomposition happens at the start of subagent-driven implementation, separate from the deferred-namespace beads which stay open.)

---

## Self-Review

1. **Spec coverage**: every section of the design spec maps to a task. §3 file layout → Tasks 1–9. §4.1 mappers → Task 3. §4.2 narrowing helpers → Task 3. §4.3 RETURNING * → Tasks 5–8 (every create). §4.4 COALESCE update → Tasks 5–8. §4.5 uuidv7.ts seam + migrate.ts switch → Task 1. §4.6 method-level decisions → Tasks 5–8. §5 AppDeps + server wiring → Task 9. §6 tests → all namespace tasks + Task 3. §7 DoD → covered across tasks; final check in Task 10.

2. **Placeholder scan**: no TBDs, TODOs, "implement later." Every code block is complete. The wiki subagent prompt references `docs/wiki/AUTHORING.md` rather than re-stating its content — that's a real file the subagent can read, not a placeholder.

3. **Type / signature consistency**: `createRepo`/`createUsersRepo`/`createWorldsRepo`/`createCampaignsRepo`/`createSessionsRepo` named consistently across Tasks 5–9. Row types (`User`, `World`, `Campaign`, `Session`) match between Task 2 (declaration) and Tasks 5–8 (use). `UserDbRow`/`WorldDbRow`/`CampaignDbRow`/`SessionDbRow` declared in Task 3 and imported by Tasks 5–8. `UserUpdate`/`WorldUpdate`/`CampaignUpdate`/`SessionUpdate` consistent.

4. **Order of operations**: Task 1 (uuidv7) is independent. Task 2 (types) is independent. Task 3 (mappers) depends on Task 2. Task 4 (reset helper) is independent. Tasks 5–8 (namespace impls) depend on Tasks 1, 2, 3, 4. Task 9 (factory + wiring) depends on Tasks 5–8. Task 10 wraps. Workable in this order.

5. **Time budget**: ~1 working day per the Linear estimate. Task 1 (~15 min), Task 2 (~30 min), Task 3 (~45 min), Task 4 (~15 min), Tasks 5–8 (~45 min each = ~3h), Task 9 (~30 min), Task 10 (~30 min). Total ~5–6 hours, within budget.

---

Plan complete and saved to `docs/superpowers/plans/2026-04-28-repository-layer.md`. Two execution options:

1. **Subagent-Driven (recommended)** — fresh subagent per task, review between tasks, fast iteration. Tasks 1–4 are highly mechanical (good fit for a single fast model); Tasks 5–8 want more care but follow a strong template; Task 9 is small wiring; Task 10 wraps.
2. **Inline Execution** — execute in this session using executing-plans, batch with checkpoints.

Which approach?
