// backend/src/preview/preview-store.ts
//
// MYT-89 Task A2 — a Redis-backed holding pen for a gated world-concept
// between the synthesize-preview step and the campaign-create commit. The
// create flow can preview + optionally rework a concept before committing
// ~10 minutes of world generation, so the concept lives here (not Postgres)
// with a short TTL: abandoned previews reap themselves.
//
// Keys are `${redisKeyPrefix}campaign-preview:${userId}:${previewId}`. The
// `redisKeyPrefix` (`${MYTHRUN_ENV}:${REGION_PREFIX}:`, config/env.ts) is the
// same env/region namespace session-state, the rate-limiter, pipeline
// channels, and the rejection-storm counter all carry — so a per-env key
// inventory / flush (`SCAN prod:use1:*`) reaches this key family too. The
// userId is baked INTO the key, so a cross-user `getPreview` simply misses —
// there is no IDOR surface where user B reads user A's preview by guessing
// the id.
//
// The Redis client is a parameter (matching redis/session-state.ts's
// `makeSessionState(redis, …)` shape) so these functions are unit-testable
// against ioredis-mock without a live instance.

import type { Redis } from 'ioredis'

import type { SynthesizerOutput } from '../llm/prep/synthesize-concept.js'
import { uuidv7 } from '../repo/uuidv7.js'

/** Preview TTL (seconds). 30 minutes — long enough for a human to read a
 *  concept and decide whether to rework or commit, short enough that an
 *  abandoned preview reaps itself rather than accumulating in Redis. */
const PREVIEW_TTL_SECONDS = 1800

/** The gated concept parked between synthesize-preview and campaign-create.
 *  `intentSummary` mirrors the synthesizer's own shape (aesthetics / themes /
 *  sourcesInternal) so the committed campaign carries the same intent the
 *  preview was generated from. `reworkCount` starts at 0 and is bumped to 1
 *  by `overwritePreview` when a rework passes the input gate. */
export interface PreviewRecord {
  /** myth-z3icr: the world's working name, headlined by the proposal screen and
   *  carried into a rework so a revision keeps the name it was shown under. */
  readonly title: string
  readonly concept: string
  readonly intentSummary: SynthesizerOutput['intentSummary']
  readonly reworkCount: number
}

/** The env-namespaced, user-scoped Redis key. `redisKeyPrefix` already carries
 *  its trailing colon (`${MYTHRUN_ENV}:${REGION_PREFIX}:`), so it prefixes
 *  directly — matching session-state's `${keyPrefix}session:…`. userId is
 *  embedded so a cross-user read misses. */
function previewKey(redisKeyPrefix: string, userId: string, previewId: string): string {
  return `${redisKeyPrefix}campaign-preview:${userId}:${previewId}`
}

/**
 * Store a fresh preview under a newly-minted UUIDv7 id (time-ordered, per the
 * repo id convention) with the 30-min TTL. Returns the `previewId` the caller
 * hands back to the client to later fetch or commit the concept.
 */
export async function putPreview(
  redis: Redis,
  redisKeyPrefix: string,
  userId: string,
  record: PreviewRecord,
): Promise<string> {
  const previewId = uuidv7()
  await redis.set(
    previewKey(redisKeyPrefix, userId, previewId),
    JSON.stringify(record),
    'EX',
    PREVIEW_TTL_SECONDS,
  )
  return previewId
}

/**
 * Read a preview for `(userId, previewId)`. Returns `null` when the key is
 * absent (never stored, expired, or owned by a DIFFERENT user — the userId is
 * part of the key) or holds a corrupt (non-JSON) blob.
 */
export async function getPreview(
  redis: Redis,
  redisKeyPrefix: string,
  userId: string,
  previewId: string,
): Promise<PreviewRecord | null> {
  const raw = await redis.get(previewKey(redisKeyPrefix, userId, previewId))
  if (raw === null) return null
  try {
    return JSON.parse(raw) as PreviewRecord
  } catch {
    // A corrupt blob is treated as absent — the create flow re-synthesizes
    // rather than throwing on a value it can never have written itself.
    return null
  }
}

/**
 * Replace the value under an EXISTING preview id and RESET its TTL. Used by
 * rework on gate-pass: the caller passes a record with `reworkCount: 1`, so the
 * committed concept records that it was reworked. A plain SET (not a merge) —
 * the reworked concept fully supersedes the prior one.
 */
export async function overwritePreview(
  redis: Redis,
  redisKeyPrefix: string,
  userId: string,
  previewId: string,
  record: PreviewRecord,
): Promise<void> {
  await redis.set(
    previewKey(redisKeyPrefix, userId, previewId),
    JSON.stringify(record),
    'EX',
    PREVIEW_TTL_SECONDS,
  )
}
