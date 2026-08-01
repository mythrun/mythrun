// backend/scripts/cost/scenarios/s1-driver.ts
//
// Cost Wave 1 Task 4 — the S-1 WS turn-driver (spec §5, S-1 row).
//
// Seeds the constructed-state ready-to-play fixture (the same replay harness the
// session-prep smoke uses), starts a live session through the REAL /start route
// (which self-heals the missing session-1 prep — real Opus, minutes), then plays
// a scripted solo session over the real WS transport: N player turns (default
// 12) including 2 skill-check-shaped inputs, each waiting for the DM turn's
// `turn_end`. The measurement window opens just before turn 1 and closes at
// drained-queue quiescence — BullMQ waiting+active+delayed == 0 across the four
// turn-driven session queues (session-turn, dm-trigger, st-evaluation, scribe),
// held for a settle interval — never at the last WS frame (turn N's eval/audit/
// scribe land after the stream ends).
//
// On close it sends NO end_session (mirrors the ws-transport smoke): S-2
// re-asserts this same window, and the ~5-min suspend keeps the session benign.
//
// Usage (live local stack: `pnpm dev` + worker up, real Anthropic, Redis + PG up):
//   cd backend && pnpm exec tsx --env-file=.env.development \
//     scripts/cost/scenarios/s1-driver.ts [--turns N]
//
// Cost: ~$0.10/turn + one session prep (~$0.30-0.60) per run. The 3-turn form
// is the E2E smoke; the 12-turn form is the baseline scenario (Task 5).

import { pathToFileURL } from 'node:url'
import { Redis } from 'ioredis'
import { Queue } from 'bullmq'
import type { WebSocket } from 'ws'
import { createPgPool } from '../../../src/db/postgres.js'
import { loadFixture, readFixture } from '../../smoke/fixtures/load.js'
import { connectFirstFrame } from '../../smoke/ws-transport.js'
import type { ServerFrame } from '../../../src/contract/session-events.js'
import { QUEUE_SESSION_TURN } from '../../../src/session/turn-queue.js'
import { QUEUE_DM_TRIGGER } from '../../../src/session/dm-trigger-config.js'
import { QUEUE_ST_EVAL } from '../../../src/session/st-eval-queue.js'
import { QUEUE_SCRIBE } from '../../../src/session/scribe-queue.js'

export interface RunS1Opts {
  readonly baseUrl: string
  readonly wsUrl: string
  readonly devSub: string
  /** Player-turn count (default 12 — the full S-1 scenario; the E2E smoke runs 3). */
  readonly turns?: number
}

export interface RunS1Result {
  readonly campaignId: string
  readonly sessionId: string
  readonly window: { readonly fromMs: number; readonly toMs: number }
}

/** The four queues a live turn drives (worker.ts's session set minus the
 *  end-of-session pair + suspend, which this scenario never fires). */
const SESSION_QUEUES = [QUEUE_SESSION_TURN, QUEUE_DM_TRIGGER, QUEUE_ST_EVAL, QUEUE_SCRIBE] as const

const DEFAULT_TURNS = 12
const START_TIMEOUT_MS = 20 * 60_000 // /start polls through the self-healed prep (real Opus)
const START_POLL_MS = 10_000
const TURN_TIMEOUT_MS = 300_000 // quiet-window debounce (4s) + FT stream + tool calls
const COMBAT_RESUME_TIMEOUT_MS = 15_000
const QUIESCENCE_TIMEOUT_MS = 10 * 60_000 // post-turn ST eval (Opus) + scribe chains
const QUIESCENCE_POLL_MS = 1_000
const SETTLE_MS = 10_000 // > the 4s quiet window, so a hidden pending debounce fires inside it

// The scripted session, in-fiction for the fixture's fog-wrapped harbor town +
// road-weary-cartographer PC. Indexes 2 and 7 are the two skill-check-shaped
// inputs (risky non-combat attempts the FT's check flow tends to gate); a
// 3-turn smoke run (slice 0..2) therefore still ends on a check-inviting turn.
const SCRIPT: readonly string[] = [
  'I take in the harbor from the quay — what does the fog leave visible tonight?',
  'I ask the nearest lamplighter what name they traded away for their lamp.',
  'I climb the slick harbor wall to reach the lamplighters gallery above the quay, fog or no fog.',
  'I sketch the gallery onto my map and note anything that seems out of place.',
  'I follow the tide-line south toward the old debt-houses.',
  'I ask around the debt-house steps about a ship that never made it out of this harbor.',
  'I buy a cup of something warm and listen in on the dockworkers talk.',
  'I try to slip past the watchman unseen into the tide-warehouse and copy the harbor ledger.',
  'I study whatever ledger pages I managed to see and cross-reference them with my map.',
  'I head back along the quay looking for the lamplighter I spoke with earlier.',
  'I ask them plainly what the tide carried ashore this week.',
  'I find a bench under a working lamp, update my map, and plan tomorrows route.',
]

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

/** This driver DELETEs + reloads fixture rows — fence it to a local database the
 *  way guard-db fences the test DB, so a mis-set DATABASE_URL can never point it
 *  at anything remote. */
function assertLocalDatabase(databaseUrl: string): void {
  const host = new URL(databaseUrl).hostname
  if (host !== 'localhost' && host !== '127.0.0.1') {
    throw new Error(`s1-driver only runs against a LOCAL database; got host=${host}`)
  }
}

async function api<T>(
  opts: RunS1Opts,
  method: string,
  path: string,
  body?: unknown,
): Promise<T> {
  // content-type only WITH a body — Fastify 400s an empty application/json POST.
  const res = await fetch(`${opts.baseUrl}${path}`, {
    method,
    headers: {
      'x-mythrun-dev-sub': opts.devSub,
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })
  const text = await res.text()
  if (!res.ok) throw new Error(`${method} ${path} → ${String(res.status)}: ${text}`)
  return text.length > 0 ? (JSON.parse(text) as T) : ({} as T)
}

/** Replay the ready-to-play fixture into the LIVE stack's database. Delete-then-
 *  load (load.ts) makes reruns idempotent: prior runs' sessions/messages/preps
 *  cascade away with the campaign row, so every run starts from the identical
 *  constructed state (measurement reproducibility over prep reuse). */
async function seedReadyToPlay(databaseUrl: string): Promise<string> {
  assertLocalDatabase(databaseUrl)
  const pool = createPgPool(databaseUrl)
  try {
    // Pre-clean: a prior run's sessions hold session_participants rows whose
    // character_id FK has NO cascade from characters, and load.ts deletes
    // characters BEFORE campaigns — so the campaign row goes first, cascading
    // sessions/participants/messages/preps away.
    // eslint-disable-next-line mythrun/no-raw-db-access -- fixture-reset SQL, same harness tier as load.ts's delete-then-load; production has no campaign delete to call
    await pool.query('DELETE FROM campaigns WHERE id = $1', [
      readFixture('ready-to-play-campaign').rootCampaignId,
    ])
    const fixture = await loadFixture(pool, 'ready-to-play-campaign')
    log('fixture_loaded', { campaignId: fixture.rootCampaignId, worldId: fixture.rootWorldId })
    return fixture.rootCampaignId
  } finally {
    await pool.end()
  }
}

/** POST /start until 200. The first call typically 409s `prep_not_ready` and
 *  self-enqueues the session-1 prep (MYT-102); we poll through the real-Opus
 *  prep. Any other failure is terminal — fail loudly. */
async function startSession(opts: RunS1Opts, campaignId: string): Promise<string> {
  const deadline = Date.now() + START_TIMEOUT_MS
  let last = ''
  while (Date.now() < deadline) {
    const res = await fetch(`${opts.baseUrl}/api/sessions/${campaignId}/start`, {
      method: 'POST',
      headers: { 'x-mythrun-dev-sub': opts.devSub },
    })
    const text = await res.text()
    if (res.ok) return (JSON.parse(text) as { sessionId: string }).sessionId
    last = `${String(res.status)}: ${text}`
    let code: string | undefined
    try {
      code = (JSON.parse(text) as { code?: string }).code
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

/** Sequential frame consumer over one socket. The driver is strictly
 *  single-waiter (one turn in flight at a time), so a single parked resolver
 *  suffices; a socket error/close rejects the current and every future wait. */
class FrameSink {
  private readonly buffer: ServerFrame[] = []
  private waiter: { resolve: (f: ServerFrame) => void; reject: (e: Error) => void } | null = null
  private failure: Error | null = null
  private closed = false

  attach(socket: WebSocket): void {
    socket.on('message', (data: Buffer) => {
      this.push(JSON.parse(data.toString()) as ServerFrame)
    })
    socket.on('close', (code: number) => {
      this.fail(new Error(`socket closed mid-run (code ${String(code)})`))
    })
    socket.on('error', (err: Error) => {
      this.fail(err)
    })
  }

  private push(frame: ServerFrame): void {
    if (this.waiter !== null) {
      const w = this.waiter
      this.waiter = null
      w.resolve(frame)
      return
    }
    this.buffer.push(frame)
  }

  private fail(err: Error): void {
    if (this.closed) return
    this.failure = err
    if (this.waiter !== null) {
      const w = this.waiter
      this.waiter = null
      w.reject(err)
    }
  }

  /** Expected teardown: stop treating the coming socket close as a failure. */
  expectClose(): void {
    this.closed = true
  }

  next(timeoutMs: number): Promise<ServerFrame> {
    const head = this.buffer.shift()
    if (head !== undefined) return Promise.resolve(head)
    if (this.failure !== null) return Promise.reject(this.failure)
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.waiter = null
        reject(new Error(`no frame within ${String(timeoutMs)}ms`))
      }, timeoutMs)
      this.waiter = {
        resolve: (f) => {
          clearTimeout(timer)
          resolve(f)
        },
        reject: (e) => {
          clearTimeout(timer)
          reject(e)
        },
      }
    })
  }

  drain(): void {
    this.buffer.length = 0
  }
}

/** A fight resolved mid-turn leaves the session in combat mode, whose drop-gate
 *  would eat every later player_message. Summon the flip back and wait for the
 *  mode_change so the next scripted turn lands. */
async function resumeCombat(sink: FrameSink, socket: WebSocket): Promise<void> {
  log('combat_resume_send', {})
  socket.send(JSON.stringify({ type: 'resume_combat' }))
  const deadline = Date.now() + COMBAT_RESUME_TIMEOUT_MS
  while (Date.now() < deadline) {
    const frame = await sink.next(deadline - Date.now())
    if (frame.type === 'mode_change' && frame.to === 'exploration') return
  }
  throw new Error('resume_combat: no mode_change back to exploration')
}

/** Send one scripted player message and consume frames until the DM turn's
 *  `turn_end`. `turn_error` and a per-turn timeout both fail loudly. */
async function driveTurn(
  sink: FrameSink,
  socket: WebSocket,
  text: string,
  turnNumber: number,
): Promise<{ skillChecks: number }> {
  sink.drain() // discard stale inter-turn frames (presence, ledger updates)
  socket.send(JSON.stringify({ type: 'player_message', text }))
  const deadline = Date.now() + TURN_TIMEOUT_MS
  let skillChecks = 0
  let sawCombat = false
  while (Date.now() < deadline) {
    const frame = await sink.next(deadline - Date.now())
    if (frame.type === 'turn_error') {
      throw new Error(`turn ${String(turnNumber)}: turn_error — ${frame.message}`)
    }
    if (frame.type === 'skill_check') skillChecks += 1
    if (frame.type === 'combat_started' || frame.type === 'combat_resolved') sawCombat = true
    if (frame.type === 'turn_end') {
      if (sawCombat) await resumeCombat(sink, socket)
      return { skillChecks }
    }
  }
  throw new Error(`turn ${String(turnNumber)}: no turn_end within ${String(TURN_TIMEOUT_MS)}ms`)
}

/** Sum waiting+active+delayed across one queue. Delayed counts on purpose: a
 *  parked debounce or a backoff retry is work the window hasn't absorbed yet. */
async function pendingCount(queue: Queue): Promise<number> {
  const counts = await queue.getJobCounts('waiting', 'active', 'delayed')
  return Object.values(counts).reduce((s, n) => s + n, 0)
}

/** Drained-queue quiescence (spec §1.1(3)): all four session queues at zero
 *  pending, HELD for SETTLE_MS. Returns toMs (settle completion). */
async function awaitQuiescence(redisBatchUrl: string): Promise<number> {
  const connection = new Redis(redisBatchUrl, { maxRetriesPerRequest: null })
  const queues = SESSION_QUEUES.map((name) => new Queue(name, { connection }))
  try {
    const deadline = Date.now() + QUIESCENCE_TIMEOUT_MS
    let zeroSince: number | null = null
    while (Date.now() < deadline) {
      const perQueue = await Promise.all(queues.map(pendingCount))
      const total = perQueue.reduce((s, n) => s + n, 0)
      if (total === 0) {
        zeroSince ??= Date.now()
        if (Date.now() - zeroSince >= SETTLE_MS) {
          log('quiescence_settled', { settleMs: SETTLE_MS })
          return Date.now()
        }
      } else {
        if (zeroSince !== null) log('quiescence_reset', {})
        zeroSince = null
        log('quiescence_wait', {
          counts: Object.fromEntries(SESSION_QUEUES.map((n, i) => [n, perQueue[i]])),
        })
      }
      await sleep(QUIESCENCE_POLL_MS)
    }
    throw new Error(`queues never quiesced within ${String(QUIESCENCE_TIMEOUT_MS)}ms`)
  } finally {
    await Promise.all(queues.map((q) => q.close()))
    connection.disconnect()
  }
}

/** Seed → start → connect → drive N turns → quiesce. Reads DATABASE_URL +
 *  REDIS_BATCH_URL from env (the live local stack's own settings). */
export async function runS1(opts: RunS1Opts): Promise<RunS1Result> {
  const turns = opts.turns ?? DEFAULT_TURNS
  if (turns < 1 || turns > SCRIPT.length) {
    throw new Error(`turns must be 1..${String(SCRIPT.length)}, got ${String(turns)}`)
  }
  const databaseUrl = requiredEnv('DATABASE_URL')
  const redisBatchUrl = requiredEnv('REDIS_BATCH_URL')

  const campaignId = await seedReadyToPlay(databaseUrl)
  await api(opts, 'POST', '/api/dev/credits/grant', { creditType: 'session', amount: 5 })
  const sessionId = await startSession(opts, campaignId)
  log('session_started', { campaignId, sessionId })

  const { ticket } = await api<{ ticket: string }>(opts, 'POST', `/api/sessions/${sessionId}/ws-ticket`)
  // lastSeq=0 mirrors the shipped client: the first frame is then a DIRECT-sent
  // session_reconnect — deterministic, unlike session_ready vs the racy
  // player_joined pub/sub fan-out.
  const { socket, first } = await connectFirstFrame(sessionId, ticket, 0, opts.wsUrl)
  if (first.type !== 'session_reconnect') {
    socket.terminate()
    throw new Error(`expected session_reconnect first frame, got ${first.type}`)
  }
  const sink = new FrameSink()
  sink.attach(socket)
  log('ws_connected', { sessionId })

  const fromMs = Date.now()
  let skillChecks = 0
  for (let i = 0; i < turns; i += 1) {
    const text = SCRIPT[i]
    if (text === undefined) throw new Error(`no script line for turn ${String(i + 1)}`)
    log('turn_send', { turn: i + 1, of: turns, text })
    const t0 = Date.now()
    const result = await driveTurn(sink, socket, text, i + 1)
    skillChecks += result.skillChecks
    log('turn_complete', { turn: i + 1, ms: Date.now() - t0, skillChecks: result.skillChecks })
  }

  const toMs = await awaitQuiescence(redisBatchUrl)
  // NO end_session (mirrors ws-transport.ts): S-2 re-asserts this same window,
  // and the all-disconnected suspend cleans up the live session harmlessly.
  sink.expectClose()
  socket.close()
  log('s1_complete', { campaignId, sessionId, fromMs, toMs, turns, skillChecks })
  return { campaignId, sessionId, window: { fromMs, toMs } }
}

function parseTurnsFlag(argv: readonly string[]): number | undefined {
  const i = argv.indexOf('--turns')
  if (i === -1) return undefined
  const raw = argv[i + 1]
  const n = Number(raw)
  if (!Number.isInteger(n) || n < 1) {
    throw new Error(`--turns expects a positive integer, got ${raw ?? '(missing)'}`)
  }
  return n
}

async function main(): Promise<void> {
  const turns = parseTurnsFlag(process.argv.slice(2))
  const result = await runS1({
    baseUrl: process.env.S1_BASE_URL ?? 'http://localhost:3030',
    wsUrl: process.env.S1_WS_URL ?? 'ws://localhost:3030',
    devSub: process.env.S1_DEV_SUB ?? 'dev-user-1',
    ...(turns !== undefined ? { turns } : {}),
  })
  process.stdout.write(`\nS1_RESULT=${JSON.stringify(result)}\n`)
  process.exit(0)
}

const entry = process.argv[1]
if (entry !== undefined && import.meta.url === pathToFileURL(entry).href) {
  main().catch((err: unknown) => {
    process.stderr.write(`${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`)
    process.exit(1)
  })
}
