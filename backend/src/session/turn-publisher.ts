// backend/src/session/turn-publisher.ts
//
// MYT-66 Task 6 — the cross-process turn frame publisher.
//
// The turn worker is a DIFFERENT process from the SessionHub (sse/ws fan-out):
// it has no in-memory socket registry, so it streams a turn by PUBLISHing the
// MYT-66 DM-turn frames (`dm_thinking`/`text_delta`/`turn_end`/`turn_error`) to
// the per-campaign channel. The SessionHub PSUBSCRIBEs the pattern and fans each
// frame out to the locally-registered sockets. Both sides derive the channel
// string from `../contract/session-channel.js` (a re-derived string that drifts
// would silently fan out to nobody).
//
// Every frame carries the `turnId` (H2): it is stable across BullMQ
// redeliveries, so a client dedups a re-streamed turn on it. These are
// intra-turn / control frames and carry NO seq.

import type { Redis } from 'ioredis'
import { sessionChannel } from '../contract/session-channel.js'
import type { ServerFrame } from '../contract/session-events.js'
import type { TurnEmit } from './tiers/types.js'

/**
 * Publishes the MYT-66 DM-turn streaming frames for a turn cross-container. The
 * worker holds one instance for the life of the process; each method targets a
 * specific (campaign, turn). `emitFor` binds a `TurnEmit` the Fast Thinker
 * streams text_delta through (the FT seam stays frame-agnostic — see
 * `tiers/types.ts`).
 */
export interface TurnPublisher {
  dmThinking(campaignId: string, turnId: string): Promise<void>
  textDelta(campaignId: string, turnId: string, text: string): Promise<void>
  turnEnd(campaignId: string, turnId: string): Promise<void>
  turnError(campaignId: string, turnId: string, message: string): Promise<void>
  /** A text_delta emitter bound to one (campaign, turn) for the Fast Thinker. */
  emitFor(campaignId: string, turnId: string): TurnEmit
}

export function createTurnPublisher(redis: Redis, keyPrefix: string): TurnPublisher {
  async function publish(campaignId: string, frame: ServerFrame): Promise<void> {
    await redis.publish(sessionChannel(keyPrefix, campaignId), JSON.stringify(frame))
  }

  return {
    async dmThinking(campaignId, turnId): Promise<void> {
      await publish(campaignId, { type: 'dm_thinking', turnId })
    },
    async textDelta(campaignId, turnId, text): Promise<void> {
      await publish(campaignId, { type: 'text_delta', turnId, text })
    },
    async turnEnd(campaignId, turnId): Promise<void> {
      await publish(campaignId, { type: 'turn_end', turnId })
    },
    async turnError(campaignId, turnId, message): Promise<void> {
      await publish(campaignId, { type: 'turn_error', turnId, message })
    },
    emitFor(campaignId, turnId): TurnEmit {
      return (text: string): Promise<void> => this.textDelta(campaignId, turnId, text)
    },
  }
}
