// backend/scripts/cost/scenarios/s4-driver.ts
//
// Cost Wave 1 Task 5 — the S-4 driver (spec §5, S-4 row): character
// finalize → prep pipeline, via the EXISTING route path.
//
// Constructed state: reload the ready-to-play fixture (same replay harness as
// the S-1 driver), then REWIND it to just-before-finalize:
//   - delete the world's pc entities (characters.entity_id is ON DELETE SET
//     NULL; pc facts/kernels/relationships cascade),
//   - flip the campaign back to status='setup', pre_integration_notes=NULL,
//   - insert a synthetic COMPLETED character concept for the fixture owner
//     (the fixture ships none; the integration party join tolerates a null
//     concept_output, and the fixed text keeps runs comparable).
// The fixture's campaign pre-delete cascades pipeline_runs (ON DELETE
// CASCADE), so the integration stage claim starts clean every run.
//
// Drive: POST /finalize-character-creation (owner = dev-user-1, the fixture
// owner's cognito_sub) → 202 → poll pipeline_runs character_integration =
// completed → POST /start, polling through the prep_not_ready self-heal
// (sessions.ts — the existing session-prep route path) → assert the
// session_preps row parses under sessionPrepSchema (spec: ft_context /
// sd_playbook schema-valid) → drained-queue quiescence over campaign-setup +
// session-prep. The window opens just before the finalize POST. All three
// pipeline calls (integration, prep, the vetOpening tripwire) stamp
// campaignId at HEAD and arrive id-scoped; the runner's stage-only tripwire
// arm is belt-and-braces.
//
// Cost: ~1 integration Opus call + session prep (~$0.90-1.5/run, sticker).

import { pathToFileURL } from 'node:url'
import type { Pool } from 'pg'
import { createPgPool } from '../../../src/db/postgres.js'
import { loadFixture, readFixture } from '../../smoke/fixtures/load.js'
import { uuidv7 } from '../../../src/repo/uuidv7.js'
import { sessionPrepSchema } from '../../../src/llm/prep/stages/session-prep.js'
import {
  QUEUE_CAMPAIGN_SETUP,
  QUEUE_SESSION_PREP,
} from '../../../src/worker/bullmq-config.js'
import { awaitQuiescence } from './quiesce.js'
import { resetCampaignSessionState } from './reset-session-state.js'

export interface RunS4Opts {
  readonly baseUrl: string
  readonly devSub: string
}

export interface RunS4Result {
  readonly campaignId: string
  readonly window: { readonly fromMs: number; readonly toMs: number }
}

const INTEGRATION_TIMEOUT_MS = 10 * 60_000
const INTEGRATION_POLL_MS = 5_000
const START_TIMEOUT_MS = 20 * 60_000 // /start polls through the self-healed prep (real Opus)
const START_POLL_MS = 10_000
const QUIESCENCE_TIMEOUT_MS = 5 * 60_000
const SETTLE_MS = 10_000

// Fixed synthetic concept — in-fiction for the fixture's fog-wrapped harbor
// town + the fixture character (Solen Vare, road-weary cartographer). Fixed
// text keeps the integration prompt (and so the baseline) comparable across
// runs.
const CONCEPT_TEXT =
  'Solen Vare, a road-weary cartographer who maps harbors nobody asks about. ' +
  'Solen keeps a ledger of debts that are not theirs and a habit of asking ' +
  'lamplighters what the fog took. They came to this town following a chart ' +
  'whose margins someone else annotated — in their own handwriting.'
const SITUATION_GROUNDING =
  'Arrives at the fog-wrapped harbor town at lamplighting, taking a room above the quay.'

function log(msg: string, extra?: Record<string, unknown>): void {
  process.stdout.write(`${JSON.stringify({ ts: new Date().toISOString(), msg, ...extra })}\n`)
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}

function requiredEnv(name: string): string {
  const v = process.env[name]
  if (v === undefined || v === '') throw new Error(`missing env ${name} (use --env-file=.env.development)`)
  return v
}

/** Same fence as the S-1 driver: this driver DELETEs + rewrites fixture rows. */
function assertLocalDatabase(databaseUrl: string): void {
  const host = new URL(databaseUrl).hostname
  if (host !== 'localhost' && host !== '127.0.0.1') {
    throw new Error(`s4-driver only runs against a LOCAL database; got host=${host}`)
  }
}

async function api(
  opts: RunS4Opts,
  method: string,
  path: string,
  body?: unknown,
): Promise<{ status: number; text: string }> {
  const res = await fetch(`${opts.baseUrl}${path}`, {
    method,
    headers: {
      'x-mythrun-dev-sub': opts.devSub,
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })
  return { status: res.status, text: await res.text() }
}

/* eslint-disable mythrun/no-raw-db-access -- fixture rewind SQL, same harness
 * tier as load.ts's delete-then-load; production has no "un-finalize" to call */

/** Reload the fixture, then rewind to just-before-finalize. */
async function seedJustBeforeFinalize(pool: Pool): Promise<{ campaignId: string; ownerId: string }> {
  const fixtureIds = readFixture('ready-to-play-campaign')
  await pool.query('DELETE FROM campaigns WHERE id = $1', [fixtureIds.rootCampaignId])
  const fixture = await loadFixture(pool, 'ready-to-play-campaign')
  const campaignId = fixture.rootCampaignId
  const owner = await pool.query<{ created_by: string }>(
    'SELECT created_by FROM campaigns WHERE id = $1',
    [campaignId],
  )
  const ownerId = owner.rows[0]?.created_by
  if (ownerId === undefined) throw new Error('fixture campaign has no created_by')

  // Rewind: pc entities out (characters.entity_id SET NULL by FK; pc facts/
  // kernels/relationships cascade), campaign back to setup.
  await pool.query(`DELETE FROM entities WHERE world_id = $1 AND entity_type = 'pc'`, [
    fixture.rootWorldId,
  ])
  await pool.query(
    `UPDATE campaigns SET status = 'setup', pre_integration_notes = NULL WHERE id = $1`,
    [campaignId],
  )
  await pool.query(
    `INSERT INTO character_concepts (
       id, campaign_id, user_id, concept_text, situation_grounding_text,
       guided_choices, status
     ) VALUES ($1, $2, $3, $4, $5, '{}'::jsonb, 'completed')`,
    [uuidv7(), campaignId, ownerId, CONCEPT_TEXT, SITUATION_GROUNDING],
  )
  log('fixture_rewound', { campaignId, worldId: fixture.rootWorldId })
  return { campaignId, ownerId }
}

async function pollIntegrationCompleted(pool: Pool, campaignId: string): Promise<void> {
  const deadline = Date.now() + INTEGRATION_TIMEOUT_MS
  while (Date.now() < deadline) {
    const res = await pool.query<{ status: string }>(
      `SELECT status FROM pipeline_runs
        WHERE campaign_id = $1 AND stage = 'character_integration'`,
      [campaignId],
    )
    const status = res.rows[0]?.status
    if (status === 'completed') return
    if (status === 'failed') throw new Error('character_integration pipeline_runs row is failed')
    log('integration_pending', { status: status ?? '(no row yet)' })
    await sleep(INTEGRATION_POLL_MS)
  }
  throw new Error(`character_integration did not complete within ${String(INTEGRATION_TIMEOUT_MS)}ms`)
}

/** POST /start until 200, riding the MYT-102 prep_not_ready self-heal — the
 *  existing session-prep route path (sessions.ts enqueues the prep job). */
async function startThroughPrep(opts: RunS4Opts, campaignId: string): Promise<void> {
  const deadline = Date.now() + START_TIMEOUT_MS
  let last = ''
  while (Date.now() < deadline) {
    const res = await api(opts, 'POST', `/api/sessions/${campaignId}/start`)
    if (res.status === 200) return
    last = `${String(res.status)}: ${res.text}`
    let code: string | undefined
    try {
      code = (JSON.parse(res.text) as { code?: string }).code
    } catch {
      code = undefined
    }
    if (res.status !== 409 || code !== 'prep_not_ready') {
      throw new Error(`session start failed — ${last}`)
    }
    log('prep_pending', { campaignId })
    await sleep(START_POLL_MS)
  }
  throw new Error(`session start timed out after ${String(START_TIMEOUT_MS)}ms — last=${last}`)
}

/** Spec: ft_context/sd_playbook schema-valid. Parse the PERSISTED row under
 *  the processor's own output schema — floor lengths, real columns. */
async function assertPrepSchemaValid(pool: Pool, campaignId: string): Promise<void> {
  const res = await pool.query<{ ft_context: string; sd_playbook: string; opening: string | null }>(
    `SELECT ft_context, sd_playbook, opening FROM session_preps
      WHERE campaign_id = $1 AND session_number = 1`,
    [campaignId],
  )
  const row = res.rows[0]
  if (row === undefined) throw new Error('no session_preps row after /start returned 200')
  const parsed = sessionPrepSchema.safeParse({
    ft_context: row.ft_context,
    sd_playbook: row.sd_playbook,
    opening: row.opening ?? '',
  })
  if (!parsed.success) {
    throw new Error(`session_preps row fails sessionPrepSchema: ${parsed.error.message}`)
  }
  log('prep_schema_valid', {
    ftContextLen: row.ft_context.length,
    sdPlaybookLen: row.sd_playbook.length,
  })
}

/* eslint-enable mythrun/no-raw-db-access */

/** Rewind → finalize → integration → /start (prep self-heal) → quiesce. */
export async function runS4(opts: RunS4Opts): Promise<RunS4Result> {
  const databaseUrl = requiredEnv('DATABASE_URL')
  const redisBatchUrl = requiredEnv('REDIS_BATCH_URL')
  const redisRealtimeUrl = requiredEnv('REDIS_REALTIME_URL')
  assertLocalDatabase(databaseUrl)
  const pool = createPgPool(databaseUrl)
  try {
    const { campaignId } = await seedJustBeforeFinalize(pool)
    // Stale campaign-scoped Redis state (usage counters, `:ending` fence)
    // survives the DB rewind and 409s /start — clear it with the fixture.
    await resetCampaignSessionState(redisRealtimeUrl, campaignId, log)
    // Session credits for /start; grant before the window opens.
    const grant = await api(opts, 'POST', '/api/dev/credits/grant', {
      creditType: 'session',
      amount: 5,
    })
    if (grant.status >= 400) throw new Error(`credit grant failed: ${String(grant.status)}`)

    const fromMs = Date.now()
    const fin = await api(opts, 'POST', `/api/campaigns/${campaignId}/finalize-character-creation`, {})
    if (fin.status !== 202) {
      throw new Error(`finalize-character-creation → ${String(fin.status)}: ${fin.text}`)
    }
    log('finalize_accepted', { campaignId })
    await pollIntegrationCompleted(pool, campaignId)
    log('integration_completed', { campaignId })

    await startThroughPrep(opts, campaignId)
    log('session_started_through_prep', { campaignId })
    await assertPrepSchemaValid(pool, campaignId)

    const toMs = await awaitQuiescence({
      redisUrl: redisBatchUrl,
      queues: [QUEUE_CAMPAIGN_SETUP, QUEUE_SESSION_PREP],
      settleMs: SETTLE_MS,
      timeoutMs: QUIESCENCE_TIMEOUT_MS,
      log,
    })
    log('s4_complete', { campaignId, fromMs, toMs })
    return { campaignId, window: { fromMs, toMs } }
  } finally {
    await pool.end()
  }
}

async function main(): Promise<void> {
  const result = await runS4({
    baseUrl: process.env.S1_BASE_URL ?? 'http://localhost:3030',
    devSub: process.env.S1_DEV_SUB ?? 'dev-user-1',
  })
  process.stdout.write(`\nS4_RESULT=${JSON.stringify(result)}\n`)
  process.exit(0)
}

const entry = process.argv[1]
if (entry !== undefined && import.meta.url === pathToFileURL(entry).href) {
  main().catch((err: unknown) => {
    process.stderr.write(`${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`)
    process.exit(1)
  })
}
