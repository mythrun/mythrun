// MYT-62: makePipelinePublishers routes lifecycle events and prose deltas to
// their respective Redis channels. The channel formulas are a secret-routing
// boundary (player-facing `pipeline:campaign:` vs dev-only `prep:campaign:`),
// so these tests pin the exact channel name + JSON encoding for both arms.

import { describe, it, expect, vi } from 'vitest'
import type { Redis } from 'ioredis'
import { makePipelinePublishers } from '../publishers.js'

function fakeRedis(): { redis: Redis; publish: ReturnType<typeof vi.fn> } {
  const publish = vi.fn().mockResolvedValue(1)
  const redis = { publish } as unknown as Redis
  return { redis, publish }
}

describe('makePipelinePublishers (MYT-62)', () => {
  const PREFIX = 'mythrun:test:'
  const CAMPAIGN_ID = '019e892e-383d-711b-8ebb-b32f9c816511'

  it('publishEvent publishes to pipeline:campaign:{id} with JSON.stringify(event)', async () => {
    const { redis, publish } = fakeRedis()
    const { publishEvent } = makePipelinePublishers(redis, PREFIX)

    const event = { type: 'prep-started', sessionNumber: 1 }
    await publishEvent(CAMPAIGN_ID, event)

    expect(publish).toHaveBeenCalledTimes(1)
    expect(publish).toHaveBeenCalledWith(
      `${PREFIX}pipeline:campaign:${CAMPAIGN_ID}`,
      JSON.stringify(event),
    )
  })

  it('publishProse publishes to prep:campaign:{id} with JSON.stringify(event)', async () => {
    const { redis, publish } = fakeRedis()
    const { publishProse } = makePipelinePublishers(redis, PREFIX)

    const event = { type: 'prep-delta', field: 'sd_playbook', text: 'SECRET' } as const
    await publishProse(CAMPAIGN_ID, event)

    expect(publish).toHaveBeenCalledTimes(1)
    expect(publish).toHaveBeenCalledWith(
      `${PREFIX}prep:campaign:${CAMPAIGN_ID}`,
      JSON.stringify(event),
    )
  })

  it('the two arms use DISTINCT channels (secret-routing boundary holds)', async () => {
    const { redis, publish } = fakeRedis()
    const { publishEvent, publishProse } = makePipelinePublishers(redis, PREFIX)

    await publishEvent(CAMPAIGN_ID, { type: 'prep-ready', sessionNumber: 1, costUsd: 0.25 })
    await publishProse(CAMPAIGN_ID, { type: 'prep-delta', field: 'ft_context', text: 'x' })

    const channels = publish.mock.calls.map((c) => c[0] as string)
    expect(channels[0]).toBe(`${PREFIX}pipeline:campaign:${CAMPAIGN_ID}`)
    expect(channels[1]).toBe(`${PREFIX}prep:campaign:${CAMPAIGN_ID}`)
    expect(channels[0]).not.toBe(channels[1])
  })
})
