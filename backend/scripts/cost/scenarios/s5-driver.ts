// backend/scripts/cost/scenarios/s5-driver.ts
//
// Cost Wave 1 Task 5 — the S-5 driver (spec §5, S-5 row): a full prep-engine
// world-gen run on FIXED input, through the real route (the dev-tool
// verifier's campaign-creation shape: POST /api/campaigns with
// `{ world: { kind: 'new', source: { mode: 'freeform', concept } } }`).
//
// The window opens just before the POST — the input gate runs in-request
// BEFORE any campaign row exists, so its line carries stage but no ids and
// is captured by the runner's window+stage-scoped arm. Every world-gen stage
// line carries campaignId (verified at HEAD: the stage modules stamp
// providerOptions.mythrun campaignId). Completion = worlds.status
// 'complete', then drained world-gen queue (delayed counts — world-gen parks
// itself with self-delaying resumes).
//
// Reruns: prior S-5 campaigns are found by the FIXED concept text on their
// worlds row and deleted first — this also clears a dead 'generating' world
// that would otherwise trip the route's concurrent-generation 409.
//
// Cost: one full world-gen (~$1.50-2.50/run at sticker, per program doc §2).

import { pathToFileURL } from 'node:url'
import type { Pool } from 'pg'
import { createPgPool } from '../../../src/db/postgres.js'
import { QUEUE_WORLD_GEN } from '../../../src/worker/bullmq-config.js'
import { awaitQuiescence } from './quiesce.js'

export interface RunS5Opts {
  readonly baseUrl: string
  readonly devSub: string
}

export interface RunS5Result {
  readonly campaignId: string
  readonly window: { readonly fromMs: number; readonly toMs: number }
}

const WORLD_GEN_TIMEOUT_MS = 45 * 60_000 // full pipeline streams for many minutes
const WORLD_GEN_POLL_MS = 15_000
const QUIESCENCE_TIMEOUT_MS = 5 * 60_000
const SETTLE_MS = 10_000

// FIXED input (spec: "full prep-engine run on fixed input") — comparable
// baselines require the same seed concept every run. Distinctive enough to
// identify this driver's campaigns for pre-run cleanup.
const WORLD_CONCEPT =
  'A drowned river-kingdom where the locks and sluice-gates are holy sites, ' +
  'tended by a guild of gatekeepers who no longer remember which floods they ' +
  'are preventing and which they are preserving. Trade moves on stilt-barges ' +
  'poled between drowned bell-towers; the bells still ring underwater on cold ' +
  'nights, and everyone pretends not to count the strokes. [cost-smoke S-5 fixed input]'

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

function assertLocalDatabase(databaseUrl: string): void {
  const host = new URL(databaseUrl).hostname
  if (host !== 'localhost' && host !== '127.0.0.1') {
    throw new Error(`s5-driver only runs against a LOCAL database; got host=${host}`)
  }
}

async function api(
  opts: RunS5Opts,
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

/* eslint-disable mythrun/no-raw-db-access -- driver cleanup/polling SQL at the
 * same harness tier as the fixture loader; production has no such surface */

/** Delete prior S-5 campaigns/worlds (identified by the fixed concept). */
async function cleanupPriorRuns(pool: Pool): Promise<void> {
  const worlds = await pool.query<{ id: string }>(
    'SELECT id FROM worlds WHERE concept = $1',
    [WORLD_CONCEPT],
  )
  for (const row of worlds.rows) {
    await pool.query('DELETE FROM campaigns WHERE world_id = $1', [row.id])
    await pool.query('DELETE FROM worlds WHERE id = $1', [row.id])
  }
  if (worlds.rows.length > 0) log('prior_runs_cleaned', { worlds: worlds.rows.length })
}

async function pollWorldComplete(pool: Pool, campaignId: string): Promise<void> {
  const deadline = Date.now() + WORLD_GEN_TIMEOUT_MS
  while (Date.now() < deadline) {
    const res = await pool.query<{ status: string }>(
      `SELECT w.status FROM worlds w JOIN campaigns c ON c.world_id = w.id WHERE c.id = $1`,
      [campaignId],
    )
    const status = res.rows[0]?.status
    if (status === 'complete') return
    if (status === 'failed') throw new Error('world-gen failed (worlds.status = failed)')
    log('world_gen_pending', { status: status ?? '(no row)' })
    await sleep(WORLD_GEN_POLL_MS)
  }
  throw new Error(`world-gen did not complete within ${String(WORLD_GEN_TIMEOUT_MS)}ms`)
}

/* eslint-enable mythrun/no-raw-db-access */

/** Cleanup → grant → create (fixed concept) → world 'complete' → quiesce. */
export async function runS5(opts: RunS5Opts): Promise<RunS5Result> {
  const databaseUrl = requiredEnv('DATABASE_URL')
  const redisBatchUrl = requiredEnv('REDIS_BATCH_URL')
  assertLocalDatabase(databaseUrl)
  const pool = createPgPool(databaseUrl)
  try {
    await cleanupPriorRuns(pool)
    const grant = await api(opts, 'POST', '/api/dev/credits/grant', {
      creditType: 'world_gen',
      amount: 1,
    })
    if (grant.status >= 400) throw new Error(`credit grant failed: ${String(grant.status)}`)

    const fromMs = Date.now()
    const created = await api(opts, 'POST', '/api/campaigns', {
      world: { kind: 'new', source: { mode: 'freeform', concept: WORLD_CONCEPT } },
    })
    if (created.status !== 201) {
      throw new Error(`POST /api/campaigns → ${String(created.status)}: ${created.text}`)
    }
    const { campaignId } = JSON.parse(created.text) as { campaignId: string }
    log('campaign_created', { campaignId })

    await pollWorldComplete(pool, campaignId)
    log('world_complete', { campaignId })

    const toMs = await awaitQuiescence({
      redisUrl: redisBatchUrl,
      queues: [QUEUE_WORLD_GEN],
      settleMs: SETTLE_MS,
      timeoutMs: QUIESCENCE_TIMEOUT_MS,
      log,
    })
    log('s5_complete', { campaignId, fromMs, toMs })
    return { campaignId, window: { fromMs, toMs } }
  } finally {
    await pool.end()
  }
}

async function main(): Promise<void> {
  const result = await runS5({
    baseUrl: process.env.S1_BASE_URL ?? 'http://localhost:3030',
    devSub: process.env.S1_DEV_SUB ?? 'dev-user-1',
  })
  process.stdout.write(`\nS5_RESULT=${JSON.stringify(result)}\n`)
  process.exit(0)
}

const entry = process.argv[1]
if (entry !== undefined && import.meta.url === pathToFileURL(entry).href) {
  main().catch((err: unknown) => {
    process.stderr.write(`${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`)
    process.exit(1)
  })
}
