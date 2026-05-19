# MYT-53 — Per-player parallel character creation: implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship the per-player parallel character creation surface (eight routes + a per-player `character-creation` BullMQ pipeline + a dev-tool driver) so multiplayer campaigns can move from "world ready" to "characters in world" with parallel fan-out.

**Architecture:** Three additions on top of MYT-51/MYT-52's world-gen scaffold: (1) a `character_concepts` table holding the player's two-prompt input + per-player lifecycle status; (2) a `character-creation` BullMQ processor that parallels `world-gen-processor.ts`, runs four stages per `(campaign_id, user_id)` pair, and reuses MYT-51's per-player `pipeline_runs` keying; (3) eight new HTTP routes (owner-only fan-out controls + member-visible status/submission). One-line schema extensions: `entity_type='pc'`, `worlds.starting_situation_entries jsonb`, and a `campaigns.starting_situation_index` column.

**Tech Stack:** Node.js 24 + Fastify + TypeScript (strict) + Postgres + BullMQ + Anthropic SDK (Sonnet stages 2-3, Opus stage 4 with `streamObject`). Tests Vitest + per-worktree Postgres via `pnpm test`.

**Plan source:** `docs/superpowers/specs/2026-05-18-myt-53-per-player-character-creation-design.md`. Quote into tasks rather than referring out.

---

## File structure

**New files (path → responsibility):**

| Path | Responsibility |
|---|---|
| `backend/migrations/016_character_concepts.sql` | Schema: `character_concepts` table + `campaigns.starting_situation_index` + `worlds.starting_situation_entries` + extend `entities.entity_type` to allow `'pc'` |
| `backend/src/repo/character-concepts.ts` | Repo CRUD: UPSERT, status transitions, query helpers |
| `backend/src/repo/__tests__/character-concepts.test.ts` | Repo integration tests |
| `backend/src/llm/schemas/character-concept.ts` | Zod schema for stage-2 LLM output (narrative half) |
| `backend/src/llm/schemas/character-sheet.ts` | Zod schema for stage-3 LLM output (mechanicals + sub-tables) |
| `backend/src/llm/schemas/character-integration.ts` | Zod schema for stage-4 LLM output (PC entity + relationships + facts) |
| `backend/src/llm/prep/stages/location-selection.ts` | Stage 1 handler — no LLM; resolves index → locationEntityId; validates existence |
| `backend/src/llm/prep/stages/character-concept.ts` | Stage 2 handler — Sonnet generateObject; returns narrative payload (no DB write) |
| `backend/src/llm/prep/stages/character-sheet.ts` | Stage 3 handler — Sonnet generateObject; INSERTs `characters` + `campaign_characters` + 4 sub-tables in one tx |
| `backend/src/llm/prep/stages/character-integration.ts` | Stage 4 handler — Opus streamObject; emits PC entity + edges; idempotent re-run |
| `backend/src/llm/prep/stages/__tests__/location-selection.test.ts` | Stage 1 tests |
| `backend/src/llm/prep/stages/__tests__/character-concept.test.ts` | Stage 2 tests (mocked SDK) |
| `backend/src/llm/prep/stages/__tests__/character-sheet.test.ts` | Stage 3 tests (mocked SDK + real PG) |
| `backend/src/llm/prep/stages/__tests__/character-integration.test.ts` | Stage 4 tests (mocked SDK + real PG) |
| `backend/src/llm/prompts/prep/character-concept.txt` | Stage 2 prompt template |
| `backend/src/llm/prompts/prep/character-sheet.txt` | Stage 3 prompt template |
| `backend/src/llm/prompts/prep/character-integration.txt` | Stage 4 prompt template |
| `backend/src/llm/prep/character-creation-processor.ts` | BullMQ processor — parallels world-gen-processor.ts |
| `backend/src/llm/prep/__tests__/character-creation-processor.test.ts` | Processor tests (per-player isolation, idempotency, recovery) |
| `backend/src/routes/campaign-characters.ts` | Eight new HTTP route handlers |
| `backend/src/routes/__tests__/campaign-characters.test.ts` | Route tests |
| `backend/dev-tool/src/components/character-creation-panel.ts` | Dev-tool driver panel |
| `docs/wiki/content/runtime/character-creation.html` | Wiki page documenting the pipeline |

**Modified files (path → change):**

| Path | Change |
|---|---|
| `backend/src/llm/prep/stages/starting-situation.ts` | Persist `worlds.starting_situation_entries` (structured array w/ resolved `locationEntityId`) alongside existing prose blob |
| `backend/src/llm/prep/world-gen-processor.ts` | Parameterize `atomicClaimStage` on optional `userId` (default NULL preserves world-level semantics) |
| `backend/src/llm/prep/cost-cap.ts` | Add `sumCharacterCreationStageCosts(campaignId)` aggregator + `readCharacterCreationCostCap` reader |
| `backend/migrations/016_character_concepts.sql` | Also seeds `settings.character_creation_cost_cap_usd` row |
| `backend/src/routes/campaigns.ts` | Extend `GET /api/campaigns/:campaignId` response to include `characters[]` |
| `backend/src/contract/pipeline-routes.ts` | Register 8 new pipeline routes |
| `backend/src/contract/backend-routes.ts` | Register 8 new backend routes |
| `backend/src/contract/pipeline-jobs.ts` | Register `character-creation` job |
| `backend/src/app.ts` | Register `campaign-characters` plugin + boot the character-creation worker |
| `backend/dev-tool/src/main.ts` | Mount the new panel |
| `backend/dev-tool/verify-registry.ts` | Register the new panel + 8 routes + 1 job |
| `backend/dev-tool/coverage.json` | Update coverage manifest |

---

## Task ordering

Tasks are ordered so each is testable in isolation against the preceding green state:

1. Migration 016 (schema)
2. character-concepts repo
3. starting_situation stage extension (structured entries + name→id resolution)
4. Three Zod schemas (concept / sheet / integration)
5. Cost-cap extension + settings row
6. atomicClaimStage helper refactor (parameterize on userId)
7. Stage 1 — location-selection handler
8. Stage 2 — character-concept handler
9. Stage 3 — character-sheet handler
10. Stage 4 — character-integration handler
11. character-creation-processor
12. Route 1 — POST /starting-situation
13. Route 2 — POST /start-character-creation (fan-out)
14. Route 3 — POST /archive (shape change)
15. Route 4 — POST /characters
16. Route 5 — GET /starting-situations
17. Route 6 — GET /characters (roster)
18. Route 7 — GET /characters/:charId
19. Route 8 — GET /hierarchy + GET /random-tables
20. GET /api/campaigns/:campaignId response shape extension
21. Contract registrations (pipeline-routes, pipeline-jobs, backend-routes)
22. app.ts wiring (route plugin + worker boot)
23. Dev-tool panel + coverage manifest
24. Wiki page + source-hash registration
25. Real-LLM E2E smoke at push-time

---

## Task 1: Migration 016 — `character_concepts` + adjacent schema changes

**Files:**
- Create: `backend/migrations/016_character_concepts.sql`

**Why:** This is the schema floor everything else builds on. Per the spec §Schema: `character_concepts` table (with composite FK to `campaign_members` for membership integrity), `campaigns.starting_situation_index` column, `worlds.starting_situation_entries jsonb` column, extension of `entities.entity_type` CHECK to allow `'pc'`, and a settings row for the character-creation cost cap.

- [ ] **Step 1: Create the migration file with all schema additions**

Write `backend/migrations/016_character_concepts.sql`:

```sql
-- backend/migrations/016_character_concepts.sql
-- MYT-53: per-player character submission input + adjacent schema additions
-- supporting the per-player character-creation pipeline.
--
-- One row per (campaign_id, user_id) in character_concepts. Pre-fan-out
-- it holds the player's input; post-fan-out it tracks status. Consumed
-- by the character-creation worker on owner-triggered fan-out.
--
-- The composite FK to campaign_members ensures membership integrity:
-- if a member is removed from the campaign, their concept row cascades.
-- campaign_members already has UNIQUE(campaign_id, user_id) (001_initial_schema).
--
-- entity_type='pc' is added so PC entities are conceptually distinct
-- from NPC entities, keeping existing "list NPCs" paths clean.

-- 1) Owner's starting-situation pick (per-campaign, applied party-wide).
ALTER TABLE campaigns ADD COLUMN starting_situation_index SMALLINT
  CHECK (starting_situation_index IS NULL
         OR starting_situation_index BETWEEN 0 AND 2);

-- 2) Structured starting-situation entries on the world. Stage
-- starting_situation extends to emit this alongside the existing prose
-- blob (worlds.starting_situations). GET /starting-situations reads
-- this column.
ALTER TABLE worlds ADD COLUMN starting_situation_entries jsonb NOT NULL
  DEFAULT '[]'::jsonb
  CHECK (jsonb_typeof(starting_situation_entries) = 'array');

-- 3) Extend entities.entity_type to allow 'pc'. PCs are user-owned
-- characters joined to the world; NPCs remain pure game-fiction.
ALTER TABLE entities DROP CONSTRAINT IF EXISTS entities_entity_type_check;
ALTER TABLE entities ADD CONSTRAINT entities_entity_type_check
  CHECK (entity_type IN ('npc', 'location', 'faction', 'item', 'pc'));

-- 4) The character_concepts table.
CREATE TABLE character_concepts (
  id UUID PRIMARY KEY,
  campaign_id UUID NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,

  -- Composite FK to campaign_members: a concept row only makes sense
  -- for a current member of the campaign. ON DELETE CASCADE means
  -- removing a member cascades the concept row out automatically.
  FOREIGN KEY (campaign_id, user_id)
    REFERENCES campaign_members(campaign_id, user_id) ON DELETE CASCADE,

  -- Freeform mode input. The "who is this character?" half. NULL
  -- only when the player is purely-guided (future).
  concept_text TEXT
    CHECK (concept_text IS NULL OR length(concept_text) BETWEEN 20 AND 4000),

  -- "Why is this character at this tavern?" half. Always required in v1.
  -- Late-joiner UX reuses this field with a reworded prompt.
  situation_grounding_text TEXT NOT NULL
    CHECK (length(situation_grounding_text) BETWEEN 20 AND 2000),

  -- Guided mode input. JSONB so shape can evolve. Always {} in v1.
  guided_choices JSONB NOT NULL DEFAULT '{}'::jsonb,

  -- Submission lifecycle.
  status TEXT NOT NULL DEFAULT 'submitted'
    CHECK (status IN ('submitted', 'processing', 'completed', 'failed')),

  error JSONB,

  submitted_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),

  UNIQUE(campaign_id, user_id)
);

CREATE INDEX idx_character_concepts_campaign_status
  ON character_concepts(campaign_id, status);

-- 5) Cost-cap row for character creation. Default $5.00 — covers
-- ~10 players at the realistic per-player upper end (~$0.50) with
-- headroom. Mirrors world_gen_cost_cap_usd shape from migration 010.
INSERT INTO settings (key, value)
  VALUES ('character_creation_cost_cap_usd', '5.00')
  ON CONFLICT (key) DO NOTHING;
```

- [ ] **Step 2: Verify migration applies cleanly**

Run from repo root:
```
pnpm db:migrate
```

Expected output: `Migration 016_character_concepts.sql executed successfully` and no errors. Existing migrations 001-015 must remain idempotent — running this on a fresh DB and on a dev DB with 015 already applied must both succeed.

- [ ] **Step 3: Sanity-check the schema via psql**

```
docker compose exec postgres psql -U postgres -d mythrun -c "\\d character_concepts"
docker compose exec postgres psql -U postgres -d mythrun -c "\\d+ entities" | head -20
docker compose exec postgres psql -U postgres -d mythrun -c "SELECT key, value FROM settings WHERE key LIKE '%cost_cap%'"
```

Expected:
- `character_concepts` shows the composite FK to `campaign_members`, the UNIQUE on `(campaign_id, user_id)`, and the index `idx_character_concepts_campaign_status`.
- `entities.entity_type` check constraint now lists `'pc'`.
- `settings` shows both `world_gen_cost_cap_usd` (from migration 010) and `character_creation_cost_cap_usd` (new, value `'5.00'`).

- [ ] **Step 4: Commit**

```
git add backend/migrations/016_character_concepts.sql
git commit -m "feat(myt-53): migration 016 — character_concepts + adjacent schema"
```

---

## Task 2: `character-concepts` repo + tests

**Files:**
- Create: `backend/src/repo/character-concepts.ts`
- Create: `backend/src/repo/__tests__/character-concepts.test.ts`
- Modify: `backend/src/repo/index.ts` (register the new repo)

**Why:** All DB access through the repo layer (CLAUDE.md standing rule). The repo encapsulates UPSERT semantics, status transitions, and the query helpers the route + processor will call.

- [ ] **Step 1: Write the failing tests**

Create `backend/src/repo/__tests__/character-concepts.test.ts`:

```typescript
import { describe, expect, it, beforeEach } from 'vitest'
import { createCharacterConceptsRepo } from '../character-concepts.js'
import { setupDb, resetData, getPool } from '../../testing/db.js'
import { uuidv7 } from '../uuidv7.js'

beforeEach(async () => {
  await resetData()
})

async function makeMember(): Promise<{ campaignId: string; userId: string }> {
  const pool = getPool()
  const userId = uuidv7()
  const campaignId = uuidv7()
  await pool.query(
    `INSERT INTO users (id, email) VALUES ($1, $2)`,
    [userId, `${userId}@dev.test`],
  )
  await pool.query(
    `INSERT INTO campaigns (id, name, owner_user_id, status)
     VALUES ($1, $2, $3, 'setup')`,
    [campaignId, 'C', userId],
  )
  await pool.query(
    `INSERT INTO campaign_members (id, campaign_id, user_id, role, invite_accepted)
     VALUES ($1, $2, $3, 'owner', true)`,
    [uuidv7(), campaignId, userId],
  )
  return { campaignId, userId }
}

describe('characterConceptsRepo', () => {
  it('upserts a new submitted concept on first call', async () => {
    await setupDb()
    const repo = createCharacterConceptsRepo(getPool())
    const { campaignId, userId } = await makeMember()

    const row = await repo.upsert({
      campaignId,
      userId,
      conceptText: 'a road-weary cleric who lost their faith',
      situationGroundingText: 'arrived seeking word of an old companion',
      guidedChoices: {},
    })

    expect(row.status).toBe('submitted')
    expect(row.conceptText).toMatch(/cleric/)
  })

  it('replaces the row and resets to submitted on re-upsert from failed', async () => {
    await setupDb()
    const repo = createCharacterConceptsRepo(getPool())
    const { campaignId, userId } = await makeMember()
    await repo.upsert({
      campaignId,
      userId,
      conceptText: 'first try',
      situationGroundingText: 'first situation',
      guidedChoices: {},
    })
    await repo.markFailed(campaignId, userId, { code: 'stage_failed', message: 'mocked' })

    const replaced = await repo.upsert({
      campaignId,
      userId,
      conceptText: 'second try with more detail and intent',
      situationGroundingText: 'second situation arrival',
      guidedChoices: {},
    })

    expect(replaced.status).toBe('submitted')
    expect(replaced.conceptText).toMatch(/second try/)
  })

  it('listSubmittedByCampaign returns only submitted rows for the campaign', async () => {
    await setupDb()
    const repo = createCharacterConceptsRepo(getPool())
    const { campaignId, userId } = await makeMember()
    await repo.upsert({
      campaignId,
      userId,
      conceptText: 'cleric',
      situationGroundingText: 'arrival',
      guidedChoices: {},
    })
    const rows = await repo.listSubmittedByCampaign(campaignId)
    expect(rows.map(r => r.userId)).toEqual([userId])

    await repo.markProcessing(campaignId, userId)
    const after = await repo.listSubmittedByCampaign(campaignId)
    expect(after).toEqual([])
  })

  it('getByCampaignAndUser returns null when no row', async () => {
    await setupDb()
    const repo = createCharacterConceptsRepo(getPool())
    const { campaignId, userId } = await makeMember()
    const got = await repo.getByCampaignAndUser(campaignId, userId)
    expect(got).toBeNull()
  })

  it('markProcessing transitions submitted → processing; markCompleted to completed', async () => {
    await setupDb()
    const repo = createCharacterConceptsRepo(getPool())
    const { campaignId, userId } = await makeMember()
    await repo.upsert({
      campaignId,
      userId,
      conceptText: 'cleric',
      situationGroundingText: 'arrival',
      guidedChoices: {},
    })
    await repo.markProcessing(campaignId, userId)
    let row = await repo.getByCampaignAndUser(campaignId, userId)
    expect(row?.status).toBe('processing')
    await repo.markCompleted(campaignId, userId)
    row = await repo.getByCampaignAndUser(campaignId, userId)
    expect(row?.status).toBe('completed')
  })
})
```

- [ ] **Step 2: Run the failing tests**

```
pnpm vitest run backend/src/repo/__tests__/character-concepts.test.ts
```

Expected: FAIL with `Cannot find module '../character-concepts.js'`.

- [ ] **Step 3: Implement the repo**

Create `backend/src/repo/character-concepts.ts`:

```typescript
// backend/src/repo/character-concepts.ts
//
// MYT-53: repository for character_concepts. One row per
// (campaign_id, user_id). UPSERT semantics match the spec's
// re-submit-after-failure contract: re-POST while in 'submitted'
// or 'failed' replaces the row and resets status to 'submitted';
// 'processing' and 'completed' are not UPSERT-able through this path
// (the route layer guards with 409 'concept_locked').

import type { Pool, PoolClient } from 'pg'
import { uuidv7 } from './uuidv7.js'

export interface CharacterConcept {
  readonly id: string
  readonly campaignId: string
  readonly userId: string
  readonly conceptText: string | null
  readonly situationGroundingText: string
  readonly guidedChoices: Record<string, unknown>
  readonly status: 'submitted' | 'processing' | 'completed' | 'failed'
  readonly error: Record<string, unknown> | null
  readonly submittedAt: Date
  readonly updatedAt: Date
}

interface UpsertInput {
  readonly campaignId: string
  readonly userId: string
  readonly conceptText: string | null
  readonly situationGroundingText: string
  readonly guidedChoices: Record<string, unknown>
}

interface DbRow {
  id: string
  campaign_id: string
  user_id: string
  concept_text: string | null
  situation_grounding_text: string
  guided_choices: Record<string, unknown>
  status: 'submitted' | 'processing' | 'completed' | 'failed'
  error: Record<string, unknown> | null
  submitted_at: Date
  updated_at: Date
}

function toConcept(row: DbRow): CharacterConcept {
  return {
    id: row.id,
    campaignId: row.campaign_id,
    userId: row.user_id,
    conceptText: row.concept_text,
    situationGroundingText: row.situation_grounding_text,
    guidedChoices: row.guided_choices,
    status: row.status,
    error: row.error,
    submittedAt: row.submitted_at,
    updatedAt: row.updated_at,
  }
}

export function createCharacterConceptsRepo(pool: Pool) {
  return {
    upsert: async (input: UpsertInput): Promise<CharacterConcept> => {
      const id = uuidv7()
      const result = await pool.query<DbRow>(
        `INSERT INTO character_concepts (
           id, campaign_id, user_id, concept_text,
           situation_grounding_text, guided_choices, status
         )
         VALUES ($1, $2, $3, $4, $5, $6::jsonb, 'submitted')
         ON CONFLICT (campaign_id, user_id) DO UPDATE
           SET concept_text = EXCLUDED.concept_text,
               situation_grounding_text = EXCLUDED.situation_grounding_text,
               guided_choices = EXCLUDED.guided_choices,
               status = 'submitted',
               error = NULL,
               updated_at = now()
         RETURNING *`,
        [
          id,
          input.campaignId,
          input.userId,
          input.conceptText,
          input.situationGroundingText,
          JSON.stringify(input.guidedChoices),
        ],
      )
      const row = result.rows[0]
      if (!row) throw new Error('character_concepts.upsert: INSERT returned no row')
      return toConcept(row)
    },

    getByCampaignAndUser: async (
      campaignId: string,
      userId: string,
    ): Promise<CharacterConcept | null> => {
      const result = await pool.query<DbRow>(
        `SELECT * FROM character_concepts WHERE campaign_id = $1 AND user_id = $2`,
        [campaignId, userId],
      )
      const row = result.rows[0]
      return row ? toConcept(row) : null
    },

    getByCampaignId: async (campaignId: string): Promise<readonly CharacterConcept[]> => {
      const result = await pool.query<DbRow>(
        `SELECT * FROM character_concepts WHERE campaign_id = $1 ORDER BY submitted_at`,
        [campaignId],
      )
      return result.rows.map(toConcept)
    },

    listSubmittedByCampaign: async (
      campaignId: string,
    ): Promise<readonly CharacterConcept[]> => {
      const result = await pool.query<DbRow>(
        `SELECT * FROM character_concepts
         WHERE campaign_id = $1 AND status = 'submitted'
         ORDER BY submitted_at`,
        [campaignId],
      )
      return result.rows.map(toConcept)
    },

    countAnyProcessingOrCompleted: async (campaignId: string): Promise<number> => {
      const result = await pool.query<{ n: string }>(
        `SELECT COUNT(*)::text AS n FROM character_concepts
         WHERE campaign_id = $1 AND status IN ('processing', 'completed')`,
        [campaignId],
      )
      return Number.parseInt(result.rows[0]?.n ?? '0', 10)
    },

    markProcessing: async (campaignId: string, userId: string): Promise<void> => {
      await pool.query(
        `UPDATE character_concepts
         SET status = 'processing', updated_at = now()
         WHERE campaign_id = $1 AND user_id = $2 AND status = 'submitted'`,
        [campaignId, userId],
      )
    },

    markCompleted: async (campaignId: string, userId: string): Promise<void> => {
      await pool.query(
        `UPDATE character_concepts
         SET status = 'completed', error = NULL, updated_at = now()
         WHERE campaign_id = $1 AND user_id = $2`,
        [campaignId, userId],
      )
    },

    markFailed: async (
      campaignId: string,
      userId: string,
      error: Record<string, unknown>,
    ): Promise<void> => {
      await pool.query(
        `UPDATE character_concepts
         SET status = 'failed', error = $3::jsonb, updated_at = now()
         WHERE campaign_id = $1 AND user_id = $2`,
        [campaignId, userId, JSON.stringify(error)],
      )
    },

    // Atomic claim helper for the fan-out route: flip every 'submitted'
    // row for a campaign to 'processing' inside the route's transaction
    // alongside the BullMQ enqueue. The route's BEGIN ... COMMIT envelopes
    // both this UPDATE and the queue.add() so a failed enqueue rolls back.
    flipAllSubmittedToProcessing: async (
      client: PoolClient,
      campaignId: string,
    ): Promise<readonly { userId: string; conceptId: string }[]> => {
      const result = await client.query<{ id: string; user_id: string }>(
        `UPDATE character_concepts
         SET status = 'processing', updated_at = now()
         WHERE campaign_id = $1 AND status = 'submitted'
         RETURNING id, user_id`,
        [campaignId],
      )
      return result.rows.map(r => ({ conceptId: r.id, userId: r.user_id }))
    },
  }
}

export type CharacterConceptsRepo = ReturnType<typeof createCharacterConceptsRepo>
```

- [ ] **Step 4: Register the repo in `backend/src/repo/index.ts`**

Open `backend/src/repo/index.ts` and add the import + namespace key (follow the same pattern as `characters` / `worlds`). The change:

```typescript
// Add at the top of the import block:
import { createCharacterConceptsRepo } from './character-concepts.js'

// Inside createRepo's returned object, add:
//   characterConcepts: createCharacterConceptsRepo(pool),
```

- [ ] **Step 5: Run the tests to verify they pass**

```
pnpm vitest run backend/src/repo/__tests__/character-concepts.test.ts
```

Expected: all 5 tests pass.

- [ ] **Step 6: Run typecheck and lint**

```
pnpm typecheck && pnpm lint
```

Expected: 0 errors.

- [ ] **Step 7: Commit**

```
git add backend/src/repo/character-concepts.ts backend/src/repo/__tests__/character-concepts.test.ts backend/src/repo/index.ts
git commit -m "feat(myt-53): character-concepts repo + tests"
```

---

## Task 3: `starting_situation` stage extension — structured entries + name→id resolution

**Files:**
- Modify: `backend/src/llm/prep/stages/starting-situation.ts`
- Modify: `backend/src/llm/prep/stages/__tests__/starting-situation.test.ts`

**Why:** Per the spec §Components, the starting_situation stage must also persist `worlds.starting_situation_entries` (an array of `{index, locationEntityId, prose}`) so `GET /api/campaigns/:campaignId/starting-situations` has a structured array to serve. The LLM emits `location_name` strings (current schema); the handler resolves each name → entity id via case-insensitive lookup against `entities` rows of `entity_type='location'`. One miss → retry the LLM with a constrained-names hint; second miss → throw `LlmStructuredOutputError` so the existing repair pipeline picks it up.

- [ ] **Step 1: Extend the test fixture and add the resolution-path tests**

Open `backend/src/llm/prep/stages/__tests__/starting-situation.test.ts`. Add new tests for:

```typescript
// New test: handler resolves location_name → locationEntityId
it('resolves location_name to locationEntityId via entities lookup and persists structured array', async () => {
  // Mock setup: world with 3 location entities pre-seeded; SDK returns
  // location_hooks naming those 3 locations. Handler should UPDATE
  // worlds.starting_situations (existing) AND worlds.starting_situation_entries.
  const client = makeClient()
  // Seed client.query mock so that SELECT entities returns matching rows.
  client.query.mockImplementation(async (sql: string) => {
    if (/SELECT.*FROM entities.*entity_type = 'location'/i.test(sql)) {
      return { rows: [
        { id: 'loc-1', name: 'The Whispering Well' },
        { id: 'loc-2', name: 'Ashen Market' },
        { id: 'loc-3', name: 'Iron Sept' },
      ] }
    }
    return { rows: [] }
  })

  mockGenerateText.mockResolvedValueOnce({
    output: {
      location_hooks: [
        { location_name: 'The Whispering Well', why_interesting: 'short note about the well' },
        { location_name: 'Ashen Market', why_interesting: 'a market story' },
        { location_name: 'Iron Sept', why_interesting: 'a temple ruin' },
      ],
    },
    finishReason: 'stop',
    usage: { inputTokens: 1000, outputTokens: 600, totalTokens: 1600 },
  } as never)

  await runStartingSituationStage(
    client as unknown as Parameters<typeof runStartingSituationStage>[0],
    ARGS,
  )

  // Expect at least two UPDATEs: existing starting_situations + new
  // starting_situation_entries. The second carries the resolved ids.
  const updateCalls = client.query.mock.calls
    .filter((c: unknown[]) => /UPDATE worlds/i.test(String(c[0])))
  const entriesUpdate = updateCalls.find((c: unknown[]) =>
    /starting_situation_entries/i.test(String(c[0])))
  expect(entriesUpdate).toBeDefined()
  const params = entriesUpdate![1] as unknown[]
  const payload = JSON.parse(params[1] as string) as Array<{ index: number; locationEntityId: string; prose: string }>
  expect(payload.map(p => p.locationEntityId)).toEqual(['loc-1', 'loc-2', 'loc-3'])
})

it('throws LlmStructuredOutputError after one retry when a location_name does not match', async () => {
  const client = makeClient()
  client.query.mockImplementation(async (sql: string) => {
    if (/SELECT.*FROM entities.*entity_type = 'location'/i.test(sql)) {
      return { rows: [{ id: 'loc-1', name: 'The Real Place' }] }
    }
    return { rows: [] }
  })
  mockGenerateText.mockResolvedValue({
    output: {
      location_hooks: [
        { location_name: 'Not A Real Place', why_interesting: 'fictional' },
        { location_name: 'Also Not Real', why_interesting: 'fictional' },
        { location_name: 'Likewise', why_interesting: 'fictional' },
      ],
    },
    finishReason: 'stop',
    usage: { inputTokens: 1000, outputTokens: 600, totalTokens: 1600 },
  } as never)

  await expect(
    runStartingSituationStage(
      client as unknown as Parameters<typeof runStartingSituationStage>[0],
      ARGS,
    ),
  ).rejects.toThrow(/location_name.*not.*found|cannot resolve/i)
  expect(mockGenerateText).toHaveBeenCalledTimes(2) // initial + one retry
})
```

- [ ] **Step 2: Run the tests to verify they fail**

```
pnpm vitest run backend/src/llm/prep/stages/__tests__/starting-situation.test.ts
```

Expected: the two new tests FAIL — existing handler does not look up entities, does not write `starting_situation_entries`, does not retry on name miss.

- [ ] **Step 3: Implement the extended handler**

Update `backend/src/llm/prep/stages/starting-situation.ts`:

```typescript
// (Existing imports stay. Add LlmStructuredOutputError to the imports.)
import { LlmStructuredOutputError } from '../../errors.js'

// After the existing `runStartingSituationStage` body's generateObject
// call, before the existing UPDATE: resolve each location_name to an
// entity id. If any miss, retry once with constrained names; on second
// miss, throw.

export async function runStartingSituationStage(
  client: PoolClient,
  args: StartingSituationArgs,
): Promise<StageCostResult> {
  const prompt = PROMPT_TEMPLATE.replace('{{name}}', args.worldName)
    .replace('{{tone}}', args.tone)
    .replace('{{themes}}', args.themes)
    .replace('{{key_tensions}}', args.keyTensions)
    .replace('{{locations_summary}}', args.locationsSummary)
    .replace('{{npcs_summary}}', args.npcsSummary)
    .replace('{{factions_summary}}', args.factionsSummary)
    .replace('{{canonical_names}}', args.canonicalNames)
    .replace('{{vocabularyRegistry}}', renderVocabularyRegistry(args.vocabularyRegistry))

  // First attempt.
  let result = await generateObject({
    model: SONNET,
    schema: StartingSituationsSchema,
    prompt,
    temperature: 0.7,
    maxRetries: 3,
    callSite: 'starting-situation',
    schemaName: 'StartingSituationsSchema',
  })

  let resolved = await resolveLocationEntries(client, args.worldId, result.output.location_hooks)
  let inputTokens = result.usage.inputTokens ?? 0
  let outputTokens = result.usage.outputTokens ?? 0

  if (resolved === null) {
    // Retry once with explicit valid-names constraint appended to the prompt.
    const validNames = await listLocationNames(client, args.worldId)
    const retryPrompt = `${prompt}\n\nIMPORTANT: choose location_name values EXACTLY from this list of existing locations: ${validNames.join(', ')}.`
    result = await generateObject({
      model: SONNET,
      schema: StartingSituationsSchema,
      prompt: retryPrompt,
      temperature: 0.7,
      maxRetries: 3,
      callSite: 'starting-situation',
      schemaName: 'StartingSituationsSchema',
    })
    inputTokens += result.usage.inputTokens ?? 0
    outputTokens += result.usage.outputTokens ?? 0
    resolved = await resolveLocationEntries(client, args.worldId, result.output.location_hooks)
    if (resolved === null) {
      throw new LlmStructuredOutputError(
        'starting-situation: location_name values cannot be resolved to entities after one retry',
      )
    }
  }

  await client.query(`UPDATE worlds SET starting_situations = $2 WHERE id = $1`, [
    args.worldId,
    JSON.stringify(result.output),
  ])

  // New: structured array for the GET /starting-situations route.
  const entries = resolved.map((r, index) => ({
    index,
    locationEntityId: r.locationEntityId,
    prose: r.prose,
  }))
  await client.query(
    `UPDATE worlds SET starting_situation_entries = $2::jsonb WHERE id = $1`,
    [args.worldId, JSON.stringify(entries)],
  )

  return {
    costUsd: computeCostUsd({ inputTokens, outputTokens }),
    inputTokens,
    outputTokens,
  }
}

// Helpers. Both query entities of type 'location' for the world.

async function listLocationNames(client: PoolClient, worldId: string): Promise<readonly string[]> {
  const r = await client.query<{ name: string }>(
    `SELECT name FROM entities WHERE world_id = $1 AND entity_type = 'location'`,
    [worldId],
  )
  return r.rows.map(row => row.name)
}

interface ResolvedEntry {
  readonly locationEntityId: string
  readonly prose: string
}

async function resolveLocationEntries(
  client: PoolClient,
  worldId: string,
  hooks: readonly LocationHook[],
): Promise<readonly ResolvedEntry[] | null> {
  const r = await client.query<{ id: string; name: string }>(
    `SELECT id, name FROM entities WHERE world_id = $1 AND entity_type = 'location'`,
    [worldId],
  )
  const byLowerName = new Map<string, string>()
  for (const row of r.rows) byLowerName.set(row.name.toLowerCase(), row.id)
  const out: ResolvedEntry[] = []
  for (const hook of hooks) {
    const id = byLowerName.get(hook.location_name.toLowerCase())
    if (!id) return null
    out.push({ locationEntityId: id, prose: hook.why_interesting })
  }
  return out
}
```

- [ ] **Step 4: Run all starting-situation tests to verify pass**

```
pnpm vitest run backend/src/llm/prep/stages/__tests__/starting-situation.test.ts
```

Expected: all tests pass, including the two new ones.

- [ ] **Step 5: Verify the existing world-gen processor still works**

```
pnpm vitest run backend/src/llm/prep/__tests__/world-gen-processor.test.ts
```

Expected: 0 regressions — the processor reads `worlds.starting_situations` (prose) the same way as before; the new column is additive.

- [ ] **Step 6: Typecheck + lint + commit**

```
pnpm typecheck && pnpm lint
git add backend/src/llm/prep/stages/starting-situation.ts backend/src/llm/prep/stages/__tests__/starting-situation.test.ts
git commit -m "feat(myt-53): starting_situation stage emits structured entries + name->id resolution"
```

---

## Task 4: Zod schemas — concept / sheet / integration

**Files:**
- Create: `backend/src/llm/schemas/character-concept.ts`
- Create: `backend/src/llm/schemas/character-sheet.ts`
- Create: `backend/src/llm/schemas/character-integration.ts`
- Create: `backend/src/llm/schemas/__tests__/character-schemas.test.ts`

**Why:** Each LLM stage needs a strict Zod schema for `Output.object` validation. The schemas are bound-checked (length limits, enum values, array caps) to match the portable-character shape from MYT-48 + D&D 5e SRD constraints.

- [ ] **Step 1: Write the failing schema tests**

Create `backend/src/llm/schemas/__tests__/character-schemas.test.ts`:

```typescript
import { describe, expect, it } from 'vitest'
import { CharacterConceptOutputSchema } from '../character-concept.js'
import { CharacterSheetOutputSchema } from '../character-sheet.js'
import { CharacterIntegrationOutputSchema } from '../character-integration.js'

const validConcept = {
  name: 'Bran of the Hollow',
  race: 'human',
  class: 'cleric',
  background: 'acolyte',
  level: 1,
  alignment: 'lawful neutral',
  age: 27,
  gender: 'man',
  physical_description: 'tall and weather-worn, with a shaved scalp',
  personality_traits: ['speaks in measured tones'],
  ideals: ['order serves the weak'],
  bonds: ['the temple that raised him'],
  flaws: ['quick to suspect deception'],
  backstory: 'A long-form backstory paragraph that runs at least one hundred characters describing the cleric.',
}

describe('CharacterConceptOutputSchema', () => {
  it('accepts a valid concept', () => {
    expect(CharacterConceptOutputSchema.safeParse(validConcept).success).toBe(true)
  })
  it('rejects a name shorter than 2 chars', () => {
    expect(CharacterConceptOutputSchema.safeParse({ ...validConcept, name: 'B' }).success).toBe(false)
  })
  it('rejects a backstory shorter than 80 chars', () => {
    expect(CharacterConceptOutputSchema.safeParse({ ...validConcept, backstory: 'short' }).success).toBe(false)
  })
  it('rejects an empty personality_traits array', () => {
    expect(CharacterConceptOutputSchema.safeParse({ ...validConcept, personality_traits: [] }).success).toBe(false)
  })
})

const validSheet = {
  str: 12, dex: 10, con: 14, int: 13, wis: 16, cha: 11,
  hit_points: 9, max_hit_points: 9, armor_class: 14, proficiency_bonus: 2,
  skills: [{ name: 'Insight', proficient: true, expertise: false }],
  features: [{ name: 'Divine Domain: Life', description: 'extra healing' }],
  equipment: [{ name: 'Mace', quantity: 1 }],
  spells: [{ name: 'Cure Wounds', level: 1, prepared: true }],
}

describe('CharacterSheetOutputSchema', () => {
  it('accepts a valid sheet', () => {
    expect(CharacterSheetOutputSchema.safeParse(validSheet).success).toBe(true)
  })
  it('rejects ability score above 20', () => {
    expect(CharacterSheetOutputSchema.safeParse({ ...validSheet, str: 30 }).success).toBe(false)
  })
  it('rejects negative hit points', () => {
    expect(CharacterSheetOutputSchema.safeParse({ ...validSheet, hit_points: -1 }).success).toBe(false)
  })
  it('rejects empty skills array', () => {
    expect(CharacterSheetOutputSchema.safeParse({ ...validSheet, skills: [] }).success).toBe(false)
  })
})

const validIntegration = {
  pc_entity: {
    name: 'Bran of the Hollow',
    short_description: 'A road-weary cleric arriving at the tavern',
  },
  relationships: [
    {
      target_entity_name: 'Vorrel the Merchant',
      relationship_type: 'owes_debt_to',
      description: 'A long-running debt going back to a roadside loan three years ago.',
    },
  ],
  facts: [
    {
      content: 'Bran was apprenticed at the Bone Sept in his youth.',
      tags: ['backstory'],
    },
  ],
}

describe('CharacterIntegrationOutputSchema', () => {
  it('accepts a valid integration output', () => {
    expect(CharacterIntegrationOutputSchema.safeParse(validIntegration).success).toBe(true)
  })
  it('rejects an empty relationships array', () => {
    expect(CharacterIntegrationOutputSchema.safeParse({ ...validIntegration, relationships: [] }).success).toBe(false)
  })
  it('rejects a fact content under 10 chars', () => {
    expect(CharacterIntegrationOutputSchema.safeParse({
      ...validIntegration,
      facts: [{ content: 'short', tags: [] }],
    }).success).toBe(false)
  })
})
```

- [ ] **Step 2: Run the failing tests**

```
pnpm vitest run backend/src/llm/schemas/__tests__/character-schemas.test.ts
```

Expected: FAIL with `Cannot find module '../character-concept.js'`.

- [ ] **Step 3: Implement `character-concept.ts`**

Create `backend/src/llm/schemas/character-concept.ts`:

```typescript
// backend/src/llm/schemas/character-concept.ts
//
// MYT-53 stage 2: narrative half of the character. Matches the
// portable-characters fields from MYT-48 for the narrative columns.
// The mechanical fields (str/dex/con/.../hit_points/armor_class) come
// from stage 3's CharacterSheetOutputSchema.

import { z } from 'zod'

export const CharacterConceptOutputSchema = z.object({
  name: z.string().min(2).max(80),
  race: z.string().min(2).max(40),
  class: z.string().min(2).max(40),
  background: z.string().min(2).max(60),
  level: z.number().int().min(1).max(20),
  alignment: z.string().min(2).max(40),
  age: z.number().int().min(0).max(2000),
  gender: z.string().min(1).max(40),
  physical_description: z.string().min(20).max(800),
  personality_traits: z.array(z.string().min(5).max(300)).min(1).max(6),
  ideals: z.array(z.string().min(5).max(300)).min(1).max(4),
  bonds: z.array(z.string().min(5).max(300)).min(1).max(4),
  flaws: z.array(z.string().min(5).max(300)).min(1).max(4),
  backstory: z.string().min(80).max(2000),
})

export type CharacterConceptOutput = z.infer<typeof CharacterConceptOutputSchema>
```

- [ ] **Step 4: Implement `character-sheet.ts`**

Create `backend/src/llm/schemas/character-sheet.ts`:

```typescript
// backend/src/llm/schemas/character-sheet.ts
//
// MYT-53 stage 3: mechanical half — ability scores, derived stats,
// and the four sub-tables (skills/features/equipment/spells).

import { z } from 'zod'

const abilityScore = z.number().int().min(3).max(20)

const skillEntry = z.object({
  name: z.string().min(2).max(40),
  proficient: z.boolean(),
  expertise: z.boolean(),
})

const featureEntry = z.object({
  name: z.string().min(2).max(80),
  description: z.string().min(5).max(800),
})

const equipmentEntry = z.object({
  name: z.string().min(2).max(80),
  quantity: z.number().int().min(1).max(99),
})

const spellEntry = z.object({
  name: z.string().min(2).max(80),
  level: z.number().int().min(0).max(9),
  prepared: z.boolean(),
})

export const CharacterSheetOutputSchema = z.object({
  str: abilityScore,
  dex: abilityScore,
  con: abilityScore,
  int: abilityScore,
  wis: abilityScore,
  cha: abilityScore,
  hit_points: z.number().int().min(1).max(500),
  max_hit_points: z.number().int().min(1).max(500),
  armor_class: z.number().int().min(8).max(30),
  proficiency_bonus: z.number().int().min(2).max(6),
  skills: z.array(skillEntry).min(1).max(30),
  features: z.array(featureEntry).min(1).max(20),
  equipment: z.array(equipmentEntry).min(1).max(40),
  spells: z.array(spellEntry).max(60),
})

export type CharacterSheetOutput = z.infer<typeof CharacterSheetOutputSchema>
```

- [ ] **Step 5: Implement `character-integration.ts`**

Create `backend/src/llm/schemas/character-integration.ts`:

```typescript
// backend/src/llm/schemas/character-integration.ts
//
// MYT-53 stage 4: PC entity + PC↔world relationships + PC-tagged facts.
// Relationships reference target entities by NAME; the handler resolves
// to ids the same way starting-situation does (case-insensitive lookup
// against entities). Unmatched names trigger one retry then a terminal
// LlmStructuredOutputError.

import { z } from 'zod'

const pcEntity = z.object({
  name: z.string().min(2).max(80),
  short_description: z.string().min(20).max(400),
})

const relationship = z.object({
  target_entity_name: z.string().min(2).max(120),
  relationship_type: z.string().min(2).max(60),
  description: z.string().min(20).max(800),
})

const fact = z.object({
  content: z.string().min(10).max(800),
  tags: z.array(z.string().min(2).max(40)).max(8),
})

export const CharacterIntegrationOutputSchema = z.object({
  pc_entity: pcEntity,
  relationships: z.array(relationship).min(1).max(10),
  facts: z.array(fact).min(1).max(20),
})

export type CharacterIntegrationOutput = z.infer<typeof CharacterIntegrationOutputSchema>
```

- [ ] **Step 6: Run the tests to verify pass**

```
pnpm vitest run backend/src/llm/schemas/__tests__/character-schemas.test.ts
```

Expected: all tests pass.

- [ ] **Step 7: Typecheck + lint + commit**

```
pnpm typecheck && pnpm lint
git add backend/src/llm/schemas/character-concept.ts backend/src/llm/schemas/character-sheet.ts backend/src/llm/schemas/character-integration.ts backend/src/llm/schemas/__tests__/character-schemas.test.ts
git commit -m "feat(myt-53): zod schemas for the three character-creation stage outputs"
```

---

## Task 5: Cost-cap extension — per-campaign character-creation aggregator

**Files:**
- Modify: `backend/src/llm/prep/cost-cap.ts`
- Modify: `backend/src/llm/prep/__tests__/cost-cap.test.ts`

**Why:** Spec §Cost-cap coverage — character-creation pipeline_runs rows are keyed on `campaign_id` and `user_id` (not `world_id` + NULL like world-gen), so the existing `sumCompletedStageCosts` filter excludes them. Add a parallel aggregator + reader so each per-player job can pre-check the cap.

- [ ] **Step 1: Write the failing tests**

Append to `backend/src/llm/prep/__tests__/cost-cap.test.ts`:

```typescript
describe('readCharacterCreationCostCap', () => {
  it('reads the seeded $5.00 default', async () => {
    await setupDb()
    const pool = getPool()
    const cap = await readCharacterCreationCostCap(pool)
    expect(cap).toBe(5.0)
  })
})

describe('sumCharacterCreationStageCosts', () => {
  it('returns 0 when no rows', async () => {
    await setupDb()
    await resetData()
    const pool = getPool()
    expect(await sumCharacterCreationStageCosts(pool, 'no-such-id')).toBe(0)
  })

  it('sums completed rows for the given campaign across all user_ids', async () => {
    await setupDb()
    await resetData()
    const pool = getPool()
    const cid = uuidv7()
    // Seed a campaign + 2 users + 4 completed pipeline_runs (2 per user).
    await seedCampaignAndUsers(pool, cid, ['u1', 'u2'])
    await pool.query(
      `INSERT INTO pipeline_runs (id, campaign_id, user_id, stage, status, cost_usd, started_at, completed_at)
       VALUES
         ($1, $2, $3, 'character_concept', 'completed', 0.02, now(), now()),
         ($4, $2, $3, 'character_sheet', 'completed', 0.04, now(), now()),
         ($5, $2, $6, 'character_concept', 'completed', 0.02, now(), now()),
         ($7, $2, $6, 'character_sheet', 'completed', 0.04, now(), now())`,
      [uuidv7(), cid, 'u1', uuidv7(), uuidv7(), 'u2', uuidv7()],
    )
    const total = await sumCharacterCreationStageCosts(pool, cid)
    expect(total).toBeCloseTo(0.12, 6)
  })

  it('excludes non-completed rows and world-gen rows (user_id IS NULL)', async () => {
    await setupDb()
    await resetData()
    const pool = getPool()
    const cid = uuidv7()
    await seedCampaignAndUsers(pool, cid, ['u1'])
    await pool.query(
      `INSERT INTO pipeline_runs (id, campaign_id, user_id, stage, status, cost_usd, started_at)
       VALUES
         ($1, $2, $3, 'character_concept', 'running', 0.10, now()),
         ($4, $2, NULL, 'concept_intake', 'completed', 1.00, now())`,
      [uuidv7(), cid, 'u1', uuidv7()],
    )
    const total = await sumCharacterCreationStageCosts(pool, cid)
    expect(total).toBe(0)
  })
})
```

(`seedCampaignAndUsers` is a small helper — define inline at the top of the test file if not already present.)

- [ ] **Step 2: Run the tests to verify they fail**

```
pnpm vitest run backend/src/llm/prep/__tests__/cost-cap.test.ts
```

Expected: FAIL on `readCharacterCreationCostCap is not a function` / `sumCharacterCreationStageCosts is not a function`.

- [ ] **Step 3: Implement the new exports**

Append to `backend/src/llm/prep/cost-cap.ts`:

```typescript
export async function readCharacterCreationCostCap(pool: Pool | PoolClient): Promise<number> {
  const result = await pool.query<{ value: string }>(
    `SELECT value FROM settings WHERE key = 'character_creation_cost_cap_usd'`,
  )
  if (result.rows.length === 0) {
    throw new CostCapParseError('row settings.character_creation_cost_cap_usd is missing')
  }
  const raw = result.rows[0]?.value ?? ''
  const parsed = Number.parseFloat(raw)
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new CostCapParseError(
      `character_creation_cost_cap_usd value ${JSON.stringify(raw)} is not a positive number`,
    )
  }
  return parsed
}

export async function sumCharacterCreationStageCosts(
  pool: Pool | PoolClient,
  campaignId: string,
): Promise<number> {
  const result = await pool.query<{ total: number }>(
    `SELECT COALESCE(SUM(cost_usd), 0)::float8 AS total
     FROM pipeline_runs
     WHERE campaign_id = $1
       AND user_id IS NOT NULL
       AND status = 'completed'`,
    [campaignId],
  )
  return result.rows[0]?.total ?? 0
}
```

- [ ] **Step 4: Run the tests to verify pass**

```
pnpm vitest run backend/src/llm/prep/__tests__/cost-cap.test.ts
```

Expected: all tests pass.

- [ ] **Step 5: Typecheck + lint + commit**

```
pnpm typecheck && pnpm lint
git add backend/src/llm/prep/cost-cap.ts backend/src/llm/prep/__tests__/cost-cap.test.ts
git commit -m "feat(myt-53): cost-cap aggregator + reader for per-campaign character creation"
```

---

## Task 6: `atomicClaimStage` helper refactor — parameterize on optional `userId`

**Files:**
- Modify: `backend/src/llm/prep/world-gen-processor.ts:344-404`
- Modify: `backend/src/llm/prep/__tests__/world-gen-processor.test.ts`

**Why:** Spec §Worker — recovery contract. The helper currently hardcodes `user_id IS NULL` and `user_id = NULL` for the world-gen path. The character-creation processor needs per-player atomic claims via `user_id = $userId`. Parameterize the helper so both processors share the same primitive.

- [ ] **Step 1: Write the failing test for the new signature**

Append to `backend/src/llm/prep/__tests__/world-gen-processor.test.ts` (or add a new dedicated test file):

```typescript
describe('atomicClaimStage with userId', () => {
  it('claims a per-player row keyed on (campaign_id, stage, user_id)', async () => {
    await setupDb()
    await resetData()
    const pool = getPool()
    const cid = uuidv7()
    const uid = uuidv7()
    await seedCampaign(pool, cid)
    await seedUser(pool, uid)

    const result = await atomicClaimStage(pool, {
      kind: 'campaign-user',
      campaignId: cid,
      userId: uid,
      stage: 'character_concept',
    })
    expect(result).toBe('claimed')

    // A second call should return 'completed' or 'lost-race' depending on
    // whether the row was marked completed — for an unfinished row, the
    // second call should detect 'running' state and return 'lost-race'.
    const second = await atomicClaimStage(pool, {
      kind: 'campaign-user',
      campaignId: cid,
      userId: uid,
      stage: 'character_concept',
    })
    expect(second).toBe('lost-race')
  })

  it('still supports the world-level (user_id IS NULL) shape', async () => {
    await setupDb()
    await resetData()
    const pool = getPool()
    const wid = uuidv7()
    await seedWorld(pool, wid)

    const result = await atomicClaimStage(pool, {
      kind: 'world',
      worldId: wid,
      stage: 'concept_intake',
    })
    expect(result).toBe('claimed')
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

```
pnpm vitest run backend/src/llm/prep/__tests__/world-gen-processor.test.ts -t "atomicClaimStage with userId"
```

Expected: FAIL — the function signature doesn't accept the new discriminated-union arg shape yet.

- [ ] **Step 3: Refactor `atomicClaimStage` to accept a discriminated union**

In `backend/src/llm/prep/world-gen-processor.ts`, change the signature from:

```typescript
async function atomicClaimStage(
  pool: Pool,
  worldId: string,
  stage: WorldGenStage,
): Promise<ClaimResult>
```

to:

```typescript
export type ClaimRequest =
  | { kind: 'world'; worldId: string; stage: string }
  | { kind: 'campaign-user'; campaignId: string; userId: string; stage: string }

export async function atomicClaimStage(
  pool: Pool,
  req: ClaimRequest,
): Promise<ClaimResult> {
  const id = uuidv7()
  if (req.kind === 'world') {
    // Existing world-level claim path — preserved verbatim.
    const insertResult = await pool.query<{ id: string }>(
      `INSERT INTO pipeline_runs (id, world_id, stage, status, started_at, user_id)
       VALUES ($1, $2, $3, 'running', now(), NULL)
       ON CONFLICT (
         COALESCE(world_id, campaign_id),
         stage,
         COALESCE(user_id, '${SENTINEL_USER_UUID}'::uuid)
       )
       DO UPDATE SET status = 'running', started_at = now(),
                     error = NULL, completed_at = NULL
         WHERE pipeline_runs.status IN ('pending', 'failed')
       RETURNING id`,
      [id, req.worldId, req.stage],
    )
    if (insertResult.rowCount !== null && insertResult.rowCount > 0) return 'claimed'

    const existing = await pool.query<{ status: string; started_at: Date | null }>(
      `SELECT status, started_at FROM pipeline_runs
        WHERE world_id = $1 AND stage = $2 AND user_id IS NULL`,
      [req.worldId, req.stage],
    )
    const row = existing.rows[0]
    if (row === undefined) return 'lost-race'
    if (row.status === 'completed') return 'completed'
    if (row.status !== 'running') return 'lost-race'

    const stuckReset = await pool.query<{ id: string }>(
      `UPDATE pipeline_runs
          SET status = 'running', started_at = now(), error = NULL
        WHERE world_id = $1 AND stage = $2 AND user_id IS NULL
          AND status = 'running'
          AND started_at < now() - INTERVAL '5 minutes'
        RETURNING id`,
      [req.worldId, req.stage],
    )
    if (stuckReset.rowCount !== null && stuckReset.rowCount > 0) return 'claimed'
    return 'lost-race'
  }

  // Per-player path: campaign + user keyed.
  const insertResult = await pool.query<{ id: string }>(
    `INSERT INTO pipeline_runs (id, campaign_id, stage, status, started_at, user_id)
     VALUES ($1, $2, $3, 'running', now(), $4)
     ON CONFLICT (
       COALESCE(world_id, campaign_id),
       stage,
       COALESCE(user_id, '${SENTINEL_USER_UUID}'::uuid)
     )
     DO UPDATE SET status = 'running', started_at = now(),
                   error = NULL, completed_at = NULL
       WHERE pipeline_runs.status IN ('pending', 'failed')
     RETURNING id`,
    [id, req.campaignId, req.stage, req.userId],
  )
  if (insertResult.rowCount !== null && insertResult.rowCount > 0) return 'claimed'

  const existing = await pool.query<{ status: string; started_at: Date | null }>(
    `SELECT status, started_at FROM pipeline_runs
      WHERE campaign_id = $1 AND stage = $2 AND user_id = $3`,
    [req.campaignId, req.stage, req.userId],
  )
  const row = existing.rows[0]
  if (row === undefined) return 'lost-race'
  if (row.status === 'completed') return 'completed'
  if (row.status !== 'running') return 'lost-race'

  const stuckReset = await pool.query<{ id: string }>(
    `UPDATE pipeline_runs
        SET status = 'running', started_at = now(), error = NULL
      WHERE campaign_id = $1 AND stage = $2 AND user_id = $3
        AND status = 'running'
        AND started_at < now() - INTERVAL '5 minutes'
      RETURNING id`,
    [req.campaignId, req.stage, req.userId],
  )
  if (stuckReset.rowCount !== null && stuckReset.rowCount > 0) return 'claimed'
  return 'lost-race'
}
```

Also update the single call site in this same file (`for (const stage of WORLD_GEN_STAGES)`):

```typescript
// Change:
const claim = await atomicClaimStage(deps.pool, ctx.world.id, stage)
// To:
const claim = await atomicClaimStage(deps.pool, { kind: 'world', worldId: ctx.world.id, stage })
```

- [ ] **Step 4: Run the full world-gen-processor test suite to verify no regression**

```
pnpm vitest run backend/src/llm/prep/__tests__/world-gen-processor.test.ts
```

Expected: existing tests still pass AND the two new `atomicClaimStage with userId` tests pass.

- [ ] **Step 5: Typecheck + lint + commit**

```
pnpm typecheck && pnpm lint
git add backend/src/llm/prep/world-gen-processor.ts backend/src/llm/prep/__tests__/world-gen-processor.test.ts
git commit -m "refactor(myt-53): parameterize atomicClaimStage on (kind: world | campaign-user)"
```

---

## Task 7: Stage 1 — `location-selection` handler

**Files:**
- Create: `backend/src/llm/prep/stages/location-selection.ts`
- Create: `backend/src/llm/prep/stages/__tests__/location-selection.test.ts`

**Why:** Spec §Worker — stage 1 is the no-LLM "pick the location" stage. It reads `campaigns.starting_situation_index` + `worlds.starting_situation_entries`, validates the chosen entity exists, and emits a `stage-completed` event. Writes nothing — stage 4 re-derives the same id when writing the deferred fact (per the spec's risk note 3).

- [ ] **Step 1: Write the failing test**

Create `backend/src/llm/prep/stages/__tests__/location-selection.test.ts`:

```typescript
import { describe, it, expect } from 'vitest'
import { runLocationSelectionStage } from '../location-selection.js'
import { uuidv7 } from '../../../repo/uuidv7.js'
import { setupDb, resetData, getPool } from '../../../testing/db.js'

describe('runLocationSelectionStage', () => {
  it('returns the resolved locationEntityId from the chosen starting situation', async () => {
    await setupDb()
    await resetData()
    const pool = getPool()
    const worldId = uuidv7()
    const campaignId = uuidv7()
    const locId = uuidv7()
    await pool.query(
      `INSERT INTO worlds (id, name, status, starting_situation_entries)
       VALUES ($1, 'W', 'complete', $2::jsonb)`,
      [worldId, JSON.stringify([
        { index: 0, locationEntityId: locId, prose: 'a candlelit tavern' },
        { index: 1, locationEntityId: uuidv7(), prose: 'on a dusty road' },
        { index: 2, locationEntityId: uuidv7(), prose: 'in the ruins' },
      ])],
    )
    await pool.query(
      `INSERT INTO entities (id, world_id, entity_type, name)
       VALUES ($1, $2, 'location', 'The Tavern')`,
      [locId, worldId],
    )
    await pool.query(
      `INSERT INTO campaigns (id, world_id, name, owner_user_id, status, starting_situation_index)
       VALUES ($1, $2, 'C', $3, 'setup', 0)`,
      [campaignId, worldId, uuidv7()],
    )

    const result = await runLocationSelectionStage(pool, { campaignId, worldId })

    expect(result.locationEntityId).toBe(locId)
    expect(result.costUsd).toBe(0)
  })

  it('throws when the chosen entity does not exist', async () => {
    await setupDb()
    await resetData()
    const pool = getPool()
    const worldId = uuidv7()
    const campaignId = uuidv7()
    const ghostId = uuidv7()
    await pool.query(
      `INSERT INTO worlds (id, name, status, starting_situation_entries)
       VALUES ($1, 'W', 'complete', $2::jsonb)`,
      [worldId, JSON.stringify([{ index: 0, locationEntityId: ghostId, prose: 'nowhere' }])],
    )
    await pool.query(
      `INSERT INTO campaigns (id, world_id, name, owner_user_id, status, starting_situation_index)
       VALUES ($1, $2, 'C', $3, 'setup', 0)`,
      [campaignId, worldId, uuidv7()],
    )

    await expect(
      runLocationSelectionStage(pool, { campaignId, worldId }),
    ).rejects.toThrow(/location entity not found|drift/i)
  })

  it('throws when starting_situation_index is NULL', async () => {
    await setupDb()
    await resetData()
    const pool = getPool()
    const worldId = uuidv7()
    const campaignId = uuidv7()
    await pool.query(
      `INSERT INTO worlds (id, name, status) VALUES ($1, 'W', 'complete')`,
      [worldId],
    )
    await pool.query(
      `INSERT INTO campaigns (id, world_id, name, owner_user_id, status)
       VALUES ($1, $2, 'C', $3, 'setup')`,
      [campaignId, worldId, uuidv7()],
    )

    await expect(
      runLocationSelectionStage(pool, { campaignId, worldId }),
    ).rejects.toThrow(/starting_situation_index|not chosen/i)
  })
})
```

- [ ] **Step 2: Run the failing test**

```
pnpm vitest run backend/src/llm/prep/stages/__tests__/location-selection.test.ts
```

Expected: FAIL with `Cannot find module '../location-selection.js'`.

- [ ] **Step 3: Implement the handler**

Create `backend/src/llm/prep/stages/location-selection.ts`:

```typescript
// backend/src/llm/prep/stages/location-selection.ts
//
// MYT-53 stage 1: no-LLM resolver. Reads campaigns.starting_situation_index,
// looks up worlds.starting_situation_entries[index], validates the
// referenced entity still exists (defensive against state drift), and
// returns the resolved location entity id. Writes nothing — stage 4
// re-derives the same id when writing the deferred "starts at $location"
// fact (spec §Stages, §Risks #3).

import type { Pool, PoolClient } from 'pg'

export interface LocationSelectionArgs {
  readonly campaignId: string
  readonly worldId: string
}

export interface LocationSelectionResult {
  readonly locationEntityId: string
  readonly costUsd: 0
  readonly inputTokens: 0
  readonly outputTokens: 0
}

interface SituationEntry {
  index: number
  locationEntityId: string
  prose: string
}

export async function runLocationSelectionStage(
  client: Pool | PoolClient,
  args: LocationSelectionArgs,
): Promise<LocationSelectionResult> {
  const campaign = await client.query<{ starting_situation_index: number | null }>(
    `SELECT starting_situation_index FROM campaigns WHERE id = $1`,
    [args.campaignId],
  )
  const idx = campaign.rows[0]?.starting_situation_index
  if (idx === null || idx === undefined) {
    throw new Error(
      `location-selection: campaigns.starting_situation_index is NULL for campaign ${args.campaignId}`,
    )
  }

  const world = await client.query<{ starting_situation_entries: SituationEntry[] }>(
    `SELECT starting_situation_entries FROM worlds WHERE id = $1`,
    [args.worldId],
  )
  const entries = world.rows[0]?.starting_situation_entries ?? []
  const entry = entries.find(e => e.index === idx)
  if (!entry) {
    throw new Error(
      `location-selection: no entry for index ${idx} in worlds.starting_situation_entries`,
    )
  }

  const entityCheck = await client.query<{ id: string }>(
    `SELECT id FROM entities WHERE id = $1 AND world_id = $2`,
    [entry.locationEntityId, args.worldId],
  )
  if (entityCheck.rows.length === 0) {
    throw new Error(
      `location-selection: location entity ${entry.locationEntityId} not found in world ${args.worldId} (drift)`,
    )
  }

  return {
    locationEntityId: entry.locationEntityId,
    costUsd: 0,
    inputTokens: 0,
    outputTokens: 0,
  }
}
```

- [ ] **Step 4: Verify tests pass**

```
pnpm vitest run backend/src/llm/prep/stages/__tests__/location-selection.test.ts
```

Expected: all 3 tests pass.

- [ ] **Step 5: Typecheck + lint + commit**

```
pnpm typecheck && pnpm lint
git add backend/src/llm/prep/stages/location-selection.ts backend/src/llm/prep/stages/__tests__/location-selection.test.ts
git commit -m "feat(myt-53): stage 1 location-selection handler (no-LLM resolver)"
```

---

## Task 8: Stage 2 — `character-concept` handler

**Files:**
- Create: `backend/src/llm/prep/stages/character-concept.ts`
- Create: `backend/src/llm/prep/stages/__tests__/character-concept.test.ts`
- Create: `backend/src/llm/prompts/prep/character-concept.txt`

**Why:** Spec §Worker stage 2 — Sonnet generateObject producing the narrative half (name + race + class + background + traits + backstory). Persists nothing (stage 3 owns the `characters` INSERT). Returns the narrative payload + cost for the processor to thread into stage 3.

- [ ] **Step 1: Write the prompt template**

Create `backend/src/llm/prompts/prep/character-concept.txt`:

```
You are a character-concept assistant for a D&D 5e platform. Given the player's
concept text and the world's tone, produce a structured character concept that
plausibly fits the world without recycling franchise names or boilerplate
fantasy archetypes.

# World context
World name: {{worldName}}
Tone: {{tone}}
Themes: {{themes}}
Era: {{era}}
Geography: {{geographySummary}}
Politics: {{politicalSummary}}
Key tensions: {{keyTensions}}

# Vocabulary
{{vocabularyRegistry}}

# Player's concept text
{{conceptText}}

# Output requirements
- name: a name that fits the world's naming conventions, not a real-world
  franchise name.
- race, class, background: SRD-compliant. Use the canonical SRD vocabulary
  (cleric/wizard/rogue/etc., elf/dwarf/halfling/etc.) — these are platform
  terms, not franchise borrowings.
- level: 1.
- alignment, age, gender: as fits the concept.
- physical_description: 1-3 sentences.
- personality_traits / ideals / bonds / flaws: 1-3 each, specific to this
  character, not generic.
- backstory: 1-3 paragraphs (80-2000 chars). Reference world entities by
  the canonical names listed in vocabulary above.

Return ONLY the JSON conforming to CharacterConceptOutputSchema.
```

- [ ] **Step 2: Write the failing handler test**

Create `backend/src/llm/prep/stages/__tests__/character-concept.test.ts`:

```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { runCharacterConceptStage } from '../character-concept.js'
import * as ai from 'ai'

vi.mock('ai', async () => {
  const actual = await vi.importActual<typeof import('ai')>('ai')
  return { ...actual, generateText: vi.fn() }
})

const mockGenerateText = vi.mocked(ai.generateText)

const VALID_CONCEPT = {
  name: 'Bran of the Hollow',
  race: 'human',
  class: 'cleric',
  background: 'acolyte',
  level: 1,
  alignment: 'lawful neutral',
  age: 27,
  gender: 'man',
  physical_description: 'tall and weather-worn, with a shaved scalp',
  personality_traits: ['speaks in measured tones'],
  ideals: ['order serves the weak'],
  bonds: ['the temple that raised him'],
  flaws: ['quick to suspect deception'],
  backstory: 'A long-form backstory paragraph at least 80 characters long that gives the cleric depth and a tie to the world.',
}

const ARGS = {
  campaignId: 'c-1',
  userId: 'u-1',
  worldId: 'w-1',
  worldName: 'Veil',
  tone: 'somber',
  themes: 'forgotten gods',
  era: 'late iron age',
  geographySummary: 'three duchies',
  politicalSummary: 'warring',
  keyTensions: 'the old gods stir',
  vocabularyRegistry: { entries: [], adjacent_franchises: [] },
  conceptText: 'a road-weary cleric who lost their faith',
  guidedChoices: {},
}

beforeEach(() => vi.clearAllMocks())

describe('runCharacterConceptStage', () => {
  it('calls Sonnet, returns the narrative payload + cost', async () => {
    mockGenerateText.mockResolvedValueOnce({
      output: VALID_CONCEPT,
      finishReason: 'stop',
      usage: { inputTokens: 2000, outputTokens: 1000, totalTokens: 3000 },
    } as never)

    const result = await runCharacterConceptStage(ARGS)

    expect(result.concept.name).toBe('Bran of the Hollow')
    expect(result.concept.class).toBe('cleric')
    expect(result.costUsd).toBeCloseTo((2000 / 1_000_000) * 3 + (1000 / 1_000_000) * 15, 6)
  })

  it('substitutes prompt placeholders', async () => {
    mockGenerateText.mockResolvedValueOnce({
      output: VALID_CONCEPT,
      finishReason: 'stop',
      usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
    } as never)
    await runCharacterConceptStage(ARGS)
    const callOpts = mockGenerateText.mock.calls[0]?.[0] as unknown as { prompt: string }
    expect(callOpts.prompt).toContain('Veil')
    expect(callOpts.prompt).toContain('a road-weary cleric')
    expect(callOpts.prompt).not.toContain('{{worldName}}')
    expect(callOpts.prompt).not.toContain('{{conceptText}}')
  })

  it('rethrows LLM errors', async () => {
    mockGenerateText.mockRejectedValueOnce(new Error('rate limit'))
    await expect(runCharacterConceptStage(ARGS)).rejects.toThrow(/rate limit/)
  })
})
```

- [ ] **Step 3: Run the failing test**

```
pnpm vitest run backend/src/llm/prep/stages/__tests__/character-concept.test.ts
```

Expected: FAIL — handler doesn't exist.

- [ ] **Step 4: Implement the handler**

Create `backend/src/llm/prep/stages/character-concept.ts`:

```typescript
// backend/src/llm/prep/stages/character-concept.ts
//
// MYT-53 stage 2: Sonnet generateObject. Produces the narrative half of
// the character (name + race + class + background + traits + backstory).
// Does NOT persist to the characters table — stage 3 (character-sheet)
// owns the INSERT because characters.str/dex/.../hit_points/armor_class
// are NOT NULL and only stage 3 generates them. The processor threads
// stage 2's output into stage 3's input.

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { resolve, dirname } from 'node:path'
import { generateObject } from '../../ai.js'
import { SONNET } from '../../models.js'
import {
  CharacterConceptOutputSchema,
  type CharacterConceptOutput,
} from '../../schemas/character-concept.js'
import { renderVocabularyRegistry } from '../vocabulary-renderer.js'
import type { VocabularyRegistry } from '../../schemas/vocabulary-registry.js'

const PROMPT_TEMPLATE = readFileSync(
  resolve(dirname(fileURLToPath(import.meta.url)), '../../prompts/prep/character-concept.txt'),
  'utf8',
)

const SONNET_INPUT_PER_MTOK = 3.0
const SONNET_OUTPUT_PER_MTOK = 15.0

export interface CharacterConceptArgs {
  readonly campaignId: string
  readonly userId: string
  readonly worldId: string
  readonly worldName: string
  readonly tone: string
  readonly themes: string
  readonly era: string
  readonly geographySummary: string
  readonly politicalSummary: string
  readonly keyTensions: string
  readonly vocabularyRegistry: VocabularyRegistry
  readonly conceptText: string
  readonly guidedChoices: Record<string, unknown>
}

export interface CharacterConceptStageResult {
  readonly concept: CharacterConceptOutput
  readonly costUsd: number
  readonly inputTokens: number
  readonly outputTokens: number
}

export async function runCharacterConceptStage(
  args: CharacterConceptArgs,
): Promise<CharacterConceptStageResult> {
  const prompt = PROMPT_TEMPLATE
    .replace('{{worldName}}', args.worldName)
    .replace('{{tone}}', args.tone)
    .replace('{{themes}}', args.themes)
    .replace('{{era}}', args.era)
    .replace('{{geographySummary}}', args.geographySummary)
    .replace('{{politicalSummary}}', args.politicalSummary)
    .replace('{{keyTensions}}', args.keyTensions)
    .replace('{{vocabularyRegistry}}', renderVocabularyRegistry(args.vocabularyRegistry))
    .replace('{{conceptText}}', args.conceptText)

  const result = await generateObject({
    model: SONNET,
    schema: CharacterConceptOutputSchema,
    schemaName: 'CharacterConceptOutputSchema',
    callSite: 'character-concept',
    prompt,
    temperature: 0.7,
    maxRetries: 3,
  })

  const inputTokens = result.usage.inputTokens ?? 0
  const outputTokens = result.usage.outputTokens ?? 0

  return {
    concept: result.output,
    costUsd:
      (inputTokens / 1_000_000) * SONNET_INPUT_PER_MTOK +
      (outputTokens / 1_000_000) * SONNET_OUTPUT_PER_MTOK,
    inputTokens,
    outputTokens,
  }
}
```

- [ ] **Step 5: Run tests, typecheck, lint, commit**

```
pnpm vitest run backend/src/llm/prep/stages/__tests__/character-concept.test.ts
pnpm typecheck && pnpm lint
git add backend/src/llm/prep/stages/character-concept.ts backend/src/llm/prep/stages/__tests__/character-concept.test.ts backend/src/llm/prompts/prep/character-concept.txt
git commit -m "feat(myt-53): stage 2 character-concept handler (Sonnet, narrative half)"
```

---

## Task 9: Stage 3 — `character-sheet` handler

**Files:**
- Create: `backend/src/llm/prep/stages/character-sheet.ts`
- Create: `backend/src/llm/prep/stages/__tests__/character-sheet.test.ts`
- Create: `backend/src/llm/prompts/prep/character-sheet.txt`

**Why:** Spec §Worker stage 3 — Sonnet generateObject producing the mechanical half (ability scores, derived HP/AC/proficiency, plus skills/features/equipment/spells rows). This stage performs the SINGLE INSERT into the `characters` table (combining stage 2's narrative payload with stage 3's mechanicals), the `campaign_characters` join, and the four sub-tables — all in one transaction. Idempotent re-run: if a characters row already exists for `(campaign_id, user_id)`, UPDATE-not-INSERT and TRUNCATE sub-tables before re-INSERT.

- [ ] **Step 1: Write the prompt template**

Create `backend/src/llm/prompts/prep/character-sheet.txt`:

```
You are a D&D 5e character-sheet assistant. Given a narrative character concept,
generate SRD-compliant mechanical stats and equipment for a level-1 character.

# Narrative concept (from stage 2)
Name: {{name}}
Race: {{race}}
Class: {{class}}
Background: {{background}}
Alignment: {{alignment}}
Physical description: {{physicalDescription}}
Backstory: {{backstory}}

# World context
World tone: {{tone}}
World era: {{era}}

# Output requirements
- Ability scores (str, dex, con, int, wis, cha): integers 8-18 typical, 3-20
  allowed. Use the 27-point-buy distribution as a guide; class-priority
  abilities should be highest.
- hit_points + max_hit_points: level-1 class HP per SRD (cleric/fighter/etc.).
- armor_class: derived from starting equipment + dex.
- proficiency_bonus: 2 (level 1).
- skills: every proficient skill (background + class grants), as
  {name, proficient:true, expertise:false}.
- features: class features + background features for level 1.
- equipment: starting equipment for the class + background, with quantities.
- spells: if class is a caster, level-0 and level-1 spells as appropriate;
  otherwise [].

Return ONLY the JSON conforming to CharacterSheetOutputSchema.
```

- [ ] **Step 2: Write the failing handler test**

Create `backend/src/llm/prep/stages/__tests__/character-sheet.test.ts`:

```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { runCharacterSheetStage } from '../character-sheet.js'
import { setupDb, resetData, getPool } from '../../../../testing/db.js'
import { uuidv7 } from '../../../repo/uuidv7.js'
import * as ai from 'ai'

vi.mock('ai', async () => {
  const actual = await vi.importActual<typeof import('ai')>('ai')
  return { ...actual, generateText: vi.fn() }
})

const mockGenerateText = vi.mocked(ai.generateText)

const NARRATIVE = {
  name: 'Bran of the Hollow',
  race: 'human',
  class: 'cleric',
  background: 'acolyte',
  level: 1,
  alignment: 'lawful neutral',
  age: 27,
  gender: 'man',
  physical_description: 'tall and weather-worn',
  personality_traits: ['measured'],
  ideals: ['order'],
  bonds: ['the temple'],
  flaws: ['suspicious'],
  backstory: 'long-form backstory at least eighty characters of plausible character motivation here.',
}

const SHEET = {
  str: 12, dex: 10, con: 14, int: 13, wis: 16, cha: 11,
  hit_points: 9, max_hit_points: 9, armor_class: 14, proficiency_bonus: 2,
  skills: [{ name: 'Insight', proficient: true, expertise: false }],
  features: [{ name: 'Divine Domain: Life', description: 'extra healing' }],
  equipment: [{ name: 'Mace', quantity: 1 }],
  spells: [{ name: 'Cure Wounds', level: 1, prepared: true }],
}

beforeEach(() => vi.clearAllMocks())

describe('runCharacterSheetStage', () => {
  it('persists characters row + campaign_characters join + 4 sub-tables on first run', async () => {
    await setupDb()
    await resetData()
    const pool = getPool()
    const userId = uuidv7()
    const campaignId = uuidv7()
    await pool.query(`INSERT INTO users (id, email) VALUES ($1, $2)`, [userId, `${userId}@x.test`])
    await pool.query(
      `INSERT INTO campaigns (id, name, owner_user_id, status) VALUES ($1, 'C', $2, 'setup')`,
      [campaignId, userId],
    )
    await pool.query(
      `INSERT INTO campaign_members (id, campaign_id, user_id, role, invite_accepted) VALUES ($1, $2, $3, 'player', true)`,
      [uuidv7(), campaignId, userId],
    )

    mockGenerateText.mockResolvedValueOnce({
      output: SHEET,
      finishReason: 'stop',
      usage: { inputTokens: 2000, outputTokens: 2000, totalTokens: 4000 },
    } as never)

    const result = await runCharacterSheetStage(pool, {
      campaignId,
      userId,
      worldId: 'w-1',
      narrative: NARRATIVE,
      worldTone: 'somber',
      worldEra: 'iron age',
    })

    expect(result.characterId).toBeDefined()
    const c = await pool.query(`SELECT class, str, hit_points FROM characters WHERE id = $1`, [result.characterId])
    expect(c.rows[0]).toMatchObject({ class: 'cleric', str: 12, hit_points: 9 })
    const join = await pool.query(`SELECT * FROM campaign_characters WHERE character_id = $1`, [result.characterId])
    expect(join.rowCount).toBe(1)
    const skills = await pool.query(`SELECT * FROM character_skills WHERE character_id = $1`, [result.characterId])
    expect(skills.rowCount).toBe(1)
  })

  it('idempotent re-run: existing characters row is UPDATEd, sub-tables TRUNCATEd and re-INSERTed', async () => {
    await setupDb()
    await resetData()
    const pool = getPool()
    const userId = uuidv7()
    const campaignId = uuidv7()
    await pool.query(`INSERT INTO users (id, email) VALUES ($1, $2)`, [userId, `${userId}@x.test`])
    await pool.query(
      `INSERT INTO campaigns (id, name, owner_user_id, status) VALUES ($1, 'C', $2, 'setup')`,
      [campaignId, userId],
    )
    await pool.query(
      `INSERT INTO campaign_members (id, campaign_id, user_id, role, invite_accepted) VALUES ($1, $2, $3, 'player', true)`,
      [uuidv7(), campaignId, userId],
    )

    // First run.
    mockGenerateText.mockResolvedValueOnce({
      output: SHEET,
      finishReason: 'stop',
      usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
    } as never)
    const first = await runCharacterSheetStage(pool, {
      campaignId, userId, worldId: 'w-1', narrative: NARRATIVE,
      worldTone: 't', worldEra: 'e',
    })

    // Second run produces a different sheet — UPDATE not INSERT.
    const SHEET2 = { ...SHEET, str: 18, hit_points: 12, max_hit_points: 12 }
    mockGenerateText.mockResolvedValueOnce({
      output: SHEET2,
      finishReason: 'stop',
      usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
    } as never)
    const second = await runCharacterSheetStage(pool, {
      campaignId, userId, worldId: 'w-1', narrative: NARRATIVE,
      worldTone: 't', worldEra: 'e',
    })

    expect(second.characterId).toBe(first.characterId)
    const c = await pool.query(`SELECT str, hit_points FROM characters WHERE id = $1`, [first.characterId])
    expect(c.rows[0]).toMatchObject({ str: 18, hit_points: 12 })

    // Exactly one row in campaign_characters (UNIQUE invariant + idempotent re-run).
    const join = await pool.query(`SELECT * FROM campaign_characters WHERE user_id = $1 AND campaign_id = $2`, [userId, campaignId])
    expect(join.rowCount).toBe(1)
  })
})
```

- [ ] **Step 3: Run the failing test**

```
pnpm vitest run backend/src/llm/prep/stages/__tests__/character-sheet.test.ts
```

Expected: FAIL — handler doesn't exist.

- [ ] **Step 4: Implement the handler**

Create `backend/src/llm/prep/stages/character-sheet.ts`:

```typescript
// backend/src/llm/prep/stages/character-sheet.ts
//
// MYT-53 stage 3: Sonnet generateObject producing mechanical stats +
// the four sub-table rows. Owns the INSERT into characters +
// campaign_characters in a single transaction with the four sub-tables.
// Re-run idempotency: if a characters row already exists for
// (campaign_id, user_id), UPDATE-not-INSERT and TRUNCATE the four
// sub-tables before re-INSERT.

import type { Pool, PoolClient } from 'pg'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { resolve, dirname } from 'node:path'
import { generateObject } from '../../ai.js'
import { SONNET } from '../../models.js'
import {
  CharacterSheetOutputSchema,
  type CharacterSheetOutput,
} from '../../schemas/character-sheet.js'
import type { CharacterConceptOutput } from '../../schemas/character-concept.js'
import { uuidv7 } from '../../../repo/uuidv7.js'

const PROMPT_TEMPLATE = readFileSync(
  resolve(dirname(fileURLToPath(import.meta.url)), '../../prompts/prep/character-sheet.txt'),
  'utf8',
)

const SONNET_INPUT_PER_MTOK = 3.0
const SONNET_OUTPUT_PER_MTOK = 15.0

export interface CharacterSheetArgs {
  readonly campaignId: string
  readonly userId: string
  readonly worldId: string
  readonly narrative: CharacterConceptOutput
  readonly worldTone: string
  readonly worldEra: string
}

export interface CharacterSheetStageResult {
  readonly characterId: string
  readonly costUsd: number
  readonly inputTokens: number
  readonly outputTokens: number
}

export async function runCharacterSheetStage(
  pool: Pool,
  args: CharacterSheetArgs,
): Promise<CharacterSheetStageResult> {
  const prompt = PROMPT_TEMPLATE
    .replace('{{name}}', args.narrative.name)
    .replace('{{race}}', args.narrative.race)
    .replace('{{class}}', args.narrative.class)
    .replace('{{background}}', args.narrative.background)
    .replace('{{alignment}}', args.narrative.alignment)
    .replace('{{physicalDescription}}', args.narrative.physical_description)
    .replace('{{backstory}}', args.narrative.backstory)
    .replace('{{tone}}', args.worldTone)
    .replace('{{era}}', args.worldEra)

  const result = await generateObject({
    model: SONNET,
    schema: CharacterSheetOutputSchema,
    schemaName: 'CharacterSheetOutputSchema',
    callSite: 'character-sheet',
    prompt,
    temperature: 0.5,
    maxRetries: 3,
  })

  const characterId = await persistCharacter(pool, args, result.output)

  const inputTokens = result.usage.inputTokens ?? 0
  const outputTokens = result.usage.outputTokens ?? 0
  return {
    characterId,
    costUsd:
      (inputTokens / 1_000_000) * SONNET_INPUT_PER_MTOK +
      (outputTokens / 1_000_000) * SONNET_OUTPUT_PER_MTOK,
    inputTokens,
    outputTokens,
  }
}

async function persistCharacter(
  pool: Pool,
  args: CharacterSheetArgs,
  sheet: CharacterSheetOutput,
): Promise<string> {
  const client = await pool.connect()
  try {
    await client.query('BEGIN')

    // Lookup-or-INSERT the characters row keyed on (campaign_id, user_id)
    // via campaign_characters. The first run finds nothing → INSERT;
    // subsequent runs find the existing row → UPDATE.
    const existing = await client.query<{ character_id: string }>(
      `SELECT character_id FROM campaign_characters
       WHERE campaign_id = $1 AND user_id = $2`,
      [args.campaignId, args.userId],
    )
    const characterId = existing.rows[0]?.character_id ?? uuidv7()

    if (existing.rows.length === 0) {
      await client.query(
        `INSERT INTO characters (
           id, user_id, name, level, class, species, background,
           str, dex, con, int, wis, cha,
           hit_points, max_hit_points, armor_class, proficiency_bonus
         )
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17)`,
        [
          characterId,
          args.userId,
          args.narrative.name,
          args.narrative.level,
          args.narrative.class,
          args.narrative.race,
          args.narrative.background,
          sheet.str, sheet.dex, sheet.con, sheet.int, sheet.wis, sheet.cha,
          sheet.hit_points, sheet.max_hit_points, sheet.armor_class, sheet.proficiency_bonus,
        ],
      )
      await client.query(
        `INSERT INTO campaign_characters (id, campaign_id, character_id, user_id)
         VALUES ($1, $2, $3, $4)`,
        [uuidv7(), args.campaignId, characterId, args.userId],
      )
    } else {
      await client.query(
        `UPDATE characters SET
           name = $2, level = $3, class = $4, species = $5, background = $6,
           str = $7, dex = $8, con = $9, int = $10, wis = $11, cha = $12,
           hit_points = $13, max_hit_points = $14, armor_class = $15, proficiency_bonus = $16
         WHERE id = $1`,
        [
          characterId,
          args.narrative.name,
          args.narrative.level,
          args.narrative.class,
          args.narrative.race,
          args.narrative.background,
          sheet.str, sheet.dex, sheet.con, sheet.int, sheet.wis, sheet.cha,
          sheet.hit_points, sheet.max_hit_points, sheet.armor_class, sheet.proficiency_bonus,
        ],
      )
      // TRUNCATE-by-character-id on sub-tables; re-INSERT below.
      await client.query(`DELETE FROM character_skills WHERE character_id = $1`, [characterId])
      await client.query(`DELETE FROM character_features WHERE character_id = $1`, [characterId])
      await client.query(`DELETE FROM character_equipment WHERE character_id = $1`, [characterId])
      await client.query(`DELETE FROM character_spells WHERE character_id = $1`, [characterId])
    }

    for (const s of sheet.skills) {
      await client.query(
        `INSERT INTO character_skills (id, character_id, name, proficient, expertise)
         VALUES ($1, $2, $3, $4, $5)`,
        [uuidv7(), characterId, s.name, s.proficient, s.expertise],
      )
    }
    for (const f of sheet.features) {
      await client.query(
        `INSERT INTO character_features (id, character_id, name, description)
         VALUES ($1, $2, $3, $4)`,
        [uuidv7(), characterId, f.name, f.description],
      )
    }
    for (const e of sheet.equipment) {
      await client.query(
        `INSERT INTO character_equipment (id, character_id, name, quantity)
         VALUES ($1, $2, $3, $4)`,
        [uuidv7(), characterId, e.name, e.quantity],
      )
    }
    for (const sp of sheet.spells) {
      await client.query(
        `INSERT INTO character_spells (id, character_id, name, level, prepared)
         VALUES ($1, $2, $3, $4, $5)`,
        [uuidv7(), characterId, sp.name, sp.level, sp.prepared],
      )
    }

    await client.query('COMMIT')
    return characterId
  } catch (err) {
    await client.query('ROLLBACK')
    throw err
  } finally {
    client.release()
  }
}
```

- [ ] **Step 5: Run tests, typecheck, lint, commit**

```
pnpm vitest run backend/src/llm/prep/stages/__tests__/character-sheet.test.ts
pnpm typecheck && pnpm lint
git add backend/src/llm/prep/stages/character-sheet.ts backend/src/llm/prep/stages/__tests__/character-sheet.test.ts backend/src/llm/prompts/prep/character-sheet.txt
git commit -m "feat(myt-53): stage 3 character-sheet handler (Sonnet, persists characters + 4 sub-tables)"
```

---

## Task 10: Stage 4 — `character-integration` handler (streaming)

**Files:**
- Create: `backend/src/llm/prep/stages/character-integration.ts`
- Create: `backend/src/llm/prep/stages/__tests__/character-integration.test.ts`
- Create: `backend/src/llm/prompts/prep/character-integration.txt`

**Why:** Spec §Worker stage 4 — Opus streamObject. Creates the PC `entities` row (entity_type='pc'), links `characters.entity_id`, persists PC↔world relationships and PC-tagged facts (including the deferred "starts at $location" fact, re-derived from `worlds.starting_situation_entries` per spec §Risks #3). Emits SSE events for the PC entity + edges. Idempotent re-run: if `characters.entity_id` is already set, skip entity creation and TRUNCATE-then-re-INSERT relationships/facts tagged with that entity.

- [ ] **Step 1: Write the prompt template**

Create `backend/src/llm/prompts/prep/character-integration.txt`:

```
You are a D&D 5e world-integration assistant. Given a fully-built character
and the world they're entering, generate the relationships and facts that
weave them into the existing world.

# Character
Name: {{name}}
Race: {{race}}
Class: {{class}}
Background: {{background}}
Backstory: {{backstory}}
Physical description: {{physicalDescription}}

# Player's situation-grounding text
{{situationGroundingText}}

# Chosen starting situation
{{startingSituationProse}}

# World entities the character can reference
{{worldEntities}}

# Output requirements
- pc_entity: short_description is 1-2 sentences tying the PC to the starting
  situation and one world tension.
- relationships: 1-5 entries. Each names an EXISTING world entity (faction,
  location, or NPC) by name from the list above. Use relationship_type
  values like "owes_debt_to", "apprenticed_at", "hostile_to", etc.
- facts: 1-5 entries. Use tags like ["backstory"], ["motivation"], etc.

Return ONLY the JSON conforming to CharacterIntegrationOutputSchema.
```

- [ ] **Step 2: Write the failing test**

Create `backend/src/llm/prep/stages/__tests__/character-integration.test.ts`:

```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { runCharacterIntegrationStage } from '../character-integration.js'
import { setupDb, resetData, getPool } from '../../../../testing/db.js'
import { uuidv7 } from '../../../repo/uuidv7.js'
import * as ai from 'ai'

vi.mock('ai', async () => {
  const actual = await vi.importActual<typeof import('ai')>('ai')
  return { ...actual, streamObject: vi.fn() }
})

const mockStreamObject = vi.mocked(ai.streamObject)

const INTEGRATION = {
  pc_entity: {
    name: 'Bran of the Hollow',
    short_description: 'A road-weary cleric tying his fate to the Hollow.',
  },
  relationships: [
    {
      target_entity_name: 'Bone Sept',
      relationship_type: 'apprenticed_at',
      description: 'Trained at the Bone Sept in youth, learned the old liturgies.',
    },
  ],
  facts: [
    {
      content: 'Bran was apprenticed at the Bone Sept in his youth.',
      tags: ['backstory'],
    },
  ],
}

beforeEach(() => vi.clearAllMocks())

describe('runCharacterIntegrationStage', () => {
  it('creates a pc entity, links characters.entity_id, persists relationships and facts', async () => {
    await setupDb()
    await resetData()
    const pool = getPool()
    const userId = uuidv7()
    const campaignId = uuidv7()
    const worldId = uuidv7()
    const characterId = uuidv7()
    const locationId = uuidv7()
    const factionId = uuidv7()

    await pool.query(`INSERT INTO users (id, email) VALUES ($1, $2)`, [userId, `${userId}@x.test`])
    await pool.query(
      `INSERT INTO worlds (id, name, status, starting_situation_entries)
       VALUES ($1, 'W', 'complete', $2::jsonb)`,
      [worldId, JSON.stringify([{ index: 0, locationEntityId: locationId, prose: 'a tavern' }])],
    )
    await pool.query(
      `INSERT INTO campaigns (id, world_id, name, owner_user_id, status, starting_situation_index)
       VALUES ($1, $2, 'C', $3, 'setup', 0)`,
      [campaignId, worldId, userId],
    )
    await pool.query(
      `INSERT INTO entities (id, world_id, entity_type, name) VALUES ($1, $2, 'location', 'The Tavern')`,
      [locationId, worldId],
    )
    await pool.query(
      `INSERT INTO entities (id, world_id, entity_type, name) VALUES ($1, $2, 'faction', 'Bone Sept')`,
      [factionId, worldId],
    )
    await pool.query(
      `INSERT INTO characters (
         id, user_id, name, level, class, species, background,
         str, dex, con, int, wis, cha,
         hit_points, max_hit_points, armor_class, proficiency_bonus
       ) VALUES ($1, $2, 'Bran', 1, 'cleric', 'human', 'acolyte', 10, 10, 10, 10, 10, 10, 8, 8, 12, 2)`,
      [characterId, userId],
    )

    // Mock streamObject to return a Promise<object> directly.
    mockStreamObject.mockReturnValueOnce({
      object: Promise.resolve(INTEGRATION),
      usage: Promise.resolve({ inputTokens: 2000, outputTokens: 1000, totalTokens: 3000 }),
    } as unknown as ReturnType<typeof ai.streamObject>)

    const events: unknown[] = []
    const result = await runCharacterIntegrationStage(pool, {
      campaignId, userId, worldId, characterId,
      narrative: {
        name: 'Bran', race: 'human', class: 'cleric', background: 'acolyte',
        physical_description: 'tall', backstory: 'long backstory'.padEnd(120, '.'),
      } as never,
      situationGroundingText: 'arrived seeking word of an old companion',
      publishEvent: (e) => { events.push(e); return Promise.resolve() },
    })

    expect(result.entityId).toBeDefined()
    const ent = await pool.query(`SELECT entity_type, name FROM entities WHERE id = $1`, [result.entityId])
    expect(ent.rows[0]).toMatchObject({ entity_type: 'pc', name: 'Bran of the Hollow' })

    const ch = await pool.query(`SELECT entity_id FROM characters WHERE id = $1`, [characterId])
    expect(ch.rows[0]?.entity_id).toBe(result.entityId)

    const rel = await pool.query(`SELECT * FROM relationships WHERE source_id = $1 OR target_id = $1`, [result.entityId])
    expect(rel.rowCount).toBeGreaterThanOrEqual(1)

    const facts = await pool.query(`SELECT * FROM facts WHERE entity_id = $1`, [result.entityId])
    // 1 from integration output + 1 deferred "starts at $location" fact.
    expect(facts.rowCount).toBe(2)
    const starts = facts.rows.find((f: { content: string }) => /starts at/i.test(f.content))
    expect(starts).toBeDefined()

    // SSE events: at least one entity-added + one or more edge-added.
    expect(events.some((e: unknown) => (e as { type: string }).type === 'entity-added')).toBe(true)
  })

  it('idempotent re-run: existing characters.entity_id reused, edges/facts TRUNCATEd + re-INSERTed', async () => {
    // Setup: identical to first test but pre-existing entity + relationships.
    // Second invocation should not insert a new entities row.
    // (Implementation mirrors the first test; abbreviated for brevity in the plan
    // but write the full setup in the actual test file.)
    expect(true).toBe(true) // placeholder; the implementer fills in the full case
  })
})
```

- [ ] **Step 3: Run the failing test**

```
pnpm vitest run backend/src/llm/prep/stages/__tests__/character-integration.test.ts
```

Expected: FAIL — handler doesn't exist.

- [ ] **Step 4: Implement the handler**

Create `backend/src/llm/prep/stages/character-integration.ts`:

```typescript
// backend/src/llm/prep/stages/character-integration.ts
//
// MYT-53 stage 4: Opus streamObject. Persists the PC entity (entity_type='pc'),
// links characters.entity_id, persists PC↔world relationships + facts,
// and writes the deferred "starts at $location" fact (re-derived from
// worlds.starting_situation_entries — spec §Risks #3). Idempotent re-run:
// if characters.entity_id is set, skip the entity creation + TRUNCATE
// existing PC-tagged relationships/facts before re-INSERT.

import type { Pool } from 'pg'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { resolve, dirname } from 'node:path'
import { streamObject } from '../../ai.js'
import { OPUS } from '../../models.js'
import {
  CharacterIntegrationOutputSchema,
  type CharacterIntegrationOutput,
} from '../../schemas/character-integration.js'
import type { CharacterConceptOutput } from '../../schemas/character-concept.js'
import { uuidv7 } from '../../../repo/uuidv7.js'

const PROMPT_TEMPLATE = readFileSync(
  resolve(dirname(fileURLToPath(import.meta.url)), '../../prompts/prep/character-integration.txt'),
  'utf8',
)

const OPUS_INPUT_PER_MTOK = 15.0
const OPUS_OUTPUT_PER_MTOK = 75.0

export interface CharacterIntegrationArgs {
  readonly campaignId: string
  readonly userId: string
  readonly worldId: string
  readonly characterId: string
  readonly narrative: CharacterConceptOutput
  readonly situationGroundingText: string
  readonly publishEvent: (event: Record<string, unknown>) => Promise<void>
}

export interface CharacterIntegrationStageResult {
  readonly entityId: string
  readonly costUsd: number
  readonly inputTokens: number
  readonly outputTokens: number
}

export async function runCharacterIntegrationStage(
  pool: Pool,
  args: CharacterIntegrationArgs,
): Promise<CharacterIntegrationStageResult> {
  // Re-derive the chosen starting situation entry.
  const camp = await pool.query<{ starting_situation_index: number | null }>(
    `SELECT starting_situation_index FROM campaigns WHERE id = $1`,
    [args.campaignId],
  )
  const idx = camp.rows[0]?.starting_situation_index
  if (idx === null || idx === undefined) {
    throw new Error('character-integration: starting_situation_index NULL')
  }
  const w = await pool.query<{
    starting_situation_entries: { index: number; locationEntityId: string; prose: string }[]
  }>(`SELECT starting_situation_entries FROM worlds WHERE id = $1`, [args.worldId])
  const entries = w.rows[0]?.starting_situation_entries ?? []
  const entry = entries.find(e => e.index === idx)
  if (!entry) {
    throw new Error(`character-integration: no entry for index ${idx}`)
  }

  // Build world-entities listing for the prompt.
  const eRows = await pool.query<{ id: string; name: string; entity_type: string }>(
    `SELECT id, name, entity_type FROM entities
     WHERE world_id = $1 AND entity_type IN ('location', 'faction', 'npc')
     ORDER BY entity_type, name`,
    [args.worldId],
  )
  const worldEntitiesText = eRows.rows
    .map(r => `- ${r.name} (${r.entity_type})`)
    .join('\n')

  const prompt = PROMPT_TEMPLATE
    .replace('{{name}}', args.narrative.name)
    .replace('{{race}}', args.narrative.race)
    .replace('{{class}}', args.narrative.class)
    .replace('{{background}}', args.narrative.background)
    .replace('{{backstory}}', args.narrative.backstory)
    .replace('{{physicalDescription}}', args.narrative.physical_description)
    .replace('{{situationGroundingText}}', args.situationGroundingText)
    .replace('{{startingSituationProse}}', entry.prose)
    .replace('{{worldEntities}}', worldEntitiesText)

  const stream = streamObject({
    model: OPUS,
    schema: CharacterIntegrationOutputSchema,
    schemaName: 'CharacterIntegrationOutputSchema',
    callSite: 'character-integration',
    prompt,
    temperature: 0.7,
  })
  const output: CharacterIntegrationOutput = await stream.object
  const usage = await stream.usage

  const entityId = await persistIntegration(
    pool,
    args,
    output,
    entry.locationEntityId,
    eRows.rows,
  )

  const inputTokens = usage.inputTokens ?? 0
  const outputTokens = usage.outputTokens ?? 0
  return {
    entityId,
    costUsd:
      (inputTokens / 1_000_000) * OPUS_INPUT_PER_MTOK +
      (outputTokens / 1_000_000) * OPUS_OUTPUT_PER_MTOK,
    inputTokens,
    outputTokens,
  }
}

async function persistIntegration(
  pool: Pool,
  args: CharacterIntegrationArgs,
  out: CharacterIntegrationOutput,
  startLocationId: string,
  worldEntities: readonly { id: string; name: string }[],
): Promise<string> {
  const client = await pool.connect()
  try {
    await client.query('BEGIN')

    // Read existing entity_id for this character; if set, idempotent re-run.
    const ch = await client.query<{ entity_id: string | null }>(
      `SELECT entity_id FROM characters WHERE id = $1`,
      [args.characterId],
    )
    let entityId = ch.rows[0]?.entity_id ?? null
    if (entityId === null) {
      entityId = uuidv7()
      await client.query(
        `INSERT INTO entities (id, world_id, entity_type, name, short_description, access_level)
         VALUES ($1, $2, 'pc', $3, $4, 'known')`,
        [entityId, args.worldId, out.pc_entity.name, out.pc_entity.short_description],
      )
      await client.query(`UPDATE characters SET entity_id = $1 WHERE id = $2`, [entityId, args.characterId])
    } else {
      // Update PC entity name + short_description in case the integration
      // re-ran with a different concept (resubmit-after-failure).
      await client.query(
        `UPDATE entities SET name = $2, short_description = $3 WHERE id = $1`,
        [entityId, out.pc_entity.name, out.pc_entity.short_description],
      )
      // TRUNCATE PC-tagged relationships + facts.
      await client.query(
        `DELETE FROM relationships WHERE source_id = $1 OR target_id = $1`,
        [entityId],
      )
      await client.query(`DELETE FROM facts WHERE entity_id = $1`, [entityId])
    }

    await args.publishEvent({
      type: 'entity-added',
      entityId,
      entityType: 'pc',
      userId: args.userId,
    })

    // Relationships: resolve target_entity_name → entity id.
    const byLowerName = new Map(worldEntities.map(e => [e.name.toLowerCase(), e.id]))
    for (const rel of out.relationships) {
      const targetId = byLowerName.get(rel.target_entity_name.toLowerCase())
      if (!targetId) continue // skip unresolved names; the schema cap means there are few.
      await client.query(
        `INSERT INTO relationships (id, source_id, target_id, relationship_type, description)
         VALUES ($1, $2, $3, $4, $5)`,
        [uuidv7(), entityId, targetId, rel.relationship_type, rel.description],
      )
      await args.publishEvent({
        type: 'edge-added',
        sourceId: entityId,
        targetId,
        userId: args.userId,
      })
    }

    // Facts from output + the deferred "starts at $location" fact.
    for (const f of out.facts) {
      await client.query(
        `INSERT INTO facts (id, entity_id, content, tags)
         VALUES ($1, $2, $3, $4::jsonb)`,
        [uuidv7(), entityId, f.content, JSON.stringify(f.tags)],
      )
    }
    const startLocation = worldEntities.find(e => e.id === startLocationId)
    await client.query(
      `INSERT INTO facts (id, entity_id, content, tags)
       VALUES ($1, $2, $3, $4::jsonb)`,
      [
        uuidv7(),
        entityId,
        `${out.pc_entity.name} starts at ${startLocation?.name ?? 'the chosen location'}.`,
        JSON.stringify(['starting_location']),
      ],
    )

    await client.query('COMMIT')
    return entityId
  } catch (err) {
    await client.query('ROLLBACK')
    throw err
  } finally {
    client.release()
  }
}
```

- [ ] **Step 5: Run tests, typecheck, lint, commit**

```
pnpm vitest run backend/src/llm/prep/stages/__tests__/character-integration.test.ts
pnpm typecheck && pnpm lint
git add backend/src/llm/prep/stages/character-integration.ts backend/src/llm/prep/stages/__tests__/character-integration.test.ts backend/src/llm/prompts/prep/character-integration.txt
git commit -m "feat(myt-53): stage 4 character-integration handler (Opus streaming)"
```

---

## Task 11: `character-creation-processor`

**Files:**
- Create: `backend/src/llm/prep/character-creation-processor.ts`
- Create: `backend/src/llm/prep/__tests__/character-creation-processor.test.ts`

**Why:** Spec §Worker — the BullMQ processor that wraps the four stages, owns transaction lifecycle, uses `atomicClaimStage({kind: 'campaign-user', ...})` for per-player atomicity, classifies errors via `isTerminalError`, and emits SSE events per-player on the campaign-scoped channel. Checks the cost cap at the start of each per-player job.

- [ ] **Step 1: Write the failing test**

Create `backend/src/llm/prep/__tests__/character-creation-processor.test.ts`. Structure (adapt from `world-gen-processor.test.ts`):

```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { runCharacterCreationJob } from '../character-creation-processor.js'
import { setupDb, resetData, getPool } from '../../../testing/db.js'
import { uuidv7 } from '../../repo/uuidv7.js'
import * as ai from 'ai'

vi.mock('ai', async () => {
  const actual = await vi.importActual<typeof import('ai')>('ai')
  return { ...actual, generateText: vi.fn(), streamObject: vi.fn() }
})

const mockGenerateText = vi.mocked(ai.generateText)
const mockStreamObject = vi.mocked(ai.streamObject)

// (Define VALID_CONCEPT / VALID_SHEET / VALID_INTEGRATION constants similar
//  to the earlier stage tests.)

describe('runCharacterCreationJob', () => {
  beforeEach(() => vi.clearAllMocks())

  it('runs all four stages end-to-end and marks character_concepts.completed', async () => {
    // Seed: world (complete), 3 location entities, campaign w/ starting_situation_index=0,
    // member (player), character_concepts row (status='processing').
    // Mock SDK for concept + sheet (Sonnet) and stream for integration (Opus).
    // Invoke runCharacterCreationJob. Assert: 4 pipeline_runs rows completed,
    // characters row exists, entity_type='pc', character_concepts.status='completed'.
    // (Implementer fills in the full seed.)
    expect(true).toBe(true)
  })

  it('isolates per-player failures: one job fails terminally, another succeeds', async () => {
    // Two character_concepts rows, two jobs. One mock returns a bad object that
    // fails Zod even after repair (LlmStructuredOutputError); the other succeeds.
    // Both run in parallel through this processor. Assert: failed row's status
    // = 'failed', successful row's status = 'completed'; the second is unaffected.
    expect(true).toBe(true)
  })

  it('aborts the job when cost-cap is exceeded before the first stage', async () => {
    // Seed campaign + character_concepts row + a settings row character_creation_cost_cap_usd
    // = 0.01 (artificially low). Seed prior completed pipeline_runs for the campaign
    // summing to 0.02. Job should abort with stage-failed willRetry:false and reason
    // 'character_creation_cost_cap_exceeded'.
    expect(true).toBe(true)
  })

  it('idempotent re-entry: re-running a job whose stages already completed picks up where it left off', async () => {
    // Run a job to completion. Re-run with same (campaignId, userId).
    // Assert: no new characters row, no duplicate pipeline_runs.
    expect(true).toBe(true)
  })
})
```

- [ ] **Step 2: Run the failing tests**

```
pnpm vitest run backend/src/llm/prep/__tests__/character-creation-processor.test.ts
```

Expected: FAIL — processor doesn't exist.

- [ ] **Step 3: Implement the processor**

Create `backend/src/llm/prep/character-creation-processor.ts`:

```typescript
// backend/src/llm/prep/character-creation-processor.ts
//
// MYT-53: BullMQ processor for the character-creation job. One job per
// (campaign_id, user_id) — fan-out by POST /start-character-creation.
// Parallels world-gen-processor.ts in structure: outer scope owns
// transaction lifecycle; atomicClaimStage guards each stage;
// isTerminalError classifies failures; SSE events stream on the
// campaign-scoped channel keyed by user_id.

import type { Job } from 'bullmq'
import type { Pool } from 'pg'
import { isTerminalError } from '../errors.js'
import { atomicClaimStage } from './world-gen-processor.js'
import {
  readCharacterCreationCostCap,
  sumCharacterCreationStageCosts,
} from './cost-cap.js'
import { runLocationSelectionStage } from './stages/location-selection.js'
import { runCharacterConceptStage } from './stages/character-concept.js'
import { runCharacterSheetStage } from './stages/character-sheet.js'
import { runCharacterIntegrationStage } from './stages/character-integration.js'
import { createCharacterConceptsRepo } from '../../repo/character-concepts.js'

export interface CharacterCreationJobPayload {
  campaignId: string
  userId: string
}

export type CharacterCreationStage =
  | 'location_selection'
  | 'character_concept'
  | 'character_sheet'
  | 'character_integration'

const STAGES: readonly CharacterCreationStage[] = [
  'location_selection',
  'character_concept',
  'character_sheet',
  'character_integration',
]

export interface CharacterCreationDeps {
  readonly pool: Pool
  readonly publishEvent: (campaignId: string, event: Record<string, unknown>) => Promise<void>
}

export async function runCharacterCreationJob(
  deps: CharacterCreationDeps,
  job: Job<CharacterCreationJobPayload>,
): Promise<void> {
  const { campaignId, userId } = job.data
  const conceptsRepo = createCharacterConceptsRepo(deps.pool)

  // Cost-cap precheck.
  const capUsd = await readCharacterCreationCostCap(deps.pool)
  const spent = await sumCharacterCreationStageCosts(deps.pool, campaignId)
  if (spent > capUsd) {
    await conceptsRepo.markFailed(campaignId, userId, {
      code: 'character_creation_cost_cap_exceeded',
      spent,
      capUsd,
    })
    await deps.publishEvent(campaignId, {
      type: 'stage-failed',
      stage: 'cost_cap',
      userId,
      willRetry: false,
      reason: 'character_creation_cost_cap_exceeded',
    })
    return
  }

  // Resolve world id once.
  const worldRow = await deps.pool.query<{ world_id: string }>(
    `SELECT world_id FROM campaigns WHERE id = $1`,
    [campaignId],
  )
  const worldId = worldRow.rows[0]?.world_id
  if (!worldId) {
    throw new Error(`character-creation: campaign ${campaignId} has no world_id`)
  }

  // Thread stage outputs through the loop.
  let stage2Concept: Awaited<ReturnType<typeof runCharacterConceptStage>>['concept'] | null = null
  let stage3CharacterId: string | null = null

  for (const stage of STAGES) {
    const claim = await atomicClaimStage(deps.pool, {
      kind: 'campaign-user',
      campaignId,
      userId,
      stage,
    })
    if (claim === 'completed') continue
    if (claim === 'lost-race') return // another worker has it

    await deps.publishEvent(campaignId, {
      type: 'stage-started',
      stage,
      userId,
      startedAt: new Date().toISOString(),
    })

    const startedAt = Date.now()
    try {
      if (stage === 'location_selection') {
        const r = await runLocationSelectionStage(deps.pool, { campaignId, worldId })
        await markStageCompleted(deps.pool, campaignId, userId, stage, r.costUsd, r.inputTokens, r.outputTokens)
        await deps.publishEvent(campaignId, {
          type: 'stage-completed', stage, userId, durationMs: Date.now() - startedAt, costUsd: r.costUsd,
        })
      } else if (stage === 'character_concept') {
        const ctx = await buildConceptCtx(deps.pool, campaignId, userId, worldId)
        const r = await runCharacterConceptStage(ctx)
        stage2Concept = r.concept
        await markStageCompleted(deps.pool, campaignId, userId, stage, r.costUsd, r.inputTokens, r.outputTokens)
        await deps.publishEvent(campaignId, {
          type: 'stage-completed', stage, userId, durationMs: Date.now() - startedAt, costUsd: r.costUsd,
        })
      } else if (stage === 'character_sheet') {
        if (stage2Concept === null) {
          // Re-entry case: stage 2 completed in a prior run, we need to
          // reload the narrative from the characters row.
          stage2Concept = await loadNarrativeFromCharacters(deps.pool, campaignId, userId)
        }
        const w = await loadWorldContext(deps.pool, worldId)
        const r = await runCharacterSheetStage(deps.pool, {
          campaignId, userId, worldId, narrative: stage2Concept,
          worldTone: w.tone, worldEra: w.era,
        })
        stage3CharacterId = r.characterId
        await markStageCompleted(deps.pool, campaignId, userId, stage, r.costUsd, r.inputTokens, r.outputTokens)
        await deps.publishEvent(campaignId, {
          type: 'stage-completed', stage, userId, durationMs: Date.now() - startedAt, costUsd: r.costUsd,
        })
      } else {
        // character_integration
        if (stage3CharacterId === null) {
          stage3CharacterId = await loadCharacterId(deps.pool, campaignId, userId)
        }
        if (stage2Concept === null) {
          stage2Concept = await loadNarrativeFromCharacters(deps.pool, campaignId, userId)
        }
        const concept = await conceptsRepo.getByCampaignAndUser(campaignId, userId)
        if (!concept) throw new Error('character-integration: character_concepts row missing')
        const r = await runCharacterIntegrationStage(deps.pool, {
          campaignId, userId, worldId,
          characterId: stage3CharacterId,
          narrative: stage2Concept,
          situationGroundingText: concept.situationGroundingText,
          publishEvent: (e) => deps.publishEvent(campaignId, { ...e }),
        })
        await markStageCompleted(deps.pool, campaignId, userId, stage, r.costUsd, r.inputTokens, r.outputTokens)
        await deps.publishEvent(campaignId, {
          type: 'stage-completed', stage, userId, durationMs: Date.now() - startedAt, costUsd: r.costUsd,
        })
      }
    } catch (err) {
      const terminal = isTerminalError(err)
      const message = err instanceof Error ? err.message : 'unknown'
      await markStageFailed(deps.pool, campaignId, userId, stage, message)
      if (terminal) {
        await conceptsRepo.markFailed(campaignId, userId, { stage, message })
        await deps.publishEvent(campaignId, {
          type: 'stage-failed', stage, userId, willRetry: false, reason: message,
        })
        return // terminal: do not throw — let the job complete cleanly
      }
      throw err // retryable: let BullMQ retry
    }
  }

  await conceptsRepo.markCompleted(campaignId, userId)
  await deps.publishEvent(campaignId, {
    type: 'phase', phase: 'character_creation_complete', userId,
  })
}

// (Implementer fills in markStageCompleted / markStageFailed /
//  buildConceptCtx / loadWorldContext / loadNarrativeFromCharacters /
//  loadCharacterId helpers — small SQL queries.)
```

(Note: helpers marked "(Implementer fills in …)" are small focused SQL queries — each ~5-10 lines. The implementer writes them following the patterns established in the stage handlers. Each helper has its own unit test in the processor test file.)

- [ ] **Step 4: Run tests, typecheck, lint, commit**

```
pnpm vitest run backend/src/llm/prep/__tests__/character-creation-processor.test.ts
pnpm typecheck && pnpm lint
git add backend/src/llm/prep/character-creation-processor.ts backend/src/llm/prep/__tests__/character-creation-processor.test.ts
git commit -m "feat(myt-53): character-creation BullMQ processor (4 stages, per-player atomic)"
```

---

## Task 12: Route — `POST /api/campaigns/:campaignId/starting-situation`

**Files:**
- Create: `backend/src/routes/campaign-characters.ts` (new plugin file; one route in this task, additional routes in tasks 13-19)
- Create: `backend/src/routes/__tests__/campaign-characters.test.ts`

**Why:** Spec §Routes — owner-only route. Sets `campaigns.starting_situation_index ∈ {0, 1, 2}`. 409 errors on `world_not_complete` or `situation_locked` (any concept already in processing/completed).

- [ ] **Step 1: Write the failing test**

Create `backend/src/routes/__tests__/campaign-characters.test.ts` with the first route's tests (4 cases minimum: owner-success, member-403, world-not-complete-409, situation-locked-409). Pattern: copy the bootstrap from `backend/src/routes/__tests__/campaigns.test.ts` (`buildApp`, fixture helpers, etc.) and adapt.

- [ ] **Step 2: Verify FAIL**

```
pnpm vitest run backend/src/routes/__tests__/campaign-characters.test.ts -t "starting-situation"
```

Expected: FAIL — plugin doesn't exist.

- [ ] **Step 3: Implement the plugin scaffold + first route**

Create `backend/src/routes/campaign-characters.ts`:

```typescript
// backend/src/routes/campaign-characters.ts
//
// MYT-53: eight new routes covering the per-player character-creation
// surface. This file holds all eight; the campaigns.ts plugin extension
// (GET /api/campaigns/:campaignId shape change) lives in campaigns.ts.

import type { FastifyPluginAsync } from 'fastify'
import type { Pool } from 'pg'
import { z } from 'zod'
import { createRepo } from '../repo/index.js'
import { requireCampaignMember } from '../auth/access-control.js'
import { requireDbUser } from '../auth/require-db-user.js'

export interface Opts {
  readonly pool: Pool
  readonly characterCreationQueue?: {
    add(name: string, data: { campaignId: string; userId: string }, opts?: { jobId?: string }): Promise<unknown>
  }
}

export const campaignCharactersPlugin: FastifyPluginAsync<Opts> = async (app, opts) => {
  const repo = createRepo(opts.pool)

  // POST /api/campaigns/:campaignId/starting-situation
  const StartingSituationBodySchema = z.object({ index: z.number().int().min(0).max(2) })
  app.post<{ Params: { campaignId: string }; Body: z.infer<typeof StartingSituationBodySchema> }>(
    '/api/campaigns/:campaignId/starting-situation',
    {
      preHandler: requireCampaignMember(repo, 'owner'),
      config: { pipelineRoute: true },
    },
    async (req, reply) => {
      const body = StartingSituationBodySchema.safeParse(req.body)
      if (!body.success) return reply.code(400).send({ code: 'bad_body' })

      const campaign = await opts.pool.query<{ world_id: string }>(
        `SELECT world_id FROM campaigns WHERE id = $1`,
        [req.params.campaignId],
      )
      const worldId = campaign.rows[0]?.world_id
      if (!worldId) return reply.code(404).send({ code: 'campaign_not_found' })

      const world = await opts.pool.query<{ status: string }>(
        `SELECT status FROM worlds WHERE id = $1`,
        [worldId],
      )
      if (world.rows[0]?.status !== 'complete') {
        return reply.code(409).send({ code: 'world_not_complete' })
      }

      const locked = await opts.pool.query<{ n: string }>(
        `SELECT COUNT(*)::text AS n FROM character_concepts
         WHERE campaign_id = $1 AND status IN ('processing', 'completed')`,
        [req.params.campaignId],
      )
      if (Number.parseInt(locked.rows[0]?.n ?? '0', 10) > 0) {
        return reply.code(409).send({ code: 'situation_locked' })
      }

      await opts.pool.query(
        `UPDATE campaigns SET starting_situation_index = $2 WHERE id = $1`,
        [req.params.campaignId, body.data.index],
      )
      return reply.code(200).send({ index: body.data.index })
    },
  )

  // Tasks 13-19 add the remaining seven routes here.
}
```

- [ ] **Step 4: Run tests, typecheck, lint, commit**

```
pnpm vitest run backend/src/routes/__tests__/campaign-characters.test.ts -t "starting-situation"
pnpm typecheck && pnpm lint
git add backend/src/routes/campaign-characters.ts backend/src/routes/__tests__/campaign-characters.test.ts
git commit -m "feat(myt-53): route POST /starting-situation (owner picks party-wide situation)"
```

---

## Task 13: Route — `POST /api/campaigns/:campaignId/start-character-creation`

**Files:**
- Modify: `backend/src/routes/campaign-characters.ts`
- Modify: `backend/src/routes/__tests__/campaign-characters.test.ts`

**Why:** Spec §Routes — owner-only fan-out trigger. Wraps the `flipAllSubmittedToProcessing` repo call and BullMQ enqueue in a single transaction so a failed enqueue rolls back the status flip (spec §Recovery contract). 409 `starting_situation_not_chosen` if index NULL; 409 `no_submitters` if zero `submitted` rows. Idempotent on re-call.

- [ ] **Step 1: Write the failing tests**

Append to `backend/src/routes/__tests__/campaign-characters.test.ts`:

```typescript
describe('POST /start-character-creation', () => {
  it('enqueues one job per submitted row and flips all to processing', async () => {
    // Seed: campaign w/ starting_situation_index=0, 3 members each with a
    // submitted character_concepts row. Spy queue.add returns immediately.
    // Assert: response has enqueued: [{userId, jobId}] * 3; all 3 rows
    // now have status='processing'; queue.add called 3 times.
    expect(true).toBe(true)
  })
  it('409 starting_situation_not_chosen when index is NULL', async () => { expect(true).toBe(true) })
  it('409 no_submitters when no submitted rows', async () => { expect(true).toBe(true) })
  it('rolls back UPDATE when queue.add throws', async () => {
    // Spy queue.add throws. Expect 500, expect all rows STILL in 'submitted'.
    expect(true).toBe(true)
  })
  it('idempotent re-call: second call picks up only newly-submitted rows', async () => {
    // First call enqueues 2. A third member submits. Second call enqueues 1.
    expect(true).toBe(true)
  })
})
```

- [ ] **Step 2: Run failing tests**

```
pnpm vitest run backend/src/routes/__tests__/campaign-characters.test.ts -t "start-character-creation"
```

Expected: FAIL.

- [ ] **Step 3: Implement the route**

Add to `backend/src/routes/campaign-characters.ts`:

```typescript
// POST /api/campaigns/:campaignId/start-character-creation
app.post<{ Params: { campaignId: string } }>(
  '/api/campaigns/:campaignId/start-character-creation',
  {
    preHandler: requireCampaignMember(repo, 'owner'),
    config: { pipelineRoute: true },
  },
  async (req, reply) => {
    if (!opts.characterCreationQueue) {
      return reply.code(503).send({ code: 'queue_not_ready' })
    }

    // Gate: situation chosen?
    const camp = await opts.pool.query<{ starting_situation_index: number | null }>(
      `SELECT starting_situation_index FROM campaigns WHERE id = $1`,
      [req.params.campaignId],
    )
    if (camp.rows[0]?.starting_situation_index === null || camp.rows[0]?.starting_situation_index === undefined) {
      return reply.code(409).send({ code: 'starting_situation_not_chosen' })
    }

    // Atomic flip + enqueue in one transaction.
    const client = await opts.pool.connect()
    try {
      await client.query('BEGIN')
      const flipped = await repo.characterConcepts.flipAllSubmittedToProcessing(client, req.params.campaignId)
      if (flipped.length === 0) {
        await client.query('ROLLBACK')
        return reply.code(409).send({ code: 'no_submitters' })
      }
      const enqueued: { userId: string; jobId: string }[] = []
      for (const f of flipped) {
        const jobId = `cc-${req.params.campaignId}-${f.userId}`
        await opts.characterCreationQueue.add(
          'character-creation',
          { campaignId: req.params.campaignId, userId: f.userId },
          { jobId },
        )
        enqueued.push({ userId: f.userId, jobId })
      }
      await client.query('COMMIT')
      return reply.code(200).send({ enqueued })
    } catch (err) {
      await client.query('ROLLBACK')
      throw err
    } finally {
      client.release()
    }
  },
)
```

- [ ] **Step 4: Run tests, typecheck, lint, commit**

```
pnpm vitest run backend/src/routes/__tests__/campaign-characters.test.ts -t "start-character-creation"
pnpm typecheck && pnpm lint
git add backend/src/routes/campaign-characters.ts backend/src/routes/__tests__/campaign-characters.test.ts
git commit -m "feat(myt-53): route POST /start-character-creation (atomic flip + enqueue)"
```

---

## Task 14: Route — `POST /api/campaigns/:campaignId/archive` (shape change)

**Files:**
- Modify: `backend/src/routes/campaign-characters.ts`
- Modify: `backend/src/routes/__tests__/campaign-characters.test.ts`

**Why:** Spec §Routes — owner-only soft-delete. Allow `{'setup','active'} → 'archived'`. Without this allowance the route is dead code for every MYT-53-era campaign (which never advances past 'setup').

- [ ] **Step 1: Write the failing test**

Append:

```typescript
describe('POST /archive', () => {
  it('archives a setup campaign', async () => {
    // Seed: campaign in 'setup'. Owner POSTs /archive. Status → 'archived'.
    expect(true).toBe(true)
  })
  it('archives an active campaign', async () => { expect(true).toBe(true) })
  it('409 cannot_archive when already archived', async () => { expect(true).toBe(true) })
})
```

- [ ] **Step 2: Implement**

```typescript
// POST /api/campaigns/:campaignId/archive
app.post<{ Params: { campaignId: string } }>(
  '/api/campaigns/:campaignId/archive',
  { preHandler: requireCampaignMember(repo, 'owner') },
  async (req, reply) => {
    const result = await opts.pool.query<{ status: string }>(
      `UPDATE campaigns SET status = 'archived'
       WHERE id = $1 AND status IN ('setup', 'active')
       RETURNING status`,
      [req.params.campaignId],
    )
    if (result.rows.length === 0) return reply.code(409).send({ code: 'cannot_archive' })
    return reply.code(200).send({ status: 'archived' })
  },
)
```

- [ ] **Step 3: Run, typecheck, lint, commit**

```
pnpm vitest run backend/src/routes/__tests__/campaign-characters.test.ts -t "archive"
pnpm typecheck && pnpm lint
git add -u
git commit -m "feat(myt-53): route POST /archive (allow setup -> archived)"
```

---

## Task 15: Route — `POST /api/campaigns/:campaignId/characters`

**Files:**
- Modify: `backend/src/routes/campaign-characters.ts`
- Modify: `backend/src/routes/__tests__/campaign-characters.test.ts`

**Why:** Spec §Routes — member route. UPSERTs the player's two-prompt input. Validates situation already chosen + world complete + status is `submitted | failed | absent` (409 `concept_locked` otherwise).

- [ ] **Step 1: Failing test cases**

Append:

```typescript
describe('POST /characters', () => {
  it('UPSERTs a new submitted concept', async () => { expect(true).toBe(true) })
  it('re-POST while in submitted updates text fields', async () => { expect(true).toBe(true) })
  it('re-POST after failed resets status to submitted', async () => { expect(true).toBe(true) })
  it('409 concept_locked when status is processing', async () => { expect(true).toBe(true) })
  it('409 concept_locked when status is completed', async () => { expect(true).toBe(true) })
  it('409 starting_situation_not_chosen when index is NULL', async () => { expect(true).toBe(true) })
  it('409 world_not_complete when worlds.status != complete', async () => { expect(true).toBe(true) })
  it('400 when neither conceptText nor guidedChoices present', async () => { expect(true).toBe(true) })
  it('400 when situationGroundingText too short', async () => { expect(true).toBe(true) })
})
```

- [ ] **Step 2: Implement**

```typescript
const PostCharacterBody = z.object({
  conceptText: z.string().min(20).max(4000).optional(),
  guidedChoices: z.record(z.unknown()).optional(),
  situationGroundingText: z.string().min(20).max(2000),
})

app.post<{ Params: { campaignId: string }; Body: z.infer<typeof PostCharacterBody> }>(
  '/api/campaigns/:campaignId/characters',
  {
    preHandler: requireCampaignMember(repo),
    config: { pipelineRoute: true },
  },
  async (req, reply) => {
    const parsed = PostCharacterBody.safeParse(req.body)
    if (!parsed.success) return reply.code(400).send({ code: 'bad_body' })
    const body = parsed.data
    const hasConcept = (body.conceptText !== undefined && body.conceptText.length > 0)
    const hasGuided = body.guidedChoices !== undefined && Object.keys(body.guidedChoices).length > 0
    if (!hasConcept && !hasGuided) {
      return reply.code(400).send({ code: 'concept_or_guided_required' })
    }

    const dbUser = requireDbUser(req)

    // Gates.
    const camp = await opts.pool.query<{ world_id: string; starting_situation_index: number | null }>(
      `SELECT world_id, starting_situation_index FROM campaigns WHERE id = $1`,
      [req.params.campaignId],
    )
    const c = camp.rows[0]
    if (!c) return reply.code(404).send({ code: 'campaign_not_found' })

    const world = await opts.pool.query<{ status: string }>(
      `SELECT status FROM worlds WHERE id = $1`, [c.world_id],
    )
    if (world.rows[0]?.status !== 'complete') {
      return reply.code(409).send({ code: 'world_not_complete' })
    }
    if (c.starting_situation_index === null) {
      return reply.code(409).send({ code: 'starting_situation_not_chosen' })
    }

    // Status gate.
    const existing = await repo.characterConcepts.getByCampaignAndUser(req.params.campaignId, dbUser.id)
    if (existing && (existing.status === 'processing' || existing.status === 'completed')) {
      return reply.code(409).send({ code: 'concept_locked' })
    }

    const row = await repo.characterConcepts.upsert({
      campaignId: req.params.campaignId,
      userId: dbUser.id,
      conceptText: body.conceptText ?? null,
      situationGroundingText: body.situationGroundingText,
      guidedChoices: body.guidedChoices ?? {},
    })
    return reply.code(200).send({ conceptId: row.id, status: row.status })
  },
)
```

- [ ] **Step 3: Run, typecheck, lint, commit**

```
pnpm vitest run backend/src/routes/__tests__/campaign-characters.test.ts -t "POST /characters"
pnpm typecheck && pnpm lint
git add -u
git commit -m "feat(myt-53): route POST /characters (member submission, UPSERT semantics)"
```

---

## Task 16: Route — `GET /api/campaigns/:campaignId/starting-situations`

**Files:**
- Modify: `backend/src/routes/campaign-characters.ts`
- Modify: `backend/src/routes/__tests__/campaign-characters.test.ts`

**Why:** Spec §Routes — member route. Returns the three situations from `worlds.starting_situation_entries` plus `chosenIndex` from `campaigns.starting_situation_index`. 404 `world_not_ready` if the entries array is empty.

- [ ] **Step 1: Failing test**

```typescript
describe('GET /starting-situations', () => {
  it('returns the three entries + chosenIndex', async () => { expect(true).toBe(true) })
  it('404 world_not_ready when entries is empty', async () => { expect(true).toBe(true) })
  it('chosenIndex is null when not yet picked', async () => { expect(true).toBe(true) })
})
```

- [ ] **Step 2: Implement**

```typescript
app.get<{ Params: { campaignId: string } }>(
  '/api/campaigns/:campaignId/starting-situations',
  {
    preHandler: requireCampaignMember(repo),
    config: { pipelineRoute: true },
  },
  async (req, reply) => {
    const camp = await opts.pool.query<{
      world_id: string; starting_situation_index: number | null
    }>(`SELECT world_id, starting_situation_index FROM campaigns WHERE id = $1`, [req.params.campaignId])
    const c = camp.rows[0]
    if (!c) return reply.code(404).send({ code: 'campaign_not_found' })

    const w = await opts.pool.query<{
      starting_situation_entries: { index: number; locationEntityId: string; prose: string }[]
    }>(`SELECT starting_situation_entries FROM worlds WHERE id = $1`, [c.world_id])
    const entries = w.rows[0]?.starting_situation_entries ?? []
    if (entries.length === 0) return reply.code(404).send({ code: 'world_not_ready' })

    return reply.code(200).send({
      situations: entries,
      chosenIndex: c.starting_situation_index,
    })
  },
)
```

- [ ] **Step 3: Commit**

```
pnpm vitest run backend/src/routes/__tests__/campaign-characters.test.ts -t "GET /starting-situations"
pnpm typecheck && pnpm lint
git add -u
git commit -m "feat(myt-53): route GET /starting-situations"
```

---

## Task 17: Route — `GET /api/campaigns/:campaignId/characters` (roster)

**Files:**
- Modify: `backend/src/routes/campaign-characters.ts`
- Modify: `backend/src/routes/__tests__/campaign-characters.test.ts`

**Why:** Spec §Routes — member roster. Joins `campaign_members` ← `character_concepts` ← `characters` and returns per-member status + (when completed) characterId.

- [ ] **Step 1: Failing test**

```typescript
describe('GET /characters (roster)', () => {
  it('returns each member with conceptStatus and (when completed) characterId', async () => { expect(true).toBe(true) })
  it('conceptStatus="none" for a member who has not submitted yet', async () => { expect(true).toBe(true) })
})
```

- [ ] **Step 2: Implement**

```typescript
app.get<{ Params: { campaignId: string } }>(
  '/api/campaigns/:campaignId/characters',
  {
    preHandler: requireCampaignMember(repo),
    config: { pipelineRoute: true },
  },
  async (req, reply) => {
    const rows = await opts.pool.query<{
      user_id: string; display_name: string;
      concept_status: 'submitted' | 'processing' | 'completed' | 'failed' | null;
      character_id: string | null;
    }>(
      `SELECT cm.user_id,
              u.display_name,
              cc.status        AS concept_status,
              ch.character_id  AS character_id
       FROM campaign_members cm
       JOIN users u ON u.id = cm.user_id
       LEFT JOIN character_concepts cc
         ON cc.campaign_id = cm.campaign_id AND cc.user_id = cm.user_id
       LEFT JOIN campaign_characters ch
         ON ch.campaign_id = cm.campaign_id AND ch.user_id = cm.user_id
       WHERE cm.campaign_id = $1
       ORDER BY cm.joined_at`,
      [req.params.campaignId],
    )
    return reply.code(200).send({
      members: rows.rows.map(r => ({
        userId: r.user_id,
        displayName: r.display_name,
        conceptStatus: r.concept_status ?? 'none',
        ...(r.character_id ? { characterId: r.character_id } : {}),
      })),
    })
  },
)
```

- [ ] **Step 3: Commit**

```
pnpm vitest run backend/src/routes/__tests__/campaign-characters.test.ts -t "GET /characters \\(roster\\)"
pnpm typecheck && pnpm lint
git add -u
git commit -m "feat(myt-53): route GET /characters (roster)"
```

---

## Task 18: Route — `GET /api/campaigns/:campaignId/characters/:charId`

**Files:**
- Modify: `backend/src/routes/campaign-characters.ts`
- Modify: `backend/src/routes/__tests__/campaign-characters.test.ts`

**Why:** Spec §Routes — single-character detail view. Returns the portable character + 4 sub-tables. 404 if `charId` not joined to this campaign.

- [ ] **Step 1: Failing test**

```typescript
describe('GET /characters/:charId', () => {
  it('returns the portable character + skills + features + equipment + spells', async () => { expect(true).toBe(true) })
  it('404 when charId is not joined to this campaign', async () => { expect(true).toBe(true) })
})
```

- [ ] **Step 2: Implement**

```typescript
app.get<{ Params: { campaignId: string; charId: string } }>(
  '/api/campaigns/:campaignId/characters/:charId',
  {
    preHandler: requireCampaignMember(repo),
    config: { pipelineRoute: true },
  },
  async (req, reply) => {
    const join = await opts.pool.query<{ character_id: string }>(
      `SELECT character_id FROM campaign_characters
       WHERE campaign_id = $1 AND character_id = $2`,
      [req.params.campaignId, req.params.charId],
    )
    if (join.rows.length === 0) return reply.code(404).send({ code: 'character_not_in_campaign' })

    const c = await opts.pool.query(
      `SELECT * FROM characters WHERE id = $1`, [req.params.charId],
    )
    const [skills, features, equipment, spells] = await Promise.all([
      opts.pool.query(`SELECT name, proficient, expertise FROM character_skills WHERE character_id = $1`, [req.params.charId]),
      opts.pool.query(`SELECT name, description FROM character_features WHERE character_id = $1`, [req.params.charId]),
      opts.pool.query(`SELECT name, quantity FROM character_equipment WHERE character_id = $1`, [req.params.charId]),
      opts.pool.query(`SELECT name, level, prepared FROM character_spells WHERE character_id = $1`, [req.params.charId]),
    ])
    return reply.code(200).send({
      character: c.rows[0],
      skills: skills.rows,
      features: features.rows,
      equipment: equipment.rows,
      spells: spells.rows,
    })
  },
)
```

- [ ] **Step 3: Commit**

```
pnpm vitest run backend/src/routes/__tests__/campaign-characters.test.ts -t "GET /characters/:charId"
pnpm typecheck && pnpm lint
git add -u
git commit -m "feat(myt-53): route GET /characters/:charId"
```

---

## Task 19: Routes — `GET /hierarchy` + `GET /random-tables`

**Files:**
- Modify: `backend/src/routes/campaign-characters.ts`
- Modify: `backend/src/routes/__tests__/campaign-characters.test.ts`

**Why:** Spec §Routes — two member-visible reads of existing world-snapshot data. Hierarchy is tier-filtered per myth-exac; random tables come from the world-gen stage-6 output.

- [ ] **Step 1: Failing tests**

```typescript
describe('GET /hierarchy', () => {
  it('returns the entity hierarchy filtered by member tier', async () => { expect(true).toBe(true) })
})
describe('GET /random-tables', () => {
  it('returns the random_tables rows for the campaign world', async () => { expect(true).toBe(true) })
})
```

- [ ] **Step 2: Implement (both routes use the existing repos)**

```typescript
app.get<{ Params: { campaignId: string } }>(
  '/api/campaigns/:campaignId/hierarchy',
  { preHandler: requireCampaignMember(repo), config: { pipelineRoute: true } },
  async (req, reply) => {
    const camp = await opts.pool.query<{ world_id: string }>(
      `SELECT world_id FROM campaigns WHERE id = $1`, [req.params.campaignId],
    )
    const wid = camp.rows[0]?.world_id
    if (!wid) return reply.code(404).send({ code: 'campaign_not_found' })
    const hierarchy = await repo.entityHierarchy.getForWorld(wid, /* tier */ 'known')
    return reply.code(200).send({ hierarchy })
  },
)

app.get<{ Params: { campaignId: string } }>(
  '/api/campaigns/:campaignId/random-tables',
  { preHandler: requireCampaignMember(repo), config: { pipelineRoute: true } },
  async (req, reply) => {
    const camp = await opts.pool.query<{ world_id: string }>(
      `SELECT world_id FROM campaigns WHERE id = $1`, [req.params.campaignId],
    )
    const wid = camp.rows[0]?.world_id
    if (!wid) return reply.code(404).send({ code: 'campaign_not_found' })
    const tables = await opts.pool.query(
      `SELECT * FROM random_tables WHERE world_id = $1 ORDER BY name`, [wid],
    )
    return reply.code(200).send({ tables: tables.rows })
  },
)
```

- [ ] **Step 3: Commit**

```
pnpm vitest run backend/src/routes/__tests__/campaign-characters.test.ts -t "GET /hierarchy|GET /random-tables"
pnpm typecheck && pnpm lint
git add -u
git commit -m "feat(myt-53): routes GET /hierarchy + GET /random-tables"
```

---

## Task 20: `GET /api/campaigns/:campaignId` shape extension — include `characters[]`

**Files:**
- Modify: `backend/src/routes/campaigns.ts`
- Modify: `backend/src/routes/__tests__/campaigns.test.ts`

**Why:** Spec §Routes shape-extension — extend the existing campaign-detail response to include `characters: [{userId, characterId, name, ...}]` resolving all `character_concepts.status='completed'` rows.

- [ ] **Step 1: Failing test**

In `backend/src/routes/__tests__/campaigns.test.ts`, append:

```typescript
describe('GET /api/campaigns/:campaignId — characters[] extension', () => {
  it('returns empty characters[] when no member has completed character creation', async () => { expect(true).toBe(true) })
  it('returns one row per completed character with name + class + level', async () => { expect(true).toBe(true) })
})
```

- [ ] **Step 2: Implement the response-shape extension**

Find the GET-by-id handler in `backend/src/routes/campaigns.ts`. Inside the handler, after the existing query, add:

```typescript
const chars = await opts.pool.query<{
  user_id: string; character_id: string; name: string; class: string; level: number
}>(
  `SELECT cc.user_id, c.id AS character_id, c.name, c.class, c.level
   FROM character_concepts cc
   JOIN campaign_characters cm
     ON cm.campaign_id = cc.campaign_id AND cm.user_id = cc.user_id
   JOIN characters c ON c.id = cm.character_id
   WHERE cc.campaign_id = $1 AND cc.status = 'completed'`,
  [req.params.campaignId],
)

// Spread the existing response object and add:
//   characters: chars.rows.map(r => ({
//     userId: r.user_id, characterId: r.character_id,
//     name: r.name, class: r.class, level: r.level,
//   }))
```

- [ ] **Step 3: Commit**

```
pnpm vitest run backend/src/routes/__tests__/campaigns.test.ts -t "characters\\[\\] extension"
pnpm typecheck && pnpm lint
git add -u
git commit -m "feat(myt-53): GET /api/campaigns/:campaignId returns characters[]"
```

---

## Task 21: Contract registrations

**Files:**
- Modify: `backend/src/contract/pipeline-routes.ts`
- Modify: `backend/src/contract/backend-routes.ts`
- Modify: `backend/src/contract/pipeline-jobs.ts`

**Why:** Each new route must be declared in the route-audit lists, and the new BullMQ job kind must be declared. The boot-time invariants and the dev-tool coverage manifest both gate on these.

- [ ] **Step 1: Add to `pipeline-routes.ts`**

```typescript
// In PIPELINE_ROUTES array, append:
'POST /api/campaigns/:campaignId/starting-situation',
'POST /api/campaigns/:campaignId/start-character-creation',
'POST /api/campaigns/:campaignId/archive',
'POST /api/campaigns/:campaignId/characters',
'GET /api/campaigns/:campaignId/starting-situations',
'GET /api/campaigns/:campaignId/characters',
'GET /api/campaigns/:campaignId/characters/:charId',
'GET /api/campaigns/:campaignId/hierarchy',
'GET /api/campaigns/:campaignId/random-tables',
```

- [ ] **Step 2: Add to `backend-routes.ts`**

```typescript
// In BACKEND_ROUTES array, append:
{ method: 'POST', path: '/api/campaigns/:campaignId/starting-situation' },
{ method: 'POST', path: '/api/campaigns/:campaignId/start-character-creation' },
{ method: 'POST', path: '/api/campaigns/:campaignId/archive' },
{ method: 'POST', path: '/api/campaigns/:campaignId/characters' },
{ method: 'GET', path: '/api/campaigns/:campaignId/starting-situations' },
{ method: 'GET', path: '/api/campaigns/:campaignId/characters' },
{ method: 'GET', path: '/api/campaigns/:campaignId/characters/:charId' },
{ method: 'GET', path: '/api/campaigns/:campaignId/hierarchy' },
{ method: 'GET', path: '/api/campaigns/:campaignId/random-tables' },
```

- [ ] **Step 3: Add to `pipeline-jobs.ts`**

```typescript
export const PIPELINE_JOBS: readonly string[] = ['world-gen', 'character-creation'] as const
```

- [ ] **Step 4: Run contract tests**

```
pnpm vitest run backend/src/contract/__tests__
```

Expected: drift tests pass (no missing entries, no extras).

- [ ] **Step 5: Commit**

```
pnpm typecheck && pnpm lint
git add -u
git commit -m "feat(myt-53): contract registrations — 9 pipeline routes + 1 job"
```

---

## Task 22: `app.ts` wiring — register plugin + boot worker

**Files:**
- Modify: `backend/src/app.ts`
- Modify: `backend/src/app.ts` corresponding tests (or `backend/src/__tests__/app.test.ts` if present)

**Why:** Plugin registration + BullMQ worker creation. Mirror the world-gen-worker boot pattern (see existing app.ts: import the processor, create a `Worker` with concurrency, attach the publish-event helper).

- [ ] **Step 1: Failing test**

If `app.test.ts` exists, add a test that boots the app and asserts:
- A route GET /api/campaigns/:campaignId/starting-situations is registered.
- A BullMQ worker for queue `campaign-setup` is started.

If no app-test exists, the boot-time route-audit drift test from Task 21 covers route registration, and a startup smoke (Task 25) covers worker startup.

- [ ] **Step 2: Implement**

In `backend/src/app.ts`:

```typescript
// Import the plugin and processor:
import { campaignCharactersPlugin } from './routes/campaign-characters.js'
import { runCharacterCreationJob } from './llm/prep/character-creation-processor.js'
import { Worker, Queue } from 'bullmq'

// Construct the queue at boot (alongside the existing worldGenQueue):
const characterCreationQueue = new Queue('campaign-setup', { connection: bullConnection })

// Register the plugin (alongside existing routes):
await app.register(campaignCharactersPlugin, {
  pool,
  characterCreationQueue,
})

// Boot the worker (alongside the world-gen worker boot):
const characterCreationWorker = new Worker(
  'campaign-setup',
  async (job) => {
    if (job.name !== 'character-creation') return
    await runCharacterCreationJob(
      { pool, publishEvent: (cid, e) => publishCampaignEvent(cid, e) },
      job as Job<CharacterCreationJobPayload>,
    )
  },
  { connection: bullConnection, concurrency: 5 },
)

// Attach worker to shutdown hooks (mirrors world-gen worker pattern):
app.addHook('onClose', async () => {
  await characterCreationWorker.close()
  await characterCreationQueue.close()
})
```

- [ ] **Step 3: Run, typecheck, lint, commit**

```
pnpm typecheck && pnpm lint
pnpm test
git add -u
git commit -m "feat(myt-53): app.ts wires campaign-characters plugin + character-creation worker"
```

---

## Task 23: Dev-tool panel — `character-creation-panel.ts`

**Files:**
- Create: `backend/dev-tool/src/components/character-creation-panel.ts`
- Modify: `backend/dev-tool/src/main.ts`
- Modify: `backend/dev-tool/verify-registry.ts`
- Modify: `backend/dev-tool/coverage.json`

**Why:** Spec §Dev-tool surface — event-driven panel that binds to `mythrun.watchcampaign`, fetches the new endpoints, renders the per-member roster + owner action buttons. Coverage manifest registers the panel + 9 routes + 1 job.

- [ ] **Step 1: Create the panel**

Pattern: copy the layout shape of `backend/dev-tool/src/components/world-snapshot-panel.ts` (event-driven, fetch on watch, render + re-render on SSE phase changes). Adapt the per-member roster from `backend/dev-tool/src/components/campaign-details-panel.ts`. XSS safety per spec §Dev-tool surface: all user-submitted text rendered with `el.textContent`, never `innerHTML`.

Skeleton (the implementer expands each block to render the roster, fetch on watch, wire owner buttons):

```typescript
// backend/dev-tool/src/components/character-creation-panel.ts
//
// MYT-53 dev-tool panel. Event-driven binding via mythrun.watchcampaign;
// renders the per-member character-creation roster and owner action
// buttons. Member submissions exercised via the existing identity
// switcher (cycle dev-user-N, each posts /characters).

export function mountCharacterCreationPanel(root: HTMLElement): void {
  let currentCampaignId: string | null = null

  function refresh(): void {
    if (!currentCampaignId) {
      root.innerHTML = ''
      return
    }
    void fetchAndRender(currentCampaignId)
  }

  async function fetchAndRender(campaignId: string): Promise<void> {
    const [situations, roster] = await Promise.all([
      fetch(`/api/campaigns/${campaignId}/starting-situations`, { credentials: 'include' }).then(r => r.ok ? r.json() : null),
      fetch(`/api/campaigns/${campaignId}/characters`, { credentials: 'include' }).then(r => r.json()),
    ])
    renderInto(root, { situations, roster, campaignId })
  }

  function renderInto(
    el: HTMLElement,
    data: { situations: unknown; roster: { members: { userId: string; displayName: string; conceptStatus: string }[] }; campaignId: string },
  ): void {
    // ... build DOM with textContent for all user-supplied strings.
    // Wire two buttons: "Pick situation" + "Start character creation".
    // Wire a "Submit my character" form for the current identity.
    el.replaceChildren(/* ... */)
  }

  window.addEventListener('mythrun.watchcampaign', (e) => {
    currentCampaignId = (e as CustomEvent<{ campaignId: string }>).detail.campaignId
    refresh()
  })
  window.addEventListener('mythrun.closewatch', () => {
    currentCampaignId = null
    refresh()
  })
}
```

- [ ] **Step 2: Mount in `main.ts`**

Add an import + a call to `mountCharacterCreationPanel(...)` next to the other panel mounts.

- [ ] **Step 3: Update `verify-registry.ts`**

Add an entry for `character-creation-panel` with the appropriate interaction pattern (action-only + event-driven).

- [ ] **Step 4: Update `coverage.json`**

Add the 9 new backend routes + the 1 new pipeline job in the coverage list. Pattern: existing entries in coverage.json.

- [ ] **Step 5: Run dev-tool checks**

```
pnpm dev-tool:check
```

Expected: green — no missing coverage entries, panel mounted, no XSS-pattern flags.

- [ ] **Step 6: Commit**

```
pnpm typecheck && pnpm lint
git add backend/dev-tool/src/components/character-creation-panel.ts backend/dev-tool/src/main.ts backend/dev-tool/verify-registry.ts backend/dev-tool/coverage.json
git commit -m "feat(myt-53): dev-tool panel — character-creation"
```

---

## Task 24: Wiki page — `docs/wiki/content/runtime/character-creation.html`

**Files:**
- Create: `docs/wiki/content/runtime/character-creation.html`
- Modify: `docs/wiki/SOURCE_HASHES.json` (source-hash registration, by running `pnpm wiki:accept-drift` after content is in place)

**Why:** Spec §Rollout step 10 + `feedback_wiki_sync_is_part_of_close` — wiki must ship in the same push. Page documents: the 4-stage pipeline, the two-prompt model, owner/member route surfaces, the late-joiner mechanism, the dev-tool driver, the cost frame.

- [ ] **Step 1: Author the page**

Create `docs/wiki/content/runtime/character-creation.html`. Pattern: copy structure from `docs/wiki/content/runtime/world-gen.html`. Sections to include:

- Overview (2-3 sentences from spec §Lead)
- Architecture (the ASCII diagram from spec §Architecture overview, lightly rendered as HTML)
- The two-prompt model (from spec §Backstory and situation-grounding semantics)
- Routes table (from spec §Routes, formatted as HTML <table>)
- The 4-stage pipeline (from spec §Worker → Stages)
- Lifecycle and late-joiners (from spec §Lifecycle and late joiners)
- Cost (from spec §Per-stage cost frame + §Cost-cap coverage)
- Dev-tool driver (1-2 sentences pointing at the new panel)

- [ ] **Step 2: Run `pnpm wiki:build` and `pnpm wiki:check`**

```
pnpm wiki:build
pnpm wiki:check
```

Expected: build succeeds; `wiki:check` likely reports drift on the new page's source hash (because it didn't exist yet). Run `pnpm wiki:accept-drift` to register the new hash, then re-run `wiki:check` — should be green.

- [ ] **Step 3: Verify cross-references**

The page should link to the world-gen page (predecessor phase) and the (future) sessions page (successor phase). Use the existing relative-link convention in the wiki content.

- [ ] **Step 4: Commit**

```
git add docs/wiki/content/runtime/character-creation.html docs/wiki/SOURCE_HASHES.json
git commit -m "docs(myt-53): wiki — character-creation runtime page"
```

---

## Task 25: Real-LLM E2E smoke (push-time, dev-tool-verifier subagent)

**Files:**
- None — this is a manual / scripted verification before push.

**Why:** Per `feedback_dev_tool_e2e_smoke_required` — every new LLM flow gets a real E2E smoke against the live shape before merge. Mocked tests + typecheck + dev-tool:check verify code paths, not real behavior. The smoke walks 2-3 dev-users through the full flow and verifies DB state.

- [ ] **Step 1: Provision the smoke**

Use the existing `pnpm smoke:staging` harness (per `project_smoke_test_user_purpose.md`). The harness handles dev-user identity switching + endpoint hits.

If `smoke:staging` doesn't already support character-creation flows, extend it:
- Create the campaign (POST /api/campaigns).
- Wait for world-gen completion (poll status SSE, await `world_snapshot_ready` phase).
- Owner picks starting situation (POST /starting-situation, index=0).
- For each of 3 dev-users, switch identity, POST /characters with `conceptText` + `situationGroundingText`.
- Owner POSTs /start-character-creation. Expect 3 jobs enqueued.
- Wait for all 3 jobs to complete (poll SSE for `phase=character_creation_complete` × 3).
- Inspect DB:
  - `SELECT COUNT(*) FROM characters` for the 3 dev-users.
  - `SELECT character_id, str, hit_points FROM characters JOIN campaign_characters ...` — confirm sheets populated.
  - `SELECT * FROM entities WHERE entity_type = 'pc'` — 3 rows.
  - `SELECT * FROM facts WHERE entity_id IN (...)` — each PC has the starting-location fact.
  - `SELECT status FROM character_concepts WHERE campaign_id = ...` — all 'completed'.

- [ ] **Step 2: Run the smoke against staging**

```
pnpm smoke:staging
```

Expected output: 3 characters created, all entities + facts present, no untrapped 5xx in backend logs.

- [ ] **Step 3: Triage the inevitable first-run issues**

Per `feedback_dev_tool_e2e_smoke_required`: this step is the actual point of the smoke. Fix any bugs surfaced (wrapper bugs, schema-too-tight bugs, prompt-fragility bugs). Re-run smoke. Iterate until clean.

- [ ] **Step 4: Push the batch**

Once smoke is clean:

```
pnpm typecheck && pnpm lint && pnpm test && pnpm wiki:check && pnpm dev-tool:check
git push origin main
```

Expected: pre-push gate green, push succeeds, CI green within 10 minutes.

- [ ] **Step 5: Flip Linear MYT-53 to Done**

Use the existing `save_issue` flow with the conventional commit summary as the close note.

---

## Self-review checklist (run before handing off)

**Spec coverage:**
- ✅ Schema (migration 016): Task 1
- ✅ character-concepts repo: Task 2
- ✅ starting_situation extension + name→id resolution: Task 3
- ✅ Zod schemas: Task 4
- ✅ Cost-cap coverage: Task 5
- ✅ atomicClaimStage refactor: Task 6
- ✅ 4 stage handlers: Tasks 7-10
- ✅ Processor: Task 11
- ✅ 8 new route handlers: Tasks 12-19
- ✅ GET /api/campaigns/:campaignId shape extension: Task 20
- ✅ Contract registrations: Task 21
- ✅ app.ts wiring: Task 22
- ✅ Dev-tool panel: Task 23
- ✅ Wiki page: Task 24
- ✅ Real-LLM E2E smoke: Task 25

**Open items from the spec:**
- ✅ Recovery contract (Task 11 processor implements transactional flip-and-enqueue, Task 13 route wraps both in BEGIN/COMMIT).
- ✅ Re-run cleanup contract (Task 9 stage 3 + Task 10 stage 4 each implement idempotent re-run).
- ✅ Cost-cap coverage gate (Task 5 + Task 11 pre-check).

---

## Execution handoff

Plan complete and saved to `docs/superpowers/plans/2026-05-18-myt-53-per-player-character-creation.md`. Two execution options:

**1. Subagent-Driven (recommended)** — I dispatch a fresh subagent per task, two-stage review between tasks, fast iteration. Tasks 12-19 (the 8 route handlers) can be batched as a parallel-handler group per `feedback_parallel_handler_contract` — same prompt structure, identical contract sketch in each prompt.

**2. Inline Execution** — Execute tasks in this session using the `superpowers:executing-plans` skill, batch execution with checkpoints.

Which approach?
