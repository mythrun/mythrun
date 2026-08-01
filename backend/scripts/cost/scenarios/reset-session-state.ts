// backend/scripts/cost/scenarios/reset-session-state.ts
//
// Extends the drivers' delete-then-load fixture semantics to REDIS. The
// campaign-scoped session state (`<prefix>session:{campaignId}:*` on the
// REALTIME instance — usage counters, running summary, directions, seq,
// suspend/ending fences) survives the DB fixture reload, and stale state
// poisons baselines two ways, both observed live on 2026-07-31:
//   - the gross-token usage counter carries the PREVIOUS run's ~460k tokens,
//     so the next run starts at/over the session budget (wind-down / converge
//     mode arms flip, or a budget auto-end fires immediately — spec §3
//     requires usage seeded well below the wind-down fraction);
//   - a wedged end/suspend leaves the `:ending` fence set (~1h TTL), and
//     every /start 409s `session_ending` until it expires (the farewell-wedge
//     bug family, tripped here by a mid-suspend stack restart).
//
// Scoped strictly to one campaign id (a UUID — collision-proof pattern) and
// fenced to localhost like the drivers' Postgres access.

import { Redis } from 'ioredis'

export async function resetCampaignSessionState(
  redisRealtimeUrl: string,
  campaignId: string,
  log: (msg: string, extra?: Record<string, unknown>) => void,
): Promise<void> {
  const host = new URL(redisRealtimeUrl).hostname
  if (host !== 'localhost' && host !== '127.0.0.1') {
    throw new Error(`resetCampaignSessionState only runs against LOCAL redis; got host=${host}`)
  }
  const redis = new Redis(redisRealtimeUrl, { maxRetriesPerRequest: null })
  try {
    const keys: string[] = []
    let cursor = '0'
    do {
      const [next, batch] = await redis.scan(
        cursor,
        'MATCH',
        `*session:${campaignId}:*`,
        'COUNT',
        200,
      )
      cursor = next
      keys.push(...batch)
    } while (cursor !== '0')
    if (keys.length > 0) await redis.del(...keys)
    log('session_redis_state_reset', { campaignId, keysCleared: keys.length })
  } finally {
    redis.disconnect()
  }
}
