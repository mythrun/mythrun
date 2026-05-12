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
  // The first 'ready' is the initial connect, not a reconnect — attached
  // sinks haven't missed any messages yet. Subsequent 'ready' events
  // follow a disconnect and DO need a resync close.
  let everReady = false

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
    if (!everReady) {
      everReady = true
      return
    }
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
