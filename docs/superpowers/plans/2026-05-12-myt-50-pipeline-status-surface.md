# MYT-50 Pipeline status surface — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Land the campaign-scoped pipeline status surface — snapshot route + SSE-stream route + Redis pub/sub bridge + dev tool status panel — so MYT-51+ can render live pipeline state.

**Architecture:** API process holds ONE dedicated ioredis subscriber (constructed via `redis.duplicate({ retryStrategy, maxRetriesPerRequest: null })` so it doesn't break the command-mode `redisRealtime` client used by rate-limit + ws-ticket). PSUBSCRIBE pattern `{redisKeyPrefix}pipeline:campaign:*` covers every campaign's channel; an in-memory `Map<campaignId, Set<SseSink>>` fans incoming PMESSAGEs out to attached SSE responses. The SSE handler writes the initial snapshot as the first stream frame (eliminating the snapshot-then-attach race), then forwards live events. Phase derivation is a pure function on `pipeline_runs + campaigns.status + worlds.status` rows.

**Tech Stack:** Fastify v5 (existing) + ioredis subscriber-mode + pino structured logs + Postgres via `pg.Pool` + Vitest (with real Redis + real Postgres test fixtures). No new dependencies.

**Working directory:** `.worktrees/myt-50/` on branch `myt-50-pipeline-status`. All commands run from this directory unless noted.

**Spec:** `docs/superpowers/specs/2026-05-12-myt-50-pipeline-status-surface-design.md`

---

## File structure

New files:

```
backend/src/sse/
├── derive-phase.ts                       # pure: { campaign, world, runs } → { phase, stages, cumulativeCostUsd }
├── pipeline-subscriber.ts                # dedicated subscriber client + PSUBSCRIBE + attach/detach + reconnect
├── sse-connection.ts                     # Fastify reply wrapper (hijack, keepalive, idle-timeout, back-pressure, dual-close)
├── connection-counter.ts                 # 60s periodic log + max-since-last + wasted-message counter
└── __tests__/
    ├── derive-phase.test.ts
    ├── pipeline-subscriber.test.ts       # real Redis (Vitest setup already provides)
    ├── sse-connection.test.ts            # mocked Fastify reply
    └── connection-counter.test.ts        # fake timers

backend/src/repo/
└── pipeline-runs.ts                      # listLatestForCampaign helper (real Postgres tests)
backend/src/repo/__tests__/
└── pipeline-runs.test.ts

backend/src/routes/
├── campaigns.ts                          # NEW plugin; this issue: status + stream routes only
└── __tests__/
    └── campaigns-status.test.ts          # snapshot + SSE integration tests

backend/src/__tests__/
└── pipeline-cross-process.test.ts        # two buildApp() instances, one Redis (mirrors rate-limit-cross-worker.test.ts)

backend/dev-tool/src/components/
└── status-panel.ts                       # paste-campaignId + Watch + render

docs/wiki/content/runtime/
└── pipeline-status.html                  # wiki page
```

Modified files:

```
backend/src/app.ts                        # boot subscriber + counter; shutdown ordering
backend/src/contract/pipeline-routes.ts   # add 2 routes
backend/src/contract/pipeline-events.ts   # add 11 event types + PipelineEvent union + PipelinePhase
backend/dev-tool/coverage.json            # +2 routes, +11 events (5 in exempt.events)
backend/dev-tool/src/main.ts              # mount status-panel
```

---

### Task 1: `derive-phase.ts` pure function with full phase-table tests

Computes `phase` + per-stage list + cumulative cost from snapshot rows. Pure function; no I/O. The hardest case is multi-row-per-stage (retries) — the latest attempt wins.

**Files:**
- Create: `backend/src/sse/derive-phase.ts`
- Create: `backend/src/sse/__tests__/derive-phase.test.ts`

- [ ] **Step 1: Write the failing test file**

```ts
// backend/src/sse/__tests__/derive-phase.test.ts
import { describe, expect, it } from 'vitest'
import { derivePhase, type CampaignRow, type WorldRow, type PipelineRunRow } from '../derive-phase.js'

const baseCampaign: CampaignRow = {
  id: 'cmp-1',
  status: 'setup',
  world_id: 'wld-1',
}

const baseWorld: WorldRow = {
  id: 'wld-1',
  status: 'generating',
}

function run(partial: Partial<PipelineRunRow>): PipelineRunRow {
  return {
    stage: 'concept_intake',
    status: 'completed',
    user_id: null,
    world_id: 'wld-1',
    campaign_id: null,
    started_at: new Date('2026-05-12T00:00:00Z'),
    completed_at: new Date('2026-05-12T00:01:00Z'),
    cost_usd: 0.5,
    ...partial,
  }
}

describe('derivePhase', () => {
  it('returns not_started when there are no runs', () => {
    const result = derivePhase({
      campaign: baseCampaign,
      world: baseWorld,
      runs: [],
    })
    expect(result.phase).toBe('not_started')
    expect(result.stages).toEqual([])
    expect(result.cumulativeCostUsd).toBe(0)
  })

  it('returns world_gen when a worldgen stage is running', () => {
    const result = derivePhase({
      campaign: baseCampaign,
      world: baseWorld,
      runs: [run({ stage: 'world_and_factions', status: 'running', completed_at: null })],
    })
    expect(result.phase).toBe('world_gen')
  })

  it('returns world_gen_failed when a worldgen stage failed and no retry is running', () => {
    const result = derivePhase({
      campaign: baseCampaign,
      world: { ...baseWorld, status: 'failed' },
      runs: [
        run({ stage: 'concept_intake', status: 'completed' }),
        run({ stage: 'world_and_factions', status: 'failed', completed_at: null }),
      ],
    })
    expect(result.phase).toBe('world_gen_failed')
  })

  it('treats failed-then-retried-completed as completed for that stage', () => {
    // listLatestForCampaign returns one row per stage (the latest), so derivePhase
    // never sees two rows for the same stage simultaneously. Verify behavior on the
    // post-DISTINCT-ON view: the "latest" row is the completed retry.
    const result = derivePhase({
      campaign: baseCampaign,
      world: { ...baseWorld, status: 'complete' },
      runs: [
        run({ stage: 'concept_intake', status: 'completed' }),
        run({ stage: 'world_and_factions', status: 'completed' }),
        run({ stage: 'locations_and_npcs', status: 'completed' }),
        run({ stage: 'starting_situation', status: 'completed' }),
        run({ stage: 'random_tables', status: 'completed' }),
      ],
    })
    expect(result.phase).toBe('world_ready')
  })

  it('returns world_ready when worlds.status=complete and no charcreation runs yet', () => {
    const result = derivePhase({
      campaign: baseCampaign,
      world: { ...baseWorld, status: 'complete' },
      runs: [
        run({ stage: 'concept_intake', status: 'completed' }),
        run({ stage: 'world_and_factions', status: 'completed' }),
        run({ stage: 'locations_and_npcs', status: 'completed' }),
        run({ stage: 'starting_situation', status: 'completed' }),
        run({ stage: 'random_tables', status: 'completed' }),
      ],
    })
    expect(result.phase).toBe('world_ready')
  })

  it('returns character_creation when a charcreation stage is running', () => {
    const result = derivePhase({
      campaign: baseCampaign,
      world: { ...baseWorld, status: 'complete' },
      runs: [
        run({ stage: 'concept_intake', status: 'completed' }),
        run({
          stage: 'character_concept',
          status: 'running',
          campaign_id: 'cmp-1',
          world_id: null,
          user_id: 'usr-1',
          completed_at: null,
        }),
      ],
    })
    expect(result.phase).toBe('character_creation')
  })

  it('returns post_creation when materialize_relationships is running', () => {
    const result = derivePhase({
      campaign: baseCampaign,
      world: { ...baseWorld, status: 'complete' },
      runs: [
        run({
          stage: 'materialize_relationships',
          status: 'running',
          campaign_id: 'cmp-1',
          world_id: null,
          completed_at: null,
        }),
      ],
    })
    expect(result.phase).toBe('post_creation')
  })

  it('returns complete when campaigns.status=active', () => {
    const result = derivePhase({
      campaign: { ...baseCampaign, status: 'active' },
      world: { ...baseWorld, status: 'complete' },
      runs: [run({ stage: 'continuity_check', status: 'completed' })],
    })
    expect(result.phase).toBe('complete')
  })

  it('returns failed when a non-worldgen stage failed with no retry running', () => {
    const result = derivePhase({
      campaign: baseCampaign,
      world: { ...baseWorld, status: 'complete' },
      runs: [
        run({
          stage: 'character_sheet',
          status: 'failed',
          campaign_id: 'cmp-1',
          world_id: null,
          user_id: 'usr-1',
          completed_at: null,
        }),
      ],
    })
    expect(result.phase).toBe('failed')
  })

  it('sums cumulative cost across all rows', () => {
    const result = derivePhase({
      campaign: baseCampaign,
      world: baseWorld,
      runs: [
        run({ stage: 'concept_intake', cost_usd: 0.25 }),
        run({ stage: 'world_and_factions', cost_usd: 1.5 }),
        run({ stage: 'locations_and_npcs', cost_usd: 2.0 }),
      ],
    })
    expect(result.cumulativeCostUsd).toBeCloseTo(3.75)
  })

  it('emits a stage list ordered by stage taxonomy', () => {
    const result = derivePhase({
      campaign: baseCampaign,
      world: baseWorld,
      // input order shuffled
      runs: [
        run({ stage: 'random_tables', status: 'completed' }),
        run({ stage: 'concept_intake', status: 'completed' }),
        run({ stage: 'world_and_factions', status: 'completed' }),
      ],
    })
    expect(result.stages.map((s) => s.stage)).toEqual([
      'concept_intake',
      'world_and_factions',
      'random_tables',
    ])
  })

  it('preserves per-player rows in the stage list', () => {
    const result = derivePhase({
      campaign: baseCampaign,
      world: { ...baseWorld, status: 'complete' },
      runs: [
        run({
          stage: 'character_concept',
          status: 'completed',
          campaign_id: 'cmp-1',
          world_id: null,
          user_id: 'usr-1',
        }),
        run({
          stage: 'character_concept',
          status: 'running',
          campaign_id: 'cmp-1',
          world_id: null,
          user_id: 'usr-2',
          completed_at: null,
        }),
      ],
    })
    const charConceptStages = result.stages.filter((s) => s.stage === 'character_concept')
    expect(charConceptStages).toHaveLength(2)
    expect(charConceptStages.map((s) => s.userId).sort()).toEqual(['usr-1', 'usr-2'])
  })
})
```

- [ ] **Step 2: Run tests; confirm they fail with "module not found"**

```bash
pnpm --filter @mythrun/backend test src/sse/__tests__/derive-phase.test.ts --run
```

Expected: failure with `Cannot find module '../derive-phase.js'`.

- [ ] **Step 3: Implement `derive-phase.ts`**

```ts
// backend/src/sse/derive-phase.ts
//
// Pure phase-derivation function. Reads from snapshot row shapes (no I/O).
// The repo helper `listLatestForCampaign` returns at most one row per
// (stage, user_id) — already DISTINCT ON'd — so this function doesn't
// need to dedupe.

export type PipelinePhase =
  | 'not_started'
  | 'world_gen'
  | 'world_gen_failed'
  | 'world_ready'
  | 'character_creation'
  | 'post_creation'
  | 'complete'
  | 'failed'

export interface CampaignRow {
  readonly id: string
  readonly status: 'setup' | 'active' | 'archived'
  readonly world_id: string
}

export interface WorldRow {
  readonly id: string
  readonly status: 'generating' | 'complete' | 'failed'
}

export interface PipelineRunRow {
  readonly stage: string
  readonly status: 'pending' | 'running' | 'completed' | 'failed'
  readonly user_id: string | null
  readonly world_id: string | null
  readonly campaign_id: string | null
  readonly started_at: Date | null
  readonly completed_at: Date | null
  readonly cost_usd: number
}

export interface StageEntry {
  readonly stage: string
  readonly status: 'pending' | 'running' | 'completed' | 'failed'
  readonly userId: string | null
  readonly costUsd: number
}

export interface PhaseAndStages {
  readonly phase: PipelinePhase
  readonly stages: readonly StageEntry[]
  readonly cumulativeCostUsd: number
}

// Stage taxonomy — order-preserving for the snapshot display.
// Worldgen stages run on the world; charcreation stages run per-player;
// post-creation stages are campaign-scoped (campaign_id set, user_id null).
export const WORLDGEN_STAGES = [
  'concept_intake',
  'world_and_factions',
  'locations_and_npcs',
  'starting_situation',
  'random_tables',
] as const

export const CHARCREATION_STAGES = [
  'location_selection',
  'character_concept',
  'character_sheet',
  'character_integration',
] as const

export const POSTCREATION_STAGES = [
  'materialize_relationships',
  'continuity_check',
] as const

const STAGE_ORDER: readonly string[] = [
  ...WORLDGEN_STAGES,
  ...CHARCREATION_STAGES,
  ...POSTCREATION_STAGES,
]

function stageScope(stage: string): 'worldgen' | 'charcreation' | 'postcreation' | 'unknown' {
  if ((WORLDGEN_STAGES as readonly string[]).includes(stage)) return 'worldgen'
  if ((CHARCREATION_STAGES as readonly string[]).includes(stage)) return 'charcreation'
  if ((POSTCREATION_STAGES as readonly string[]).includes(stage)) return 'postcreation'
  return 'unknown'
}

export function derivePhase(input: {
  readonly campaign: CampaignRow
  readonly world: WorldRow
  readonly runs: readonly PipelineRunRow[]
}): PhaseAndStages {
  const { campaign, world, runs } = input

  // Bucket runs by scope.
  const worldgen = runs.filter((r) => stageScope(r.stage) === 'worldgen')
  const charcreation = runs.filter((r) => stageScope(r.stage) === 'charcreation')
  const postcreation = runs.filter((r) => stageScope(r.stage) === 'postcreation')

  // Sort stages by taxonomy order, then by user_id (null first) for per-player stability.
  const stages: StageEntry[] = [...runs]
    .sort((a, b) => {
      const ai = STAGE_ORDER.indexOf(a.stage)
      const bi = STAGE_ORDER.indexOf(b.stage)
      if (ai !== bi) return ai - bi
      const au = a.user_id ?? ''
      const bu = b.user_id ?? ''
      return au.localeCompare(bu)
    })
    .map((r) => ({
      stage: r.stage,
      status: r.status,
      userId: r.user_id,
      costUsd: r.cost_usd,
    }))

  const cumulativeCostUsd = runs.reduce((acc, r) => acc + r.cost_usd, 0)

  const phase = computePhase({
    campaign,
    world,
    worldgen,
    charcreation,
    postcreation,
  })

  return { phase, stages, cumulativeCostUsd }
}

function computePhase(input: {
  readonly campaign: CampaignRow
  readonly world: WorldRow
  readonly worldgen: readonly PipelineRunRow[]
  readonly charcreation: readonly PipelineRunRow[]
  readonly postcreation: readonly PipelineRunRow[]
}): PipelinePhase {
  const { campaign, world, worldgen, charcreation, postcreation } = input

  // Active campaign overrides everything.
  if (campaign.status === 'active') return 'complete'

  // Empty: nothing has started.
  if (worldgen.length === 0 && charcreation.length === 0 && postcreation.length === 0) {
    return 'not_started'
  }

  // Worldgen failure surfaces if the world is failed AND no later-stage runs have made progress.
  if (world.status === 'failed') {
    return 'world_gen_failed'
  }

  // Worldgen running.
  if (worldgen.some((r) => r.status === 'running' || r.status === 'pending')) {
    return 'world_gen'
  }

  // Worldgen failed but not world-status-failed: rare, treat as world_gen_failed.
  if (worldgen.some((r) => r.status === 'failed')) {
    return 'world_gen_failed'
  }

  // Post-creation running.
  if (postcreation.some((r) => r.status === 'running' || r.status === 'pending')) {
    return 'post_creation'
  }

  // Charcreation running.
  if (charcreation.some((r) => r.status === 'running' || r.status === 'pending')) {
    return 'character_creation'
  }

  // Charcreation failure → failed (post-worldgen).
  if (charcreation.some((r) => r.status === 'failed') || postcreation.some((r) => r.status === 'failed')) {
    return 'failed'
  }

  // World complete, no later activity → world_ready.
  if (world.status === 'complete') return 'world_ready'

  // Default safety net.
  return 'not_started'
}
```

- [ ] **Step 4: Run tests; confirm they pass**

```bash
pnpm --filter @mythrun/backend test src/sse/__tests__/derive-phase.test.ts --run
```

Expected: 11 tests pass.

- [ ] **Step 5: Verify typecheck + lint**

```bash
pnpm --filter @mythrun/backend typecheck
pnpm --filter @mythrun/backend exec eslint src/sse/derive-phase.ts src/sse/__tests__/derive-phase.test.ts
```

Both exit 0.

- [ ] **Step 6: Commit**

```bash
git add backend/src/sse/derive-phase.ts backend/src/sse/__tests__/derive-phase.test.ts
git commit -m "feat(myt-50): derivePhase pure function + 11 phase-state tests

Phase derivation reads campaign + world + pipeline_runs and returns
{ phase, stages, cumulativeCostUsd }. Stage taxonomy lives here as
const arrays. Multi-row-per-stage handling is upstream (repo's
DISTINCT ON); derivePhase trusts at-most-one-row-per-(stage,user)."
```

---

### Task 2: `pipeline-runs.ts` repo with NUMERIC-safe SQL + integration test

The repo helper that powers the snapshot. Uses `::float8` cast so `pg` returns numbers, not strings.

**Files:**
- Create: `backend/src/repo/pipeline-runs.ts`
- Create: `backend/src/repo/__tests__/pipeline-runs.test.ts`

- [ ] **Step 1: Write the failing integration test**

```ts
// backend/src/repo/__tests__/pipeline-runs.test.ts
import { describe, expect, it, beforeAll, afterAll, beforeEach } from 'vitest'
import { Pool } from 'pg'
import { uuidv7 } from '../uuidv7.js'
import { createPipelineRunsRepo } from '../pipeline-runs.js'

describe('pipeline-runs repo', () => {
  let pool: Pool

  beforeAll(() => {
    pool = new Pool({ connectionString: process.env.DATABASE_URL })
  })

  afterAll(async () => {
    await pool.end()
  })

  beforeEach(async () => {
    await pool.query('DELETE FROM pipeline_runs')
  })

  async function insertCampaign(): Promise<{ campaignId: string; worldId: string; userId: string }> {
    const userId = uuidv7()
    const worldId = uuidv7()
    const campaignId = uuidv7()
    await pool.query(
      `INSERT INTO users (id, cognito_sub, display_name, username) VALUES ($1, $2, $3, $4)`,
      [userId, `s-${userId}`, 'Test', `t${userId.slice(-6)}`],
    )
    await pool.query(
      `INSERT INTO worlds (id, created_by, name, concept) VALUES ($1, $2, 'W', 'C')`,
      [worldId, userId],
    )
    await pool.query(
      `INSERT INTO campaigns (id, world_id, created_by, name) VALUES ($1, $2, $3, 'C')`,
      [campaignId, worldId, userId],
    )
    return { campaignId, worldId, userId }
  }

  it('returns empty array when no runs exist for the campaign', async () => {
    const { campaignId } = await insertCampaign()
    const repo = createPipelineRunsRepo(pool)
    const rows = await repo.listLatestForCampaign(campaignId)
    expect(rows).toEqual([])
  })

  it('returns world-keyed and campaign-keyed rows in one query', async () => {
    const { campaignId, worldId, userId } = await insertCampaign()
    await pool.query(
      `INSERT INTO pipeline_runs (id, world_id, stage, status, started_at, cost_usd, user_id)
       VALUES ($1, $2, 'concept_intake', 'completed', now(), 0.5, $3)`,
      [uuidv7(), worldId, userId],
    )
    await pool.query(
      `INSERT INTO pipeline_runs (id, campaign_id, stage, status, started_at, cost_usd, user_id)
       VALUES ($1, $2, 'character_concept', 'running', now(), 1.25, $3)`,
      [uuidv7(), campaignId, userId],
    )
    const repo = createPipelineRunsRepo(pool)
    const rows = await repo.listLatestForCampaign(campaignId)
    expect(rows).toHaveLength(2)
    const stages = rows.map((r) => r.stage).sort()
    expect(stages).toEqual(['character_concept', 'concept_intake'])
  })

  it('returns cost_usd as number, not string (NUMERIC ::float8 cast)', async () => {
    const { campaignId, worldId, userId } = await insertCampaign()
    await pool.query(
      `INSERT INTO pipeline_runs (id, world_id, stage, status, started_at, cost_usd, user_id)
       VALUES ($1, $2, 'concept_intake', 'completed', now(), 0.500000, $3)`,
      [uuidv7(), worldId, userId],
    )
    const repo = createPipelineRunsRepo(pool)
    const rows = await repo.listLatestForCampaign(campaignId)
    expect(rows[0]).toBeDefined()
    expect(typeof rows[0]!.cost_usd).toBe('number')
    expect(rows[0]!.cost_usd).toBeCloseTo(0.5)
  })

  it('returns only the LATEST row per (stage, user_id) when a stage has retries', async () => {
    const { campaignId, worldId, userId } = await insertCampaign()
    await pool.query(
      `INSERT INTO pipeline_runs (id, world_id, stage, status, started_at, cost_usd, user_id)
       VALUES ($1, $2, 'concept_intake', 'failed', now() - interval '1 hour', 0.1, $3)`,
      [uuidv7(), worldId, userId],
    )
    await pool.query(
      `INSERT INTO pipeline_runs (id, world_id, stage, status, started_at, cost_usd, user_id)
       VALUES ($1, $2, 'concept_intake', 'completed', now(), 0.3, $3)`,
      [uuidv7(), worldId, userId],
    )
    const repo = createPipelineRunsRepo(pool)
    const rows = await repo.listLatestForCampaign(campaignId)
    expect(rows).toHaveLength(1)
    expect(rows[0]!.status).toBe('completed')
    expect(rows[0]!.cost_usd).toBeCloseTo(0.3)
  })
})
```

- [ ] **Step 2: Run tests; confirm they fail**

```bash
pnpm --filter @mythrun/backend test src/repo/__tests__/pipeline-runs.test.ts --run
```

Expected: failure with `Cannot find module '../pipeline-runs.js'`.

- [ ] **Step 3: Implement `pipeline-runs.ts`**

```ts
// backend/src/repo/pipeline-runs.ts
//
// Repo helper for the pipeline status surface. Returns the LATEST
// pipeline_runs row per (stage, user_id) tuple for a campaign — both
// world-keyed and campaign-keyed rows are unioned through the
// composition rule documented in parent spec §9 Resume Endpoint.
//
// cost_usd is NUMERIC(10,6) in the schema; `pg` returns NUMERIC as
// string by default. The query casts to ::float8 so the column lands
// in JS as `number`. This is local to the query (no global pg.types
// parser override).

import type { Pool } from 'pg'
import type { PipelineRunRow } from '../sse/derive-phase.js'

export interface PipelineRunsRepo {
  /**
   * Returns the latest pipeline_runs row per (stage, user_id) tuple
   * for a campaign. Empty if the campaign doesn't exist (caller's
   * auth pre-handler should already have 403'd in that case).
   */
  readonly listLatestForCampaign: (campaignId: string) => Promise<readonly PipelineRunRow[]>
}

interface PipelineRunRowRaw {
  readonly stage: string
  readonly status: 'pending' | 'running' | 'completed' | 'failed'
  readonly user_id: string | null
  readonly world_id: string | null
  readonly campaign_id: string | null
  readonly started_at: Date | null
  readonly completed_at: Date | null
  readonly cost_usd: number
}

const QUERY = `
  WITH all_runs AS (
    SELECT stage, status, user_id, world_id, campaign_id,
           started_at, completed_at, COALESCE(cost_usd, 0)::float8 AS cost_usd
    FROM pipeline_runs
    WHERE campaign_id = $1
       OR world_id = (SELECT world_id FROM campaigns WHERE id = $1)
  )
  SELECT DISTINCT ON (stage, COALESCE(user_id, '00000000-0000-0000-0000-000000000000'::uuid))
         stage, status, user_id, world_id, campaign_id,
         started_at, completed_at, cost_usd
  FROM all_runs
  ORDER BY stage,
           COALESCE(user_id, '00000000-0000-0000-0000-000000000000'::uuid),
           started_at DESC NULLS LAST
`

export function createPipelineRunsRepo(pool: Pool): PipelineRunsRepo {
  return {
    async listLatestForCampaign(campaignId: string): Promise<readonly PipelineRunRow[]> {
      const result = await pool.query<PipelineRunRowRaw>(QUERY, [campaignId])
      return result.rows
    },
  }
}
```

- [ ] **Step 4: Run tests; confirm they pass**

```bash
pnpm --filter @mythrun/backend test src/repo/__tests__/pipeline-runs.test.ts --run
```

Expected: 4 tests pass. (Requires `pnpm db:up` + `pnpm --filter @mythrun/backend db:migrate` ahead of time per the existing test convention.)

- [ ] **Step 5: Verify typecheck + lint, then commit**

```bash
pnpm --filter @mythrun/backend typecheck
pnpm --filter @mythrun/backend exec eslint src/repo/pipeline-runs.ts src/repo/__tests__/pipeline-runs.test.ts
git add backend/src/repo/pipeline-runs.ts backend/src/repo/__tests__/pipeline-runs.test.ts
git commit -m "feat(myt-50): pipeline-runs repo (listLatestForCampaign) + integration tests

DISTINCT ON returns latest row per (stage, user_id) so retries collapse
to their most recent attempt. ::float8 cast forces cost_usd to land as
JS number; without it pg returns NUMERIC as string and the snapshot's
cumulative-cost math silently concatenates."
```

---

### Task 3: `connection-counter.ts` with periodic log + max-since-last + fake-timer tests

**Files:**
- Create: `backend/src/sse/connection-counter.ts`
- Create: `backend/src/sse/__tests__/connection-counter.test.ts`

- [ ] **Step 1: Write the failing tests**

```ts
// backend/src/sse/__tests__/connection-counter.test.ts
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import pino from 'pino'
import { createConnectionCounter } from '../connection-counter.js'

describe('connection-counter', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('starts at zero', () => {
    const logger = pino({ level: 'silent' })
    const counter = createConnectionCounter(logger)
    expect(counter.current()).toBe(0)
  })

  it('increments and decrements', () => {
    const logger = pino({ level: 'silent' })
    const counter = createConnectionCounter(logger)
    counter.increment()
    counter.increment()
    counter.decrement()
    expect(counter.current()).toBe(1)
  })

  it('tracks wasted messages independently', () => {
    const logger = pino({ level: 'silent' })
    const counter = createConnectionCounter(logger)
    counter.incrementWasted()
    counter.incrementWasted()
    counter.incrementWasted()
    counter.increment()
    expect(counter.current()).toBe(1)
  })

  it('logs every 60 seconds with count + max_since_last + wasted_msgs', () => {
    const logs: Array<Record<string, unknown>> = []
    const logger = pino(
      { level: 'info' },
      {
        write(msg: string): void {
          logs.push(JSON.parse(msg) as Record<string, unknown>)
        },
      },
    )
    const counter = createConnectionCounter(logger)
    counter.increment()
    counter.increment()
    counter.increment()
    counter.decrement()
    counter.incrementWasted()
    const stop = counter.startPeriodicLog()

    vi.advanceTimersByTime(60_000)

    const line = logs.find((l) => l['event'] === 'sse.connections.active')
    expect(line).toBeDefined()
    expect(line?.['count']).toBe(2)
    expect(line?.['max_since_last']).toBe(3)
    expect(line?.['wasted_msgs']).toBe(1)

    stop()
  })

  it('resets max_since_last and wasted_msgs after each log emission', () => {
    const logs: Array<Record<string, unknown>> = []
    const logger = pino(
      { level: 'info' },
      {
        write(msg: string): void {
          logs.push(JSON.parse(msg) as Record<string, unknown>)
        },
      },
    )
    const counter = createConnectionCounter(logger)
    counter.increment()
    counter.incrementWasted()
    const stop = counter.startPeriodicLog()

    vi.advanceTimersByTime(60_000)
    vi.advanceTimersByTime(60_000)

    const lines = logs.filter((l) => l['event'] === 'sse.connections.active')
    expect(lines.length).toBeGreaterThanOrEqual(2)
    const second = lines[1]
    expect(second?.['max_since_last']).toBe(1) // current after first emission resets to current
    expect(second?.['wasted_msgs']).toBe(0)    // reset after emission

    stop()
  })

  it('stopPeriodicLog clears the interval', () => {
    const logs: Array<Record<string, unknown>> = []
    const logger = pino(
      { level: 'info' },
      {
        write(msg: string): void {
          logs.push(JSON.parse(msg) as Record<string, unknown>)
        },
      },
    )
    const counter = createConnectionCounter(logger)
    counter.increment()
    const stop = counter.startPeriodicLog()
    stop()
    vi.advanceTimersByTime(60_000)
    const lines = logs.filter((l) => l['event'] === 'sse.connections.active')
    expect(lines).toHaveLength(0)
  })
})
```

- [ ] **Step 2: Confirm fail**

```bash
pnpm --filter @mythrun/backend test src/sse/__tests__/connection-counter.test.ts --run
```

Expected: `Cannot find module '../connection-counter.js'`.

- [ ] **Step 3: Implement `connection-counter.ts`**

```ts
// backend/src/sse/connection-counter.ts
//
// Process-scoped SSE connection counter. Emits a structured pino log
// every 60s with current count, max-since-last-emission, and wasted-
// message count. The setInterval handle is unref()'d so it doesn't pin
// the event loop during shutdown.

import type pino from 'pino'

const PERIODIC_LOG_MS = 60_000

export interface ConnectionCounter {
  readonly increment: () => void
  readonly decrement: () => void
  readonly current: () => number
  readonly incrementWasted: () => void
  /** Starts the periodic log; returns an unsubscribe fn that clears the interval. */
  readonly startPeriodicLog: () => () => void
}

export function createConnectionCounter(logger: pino.Logger): ConnectionCounter {
  let count = 0
  let maxSinceLast = 0
  let wastedMsgs = 0

  function increment(): void {
    count++
    if (count > maxSinceLast) maxSinceLast = count
  }

  function decrement(): void {
    count = Math.max(0, count - 1)
  }

  function incrementWasted(): void {
    wastedMsgs++
  }

  function current(): number {
    return count
  }

  function startPeriodicLog(): () => void {
    const handle = setInterval(() => {
      logger.info(
        {
          event: 'sse.connections.active',
          count,
          max_since_last: maxSinceLast,
          wasted_msgs: wastedMsgs,
          taskRevision: process.env['ECS_TASK_REVISION'] ?? null,
        },
        'sse connections snapshot',
      )
      // Reset counters; max_since_last starts from current so the next
      // window's peak still captures any spike.
      maxSinceLast = count
      wastedMsgs = 0
    }, PERIODIC_LOG_MS)
    handle.unref()
    return () => {
      clearInterval(handle)
    }
  }

  return { increment, decrement, current, incrementWasted, startPeriodicLog }
}
```

- [ ] **Step 4: Confirm tests pass**

```bash
pnpm --filter @mythrun/backend test src/sse/__tests__/connection-counter.test.ts --run
```

Expected: 6 tests pass.

- [ ] **Step 5: Lint + commit**

```bash
pnpm --filter @mythrun/backend exec eslint src/sse/connection-counter.ts src/sse/__tests__/connection-counter.test.ts
git add backend/src/sse/connection-counter.ts backend/src/sse/__tests__/connection-counter.test.ts
git commit -m "feat(myt-50): connection-counter with 60s periodic log + max-since-last

Pino-logged metric (event: 'sse.connections.active') with count,
max_since_last (resets on emission), and wasted_msgs (PMESSAGE arrived
for an unattached campaign). setInterval is unref()'d so short-lived
ECS tasks don't pin the event loop during shutdown. taskRevision pulled
from ECS_TASK_REVISION env var for fleet-aggregate Logs Insights."
```

---

### Task 4: `sse-connection.ts` — Fastify reply wrapper with hijack + keepalive + idle-timeout + back-pressure

The most subtle module. Owns the response lifecycle: `reply.hijack()` before any raw writes, SSE headers, keepalive timer (re-armed after each event-write), 30-min idle-timeout, back-pressure detection via `drain`, dual `'close'` listeners, idempotent close.

**Files:**
- Create: `backend/src/sse/sse-connection.ts`
- Create: `backend/src/sse/__tests__/sse-connection.test.ts`

- [ ] **Step 1: Write the failing tests**

```ts
// backend/src/sse/__tests__/sse-connection.test.ts
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import { EventEmitter } from 'node:events'
import pino from 'pino'
import { openSseConnection, type CloseReason } from '../sse-connection.js'

interface MockRaw extends EventEmitter {
  headersSent: boolean
  written: string[]
  ended: boolean
  writeHead: (status: number, headers: Record<string, string>) => MockRaw
  write: (chunk: string) => boolean
  end: () => void
  // Test-only: control the next write's return value.
  __nextWriteReturns: boolean
}

function makeRaw(): MockRaw {
  const raw = new EventEmitter() as MockRaw
  raw.headersSent = false
  raw.written = []
  raw.ended = false
  raw.__nextWriteReturns = true
  raw.writeHead = (_status, _headers): MockRaw => {
    raw.headersSent = true
    return raw
  }
  raw.write = (chunk: string): boolean => {
    if (raw.ended) throw new Error('write after end')
    raw.written.push(chunk)
    return raw.__nextWriteReturns
  }
  raw.end = (): void => {
    raw.ended = true
  }
  return raw
}

interface MockReply {
  hijacked: boolean
  raw: MockRaw
  hijack: () => void
}

function makeReply(): MockReply {
  return {
    hijacked: false,
    raw: makeRaw(),
    hijack(): void {
      this.hijacked = true
    },
  }
}

function makeRequest(): { raw: EventEmitter } {
  return { raw: new EventEmitter() }
}

describe('sse-connection', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('calls reply.hijack() before writing headers', () => {
    const reply = makeReply()
    const request = makeRequest()
    const onClose = vi.fn()
    openSseConnection({
      request: request as never,
      reply: reply as never,
      logger: pino({ level: 'silent' }),
      onClose,
    })
    expect(reply.hijacked).toBe(true)
    expect(reply.raw.headersSent).toBe(true)
  })

  it('writes SSE response headers (no Connection: keep-alive)', () => {
    const reply = makeReply()
    let capturedHeaders: Record<string, string> = {}
    reply.raw.writeHead = (_status: number, headers: Record<string, string>): MockRaw => {
      capturedHeaders = headers
      reply.raw.headersSent = true
      return reply.raw
    }
    const request = makeRequest()
    openSseConnection({
      request: request as never,
      reply: reply as never,
      logger: pino({ level: 'silent' }),
      onClose: () => undefined,
    })
    expect(capturedHeaders['Content-Type']).toBe('text/event-stream; charset=utf-8')
    expect(capturedHeaders['Cache-Control']).toBe('no-cache, no-transform')
    expect(capturedHeaders['X-Accel-Buffering']).toBe('no')
    expect(capturedHeaders['Connection']).toBeUndefined()
  })

  it('write returns boolean from underlying raw.write', () => {
    const reply = makeReply()
    const request = makeRequest()
    const sink = openSseConnection({
      request: request as never,
      reply: reply as never,
      logger: pino({ level: 'silent' }),
      onClose: () => undefined,
    })
    reply.raw.__nextWriteReturns = true
    expect(sink.write('data: hi\n\n')).toBe(true)
    reply.raw.__nextWriteReturns = false
    expect(sink.write('data: bye\n\n')).toBe(false)
  })

  it('emits keepalive comment frame every 25 seconds when no events flow', () => {
    const reply = makeReply()
    const request = makeRequest()
    openSseConnection({
      request: request as never,
      reply: reply as never,
      logger: pino({ level: 'silent' }),
      onClose: () => undefined,
    })
    vi.advanceTimersByTime(25_000)
    expect(reply.raw.written.some((w) => w.startsWith(':keepalive'))).toBe(true)
  })

  it('keepalive timer re-arms after each event-write (no double-emit on busy stream)', () => {
    const reply = makeReply()
    const request = makeRequest()
    const sink = openSseConnection({
      request: request as never,
      reply: reply as never,
      logger: pino({ level: 'silent' }),
      onClose: () => undefined,
    })
    vi.advanceTimersByTime(20_000)
    sink.write('event: phase\ndata: {"phase":"world_gen"}\n\n')
    vi.advanceTimersByTime(20_000) // total 40s of wall, but the timer reset after the write
    const keepalives = reply.raw.written.filter((w) => w.startsWith(':keepalive')).length
    expect(keepalives).toBe(0)
  })

  it('closes with idle-timeout reason after 30 min no event', () => {
    const reply = makeReply()
    const request = makeRequest()
    const onClose = vi.fn()
    openSseConnection({
      request: request as never,
      reply: reply as never,
      logger: pino({ level: 'silent' }),
      onClose,
    })
    vi.advanceTimersByTime(30 * 60_000)
    const closeFrame = reply.raw.written.find((w) => w.includes('event: close'))
    expect(closeFrame).toContain('idle-timeout')
    expect(reply.raw.ended).toBe(true)
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('runs onClose exactly once when request.raw fires close', () => {
    const reply = makeReply()
    const request = makeRequest()
    const onClose = vi.fn()
    openSseConnection({
      request: request as never,
      reply: reply as never,
      logger: pino({ level: 'silent' }),
      onClose,
    })
    request.raw.emit('close')
    request.raw.emit('close') // idempotent
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('runs onClose exactly once when reply.raw fires close (dual listener)', () => {
    const reply = makeReply()
    const request = makeRequest()
    const onClose = vi.fn()
    openSseConnection({
      request: request as never,
      reply: reply as never,
      logger: pino({ level: 'silent' }),
      onClose,
    })
    reply.raw.emit('close')
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('sink.close(reason) writes close frame + ends response + runs onClose', () => {
    const reply = makeReply()
    const request = makeRequest()
    const onClose = vi.fn()
    const sink = openSseConnection({
      request: request as never,
      reply: reply as never,
      logger: pino({ level: 'silent' }),
      onClose,
    })
    sink.close('server-shutdown')
    expect(reply.raw.written.some((w) => w.includes('server-shutdown'))).toBe(true)
    expect(reply.raw.ended).toBe(true)
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('sink.close is idempotent (does not re-write or re-fire onClose)', () => {
    const reply = makeReply()
    const request = makeRequest()
    const onClose = vi.fn()
    const sink = openSseConnection({
      request: request as never,
      reply: reply as never,
      logger: pino({ level: 'silent' }),
      onClose,
    })
    sink.close('idle-timeout')
    const writeCount = reply.raw.written.length
    sink.close('server-shutdown')
    expect(reply.raw.written.length).toBe(writeCount)
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('closes with back-pressure when write returns false and drain does not fire in 5s', () => {
    const reply = makeReply()
    const request = makeRequest()
    const onClose = vi.fn()
    const sink = openSseConnection({
      request: request as never,
      reply: reply as never,
      logger: pino({ level: 'silent' }),
      onClose,
    })
    reply.raw.__nextWriteReturns = false
    sink.write('data: slow\n\n')
    vi.advanceTimersByTime(5_000)
    const closeFrame = reply.raw.written.find((w) => w.includes('event: close'))
    expect(closeFrame).toContain('back-pressure')
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('drain event before timeout clears the back-pressure close', () => {
    const reply = makeReply()
    const request = makeRequest()
    const onClose = vi.fn()
    const sink = openSseConnection({
      request: request as never,
      reply: reply as never,
      logger: pino({ level: 'silent' }),
      onClose,
    })
    reply.raw.__nextWriteReturns = false
    sink.write('data: slow\n\n')
    vi.advanceTimersByTime(2_000)
    reply.raw.emit('drain')
    vi.advanceTimersByTime(5_000)
    expect(onClose).not.toHaveBeenCalled()
  })
})
```

- [ ] **Step 2: Confirm fail**

```bash
pnpm --filter @mythrun/backend test src/sse/__tests__/sse-connection.test.ts --run
```

Expected: `Cannot find module '../sse-connection.js'`.

- [ ] **Step 3: Implement `sse-connection.ts`**

```ts
// backend/src/sse/sse-connection.ts
//
// Fastify reply wrapper for an SSE response. Owns the response lifecycle:
//   - reply.hijack() before any raw writes (Fastify won't run onSend/onResponse
//     after hijack; we own the response).
//   - SSE response headers (no Connection: keep-alive — forbidden under HTTP/2).
//   - Keepalive: ':keepalive\n\n' every 25s via re-armed setTimeout (not
//     setInterval — avoids useless ticks on busy streams).
//   - Idle-timeout: 30 min no event → close with 'idle-timeout' reason.
//   - Back-pressure: write returns boolean; if false, arm 5s drain timer;
//     on timeout, close with 'back-pressure' reason.
//   - Cleanup: listen on BOTH request.raw 'close' AND reply.raw 'close'
//     (Fastify 5 / Node 22 emits on either depending on the closing party).
//     Idempotent.

import type { FastifyReply, FastifyRequest } from 'fastify'
import type pino from 'pino'

const KEEPALIVE_MS = 25_000
const IDLE_TIMEOUT_MS = 30 * 60_000
const DRAIN_TIMEOUT_MS = 5_000

export type CloseReason =
  | 'idle-timeout'
  | 'server-shutdown'
  | 'redis-resync-required'
  | 'rate-limited'
  | 'back-pressure'
  | 'unknown'

export interface SseSink {
  /** Returns false if the writer is back-pressured (caller may ignore). */
  readonly write: (frame: string) => boolean
  /** Closes the SSE response with a structured reason. Idempotent. */
  readonly close: (reason: CloseReason) => void
}

export interface OpenSseConnectionOpts {
  readonly request: FastifyRequest
  readonly reply: FastifyReply
  readonly logger: pino.Logger
  readonly onClose: () => void
}

export function openSseConnection(opts: OpenSseConnectionOpts): SseSink {
  const { request, reply, logger, onClose } = opts

  reply.hijack()
  const raw = reply.raw
  raw.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    'X-Accel-Buffering': 'no',
  })

  let closed = false
  let keepaliveHandle: NodeJS.Timeout | null = null
  let idleHandle: NodeJS.Timeout | null = null
  let drainHandle: NodeJS.Timeout | null = null

  function armKeepalive(): void {
    if (keepaliveHandle) clearTimeout(keepaliveHandle)
    keepaliveHandle = setTimeout(() => {
      if (closed) return
      raw.write(':keepalive\n\n')
      armKeepalive()
    }, KEEPALIVE_MS)
  }

  function armIdleTimeout(): void {
    if (idleHandle) clearTimeout(idleHandle)
    idleHandle = setTimeout(() => {
      close('idle-timeout')
    }, IDLE_TIMEOUT_MS)
  }

  function clearDrain(): void {
    if (drainHandle) {
      clearTimeout(drainHandle)
      drainHandle = null
    }
  }

  function onDrain(): void {
    clearDrain()
  }

  function close(reason: CloseReason): void {
    if (closed) return
    closed = true
    if (keepaliveHandle) clearTimeout(keepaliveHandle)
    if (idleHandle) clearTimeout(idleHandle)
    clearDrain()
    raw.off('drain', onDrain)
    request.raw.off('close', onUpstreamClose)
    raw.off('close', onUpstreamClose)
    try {
      raw.write(`event: close\ndata: ${JSON.stringify({ reason })}\n\n`)
    } catch {
      // Already-half-closed; ignore.
    }
    try {
      raw.end()
    } catch {
      // Already ended; ignore.
    }
    try {
      onClose()
    } catch (err) {
      logger.warn({ err }, 'sse onClose handler threw')
    }
  }

  function onUpstreamClose(): void {
    close('unknown')
  }

  request.raw.on('close', onUpstreamClose)
  raw.on('close', onUpstreamClose)
  raw.on('drain', onDrain)

  armKeepalive()
  armIdleTimeout()

  function write(frame: string): boolean {
    if (closed) return false
    let result: boolean
    try {
      result = raw.write(frame)
    } catch (err) {
      logger.warn({ err }, 'sse write threw — closing connection')
      close('unknown')
      return false
    }
    // Reset both timers on a real event write.
    armKeepalive()
    armIdleTimeout()
    if (!result && !drainHandle) {
      drainHandle = setTimeout(() => {
        drainHandle = null
        close('back-pressure')
      }, DRAIN_TIMEOUT_MS)
    }
    return result
  }

  return { write, close }
}
```

- [ ] **Step 4: Confirm tests pass**

```bash
pnpm --filter @mythrun/backend test src/sse/__tests__/sse-connection.test.ts --run
```

Expected: 12 tests pass.

- [ ] **Step 5: Lint + commit**

```bash
pnpm --filter @mythrun/backend exec eslint src/sse/sse-connection.ts src/sse/__tests__/sse-connection.test.ts
git add backend/src/sse/sse-connection.ts backend/src/sse/__tests__/sse-connection.test.ts
git commit -m "feat(myt-50): sse-connection Fastify reply wrapper with hijack + back-pressure

reply.hijack() before any raw writes (Fastify can't manage a stream we
own). Keepalive via re-armed setTimeout (no useless ticks on busy
streams). 30min idle-timeout. write() returns boolean; back-pressure
detection via 5s drain timeout; close with 'back-pressure' reason.
Dual 'close' listeners on request.raw + reply.raw. Idempotent close."
```

---

### Task 5: `pipeline-subscriber.ts` — dedicated client + PSUBSCRIBE + map + per-sink try/catch + reconnect

The load-bearing infrastructure piece. Heavy.

**Files:**
- Create: `backend/src/sse/pipeline-subscriber.ts`
- Create: `backend/src/sse/__tests__/pipeline-subscriber.test.ts`

- [ ] **Step 1: Write the failing tests**

```ts
// backend/src/sse/__tests__/pipeline-subscriber.test.ts
import { describe, expect, it, beforeEach, afterEach } from 'vitest'
import { Redis } from 'ioredis'
import pino from 'pino'
import { createPipelineSubscriber } from '../pipeline-subscriber.js'
import type { SseSink, CloseReason } from '../sse-connection.js'

const REDIS_URL = process.env['REDIS_REALTIME_URL'] ?? 'redis://localhost:6379'
const PREFIX = `test:${Math.random().toString(36).slice(2)}:` // unique per run

function makeSink(): SseSink & { written: string[]; closed: CloseReason | null } {
  const written: string[] = []
  let closed: CloseReason | null = null
  return {
    written,
    get closed(): CloseReason | null {
      return closed
    },
    write: (frame: string): boolean => {
      written.push(frame)
      return true
    },
    close: (reason: CloseReason): void => {
      closed = reason
    },
  }
}

describe('pipeline-subscriber', () => {
  let redis: Redis
  let publisher: Redis

  beforeEach(async () => {
    redis = new Redis(REDIS_URL, { lazyConnect: true })
    publisher = new Redis(REDIS_URL, { lazyConnect: true })
    await redis.connect()
    await publisher.connect()
  })

  afterEach(async () => {
    await redis.quit()
    await publisher.quit()
  })

  it('attach + PUBLISH delivers to the attached sink', async () => {
    const sub = createPipelineSubscriber(redis, PREFIX, pino({ level: 'silent' }))
    const sink = makeSink()
    sub.attach('cmp-1', sink)
    // Subscriber's PSUBSCRIBE is async; wait a beat.
    await new Promise<void>((resolve) => setTimeout(resolve, 50))
    await publisher.publish(
      `${PREFIX}pipeline:campaign:cmp-1`,
      JSON.stringify({ type: 'phase', phase: 'world_gen' }),
    )
    await new Promise<void>((resolve) => setTimeout(resolve, 50))
    expect(sink.written.some((w) => w.includes('"phase":"world_gen"'))).toBe(true)
    await sub.close()
  })

  it('detach removes the sink from the map; subsequent publishes are not delivered', async () => {
    const sub = createPipelineSubscriber(redis, PREFIX, pino({ level: 'silent' }))
    const sink = makeSink()
    const detach = sub.attach('cmp-2', sink)
    await new Promise<void>((resolve) => setTimeout(resolve, 50))
    detach()
    await publisher.publish(
      `${PREFIX}pipeline:campaign:cmp-2`,
      JSON.stringify({ type: 'phase', phase: 'world_gen' }),
    )
    await new Promise<void>((resolve) => setTimeout(resolve, 50))
    expect(sink.written).toHaveLength(0)
    await sub.close()
  })

  it('only routes messages to sinks for the matching campaignId', async () => {
    const sub = createPipelineSubscriber(redis, PREFIX, pino({ level: 'silent' }))
    const sinkA = makeSink()
    const sinkB = makeSink()
    sub.attach('cmp-A', sinkA)
    sub.attach('cmp-B', sinkB)
    await new Promise<void>((resolve) => setTimeout(resolve, 50))
    await publisher.publish(
      `${PREFIX}pipeline:campaign:cmp-A`,
      JSON.stringify({ type: 'phase', phase: 'world_gen' }),
    )
    await new Promise<void>((resolve) => setTimeout(resolve, 50))
    expect(sinkA.written).toHaveLength(1)
    expect(sinkB.written).toHaveLength(0)
    await sub.close()
  })

  it('continues delivering to other sinks when one sink.write throws', async () => {
    const sub = createPipelineSubscriber(redis, PREFIX, pino({ level: 'silent' }))
    const badSink: SseSink = {
      write: (): boolean => {
        throw new Error('boom')
      },
      close: () => undefined,
    }
    const goodSink = makeSink()
    sub.attach('cmp-3', badSink)
    sub.attach('cmp-3', goodSink)
    await new Promise<void>((resolve) => setTimeout(resolve, 50))
    await publisher.publish(
      `${PREFIX}pipeline:campaign:cmp-3`,
      JSON.stringify({ type: 'phase', phase: 'world_gen' }),
    )
    await new Promise<void>((resolve) => setTimeout(resolve, 50))
    expect(goodSink.written).toHaveLength(1)
    await sub.close()
  })

  it('reports activeConnectionCount', async () => {
    const sub = createPipelineSubscriber(redis, PREFIX, pino({ level: 'silent' }))
    expect(sub.activeConnectionCount()).toBe(0)
    const s1 = makeSink()
    const s2 = makeSink()
    const d1 = sub.attach('cmp-a', s1)
    sub.attach('cmp-b', s2)
    expect(sub.activeConnectionCount()).toBe(2)
    d1()
    expect(sub.activeConnectionCount()).toBe(1)
    await sub.close()
  })

  it('close() unsubscribes + drops all attached sinks', async () => {
    const sub = createPipelineSubscriber(redis, PREFIX, pino({ level: 'silent' }))
    const sink = makeSink()
    sub.attach('cmp-4', sink)
    await new Promise<void>((resolve) => setTimeout(resolve, 50))
    await sub.close()
    expect(sub.activeConnectionCount()).toBe(0)
  })
})
```

- [ ] **Step 2: Confirm fail**

```bash
pnpm --filter @mythrun/backend test src/sse/__tests__/pipeline-subscriber.test.ts --run
```

Expected: `Cannot find module '../pipeline-subscriber.js'`.

- [ ] **Step 3: Implement `pipeline-subscriber.ts`**

```ts
// backend/src/sse/pipeline-subscriber.ts
//
// One PSUBSCRIBE'd Redis client per API process. The client is a
// DEDICATED duplicate of deps.redisRealtime so it doesn't share command
// mode with rate-limit + ws-ticket — once a client enters subscriber
// mode (SUBSCRIBE/PSUBSCRIBE) it rejects almost all commands.
//
// Pattern: `{redisKeyPrefix}pipeline:campaign:*`. Channel-key extraction
// uses suffix-slice, NOT split-on-':' (the prefix contains colons).
//
// On per-sink write throw: log + close + detach within a snapshot of
// the Set, so one stale sink can't wedge iteration over the others.

import type { Redis } from 'ioredis'
import type pino from 'pino'
import type { SseSink } from './sse-connection.js'

export interface PipelineSubscriber {
  /** Attach an SSE sink to a campaign's channel. Returns a detach fn. */
  readonly attach: (campaignId: string, sink: SseSink) => () => void
  /** Count of attached sinks across all campaigns on this process. */
  readonly activeConnectionCount: () => number
  /** Count of PMESSAGEs received for a channel with no attached sinks. */
  readonly wastedMessageCount: () => number
  /** Tear down: UNSUBSCRIBE + close attached sinks + QUIT the dedicated client. */
  readonly close: () => Promise<void>
}

export function createPipelineSubscriber(
  redis: Redis,
  redisKeyPrefix: string,
  logger: pino.Logger,
): PipelineSubscriber {
  // Dedicated subscriber client. duplicate() inherits URL/AUTH/TLS but
  // we override retry options for the long-lived subscriber's needs.
  // Cast through `as unknown` because ioredis's duplicate() typing
  // doesn't include the options-override overload.
  const sub = (redis as unknown as { duplicate: (opts: Record<string, unknown>) => Redis }).duplicate({
    retryStrategy: (n: number) => Math.min(n * 1000, 30_000),
    maxRetriesPerRequest: null,
    enableOfflineQueue: true,
  })

  const pattern = `${redisKeyPrefix}pipeline:campaign:*`
  const channelPrefix = `${redisKeyPrefix}pipeline:campaign:`
  const map = new Map<string, Set<SseSink>>()
  let wastedMessages = 0
  let closed = false

  sub.on('error', (err: Error) => {
    logger.warn({ err }, 'pipeline-subscriber redis error')
  })

  sub.on('reconnecting', () => {
    logger.warn({ pattern }, 'pipeline-subscriber reconnecting')
  })

  sub.on('ready', () => {
    if (closed) return
    sub.psubscribe(pattern).catch((err: unknown) => {
      logger.error({ err, pattern }, 'pipeline-subscriber psubscribe failed on ready')
    })
    // After a reconnect, attached sinks may have missed events. Push a
    // resync close so clients re-fetch their state via a fresh stream.
    if (map.size > 0) {
      logger.warn(
        { attached: map.size },
        'pipeline-subscriber reconnected — closing attached sinks with redis-resync-required',
      )
      for (const set of map.values()) {
        for (const sink of [...set]) {
          try {
            sink.close('redis-resync-required')
          } catch (err) {
            logger.warn({ err }, 'pipeline-subscriber failed to close sink on resync')
          }
        }
      }
      map.clear()
    }
  })

  sub.on('pmessage', (_pattern: string, channel: string, message: string) => {
    if (!channel.startsWith(channelPrefix)) return
    const campaignId = channel.slice(channelPrefix.length)
    const sinks = map.get(campaignId)
    if (!sinks || sinks.size === 0) {
      wastedMessages++
      return
    }
    const frame = `data: ${message}\n\n`
    // Iterate over a snapshot so detach-during-iteration is safe.
    for (const sink of [...sinks]) {
      try {
        sink.write(frame)
      } catch (err) {
        logger.warn({ err, campaignId }, 'pipeline-subscriber sink.write threw — closing + detaching')
        try {
          sink.close('unknown')
        } catch {
          // already broken — best-effort
        }
        sinks.delete(sink)
      }
    }
  })

  function attach(campaignId: string, sink: SseSink): () => void {
    let set = map.get(campaignId)
    if (!set) {
      set = new Set()
      map.set(campaignId, set)
    }
    set.add(sink)
    return () => {
      const s = map.get(campaignId)
      if (!s) return
      s.delete(sink)
      if (s.size === 0) map.delete(campaignId)
    }
  }

  function activeConnectionCount(): number {
    let total = 0
    for (const set of map.values()) total += set.size
    return total
  }

  function wastedMessageCount(): number {
    return wastedMessages
  }

  async function close(): Promise<void> {
    closed = true
    try {
      await sub.punsubscribe(pattern)
    } catch (err) {
      logger.warn({ err }, 'pipeline-subscriber punsubscribe failed during close')
    }
    for (const set of map.values()) {
      for (const sink of [...set]) {
        try {
          sink.close('server-shutdown')
        } catch (err) {
          logger.warn({ err }, 'pipeline-subscriber failed to close sink on shutdown')
        }
      }
    }
    map.clear()
    try {
      await sub.quit()
    } catch (err) {
      logger.warn({ err }, 'pipeline-subscriber quit failed')
    }
  }

  // Kick off the initial PSUBSCRIBE. ioredis queues this until connect.
  sub.psubscribe(pattern).catch((err: unknown) => {
    logger.error({ err, pattern }, 'pipeline-subscriber initial psubscribe failed')
  })

  return { attach, activeConnectionCount, wastedMessageCount, close }
}
```

- [ ] **Step 4: Confirm tests pass**

```bash
pnpm --filter @mythrun/backend test src/sse/__tests__/pipeline-subscriber.test.ts --run
```

Expected: 6 tests pass. (Requires `pnpm db:up` so Redis is reachable.)

- [ ] **Step 5: Lint + commit**

```bash
pnpm --filter @mythrun/backend exec eslint src/sse/pipeline-subscriber.ts src/sse/__tests__/pipeline-subscriber.test.ts
git add backend/src/sse/pipeline-subscriber.ts backend/src/sse/__tests__/pipeline-subscriber.test.ts
git commit -m "feat(myt-50): pipeline-subscriber with dedicated client + PSUBSCRIBE

redis.duplicate({ retryStrategy, maxRetriesPerRequest: null }) so the
subscriber doesn't share command mode with rate-limit + ws-ticket.
PSUBSCRIBE pattern includes redisKeyPrefix; channel-key extraction uses
suffix-slice. Per-sink try/catch + Set-snapshot iteration prevents one
stale connection from wedging the rest. On reconnect, attached sinks
get redis-resync-required close (clients re-fetch via fresh stream).
6 integration tests against real Redis."
```

---

### Task 6: `routes/campaigns.ts` plugin + snapshot/stream handlers + integration tests

**Files:**
- Create: `backend/src/routes/campaigns.ts`
- Create: `backend/src/routes/__tests__/campaigns-status.test.ts`

- [ ] **Step 1: Write the failing tests**

```ts
// backend/src/routes/__tests__/campaigns-status.test.ts
import { describe, expect, it, beforeAll, afterAll, beforeEach } from 'vitest'
import { Pool } from 'pg'
import { Redis } from 'ioredis'
import { buildApp } from '../../app.js'
import { uuidv7 } from '../../repo/uuidv7.js'
import { stubEnv } from '../../__tests__/helpers/stub-env.js'

describe('campaigns status routes', () => {
  let pool: Pool
  let app: Awaited<ReturnType<typeof buildApp>>
  let redis: Redis
  let publisher: Redis

  beforeAll(async () => {
    pool = new Pool({ connectionString: process.env.DATABASE_URL })
    redis = new Redis(process.env['REDIS_REALTIME_URL'] ?? 'redis://localhost:6379', { lazyConnect: true })
    publisher = new Redis(process.env['REDIS_REALTIME_URL'] ?? 'redis://localhost:6379', { lazyConnect: true })
    await redis.connect()
    await publisher.connect()
    app = await buildApp({
      env: stubEnv(),
      pg: pool,
      redisRealtime: redis,
      redisBatch: redis,
      redisKeyPrefix: 'test:',
    })
  })

  afterAll(async () => {
    await app.close()
    await pool.end()
    await redis.quit()
    await publisher.quit()
  })

  beforeEach(async () => {
    await pool.query('DELETE FROM pipeline_runs')
    await pool.query('DELETE FROM campaign_members')
    await pool.query('DELETE FROM campaigns')
    await pool.query('DELETE FROM worlds')
    await pool.query('DELETE FROM users')
  })

  async function seedCampaignWithMember(): Promise<{ campaignId: string; userId: string; devSub: string }> {
    const userId = uuidv7()
    const devSub = `bypass:test-${userId.slice(-6)}`
    const worldId = uuidv7()
    const campaignId = uuidv7()
    await pool.query(
      `INSERT INTO users (id, cognito_sub, display_name, username) VALUES ($1, $2, $3, $4)`,
      [userId, devSub, 'Test', `t${userId.slice(-6)}`],
    )
    await pool.query(
      `INSERT INTO worlds (id, created_by, name, concept) VALUES ($1, $2, 'W', 'C')`,
      [worldId, userId],
    )
    await pool.query(
      `INSERT INTO campaigns (id, world_id, created_by, name) VALUES ($1, $2, $3, 'C')`,
      [campaignId, worldId, userId],
    )
    await pool.query(
      `INSERT INTO campaign_members (id, campaign_id, user_id, role, invite_accepted)
       VALUES ($1, $2, $3, 'owner', true)`,
      [uuidv7(), campaignId, userId],
    )
    return { campaignId, userId, devSub }
  }

  it('GET /api/campaigns/:campaignId/status returns 200 with snapshot for a member', async () => {
    const { campaignId, devSub } = await seedCampaignWithMember()
    const res = await app.inject({
      method: 'GET',
      url: `/api/campaigns/${campaignId}/status`,
      headers: { 'x-mythrun-dev-sub': devSub },
    })
    expect(res.statusCode).toBe(200)
    const body = res.json() as { phase: string; stages: unknown[]; cumulativeCostUsd: number }
    expect(body.phase).toBe('not_started')
    expect(body.stages).toEqual([])
    expect(body.cumulativeCostUsd).toBe(0)
  })

  it('GET /api/campaigns/:campaignId/status returns 403 for non-members', async () => {
    const { campaignId } = await seedCampaignWithMember()
    const otherUserId = uuidv7()
    const otherSub = `bypass:other-${otherUserId.slice(-6)}`
    await pool.query(
      `INSERT INTO users (id, cognito_sub, display_name, username) VALUES ($1, $2, $3, $4)`,
      [otherUserId, otherSub, 'O', `o${otherUserId.slice(-6)}`],
    )
    const res = await app.inject({
      method: 'GET',
      url: `/api/campaigns/${campaignId}/status`,
      headers: { 'x-mythrun-dev-sub': otherSub },
    })
    expect(res.statusCode).toBe(403)
  })

  it('GET /api/campaigns/:campaignId/status/stream returns text/event-stream + initial snapshot frame', async () => {
    const { campaignId, devSub } = await seedCampaignWithMember()
    const res = await app.inject({
      method: 'GET',
      url: `/api/campaigns/${campaignId}/status/stream`,
      headers: { 'x-mythrun-dev-sub': devSub },
      payloadAsStream: true,
    })
    expect(res.statusCode).toBe(200)
    expect(res.headers['content-type']).toContain('text/event-stream')
    // Drain a chunk; expect the snapshot frame.
    const chunks: string[] = []
    await new Promise<void>((resolve) => {
      res.stream().on('data', (c: Buffer) => {
        chunks.push(c.toString('utf8'))
        if (chunks.join('').includes('event: snapshot')) resolve()
      })
      setTimeout(resolve, 1000) // safety
    })
    const all = chunks.join('')
    expect(all).toContain('event: snapshot')
    expect(all).toContain('"phase":"not_started"')
    res.stream().destroy()
  })

  it('SSE stream forwards a published phase event', async () => {
    const { campaignId, devSub } = await seedCampaignWithMember()
    const res = await app.inject({
      method: 'GET',
      url: `/api/campaigns/${campaignId}/status/stream`,
      headers: { 'x-mythrun-dev-sub': devSub },
      payloadAsStream: true,
    })
    expect(res.statusCode).toBe(200)
    // Wait for snapshot frame so we know the sink is attached.
    await new Promise<void>((resolve) => {
      const seen: string[] = []
      res.stream().on('data', (c: Buffer) => {
        seen.push(c.toString('utf8'))
        if (seen.join('').includes('event: snapshot')) resolve()
      })
      setTimeout(resolve, 1000)
    })
    await publisher.publish(
      `test:pipeline:campaign:${campaignId}`,
      JSON.stringify({ type: 'phase', phase: 'world_gen' }),
    )
    await new Promise<void>((resolve) => {
      let buf = ''
      res.stream().on('data', (c: Buffer) => {
        buf += c.toString('utf8')
        if (buf.includes('"phase":"world_gen"')) resolve()
      })
      setTimeout(resolve, 1000)
    })
    res.stream().destroy()
  })
})
```

- [ ] **Step 2: Confirm fail**

```bash
pnpm --filter @mythrun/backend test src/routes/__tests__/campaigns-status.test.ts --run
```

Expected: `Cannot find module '../campaigns.js'` or `app.register` registration error.

- [ ] **Step 3: Implement `routes/campaigns.ts`**

```ts
// backend/src/routes/campaigns.ts
//
// Campaign-scoped HTTP routes. This issue (MYT-50) lands status +
// SSE stream only. Subsequent issues add create / details / member-mgmt
// / character-creation routes here.

import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify'
import type { Pool } from 'pg'
import { createRepo } from '../repo/index.js'
import { createPipelineRunsRepo } from '../repo/pipeline-runs.js'
import { requireCampaignMember } from '../auth/access-control.js'
import { requireDbUser } from '../auth/require-db-user.js'
import { derivePhase } from '../sse/derive-phase.js'
import { openSseConnection } from '../sse/sse-connection.js'
import type { PipelineSubscriber } from '../sse/pipeline-subscriber.js'
import type { ConnectionCounter } from '../sse/connection-counter.js'

export interface Opts {
  readonly pool: Pool
  readonly subscriber: PipelineSubscriber
  readonly counter: ConnectionCounter
}

interface Params {
  readonly campaignId: string
}

// eslint-disable-next-line @typescript-eslint/require-await
export const campaignsRoutes: FastifyPluginAsync<Opts> = async (app, opts) => {
  const repo = createRepo(opts.pool)
  const pipelineRunsRepo = createPipelineRunsRepo(opts.pool)

  async function loadSnapshot(campaignId: string): Promise<{
    phase: string
    stages: ReadonlyArray<{ stage: string; status: string; userId: string | null; costUsd: number }>
    cumulativeCostUsd: number
  } | null> {
    const campaign = await repo.campaigns.getById(campaignId)
    if (!campaign) return null
    const world = await repo.worlds.getById(campaign.worldId)
    if (!world) return null
    const runs = await pipelineRunsRepo.listLatestForCampaign(campaignId)
    return derivePhase({
      campaign: { id: campaign.id, status: campaign.status, world_id: campaign.worldId },
      world: { id: world.id, status: world.status },
      runs,
    })
  }

  app.get<{ Params: Params }>(
    '/api/campaigns/:campaignId/status',
    {
      config: {
        rateLimit: { max: 60, timeWindow: '1 minute' },
      },
      preHandler: requireCampaignMember(repo),
    },
    async (request, reply) => {
      const snapshot = await loadSnapshot(request.params.campaignId)
      if (!snapshot) return reply.code(404).send({ code: 'campaign_not_found' })
      return reply.send(snapshot)
    },
  )

  app.get<{ Params: Params }>(
    '/api/campaigns/:campaignId/status/stream',
    {
      config: {
        rateLimit: {
          max: 10,
          timeWindow: '1 minute',
          keyGenerator: (req: FastifyRequest): string => {
            try {
              return requireDbUser(req).id
            } catch {
              return req.ip
            }
          },
        },
      },
      preHandler: requireCampaignMember(repo),
    },
    async (request, reply) => {
      const campaignId = request.params.campaignId
      opts.counter.increment()
      const sink = openSseConnection({
        request,
        reply,
        logger: request.log,
        onClose: () => {
          opts.counter.decrement()
        },
      })
      const detach = opts.subscriber.attach(campaignId, sink)
      // Close handler tears down the subscription too.
      const onCloseDetach: () => void = () => {
        detach()
      }
      // Hook into the sink's lifecycle by wiring onClose to also detach.
      // openSseConnection's onClose runs once; we set up detach via a
      // wrapper: re-open with a composed onClose.
      // (Refactor note: simpler to thread the detach through openSseConnection's
      // onClose directly. Adjusted below.)
      void onCloseDetach
      // Compute snapshot AFTER attach so events published in the gap are queued.
      const snapshot = await loadSnapshot(campaignId)
      if (!snapshot) {
        sink.close('unknown')
        return reply
      }
      sink.write(`event: snapshot\ndata: ${JSON.stringify(snapshot)}\n\n`)
      // No return — sink lives on; Fastify already hijacked via sse-connection.
      return reply
    },
  )
}
```

Note: the `onCloseDetach` pattern in the snippet above is awkward. The cleaner path is to thread `detach` through `openSseConnection`'s onClose composition:

```ts
const counterInc = opts.counter.increment
counterInc()
let detach: (() => void) | null = null
const sink = openSseConnection({
  request,
  reply,
  logger: request.log,
  onClose: () => {
    if (detach) detach()
    opts.counter.decrement()
  },
})
detach = opts.subscriber.attach(campaignId, sink)
```

Use that shape in the final code.

- [ ] **Step 4: Run tests; iterate until passing**

```bash
pnpm --filter @mythrun/backend test src/routes/__tests__/campaigns-status.test.ts --run
```

Expected: 4 tests pass. If the SSE-stream tests are flaky, increase the safety timeouts.

- [ ] **Step 5: Lint + commit**

```bash
pnpm --filter @mythrun/backend exec eslint src/routes/campaigns.ts src/routes/__tests__/campaigns-status.test.ts
git add backend/src/routes/campaigns.ts backend/src/routes/__tests__/campaigns-status.test.ts
git commit -m "feat(myt-50): campaigns status + stream routes + integration tests

GET /api/campaigns/:campaignId/status returns the snapshot via
derivePhase + listLatestForCampaign. GET .../status/stream:
per-user rate-limit (matches sessions.ts pattern), opens an SSE
connection via openSseConnection, attaches to the pipeline subscriber
BEFORE computing the snapshot (so events in the gap are queued), then
writes the snapshot frame and lets the sink forward live events.
Integration tests against real Postgres + Redis (4 tests)."
```

---

### Task 7: `app.ts` wiring — boot subscriber + counter, shutdown ordering

**Files:**
- Modify: `backend/src/app.ts`
- Modify: `backend/src/app-deps.ts` (if it needs the new types — verify)

- [ ] **Step 1: Modify `backend/src/app.ts`**

Add imports near the top:

```ts
import { campaignsRoutes } from './routes/campaigns.js'
import { createPipelineSubscriber, type PipelineSubscriber } from './sse/pipeline-subscriber.js'
import { createConnectionCounter, type ConnectionCounter } from './sse/connection-counter.js'
```

In `buildApp`, after Redis clients are wired (before any plugin registration that needs them), construct the subscriber + counter:

```ts
const subscriber = createPipelineSubscriber(deps.redisRealtime, deps.redisKeyPrefix, app.log)
const counter = createConnectionCounter(app.log)
const stopPeriodicLog = counter.startPeriodicLog()
```

Register the campaigns plugin alongside the existing route registrations:

```ts
await app.register(campaignsRoutes, {
  pool: deps.pg,
  subscriber,
  counter,
})
```

Add `subscriber` + `stopPeriodicLog` to the shutdown clients struct and update `createShutdown`:

```ts
// In ShutdownClients interface
export interface ShutdownClients {
  readonly pg: Pool
  readonly redisRealtime: Redis
  readonly redisBatch: Redis
  readonly subscriber: PipelineSubscriber
  readonly stopPeriodicLog: () => void
}

// In createShutdown body — order matters (D14 in the spec)
export const createShutdown = (app: FastifyInstance, clients: ShutdownClients): ShutdownHandler => {
  return async (signal) => {
    try {
      app.log.info({ signal }, 'shutting down')
      await new Promise<void>((resolve) => setImmediate(resolve))
      // 1. Stop counter's interval
      clients.stopPeriodicLog()
      // 2. Drain SSE: subscriber.close() closes attached sinks (which run their
      //    onClose callbacks, which detach + decrement the counter), then
      //    UNSUBSCRIBE + QUIT the dedicated client.
      await clients.subscriber.close()
      // 3. Existing teardown: HTTP first (no in-flight queries), then pg pool,
      //    then redis QUIT.
      await app.close()
      await clients.pg.end()
      await clients.redisRealtime.quit()
      await clients.redisBatch.quit()
      process.exit(0)
    } catch (err) {
      app.log.error({ err, signal }, 'error during shutdown')
      process.exit(1)
    }
  }
}
```

Update the call site in `server.ts` (or wherever `createShutdown` is constructed) to pass `subscriber` + `stopPeriodicLog` into the ShutdownClients.

- [ ] **Step 2: Update `server.ts` and any wiring tests**

Read `backend/src/server.ts`. Find where `createShutdown` is called. Pass `subscriber` + `stopPeriodicLog` through. The current `server.ts` constructs Redis clients and passes them to both `buildApp` and `createShutdown`; mirror that pattern for `subscriber` + `stopPeriodicLog`.

`backend/src/__tests__/shutdown.test.ts` and `backend/src/__tests__/app.test.ts` may need updates because the `ShutdownClients` interface gained two fields. Add stubs for `subscriber: { close: async () => {} } as unknown as PipelineSubscriber` and `stopPeriodicLog: () => {}` in those tests' stub builders.

- [ ] **Step 3: Run all existing tests; verify nothing regressed**

```bash
pnpm --filter @mythrun/backend typecheck
pnpm --filter @mythrun/backend test --run
```

Expected: all existing tests still pass; new shutdown ordering doesn't break anything.

- [ ] **Step 4: Commit**

```bash
git add backend/src/app.ts backend/src/server.ts backend/src/__tests__/
git commit -m "feat(myt-50): wire pipeline subscriber + counter + shutdown ordering into app.ts

buildApp constructs createPipelineSubscriber + createConnectionCounter
and registers campaignsRoutes with both. ShutdownClients gains
subscriber + stopPeriodicLog fields. Shutdown order per spec D14:
stopPeriodicLog → subscriber.close (drains SSE) → app.close → pg.end →
redisRealtime.quit → redisBatch.quit. Test stubs in shutdown.test.ts +
app.test.ts updated for the new ShutdownClients fields."
```

---

### Task 8: Contract files + coverage.json

**Files:**
- Modify: `backend/src/contract/pipeline-routes.ts`
- Modify: `backend/src/contract/pipeline-events.ts`
- Modify: `backend/dev-tool/coverage.json`

- [ ] **Step 1: Update `pipeline-routes.ts`**

```ts
// backend/src/contract/pipeline-routes.ts (existing file)
export const PIPELINE_ROUTES: readonly string[] = [
  'GET /api/campaigns/:campaignId/status',
  'GET /api/campaigns/:campaignId/status/stream',
] as const

export type PipelineRoute = (typeof PIPELINE_ROUTES)[number]
```

- [ ] **Step 2: Update `pipeline-events.ts`**

```ts
// backend/src/contract/pipeline-events.ts (existing file)
//
// Full 11-arm event union. The bridge in MYT-50 is type-blind — it
// forwards every JSON payload published on the Redis channel verbatim
// regardless of `type` field. The 5 entity-event arms are listed here
// so MYT-51+ worker emissions don't have to expand the contract
// piecemeal; dev-tool coverage uses `exempt.events` for the entity
// arms with a reason pointing at MYT-52.

export const PIPELINE_SSE_EVENTS: readonly string[] = [
  // Lifecycle (MYT-50 — landed):
  'phase',
  'stage-started',
  'stage-completed',
  'stage-failed',
  'cost-update',
  'job-failed',
  // Entity events (MYT-51+ publishes; MYT-52 renders in dev tool):
  'stage-reset',
  'entity-added',
  'entity-updated',
  'edge-added',
  'finalized',
] as const

export type PipelineSseEvent = (typeof PIPELINE_SSE_EVENTS)[number]

export type PipelinePhase =
  | 'not_started'
  | 'world_gen'
  | 'world_gen_failed'
  | 'world_ready'
  | 'character_creation'
  | 'post_creation'
  | 'complete'
  | 'failed'

// Discriminated-union of event payload shapes. Field naming uses
// `T | null` (not `T?`) consistently so JSON round-trips don't muddle
// the snapshot type with the event type.
export type PipelineEvent =
  | { type: 'phase'; phase: PipelinePhase }
  | { type: 'stage-started'; stage: string; userId: string | null; startedAt: string }
  | {
      type: 'stage-completed'
      stage: string
      userId: string | null
      durationMs: number
      costUsd: number
    }
  | {
      type: 'stage-failed'
      stage: string
      userId: string | null
      errorCode: string
      willRetry: boolean
    }
  // cost-update is ABSOLUTE (not delta); emitted only post-COMMIT.
  | { type: 'cost-update'; cumulativeUsd: number }
  | {
      type: 'job-failed'
      jobType: 'world-gen' | 'character-creation' | 'post-creation'
      errorCode: string
    }
  // Entity-event arms — MYT-51+ publishes, MYT-52 renders.
  | { type: 'stage-reset'; stage: string }
  | { type: 'entity-added'; synthKey: string; entityKind: string; data: Record<string, unknown> }
  | { type: 'entity-updated'; synthKey: string; patch: Record<string, unknown> }
  | { type: 'edge-added'; synthKey: string; from: string; to: string; relationship: string }
  | { type: 'finalized'; synthKey: string; entityId: string }
```

- [ ] **Step 3: Update `backend/dev-tool/coverage.json`**

```json
{
  "version": 1,
  "routes": [
    "GET /api/campaigns/:campaignId/status",
    "GET /api/campaigns/:campaignId/status/stream"
  ],
  "events": [
    "phase",
    "stage-started",
    "stage-completed",
    "stage-failed",
    "cost-update",
    "job-failed",
    "stage-reset",
    "entity-added",
    "entity-updated",
    "edge-added",
    "finalized"
  ],
  "jobs": [],
  "exempt": {
    "routes": {},
    "events": {
      "stage-reset": "Rendered by live-graph in MYT-52; bridge forwards verbatim in MYT-50 — dev-tool coverage lands with MYT-52",
      "entity-added": "Rendered by live-graph in MYT-52; bridge forwards verbatim in MYT-50 — dev-tool coverage lands with MYT-52",
      "entity-updated": "Rendered by live-graph in MYT-52; bridge forwards verbatim in MYT-50 — dev-tool coverage lands with MYT-52",
      "edge-added": "Rendered by live-graph in MYT-52; bridge forwards verbatim in MYT-50 — dev-tool coverage lands with MYT-52",
      "finalized": "Rendered by live-graph in MYT-52; bridge forwards verbatim in MYT-50 — dev-tool coverage lands with MYT-52"
    },
    "jobs": {}
  }
}
```

- [ ] **Step 4: Run `pnpm dev-tool:check` — expected to PASS once status-panel.ts (Task 10) lands. For now, ensure the script doesn't error on parse**

```bash
pnpm dev-tool:check
```

Expected: pass at this stage because the 2 routes will be in the coverage list once status-panel.ts ships in Task 10. If it errors with "in contract but not in coverage" for the 2 routes, that means status-panel.ts isn't yet written — defer the dev-tool:check verification to after Task 10.

- [ ] **Step 5: Commit**

```bash
git add backend/src/contract/pipeline-routes.ts backend/src/contract/pipeline-events.ts backend/dev-tool/coverage.json
git commit -m "feat(myt-50): update contract files + coverage.json for 2 routes + 11 events

PipelineEvent discriminated union covers all 11 arms. coverage.json
includes the 5 entity-event arms in exempt.events with reasons pointing
at MYT-52 (where the live-graph dev tool UI lands). 2 routes in
PIPELINE_ROUTES match the registered URLs (:campaignId param)."
```

---

### Task 9: Cross-process integration test (mirrors `rate-limit-cross-worker.test.ts`)

Two `buildApp()` instances against one Redis; one hosts the SSE attachment, the other publishes. Proves the in-memory map isn't accidentally process-scoped in a way that breaks multi-task ECS.

**Files:**
- Create: `backend/src/__tests__/pipeline-cross-process.test.ts`

- [ ] **Step 1: Read the precedent**

Open `backend/src/__tests__/rate-limit-cross-worker.test.ts` and skim the boot pattern (two `buildApp()` calls sharing one Redis URL but each with its own ioredis connection).

- [ ] **Step 2: Write the test**

```ts
// backend/src/__tests__/pipeline-cross-process.test.ts
import { describe, expect, it, beforeAll, afterAll } from 'vitest'
import { Pool } from 'pg'
import { Redis } from 'ioredis'
import { buildApp } from '../app.js'
import { stubEnv } from './helpers/stub-env.js'
import { uuidv7 } from '../repo/uuidv7.js'

describe('pipeline status cross-process', () => {
  let pool: Pool
  let appA: Awaited<ReturnType<typeof buildApp>>
  let appB: Awaited<ReturnType<typeof buildApp>>
  let redisA: Redis
  let redisB: Redis
  let publisher: Redis
  const REDIS_URL = process.env['REDIS_REALTIME_URL'] ?? 'redis://localhost:6379'

  beforeAll(async () => {
    pool = new Pool({ connectionString: process.env.DATABASE_URL })
    redisA = new Redis(REDIS_URL, { lazyConnect: true })
    redisB = new Redis(REDIS_URL, { lazyConnect: true })
    publisher = new Redis(REDIS_URL, { lazyConnect: true })
    await Promise.all([redisA.connect(), redisB.connect(), publisher.connect()])
    appA = await buildApp({
      env: stubEnv(),
      pg: pool,
      redisRealtime: redisA,
      redisBatch: redisA,
      redisKeyPrefix: 'xprc:',
    })
    appB = await buildApp({
      env: stubEnv(),
      pg: pool,
      redisRealtime: redisB,
      redisBatch: redisB,
      redisKeyPrefix: 'xprc:',
    })
  })

  afterAll(async () => {
    await Promise.all([appA.close(), appB.close()])
    await pool.end()
    await Promise.all([redisA.quit(), redisB.quit(), publisher.quit()])
  })

  it('SSE attached to instance A receives an event published by an external publisher', async () => {
    // Seed campaign owned by a dev sub.
    const userId = uuidv7()
    const worldId = uuidv7()
    const campaignId = uuidv7()
    const devSub = `bypass:xprc-${userId.slice(-6)}`
    await pool.query(
      `INSERT INTO users (id, cognito_sub, display_name, username) VALUES ($1, $2, $3, $4)`,
      [userId, devSub, 'X', `x${userId.slice(-6)}`],
    )
    await pool.query(
      `INSERT INTO worlds (id, created_by, name, concept) VALUES ($1, $2, 'W', 'C')`,
      [worldId, userId],
    )
    await pool.query(
      `INSERT INTO campaigns (id, world_id, created_by, name) VALUES ($1, $2, $3, 'C')`,
      [campaignId, worldId, userId],
    )
    await pool.query(
      `INSERT INTO campaign_members (id, campaign_id, user_id, role, invite_accepted)
       VALUES ($1, $2, $3, 'owner', true)`,
      [uuidv7(), campaignId, userId],
    )

    const res = await appA.inject({
      method: 'GET',
      url: `/api/campaigns/${campaignId}/status/stream`,
      headers: { 'x-mythrun-dev-sub': devSub },
      payloadAsStream: true,
    })
    expect(res.statusCode).toBe(200)

    // Wait for snapshot frame.
    await new Promise<void>((resolve) => {
      let buf = ''
      res.stream().on('data', (c: Buffer) => {
        buf += c.toString('utf8')
        if (buf.includes('event: snapshot')) resolve()
      })
      setTimeout(resolve, 1000)
    })

    // Publish via the SEPARATE publisher connection.
    await publisher.publish(
      `xprc:pipeline:campaign:${campaignId}`,
      JSON.stringify({ type: 'phase', phase: 'world_gen' }),
    )

    // Assert the event reaches appA.
    await new Promise<void>((resolve) => {
      let buf = ''
      res.stream().on('data', (c: Buffer) => {
        buf += c.toString('utf8')
        if (buf.includes('"phase":"world_gen"')) resolve()
      })
      setTimeout(resolve, 2000)
    })
    res.stream().destroy()

    // Cleanup
    await pool.query('DELETE FROM campaign_members WHERE campaign_id=$1', [campaignId])
    await pool.query('DELETE FROM campaigns WHERE id=$1', [campaignId])
    await pool.query('DELETE FROM worlds WHERE id=$1', [worldId])
    await pool.query('DELETE FROM users WHERE id=$1', [userId])
  })
})
```

- [ ] **Step 3: Run; iterate if flaky**

```bash
pnpm --filter @mythrun/backend test src/__tests__/pipeline-cross-process.test.ts --run
```

Expected: 1 test passes.

- [ ] **Step 4: Lint + commit**

```bash
pnpm --filter @mythrun/backend exec eslint src/__tests__/pipeline-cross-process.test.ts
git add backend/src/__tests__/pipeline-cross-process.test.ts
git commit -m "test(myt-50): cross-process SSE integration (mirrors rate-limit-cross-worker)

Two buildApp() instances sharing one Redis. Confirms the SSE attachment
on instance A receives an event published via a separate publisher
connection — proves the in-memory subscriber map isn't accidentally
process-scoped in a way that would break multi-task ECS."
```

---

### Task 10: Dev tool `status-panel.ts` component

**Files:**
- Create: `backend/dev-tool/src/components/status-panel.ts`
- Modify: `backend/dev-tool/src/main.ts`

- [ ] **Step 1: Create `status-panel.ts`**

```ts
// backend/dev-tool/src/components/status-panel.ts
//
// Paste-input campaignId + Watch button + live phase/stage display.
// Opens an EventSource on /api/campaigns/{id}/status/stream. The first
// SSE frame is the snapshot (event: snapshot); subsequent frames are
// live events. Unknown event types are silently ignored — entity-* and
// edge-* events arrive once MYT-51 streaming stages ship; the live
// graph that renders them lands in MYT-52.

interface StageEntry {
  readonly stage: string
  readonly status: string
  readonly userId: string | null
  readonly costUsd: number
}

interface Snapshot {
  readonly phase: string
  readonly stages: readonly StageEntry[]
  readonly cumulativeCostUsd: number
}

export function mountStatusPanel(parent: HTMLElement): void {
  const card = document.createElement('section')
  card.className = 'card'

  const title = document.createElement('h2')
  title.textContent = 'Pipeline status'

  const input = document.createElement('input')
  input.type = 'text'
  input.placeholder = 'campaignId (paste a UUID)'
  input.style.width = '320px'

  const watchBtn = document.createElement('button')
  watchBtn.textContent = 'Watch'

  const stopBtn = document.createElement('button')
  stopBtn.textContent = 'Stop'
  stopBtn.disabled = true

  const phaseEl = document.createElement('div')
  phaseEl.className = 'result'
  phaseEl.textContent = '(no campaign watched)'

  const stagesEl = document.createElement('pre')
  stagesEl.className = 'result'

  const costEl = document.createElement('div')
  costEl.className = 'result'

  let source: EventSource | null = null

  function render(snap: Snapshot): void {
    phaseEl.textContent = `phase: ${snap.phase}`
    stagesEl.textContent = snap.stages
      .map((s) => `${s.stage.padEnd(28)} ${s.status.padEnd(10)} ${s.userId ?? '-'} $${s.costUsd.toFixed(4)}`)
      .join('\n')
    costEl.textContent = `cumulative cost: $${snap.cumulativeCostUsd.toFixed(4)}`
  }

  function applyEvent(parsed: { type?: string; phase?: string; cumulativeUsd?: number }): void {
    if (parsed.type === 'phase' && typeof parsed.phase === 'string') {
      phaseEl.textContent = `phase: ${parsed.phase}`
    } else if (parsed.type === 'cost-update' && typeof parsed.cumulativeUsd === 'number') {
      costEl.textContent = `cumulative cost: $${parsed.cumulativeUsd.toFixed(4)}`
    }
    // stage-started / stage-completed / stage-failed: future enhancement (re-render
    // stage list incrementally). For Phase 0 we rely on the snapshot frame on
    // each reconnect for stage state.
  }

  function close(): void {
    if (source) {
      source.close()
      source = null
    }
    watchBtn.disabled = false
    stopBtn.disabled = true
    input.disabled = false
  }

  function watch(): void {
    const id = input.value.trim()
    if (!id) return
    watchBtn.disabled = true
    stopBtn.disabled = false
    input.disabled = true
    phaseEl.textContent = `phase: (connecting to /api/campaigns/${id}/status/stream)`
    stagesEl.textContent = ''
    costEl.textContent = ''
    source = new EventSource(`/api/campaigns/${id}/status/stream`)

    source.addEventListener('snapshot', (e: MessageEvent<string>): void => {
      try {
        render(JSON.parse(e.data) as Snapshot)
      } catch (err) {
        phaseEl.textContent = `error parsing snapshot: ${err instanceof Error ? err.message : String(err)}`
      }
    })

    source.addEventListener('message', (e: MessageEvent<string>): void => {
      try {
        applyEvent(JSON.parse(e.data) as { type?: string; phase?: string; cumulativeUsd?: number })
      } catch {
        // Ignore unparseable frames (keepalive comments don't fire onmessage anyway).
      }
    })

    source.addEventListener('close', (e: MessageEvent<string>): void => {
      try {
        const payload = JSON.parse(e.data) as { reason?: string }
        phaseEl.textContent = `phase: (server closed — reason: ${payload.reason ?? 'unknown'})`
      } catch {
        phaseEl.textContent = 'phase: (server closed)'
      }
      close()
    })

    source.onerror = (): void => {
      if (source && source.readyState === EventSource.CLOSED) {
        phaseEl.textContent = 'phase: (connection closed)'
        close()
      }
    }
  }

  watchBtn.addEventListener('click', watch)
  stopBtn.addEventListener('click', close)

  const inputRow = document.createElement('div')
  inputRow.style.display = 'flex'
  inputRow.style.gap = '8px'
  inputRow.style.marginBottom = '12px'
  inputRow.appendChild(input)
  inputRow.appendChild(watchBtn)
  inputRow.appendChild(stopBtn)

  card.appendChild(title)
  card.appendChild(inputRow)
  card.appendChild(phaseEl)
  card.appendChild(stagesEl)
  card.appendChild(costEl)
  parent.appendChild(card)
}
```

- [ ] **Step 2: Wire it into `main.ts`**

```ts
// backend/dev-tool/src/main.ts
import { mountIdentitySwitcher } from './components/identity-switcher.js'
import { mountHealthPanel } from './components/health-panel.js'
import { mountStatusPanel } from './components/status-panel.js'
import './styles.css'

const header = document.querySelector<HTMLElement>('header')
const main = document.querySelector<HTMLElement>('main')
if (!header || !main) throw new Error('layout missing required elements')

mountIdentitySwitcher(header)
mountHealthPanel(main)
mountStatusPanel(main)
```

- [ ] **Step 3: Smoke-verify in the browser**

In a terminal:
```bash
pnpm db:up
pnpm dev   # backend
```

In another:
```bash
pnpm dev:dev-tool
```

Open `http://127.0.0.1:5273`. Insert a campaign + member manually via `psql` (so the dev tool can hit a real `:campaignId`):

```sql
INSERT INTO users (id, cognito_sub, display_name, username) VALUES (gen_random_uuid(), 'bypass:dev-1', 'D', 'devuser');
-- copy the user id into the next inserts
INSERT INTO worlds (id, created_by, name, concept) VALUES (gen_random_uuid(), '<user-id>', 'W', 'C');
-- copy the world id
INSERT INTO campaigns (id, world_id, created_by, name) VALUES (gen_random_uuid(), '<world-id>', '<user-id>', 'C');
INSERT INTO campaign_members (id, campaign_id, user_id, role, invite_accepted) VALUES (gen_random_uuid(), '<campaign-id>', '<user-id>', 'owner', true);
```

Switch the identity switcher to `dev-1` (matches the bypass sub the inserts used). Paste the campaign id into the status panel and click Watch.

Expected: phase shows `not_started`; stages empty; cost $0.

Now `redis-cli`:

```bash
redis-cli -h localhost -p 6379 PUBLISH "staging:use1:pipeline:campaign:<campaign-id>" '{"type":"phase","phase":"world_gen"}'
```

(Adjust the channel prefix to match `REDIS_KEY_PREFIX` in `backend/.env.development`.)

Expected: the status panel updates within ~1 s to show `phase: world_gen`.

- [ ] **Step 4: Run `pnpm dev-tool:check` — verify green**

```bash
pnpm dev-tool:check
```

Expected: `dev-tool:check — 0 error(s), 0 warning(s) [routes:2 events:11 jobs:0]`.

- [ ] **Step 5: Commit**

```bash
git add backend/dev-tool/src/components/status-panel.ts backend/dev-tool/src/main.ts
git commit -m "feat(myt-50): dev tool status-panel component + main wiring

Paste-input campaignId + Watch/Stop buttons; opens EventSource on
/status/stream and renders phase + stage table + cumulative cost.
Handles event: snapshot (initial frame), event: close (with reason
enum), and live phase / cost-update events. Unknown event types
(entity-*, edge-*) are silently ignored — they arrive once MYT-51+
worker emissions ship and get rendered by MYT-52's live graph."
```

---

### Task 11: Wiki page `pipeline-status.html`

**Files:**
- Create: `docs/wiki/content/runtime/pipeline-status.html`

- [ ] **Step 1: Read the precedent**

```bash
head -80 docs/wiki/content/runtime/dev-tool.html
```

Note the source-tracking comment block format + `@diagram` directive + sectioning convention.

- [ ] **Step 2: Create the page**

Author the file at `docs/wiki/content/runtime/pipeline-status.html` with:

- Source-tracking comments referencing every file in §4.11 of the design spec.
- Sections:
  1. **What it is** — campaign-scoped status surface; snapshot + SSE stream; one Redis channel per campaign.
  2. **The two endpoints** — table with auth, rate-limit, response shape.
  3. **The pub/sub channel** — naming, prefix scoping, who publishes (worker, MYT-51+).
  4. **Phase derivation** — table of input state → phase.
  5. **SSE plumbing** — keepalive, idle-timeout, close-reason enum, back-pressure handling.
  6. **The dedicated subscriber client** — why duplicate() is required (operational rationale).
  7. **Operating this piece** — sub-runbooks:
     - "Diagnose a stale SSE connection" (read close-reason; check `sse.connections.active` log)
     - "Verify the subscriber survived a Redis blip" (logs Insights query for `pipeline-subscriber reconnecting` → `psubscribe`)
     - "Watch a campaign locally" (dev tool flow)
  8. **Integration points** — pipeline_runs schema, parent spec §8/§9, MYT-49 worker side.
  9. **Out of scope** — entity events (MYT-52), JWT-expiry mid-stream eviction (post-launch).
  10. **Source** — list of declared sources.

Use the same HTML structure as `dev-tool.html` (h1 → h2 sections → h3 runbooks).

- [ ] **Step 3: Verify wiki check passes**

```bash
DATABASE_URL="postgresql://mythrun:mythrun_dev@localhost:5432/mythrun" pnpm wiki:check
```

Expected: green.

- [ ] **Step 4: Commit**

```bash
git add docs/wiki/content/runtime/pipeline-status.html docs/wiki/site/runtime/pipeline-status.html docs/wiki/structure.ts
git commit -m "docs(myt-50): wiki page for pipeline status surface

Covers the two endpoints, the single Redis pub/sub channel, phase
derivation table, SSE plumbing (keepalive / idle-timeout / close-reason
enum / back-pressure), dedicated-subscriber rationale, operational
runbooks (diagnose stale connection / verify Redis-blip resync / watch
locally), MYT-49 worker contract, and the explicit out-of-scope list."
```

---

### Task 12: Final verification + branch backup

- [ ] **Step 1: Run all gates**

```bash
pnpm typecheck
pnpm lint
pnpm test
pnpm wiki:check     # may need DATABASE_URL — see prior runs
pnpm dev-tool:check
```

All exit 0.

- [ ] **Step 2: Manual end-to-end smoke**

Repeat the smoke flow from Task 10 Step 3 — backend + dev tool + redis-cli PUBLISH. Confirm:
- Snapshot frame renders on Watch.
- Phase update propagates through redis-cli PUBLISH.
- Stop button closes the EventSource cleanly.
- Manually trigger Redis reconnect (`redis-cli -h localhost -p 6379 DEBUG SLEEP 5` then continue) — confirm the dev tool sees `event: close` with `redis-resync-required` reason (or `unknown`) and the panel updates.

- [ ] **Step 3: Push branch backup**

```bash
git push -u origin myt-50-pipeline-status
```

- [ ] **Step 4: Signal ready for merge**

Per CLAUDE.md "Merging worktree work back" — the actual merge to main is the user's call (post-MYT-49 merge coordination). No commit in this step; just confirm the branch state.

---

## Plan complete

After Task 12, MYT-50 is ready for merge. The pipeline status surface lives behind `GET /api/campaigns/:campaignId/status[/stream]`; the dedicated Redis subscriber doesn't break command-mode siblings; the SSE plumbing handles back-pressure, idle-timeout, and Redis reconnects with a typed close-reason enum; the dev tool can paste-watch a campaign end-to-end.

Subsequent issues (MYT-51 onwards) plug into this surface by publishing to `{redisKeyPrefix}pipeline:campaign:{campaignId}` from their worker processors. No additional API-side work needed in this layer.
