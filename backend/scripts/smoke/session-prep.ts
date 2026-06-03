// backend/scripts/smoke/session-prep.ts
//
// MYT-64 — the FIRST real-Opus exercise of generateSessionPrep. Constructed-direct:
// load the ready-to-play fixture into mythrun_test, invoke processSessionPrepJob with
// real Opus + recording publishers, assert the plumbing. Manual (real LLM ~$0.30-0.60),
// NOT in CI. Targets mythrun_test (NOT mythrun_dev).
//
// PRECONDITIONS: `pnpm db:migrate:test` (or a prior `pnpm test`) so mythrun_test has a
// schema. Do NOT run concurrently with `pnpm test` (both hit mythrun_test).

import { guardTestDatabase } from '../../src/db/__tests__/guard-db.js'
import { createTestPool } from '../../src/repo/__tests__/_helpers/test-pool.js'
import { loadFixture } from './fixtures/load.js'
import {
  processSessionPrepJob,
  type SessionPrepProcessorDeps,
} from '../../src/llm/prep/session-prep-processor.js'
import type { PipelineEvent, ProseEvent } from '../../src/contract/pipeline-events.js'

function log(msg: string, extra?: Record<string, unknown>): void {
  process.stdout.write(`${JSON.stringify({ ts: new Date().toISOString(), msg, ...extra })}\n`)
}

async function main(): Promise<void> {
  const dbUrl = process.env.DATABASE_URL_TEST
  if (dbUrl === undefined || dbUrl === '') {
    throw new Error('DATABASE_URL_TEST required (set in .env.development) — this smoke targets mythrun_test')
  }
  await guardTestDatabase(dbUrl) // localhost + /^mythrun_test(_.+)?$/ fence
  const pool = createTestPool(dbUrl)

  const events: PipelineEvent[] = []
  const prose: ProseEvent[] = []
  const deps: SessionPrepProcessorDeps = {
    pool,
    publishEvent: (_campaignId, event) => {
      events.push(event)
      return Promise.resolve()
    },
    publishProse: (_campaignId, event) => {
      prose.push(event)
      return Promise.resolve()
    },
  }

  try {
    const fixture = await loadFixture(pool, 'ready-to-play-campaign')
    const campaignId = fixture.rootCampaignId
    log('fixture_loaded', { campaignId, worldId: fixture.rootWorldId })

    const t0 = Date.now()
    await processSessionPrepJob(deps, { data: { campaignId, sessionNumber: 1 } })
    log('processor_returned', { ms: Date.now() - t0 })

    // --- Assertions (fail loudly; never report success on a miss) ---
    const started = events.find((e) => e.type === 'prep-started')
    const ready = events.find((e) => e.type === 'prep-ready')
    if (!started) throw new Error('no prep-started event emitted')
    if (!ready || ready.type !== 'prep-ready') throw new Error('no prep-ready event emitted')
    if (ready.costUsd <= 0) throw new Error(`prep-ready costUsd not positive: ${String(ready.costUsd)}`)
    if (events.indexOf(started) > events.indexOf(ready)) throw new Error('prep-started emitted after prep-ready')

    const row = await pool.query<{ ft_context: string; sd_playbook: string }>(
      `SELECT ft_context, sd_playbook FROM session_preps WHERE campaign_id = $1 AND session_number = 1`,
      [campaignId],
    )
    const prep = row.rows[0]
    if (!prep) throw new Error('no session_preps row written')
    if (prep.ft_context.length === 0 || prep.sd_playbook.length === 0) {
      throw new Error('ft_context or sd_playbook empty')
    }
    if (prep.ft_context === prep.sd_playbook) throw new Error('ft_context and sd_playbook are identical')

    const stage = await pool.query<{ status: string; cost_usd: string }>(
      `SELECT status, cost_usd FROM pipeline_runs WHERE campaign_id = $1 AND stage = 'session-prep:1' AND user_id IS NULL`,
      [campaignId],
    )
    if (stage.rows[0]?.status !== 'completed') {
      throw new Error(`pipeline_runs session-prep:1 status = ${String(stage.rows[0]?.status)}`)
    }
    if (Number(stage.rows[0]?.cost_usd) <= 0) throw new Error('pipeline_runs cost_usd not positive')

    // --- Soft/diagnostic (warn, do NOT fail): per-field prose deltas ---
    // Deltas come from the FIRST partial stream; the haiku-then-sonnet repair runs after,
    // so a repaired field may stream no deltas while await result.object still succeeds.
    for (const field of ['ft_context', 'sd_playbook'] as const) {
      const n = prose.filter((p) => p.field === field).length
      if (n === 0) log('WARN_no_prose_deltas', { field })
      else log('prose_deltas', { field, count: n })
    }

    log('SMOKE PASSED', {
      costUsd: ready.costUsd,
      ftContextLen: prep.ft_context.length,
      sdPlaybookLen: prep.sd_playbook.length,
    })

    // Cleanup: delete the fixture's non-shared rows (characters don't cascade from the world).
    const charIds = (fixture.tables.find((t) => t.name === 'characters')?.rows ?? []).map(
      (r) => (r as { id: string }).id,
    )
    if (charIds.length > 0) await pool.query(`DELETE FROM characters WHERE id = ANY($1)`, [charIds])
    await pool.query(`DELETE FROM worlds WHERE id = $1`, [fixture.rootWorldId])
  } finally {
    await pool.end()
  }
}

main().catch((err: unknown) => {
  process.stderr.write(`${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`)
  process.exit(1)
})
