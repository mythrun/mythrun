// MYT-89 Task A2 — the Redis preview store holds the gated world-concept
// between synthesize-preview and campaign-create. Unit-tested against
// ioredis-mock (the prevailing backend Redis-unit convention; see
// redis/__tests__/session-state.test.ts). The store functions take the
// Redis client as a parameter, so no live instance is needed.

import IoRedisMock from 'ioredis-mock'
import type { Redis } from 'ioredis'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import type { PreviewRecord } from '../preview-store.js'
import { getPreview, overwritePreview, putPreview } from '../preview-store.js'

// UUIDv7: 36-char canonical UUID with the version nibble pinned to 7.
const UUIDV7_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

const USER_A = 'user-a'
const USER_B = 'user-b'

function makeRecord(overrides: Partial<PreviewRecord> = {}): PreviewRecord {
  return {
    concept: 'A rain-soaked harbor town where the tide never fully goes out.',
    intentSummary: {
      aesthetics: ['grey stone', 'wet rope'],
      themes: ['debt', 'quiet dread'],
      sourcesInternal: ['internal-note-1'],
    },
    reworkCount: 0,
    ...overrides,
  }
}

describe('preview-store', () => {
  let redis: Redis

  beforeEach(async () => {
    redis = new IoRedisMock()
    // ioredis-mock shares ONE in-memory keyspace per process — flush per test
    // so cross-test previews never bleed (mirrors the session-state suite).
    await redis.flushall()
  })
  afterEach(async () => {
    await redis.quit()
  })

  it('putPreview returns a UUIDv7 and a same-user getPreview round-trips the record', async () => {
    const record = makeRecord()
    const previewId = await putPreview(redis, USER_A, record)

    expect(previewId).toMatch(UUIDV7_RE)
    expect(await getPreview(redis, USER_A, previewId)).toEqual(record)
  })

  it('putPreview stores under campaign-preview:{userId}:{previewId} with a 30-min TTL', async () => {
    const previewId = await putPreview(redis, USER_A, makeRecord())

    const key = `campaign-preview:${USER_A}:${previewId}`
    expect(await redis.exists(key)).toBe(1)
    const ttl = await redis.ttl(key)
    expect(ttl).toBeGreaterThan(1700)
    expect(ttl).toBeLessThanOrEqual(1800)
  })

  it('getPreview from another user misses (cross-user isolation — key embeds userId)', async () => {
    const previewId = await putPreview(redis, USER_A, makeRecord())

    expect(await getPreview(redis, USER_B, previewId)).toBeNull()
  })

  it('getPreview returns null for an absent/expired previewId', async () => {
    expect(await getPreview(redis, USER_A, 'never-stored')).toBeNull()
  })

  it('getPreview returns null when the stored blob is corrupt (not JSON)', async () => {
    const previewId = '01923456-789a-7bcd-8ef0-000000000001'
    await redis.set(`campaign-preview:${USER_A}:${previewId}`, 'not-json{', 'EX', 1800)

    expect(await getPreview(redis, USER_A, previewId)).toBeNull()
  })

  it('overwritePreview replaces the record (reworkCount:1) and resets the TTL', async () => {
    const previewId = await putPreview(redis, USER_A, makeRecord({ reworkCount: 0 }))

    const reworked = makeRecord({
      concept: 'The same harbor, now under a foreign flag.',
      reworkCount: 1,
    })
    await overwritePreview(redis, USER_A, previewId, reworked)

    expect(await getPreview(redis, USER_A, previewId)).toEqual(reworked)
    const ttl = await redis.ttl(`campaign-preview:${USER_A}:${previewId}`)
    expect(ttl).toBeGreaterThan(1700)
    expect(ttl).toBeLessThanOrEqual(1800)
  })
})
