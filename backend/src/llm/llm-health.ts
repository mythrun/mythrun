// backend/src/llm/llm-health.ts
//
// llm-outage-resilience Task 3 — the Redis-shared LLM outage state machine
// (design §2.1). API server + workers all report connectivity-class attempt
// failures here through the boot-injected ai.ts sink (§1.4); the recovery
// probe worker drives the clear side (§2.2); GET /api/llm-health reads it.
//
//   healthy  --(≥3 connectivity failures within 10 min spanning ≥2 distinct
//               callsites OR ≥2 distinct jobIds)-->  degraded
//   degraded --(3 consecutive probe successes; counter reset by any probe
//               failure OR any new connectivity report)--> healthy
//
// Keys (under the caller-supplied prefix, riding the existing redisKeyPrefix
// discipline so test/worktree/staging isolation holds):
//
//   llm-health:window           ZSET  score = epoch-ms from Redis TIME;
//                                     member = JSON {ts, callsite, jobId,
//                                     modelId, nonce}. 30-min rolling TTL +
//                                     ZREMRANGEBYSCORE prune on every report
//                                     so a long outage cannot grow it.
//   llm-health:state            JSON  present ⇔ degraded: {"since": <ms>}.
//                                     TTL 30 min, refreshed by still-down
//                                     probe cycles (worker death self-heals).
//   llm-health:models           SET   implicated model ids. A separate SET —
//                                     SADD is atomic and commutative; a JSON
//                                     array inside :state would be a
//                                     lost-update race across reporters.
//   llm-health:probe-successes  ctr   reset on arming, any probe failure,
//                                     any new report. TTL 30 min. At 3 → clear.
//
// BOTH transitions are Lua (normative — §2.1): arm = evaluate-window +
// SET NX + seed models atomically; clear = verify-counter + DEL all four
// keys atomically. Round 3 of the design review showed every check-then-act
// variant leaks un-arm / spurious-clear races; the scripts eliminate the
// class. Scores come from Redis TIME, never local clocks, so multi-container
// reporters agree on the window.

import { randomUUID } from 'node:crypto'
import type { Redis } from 'ioredis'
import type pino from 'pino'

export interface LlmHealthReport {
  readonly callsite: string
  readonly jobId: string
  readonly modelId: string
  readonly mode: 'streaming' | 'non-streaming' | null
}

export interface LlmHealthState {
  readonly state: 'ok' | 'degraded'
  readonly since: number | null
}

export interface LlmHealthTracker {
  /** Record one connectivity-class attempt failure. Fire-and-forget from the
   *  ai.ts sink (§1.4): NEVER throws outward — a health-reporting failure
   *  must not fail the calling turn/stage, so errors are logged and eaten. */
  report(r: LlmHealthReport): Promise<void>
  /** One GET: present ⇔ degraded. The §4.1 route payload shape. */
  read(): Promise<LlmHealthState>
  /** The implicated model ids (probe targets), sorted for determinism. */
  readModels(): Promise<readonly string[]>
  /** One all-targets-succeeded probe cycle (§2.2): INCR the counter; at 3 the
   *  Lua clear DELs all four keys atomically and this returns 'cleared'. */
  probeSuccess(): Promise<'counting' | 'cleared'>
  /** One still-down probe cycle: reset the counter, refresh the state +
   *  models TTLs (the refresh is what makes a dead probe worker self-heal —
   *  no refresher, no state). */
  probeFailure(): Promise<void>
}

const ARM_THRESHOLD = 3
const ARM_WINDOW_MS = 10 * 60_000
/** Window retention (prune horizon + rolling TTL) and the state/models/counter
 *  TTL — all 30 min per §2.1. */
const RETENTION_MS = 30 * 60_000
const STATE_TTL_SEC = 30 * 60
const CLEAR_THRESHOLD = 3

// Arm script. KEYS = [window, state, models, counter]; ARGV = [nowMs, member,
// modelId, armWindowMs, retentionMs, stateTtlSec, armThreshold]. Always ZADDs
// + prunes; then either (already degraded) unions the model + resets the
// counter, or evaluates the 10-min window and arms when ≥threshold events
// span ≥2 callsites OR ≥2 jobIds. Returns 1 (degraded already), 0 (still ok),
// or the JSON window summary (armed — the caller logs it). Runs atomically on
// the server, so evaluate + SET NX + seed cannot interleave with a concurrent
// reporter's.
const REPORT_LUA = `
local now = tonumber(ARGV[1])
redis.call('ZADD', KEYS[1], now, ARGV[2])
redis.call('ZREMRANGEBYSCORE', KEYS[1], '-inf', now - tonumber(ARGV[5]))
redis.call('PEXPIRE', KEYS[1], tonumber(ARGV[5]))
if redis.call('EXISTS', KEYS[2]) == 1 then
  redis.call('SADD', KEYS[3], ARGV[3])
  local statePttl = redis.call('PTTL', KEYS[2])
  if statePttl > 0 then redis.call('PEXPIRE', KEYS[3], statePttl) end
  redis.call('DEL', KEYS[4])
  return 1
end
local events = redis.call('ZRANGEBYSCORE', KEYS[1], now - tonumber(ARGV[4]), '+inf')
if #events < tonumber(ARGV[7]) then return 0 end
local seenCallsites = {}
local seenJobIds = {}
local seenModels = {}
local callsites = {}
local jobIds = {}
local models = {}
for _, raw in ipairs(events) do
  local e = cjson.decode(raw)
  if not seenCallsites[e.callsite] then
    seenCallsites[e.callsite] = true
    callsites[#callsites + 1] = e.callsite
  end
  if not seenJobIds[e.jobId] then
    seenJobIds[e.jobId] = true
    jobIds[#jobIds + 1] = e.jobId
  end
  if not seenModels[e.modelId] then
    seenModels[e.modelId] = true
    models[#models + 1] = e.modelId
  end
end
if #callsites < 2 and #jobIds < 2 then return 0 end
redis.call('SET', KEYS[2], '{"since":' .. string.format('%.0f', now) .. '}', 'EX', tonumber(ARGV[6]), 'NX')
for _, m in ipairs(models) do redis.call('SADD', KEYS[3], m) end
redis.call('EXPIRE', KEYS[3], tonumber(ARGV[6]))
redis.call('DEL', KEYS[4])
return cjson.encode({ since = now, windowCount = #events, callsites = callsites, jobIds = jobIds, models = models })
`

// Clear script. KEYS = [counter, state, models, window]; ARGV = [stateTtlSec,
// clearThreshold]. The INCR and the ≥threshold verify are one atomic unit
// with the DEL, so a concurrent report's counter reset can never be lost to a
// clear that already decided (the spurious-clear race §2.1's scripts exist to
// kill). Returns the count (still counting) or the raw state blob ('' when
// absent) after clearing all four keys.
const PROBE_SUCCESS_LUA = `
local count = redis.call('INCR', KEYS[1])
if count < tonumber(ARGV[2]) then
  redis.call('EXPIRE', KEYS[1], tonumber(ARGV[1]))
  return count
end
local stateRaw = redis.call('GET', KEYS[2])
redis.call('DEL', KEYS[1], KEYS[2], KEYS[3], KEYS[4])
if stateRaw then return stateRaw end
return ''
`

export function createLlmHealthTracker(
  redis: Redis,
  keyPrefix: string,
  logger: pino.Logger,
): LlmHealthTracker {
  const windowKey = `${keyPrefix}llm-health:window`
  const stateKey = `${keyPrefix}llm-health:state`
  const modelsKey = `${keyPrefix}llm-health:models`
  const counterKey = `${keyPrefix}llm-health:probe-successes`

  return {
    report: async (r) => {
      try {
        const now = await redisNowMs(redis)
        const member = JSON.stringify({
          ts: now,
          callsite: r.callsite,
          jobId: r.jobId,
          modelId: r.modelId,
          // Nonce keeps simultaneous identical failures distinct — ZADD of an
          // existing member would just re-score it and under-count the window.
          nonce: randomUUID(),
        })
        const result = await redis.eval(
          REPORT_LUA,
          4,
          windowKey,
          stateKey,
          modelsKey,
          counterKey,
          String(now),
          member,
          r.modelId,
          String(ARM_WINDOW_MS),
          String(RETENTION_MS),
          String(STATE_TTL_SEC),
          String(ARM_THRESHOLD),
        )
        if (typeof result === 'string') {
          const summary = JSON.parse(result) as Record<string, unknown>
          logger.warn(
            { event: 'llm_health.degraded', ...summary },
            'llm health degraded — connectivity failures armed the outage state',
          )
        }
      } catch (err) {
        // Fire-and-forget (§1.4): never throw outward.
        logger.error(
          { event: 'llm_health.report_failed', err },
          'llm health report failed; event dropped',
        )
      }
    },

    read: async () => {
      const raw = await redis.get(stateKey)
      if (raw === null) return { state: 'ok', since: null }
      return { state: 'degraded', since: parseSince(raw) }
    },

    readModels: async () => (await redis.smembers(modelsKey)).sort(),

    probeSuccess: async () => {
      const now = await redisNowMs(redis)
      const result = await redis.eval(
        PROBE_SUCCESS_LUA,
        4,
        counterKey,
        stateKey,
        modelsKey,
        windowKey,
        String(STATE_TTL_SEC),
        String(CLEAR_THRESHOLD),
      )
      if (typeof result === 'number') return 'counting'
      const since = parseSince(String(result))
      logger.info(
        { event: 'llm_health.recovered', durationMs: since === null ? null : now - since },
        'llm health recovered — consecutive probe successes cleared the outage state',
      )
      return 'cleared'
    },

    probeFailure: async () => {
      // No check-then-act here, so a MULTI suffices: reset the clear counter
      // and refresh the state + models TTLs in one atomic block (each
      // still-down probe cycle is what keeps a real outage's state alive —
      // §2.1's "worker death self-heals"). EXPIRE no-ops on missing keys, so
      // a failure observed after the state lapsed conjures nothing.
      await redis
        .multi()
        .del(counterKey)
        .expire(stateKey, STATE_TTL_SEC)
        .expire(modelsKey, STATE_TTL_SEC)
        .exec()
    },
  }
}

/** Epoch-ms from Redis TIME — one clock for every reporter, so the window's
 *  scores agree across containers regardless of local clock skew. */
async function redisNowMs(redis: Redis): Promise<number> {
  return timeReplyToMs(await redis.time())
}

/** Convert a TIME reply ([seconds, microseconds]) to epoch-ms. ioredis types
 *  the reply as number[] but the wire carries bulk strings — Number()
 *  normalizes both, and a malformed reply degrades to 0 rather than NaN
 *  (which would poison every window score it touched). */
export function timeReplyToMs(reply: readonly (number | string)[]): number {
  return Number(reply[0] ?? 0) * 1000 + Math.floor(Number(reply[1] ?? 0) / 1000)
}

/** Parse the state blob's {since}. Presence of the key ⇔ degraded, so a
 *  corrupt blob still reads degraded — only the timestamp is lost. */
function parseSince(raw: string): number | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return null
  }
  if (typeof parsed !== 'object' || parsed === null) return null
  const since = (parsed as { since?: unknown }).since
  return typeof since === 'number' ? since : null
}
