// Shared SSE publishers for the prep pipeline (MYT-62).
//
// The channel names encode a SECRET-ROUTING BOUNDARY:
//   - `pipeline:campaign:{id}` — player-facing lifecycle events (PipelineEvent).
//     All worker-emitted phase events (world-gen, character-creation,
//     character-integration, session-prep started/ready/failed) ride here.
//   - `prep:campaign:{id}` — dev-only session-prep PROSE deltas (ProseEvent).
//     The sd_playbook prose may contain plot secrets, so it MUST NOT share the
//     player-facing channel.
//
// Single-sourced here so the two boundary strings can't drift between the
// worker.ts entrypoint and the API container's in-process worker
// (server.ts:buildSessionPrepWorker). `publishEvent` stays typed
// `Record<string, unknown>` because the character-creation/integration
// processors also consume it; it remains assignable to the session-prep
// processor's tighter `PipelineEvent` param via function-parameter
// contravariance.

import type { Redis } from 'ioredis'
import type { ProseEvent } from '../contract/pipeline-events.js'

export interface PipelinePublishers {
  readonly publishEvent: (campaignId: string, event: Record<string, unknown>) => Promise<void>
  readonly publishProse: (campaignId: string, event: ProseEvent) => Promise<void>
}

export function makePipelinePublishers(
  redisRealtime: Redis,
  redisKeyPrefix: string,
): PipelinePublishers {
  return {
    publishEvent: async (campaignId, event) => {
      const channel = `${redisKeyPrefix}pipeline:campaign:${campaignId}`
      await redisRealtime.publish(channel, JSON.stringify(event))
    },
    publishProse: async (campaignId, event) => {
      const channel = `${redisKeyPrefix}prep:campaign:${campaignId}`
      await redisRealtime.publish(channel, JSON.stringify(event))
    },
  }
}
