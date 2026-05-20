// backend/scripts/smoke/phantom-reconciliation.ts
//
// Real-LLM end-to-end smoke for the phantom-reference reconciliation path.
// Drives a fresh world-gen against a running backend + real Anthropic API,
// tails the campaign's SSE stream, polls until `worlds.status='complete'`,
// then asserts the structural state the spec requires:
//
//   - all 9 world-gen stages in `pipeline_runs` reach `completed`
//   - entities exist for stages 3 (world_and_factions) and 4 (locations_and_npcs)
//   - total entity count is ≥30
//   - IF the run produced phantom declarations at stage 4, the
//     stage:entity_consolidation rows landed in `entities` (Layer 2
//     acceptance for stage 4b — phantom path actually exercised end-to-end)
//
// Runs up to MAX_RUNS attempts; passes if at least one attempt exercised
// the phantom path. The concept is hand-crafted to be phantom-prone (named
// factions hint at relationships the relationships stage will mint as
// phantoms), but the LLM can still draft a clean stage 4 — hence the retry
// loop.
//
// Smoke vs eval distinction (feedback_smoke_vs_eval): this asserts on
// HTTP shape, SSE shape, and DB invariants — NOT on prose quality, NPC
// distinctness, or "is this a good world." Quality belongs in the eval
// harness, not here.
//
// Usage: `cd backend && pnpm smoke:phantom-reconciliation`. Requires:
//   - backend running locally (`pnpm dev`)
//   - ANTHROPIC_API_KEY available to the backend's env
//   - postgres + redis up (`pnpm db:up` from repo root)
//
// Cost: ~$0.50–$1.50 per run depending on stage 4b's phantom count.

import { Pool } from 'pg'
import { mkdirSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'

const BACKEND_URL = process.env.SMOKE_BACKEND_URL ?? 'http://localhost:3030'
const DEV_USER_SUB = process.env.SMOKE_DEV_USER_SUB ?? 'dev-user-1'
const MAX_RUNS = Number(process.env.SMOKE_MAX_RUNS ?? '3')
const POLL_INTERVAL_MS = 5_000
const RUN_TIMEOUT_MS = 15 * 60_000
const SSE_PATH = '/status/stream'

// Phantom-prone concept: stage 4 (locations_and_npcs) writes named
// hunting bands + magic institutions; stage 5 (entity_relationships) is
// then very likely to reference siblings (e.g., "Magisterium's rival is
// the Aetheric Conservatory") by `new-NNN` placeholders rather than
// crafting every relationship from rows already in the entities table.
// Tuned during smoke design; if a run produces no phantoms we retry.
const CONCEPT = [
  'A floating sky city above a harsh desert.',
  'The sky-dwellers wield magic; the desert-dwellers hunt megafauna in named bands.',
  'There is tension between the magisters above and the underclass below.',
  'Named hunting bands: Ironjaw, Long Vigil, Ash-and-Salt, Stoneback.',
  'Named magic institutions: the Magisterium, the Aetheric Conservatory, the Procurement Office.',
  'A black market trades artifacts between the two worlds.',
].join(' ')

const WORLD_GEN_STAGES = [
  'concept_intake',
  'vocabulary_intake',
  'world_and_factions',
  'locations_and_npcs',
  'entity_relationships',
  'entity_consolidation',
  'starting_situation',
  'random_tables',
  'coherence_pass',
] as const

interface SseEvent {
  readonly type: string
  readonly [k: string]: unknown
}

interface RunResult {
  readonly campaignId: string
  readonly worldId: string
  readonly worldStatus: string
  readonly events: readonly SseEvent[]
  readonly stageCompletedSet: ReadonlySet<string>
  readonly consolidationEntityCount: number
}

function authHeaders(): Record<string, string> {
  return {
    'Content-Type': 'application/json',
    'x-mythrun-dev-sub': DEV_USER_SUB,
  }
}

function log(msg: string): void {
  // JSON-line log for grep-ability; matches the pino convention used elsewhere.
  process.stdout.write(`${JSON.stringify({ ts: new Date().toISOString(), msg })}\n`)
}

async function grantCredits(): Promise<void> {
  // Dev-only route: force-grants 5 world_gen credits to the active dev sub.
  // Idempotent in effect — over-granting is fine; the cap is 100 per call.
  const res = await fetch(`${BACKEND_URL}/api/dev/credits/grant`, {
    method: 'POST',
    headers: authHeaders(),
    body: JSON.stringify({ creditType: 'world_gen', amount: 5 }),
  })
  if (!res.ok) {
    throw new Error(`grant credits failed: ${String(res.status)} ${await res.text()}`)
  }
  const body = (await res.json()) as { newBalance: number }
  log(`credits granted; world_gen balance=${String(body.newBalance)}`)
}

async function createCampaign(): Promise<string> {
  const res = await fetch(`${BACKEND_URL}/api/campaigns`, {
    method: 'POST',
    headers: authHeaders(),
    body: JSON.stringify({
      world: { kind: 'new', source: { mode: 'freeform', concept: CONCEPT } },
      devBypassAccessFilter: true,
    }),
  })
  if (!res.ok) {
    throw new Error(`create campaign failed: ${String(res.status)} ${await res.text()}`)
  }
  const body = (await res.json()) as { campaignId: string }
  return body.campaignId
}

interface CampaignDetail {
  readonly campaign: { readonly id: string; readonly worldId: string }
  readonly world: { readonly id: string; readonly status: string }
}

async function fetchDetail(campaignId: string): Promise<CampaignDetail> {
  const res = await fetch(`${BACKEND_URL}/api/campaigns/${campaignId}`, {
    headers: authHeaders(),
  })
  if (!res.ok) {
    throw new Error(`fetch detail failed: ${String(res.status)} ${await res.text()}`)
  }
  return (await res.json()) as CampaignDetail
}

// Native fetch SSE reader — no `eventsource` dep needed. Returns a
// detach function that aborts the underlying stream. The pump runs as
// a background promise; events accumulate in the passed-in sink array.
function startSseTail(
  campaignId: string,
  sink: SseEvent[],
  onError: (err: Error) => void,
): () => void {
  const controller = new AbortController()
  const url = `${BACKEND_URL}/api/campaigns/${campaignId}${SSE_PATH}`
  void (async () => {
    try {
      const res = await fetch(url, {
        headers: { ...authHeaders(), Accept: 'text/event-stream' },
        signal: controller.signal,
      })
      if (!res.ok || !res.body) {
        throw new Error(`SSE connect failed: ${String(res.status)}`)
      }
      const reader = res.body.getReader()
      const decoder = new TextDecoder()
      let buffer = ''
      // Bounded by the runner's controller.abort(); ESLint rejects
      // `while (true)` so we hang the loop off the abort flag, which
      // the AbortController also flips after the outer poll loop ends.
      while (!controller.signal.aborted) {
        const { done, value } = await reader.read()
        if (done) return
        buffer += decoder.decode(value, { stream: true })
        // SSE frames are separated by a blank line (\n\n). Each frame may
        // have an `event:` line + one or more `data:` lines.
        let frameEnd = buffer.indexOf('\n\n')
        while (frameEnd !== -1) {
          const frame = buffer.slice(0, frameEnd)
          buffer = buffer.slice(frameEnd + 2)
          const dataLines = frame
            .split('\n')
            .filter((l) => l.startsWith('data:'))
            .map((l) => l.slice(5).trimStart())
          if (dataLines.length > 0) {
            const dataStr = dataLines.join('\n')
            try {
              const evt = JSON.parse(dataStr) as SseEvent
              sink.push(evt)
            } catch {
              // Ignore non-JSON keepalives + snapshot frames the server emits
              // as plain text. Smoke cares about typed pipeline events.
            }
          }
          frameEnd = buffer.indexOf('\n\n')
        }
      }
    } catch (err) {
      if (controller.signal.aborted) return
      onError(err instanceof Error ? err : new Error(String(err)))
    }
  })()
  return () => {
    controller.abort()
  }
}

async function runOnce(pool: Pool, runIdx: number): Promise<RunResult> {
  log(`[run ${String(runIdx)}] granting credits`)
  await grantCredits()
  log(`[run ${String(runIdx)}] creating campaign`)
  const campaignId = await createCampaign()
  log(`[run ${String(runIdx)}] campaignId=${campaignId}`)

  const events: SseEvent[] = []
  // Holder lets the closure mutate without tripping TS's
  // no-unnecessary-condition narrowing on a top-level `let`.
  const sseErr: { err: Error | null } = { err: null }
  const detach = startSseTail(campaignId, events, (err) => {
    sseErr.err = err
    log(`[run ${String(runIdx)}] sse error: ${err.message}`)
  })

  // Poll worlds.status via the detail endpoint. Loops every POLL_INTERVAL_MS
  // until status flips to 'complete' or 'failed', or RUN_TIMEOUT_MS elapses.
  const deadline = Date.now() + RUN_TIMEOUT_MS
  let worldId = ''
  let worldStatus = 'unknown'
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS))
    try {
      const detail = await fetchDetail(campaignId)
      worldId = detail.world.id
      worldStatus = detail.world.status
      log(`[run ${String(runIdx)}] poll status=${worldStatus} events=${String(events.length)}`)
      if (worldStatus === 'complete' || worldStatus === 'failed') break
    } catch (err) {
      log(`[run ${String(runIdx)}] poll error: ${String(err)}`)
    }
  }
  detach()

  if (sseErr.err !== null) {
    // SSE errors are warnings, not fatal — DB state is the source of truth.
    log(`[run ${String(runIdx)}] sse ended with error (non-fatal): ${sseErr.err.message}`)
  }

  if (worldId === '') {
    throw new Error(`[run ${String(runIdx)}] never observed a world row before timeout`)
  }

  // Persist events for post-mortem. tmp/ is repo-root and gitignored.
  const eventDir = resolve('tmp', 'smoke', campaignId)
  mkdirSync(eventDir, { recursive: true })
  writeFileSync(
    resolve(eventDir, 'events.jsonl'),
    `${events.map((e) => JSON.stringify(e)).join('\n')}\n`,
  )

  // Derive completed stage set from SSE events for cross-check; the DB
  // is authoritative but the event tape catches drift between the two.
  const stageCompletedSet = new Set<string>()
  for (const e of events) {
    if (e.type === 'stage-completed' && typeof e.stage === 'string') {
      stageCompletedSet.add(e.stage)
    }
  }

  const consolidationCount = await pool.query<{ n: string }>(
    `SELECT COUNT(*)::text AS n FROM entities
       WHERE world_id = $1 AND created_in = 'stage:entity_consolidation'`,
    [worldId],
  )
  const consolidationEntityCount = Number(consolidationCount.rows[0]?.n ?? '0')

  return {
    campaignId,
    worldId,
    worldStatus,
    events,
    stageCompletedSet,
    consolidationEntityCount,
  }
}

async function assertStructural(pool: Pool, result: RunResult): Promise<void> {
  if (result.worldStatus !== 'complete') {
    throw new Error(
      `world status=${result.worldStatus}, expected 'complete' (campaignId=${result.campaignId})`,
    )
  }
  const pr = await pool.query<{ stage: string; status: string }>(
    `SELECT stage, status FROM pipeline_runs
       WHERE world_id = $1 AND user_id IS NULL
       ORDER BY started_at`,
    [result.worldId],
  )
  const stagesByName = new Map(pr.rows.map((r) => [r.stage, r.status]))
  for (const stage of WORLD_GEN_STAGES) {
    const got = stagesByName.get(stage)
    if (got !== 'completed') {
      throw new Error(`stage ${stage}: status=${got ?? 'missing'}, expected completed`)
    }
  }

  const counts = await pool.query<{ created_in: string; n: string }>(
    `SELECT created_in, COUNT(*)::text AS n FROM entities
       WHERE world_id = $1 GROUP BY created_in`,
    [result.worldId],
  )
  const byOrigin = new Map(counts.rows.map((r) => [r.created_in, Number(r.n)]))
  const factionsCount = byOrigin.get('stage:world_and_factions') ?? 0
  const locationsCount = byOrigin.get('stage:locations_and_npcs') ?? 0
  if (factionsCount < 1) throw new Error('no stage:world_and_factions entities')
  if (locationsCount < 1) throw new Error('no stage:locations_and_npcs entities')
  const total = [...byOrigin.values()].reduce((s, n) => s + n, 0)
  if (total < 30) throw new Error(`total entities=${String(total)}, expected ≥30`)

  log(
    `[assert] stages=${String(WORLD_GEN_STAGES.length)} ok; ` +
      `factions=${String(factionsCount)} locations=${String(locationsCount)} ` +
      `consolidation=${String(result.consolidationEntityCount)} total=${String(total)}`,
  )
}

async function main(): Promise<void> {
  const databaseUrl = process.env.DATABASE_URL
  if (databaseUrl === undefined || databaseUrl === '') {
    throw new Error('DATABASE_URL is required (loaded from .env.development)')
  }
  const pool = new Pool({ connectionString: databaseUrl })
  try {
    let exercisedAny = false
    let lastResult: RunResult | null = null
    for (let i = 1; i <= MAX_RUNS; i++) {
      const result = await runOnce(pool, i)
      await assertStructural(pool, result)
      lastResult = result
      if (result.consolidationEntityCount > 0) {
        exercisedAny = true
        log(`[run ${String(i)}] exercised phantom path (consolidation entities=${String(result.consolidationEntityCount)})`)
        break
      }
      log(`[run ${String(i)}] no phantoms produced; retrying`)
    }
    if (!exercisedAny) {
      throw new Error(
        `phantom path not exercised after ${String(MAX_RUNS)} attempts; ` +
          'increase SMOKE_MAX_RUNS or tune CONCEPT to be more phantom-prone',
      )
    }
    log(`SMOKE PASSED. Final run: ${lastResult?.campaignId ?? 'unknown'}`)
  } finally {
    await pool.end()
  }
}

main().catch((err: unknown) => {
  process.stderr.write(`${err instanceof Error ? err.stack ?? err.message : String(err)}\n`)
  process.exit(1)
})
