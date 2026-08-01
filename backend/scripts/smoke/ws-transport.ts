// backend/scripts/smoke/ws-transport.ts
//
// MYT-85 — the reusable real-wire WS transport smoke against deployed staging.
// Validates the things unit tests + a dev forced-disconnect cannot:
//   - a 101 WebSocket upgrade through the CloudFront /ws/* proxy,
//   - the first-frame contract (session_ready fresh, session_reconnect on lastSeq),
//   - idle-survival across >= 2 heartbeats (the 30s server ping vs the 60s
//     origin_read_timeout — the prod-only reaping risk this smoke exists to catch).
// Deliberately cheap: it never drives a turn, so no LLM call and no credit spend.
// On close it sends NO end_session, so the backend's ~5-min suspend keeps the
// session active and the smoke is rerunnable for ~$0.
//
// Auth + the campaignId arrive from the wrapper (ws-transport.sh) via env:
//   SMOKE_ACCESS_TOKEN, SMOKE_CAMPAIGN_ID. Same-origin paths (mirrors the browser):
//   REST + WS both ride staging.mythrun.com (the /api/* and /ws/* CloudFront behaviors).

import { pathToFileURL } from 'node:url'
import { WebSocket } from 'ws'

const FRONTEND = process.env.SMOKE_FRONTEND_BASE ?? 'https://staging.mythrun.com'
const IDLE_HOLD_MS = 75_000 // > 2 * 30s heartbeat

export interface Frame {
  readonly type: string
}
interface ActiveResp {
  readonly session: { readonly id: string; readonly status: string }
}

function env(name: string): string {
  const v = process.env[name]
  if (v === undefined || v === '') fail(`missing env ${name}`)
  return v
}
function ok(m: string): void {
  process.stdout.write(`✓ ${m}\n`)
}
function info(m: string): void {
  process.stdout.write(`→ ${m}\n`)
}
function fail(m: string): never {
  process.stderr.write(`✗ ${m}\n`)
  process.exit(1)
}
function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}

async function rest<T>(method: string, path: string, token: string): Promise<T> {
  const res = await fetch(`${FRONTEND}${path}`, {
    method,
    headers: { authorization: `Bearer ${token}` },
  })
  const text = await res.text()
  if (!res.ok) fail(`${method} ${path} -> ${String(res.status)}: ${text}`)
  return JSON.parse(text) as T
}

/** Open a socket and resolve with the FIRST frame (or reject on error / a close
 *  before any frame). The browser WS API can't read the handshake status, but the
 *  Node `ws` client surfaces a pre-upgrade non-101 as an `error` with the status.
 *  Exported for reuse (cost scenario drivers); `wsBase` defaults to this smoke's
 *  staging FRONTEND so the direct-run behavior is unchanged. */
export function connectFirstFrame(
  sessionId: string,
  ticket: string,
  lastSeq: number | null,
  wsBase: string = FRONTEND.replace(/^http/, 'ws'),
): Promise<{ socket: WebSocket; first: Frame }> {
  const url =
    `${wsBase}/ws/session/${sessionId}?ticket=${encodeURIComponent(ticket)}` +
    (lastSeq === null ? '' : `&lastSeq=${String(lastSeq)}`)
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url)
    const timer = setTimeout(() => {
      socket.terminate()
      reject(new Error('no first frame within 15s'))
    }, 15_000)
    socket.once('message', (data: Buffer) => {
      clearTimeout(timer)
      resolve({ socket, first: JSON.parse(data.toString()) as Frame })
    })
    socket.once('error', (err: Error) => {
      clearTimeout(timer)
      reject(err)
    })
    socket.once('close', (code: number, reason: Buffer) => {
      clearTimeout(timer)
      reject(new Error(`closed ${String(code)} ${reason.toString()} before first frame`))
    })
  })
}

async function main(): Promise<void> {
  const token = env('SMOKE_ACCESS_TOKEN')
  const campaignId = env('SMOKE_CAMPAIGN_ID')

  const { session } = await rest<ActiveResp>('GET', `/api/sessions/${campaignId}/active`, token)
  if (session.status !== 'active') fail(`active session has status=${session.status}`)
  ok(`active session ${session.id}`)
  const sid = session.id

  // 1. Fresh connect -> session_ready (a 101 upgrade through CloudFront /ws/*).
  const { ticket: t1 } = await rest<{ ticket: string }>('POST', `/api/sessions/${sid}/ws-ticket`, token)
  const { socket: s1, first } = await connectFirstFrame(sid, t1, null)
  if (first.type !== 'session_ready') fail(`fresh connect: expected session_ready, got ${first.type}`)
  ok('fresh connect -> session_ready (101 via CloudFront /ws/*)')

  // 2. Idle-survival: hold silent > 2 heartbeats; the socket must stay OPEN.
  let pings = 0
  s1.on('ping', () => {
    pings += 1
  })
  info(`holding ${String(IDLE_HOLD_MS / 1000)}s silent for idle-survival (>= 2 heartbeats)...`)
  await sleep(IDLE_HOLD_MS)
  if (s1.readyState !== WebSocket.OPEN) {
    fail(`socket dropped during idle (readyState=${String(s1.readyState)}) — CloudFront reaped the idle tunnel`)
  }
  ok(`idle-survival: OPEN after ${String(IDLE_HOLD_MS / 1000)}s, ${String(pings)} server pings observed`)
  s1.close()
  await sleep(500)

  // 3. Reconnect with lastSeq -> session_reconnect (the L1 reconnect path).
  const { ticket: t2 } = await rest<{ ticket: string }>('POST', `/api/sessions/${sid}/ws-ticket`, token)
  const { socket: s2, first: rf } = await connectFirstFrame(sid, t2, 0)
  if (rf.type !== 'session_reconnect') fail(`reconnect: expected session_reconnect, got ${rf.type}`)
  ok('reconnect (lastSeq=0) -> session_reconnect (replay path)')
  s2.close() // NO end_session: the ~5-min suspend keeps the session active for the next run.
  await sleep(500)

  process.stdout.write('\nWS transport smoke PASSED.\n')
  process.exit(0)
}

// Direct-run guard: `connectFirstFrame` is imported by the cost scenario
// drivers, and a bare top-level main() would run the staging smoke on import.
const entry = process.argv[1]
if (entry !== undefined && import.meta.url === pathToFileURL(entry).href) {
  main().catch((err: unknown) => fail(err instanceof Error ? (err.stack ?? err.message) : String(err)))
}
