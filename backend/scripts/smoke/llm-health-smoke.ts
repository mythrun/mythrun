// llm-health lifecycle smoke + operator runbook tool (outage-resilience spec §2).
//
//   pnpm --filter @mythrun/backend exec tsx scripts/smoke/llm-health-smoke.ts status
//   … arm      — three connectivity reports across two call sites (the real
//                sink path) → sitewide degraded; the strip rises within one poll.
//   … clear    — the operator manual-clear: DELs state/counter/window/models.
//
// Uses the same tracker + env the server binds, so `arm` exercises the exact
// production Lua arm path, not a hand-SET.
import { Redis } from 'ioredis'
import pino from 'pino'
import { loadEnv } from '../../src/config/env.js'
import { createLlmHealthTracker } from '../../src/llm/llm-health.js'

const cmd = process.argv[2] ?? 'status'
// The REAL config loader, not a hand-read env var: the server's prefix is the
// derived `${env}:${region}:` — a raw REDIS_KEY_PREFIX read writes keys the
// server never sees (found the hard way in this feature's live smoke).
const env = loadEnv()
const redis = new Redis(env.redisRealtimeUrl, { maxRetriesPerRequest: null })
const prefix = env.redisKeyPrefix
const tracker = createLlmHealthTracker(redis, prefix, pino({ level: 'warn' }))

// A real model id so a running worker's probe targets something probeable.
const SMOKE_MODEL_ID = 'claude-haiku-4-5-20251001'

if (cmd === 'arm') {
  await tracker.report({ callsite: 'coherence_pass', jobId: 'smoke-job-1', modelId: SMOKE_MODEL_ID, mode: 'streaming' })
  await tracker.report({ callsite: 'coherence_pass', jobId: 'smoke-job-1', modelId: SMOKE_MODEL_ID, mode: 'streaming' })
  await tracker.report({ callsite: 'starting_situation', jobId: 'smoke-job-1', modelId: SMOKE_MODEL_ID, mode: 'streaming' })
} else if (cmd === 'clear') {
  await redis.del(
    `${prefix}llm-health:state`,
    `${prefix}llm-health:probe-successes`,
    `${prefix}llm-health:window`,
    `${prefix}llm-health:models`,
  )
}

console.log(
  JSON.stringify({ cmd, state: await tracker.read(), models: await tracker.readModels() }),
)
await redis.quit()
