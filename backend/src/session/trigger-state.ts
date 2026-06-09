// backend/src/session/trigger-state.ts
//
// MYT-67 — ALL new DM-trigger Redis state, keyed by campaignId (one live
// session per campaign). This module owns the coordination + display keys the
// trigger system needs; the transport keys (`:seq`, `:state`, presence,
// `:ft_history`/`:summary`/`:usage`) remain in `redis/session-state.ts` (MYT-65/66).
//
// Keys (spec §4.1, §4.2, §4.7, §4.8, §6), all on the same
// `${keyPrefix}session:${campaignId}:<suffix>` convention as session-state.ts —
// EXCEPT the cross-container terminal-error latch, which is keyed by `turnId`
// (not campaignId), so it lives at `${keyPrefix}turn-error-published:{turnId}`:
//
//   session:{cId}:typing:{userId}      per-member typing display (TTL = TYPING_TTL_S)
//   session:{cId}:last-activity        ms-epoch; maturity re-validation guard (§4.3)
//   session:{cId}:first-unresponded    ms-epoch; max-wait ceiling anchor, first-only (§4.2)
//   session:{cId}:responded-seq        int watermark; set at turn flush (§4.3/§4.7)
//   session:{cId}:dm_responding        "a turn is in flight" drain guard (§4.7)
//   session:{cId}:dm-trigger-explicit  explicit-pending flag, drained on release (§4.7)
//   turn-error-published:{turnId}      SET NX idempotency latch (§4.8)
//   turn:{turnId}:emitted              SET NX emitted-anything latch (§5)
//
// `keyPrefix` already ends in `:` (config/env.ts `redisKeyPrefix`), matching
// the session-state.ts precedent.

import type { Redis } from 'ioredis'

import { TYPING_TTL_S } from './dm-trigger-config.js'

/** TTL (ms) on the `dm_responding` flag — set at lock acquire, heartbeat-
 *  refreshed while a turn runs, cleared on release. ≈ the session lock TTL so a
 *  crashed worker's flag lapses on its own (never wedges the drain guard shut
 *  if the `finally` clear is skipped). Spec §4.7 ("TTL ≈ lock TTL"). */
const DM_RESPONDING_TTL_MS = 45_000

/** TTL (seconds) on the cross-container `turn-error-published` latch (§4.8).
 *  Short — it only needs to outlive the window in which the in-process `failed`
 *  listener and the broker-side `QueueEvents` could both fire for one terminal
 *  turn. 60s comfortably covers that. */
const TURN_ERROR_LATCH_TTL_S = 60

/** TTL (seconds) on the §5 emitted-anything latch. 1h comfortably outlives the
 *  longest a turn (incl. BullMQ retry/stalled-reclaim) could be re-dispatched —
 *  past that, a re-run can't credibly re-stream the same turnId, so the latch is
 *  free to lapse rather than leak a key per turn on a long-lived process. */
const TURN_EMITTED_LATCH_TTL_S = 3600

export interface TriggerState {
  /** Set/refresh this user's typing key with a TTL (`TYPING_TTL_S`). The
   *  expiry is the authoritative "stopped typing" — an explicit `typing_stop`
   *  is only a best-effort fast-path (§4.1). */
  markTyping(campaignId: string, userId: string): Promise<void>
  /** SCAN the campaign's `typing:*` keys → the userIds currently typing.
   *  Exposed for the future "who is typing" frontend query; the trigger itself
   *  does NOT read this (it is driven by the debounce job — §4.1/§4.2). */
  listTyping(campaignId: string): Promise<string[]>
  /** DEL this user's typing key (on `typing_stop`, their own `player_message`,
   *  disconnect, or when a turn fires for the campaign) (§4.1). */
  clearTyping(campaignId: string, userId: string): Promise<void>
  /** Stamp the last-activity ms-epoch on any inbound activity (§4.2). The
   *  dm-trigger worker re-reads it to re-validate quiet at maturity (§4.3). */
  stampActivity(campaignId: string, ms: number): Promise<void>
  /** Read the last-activity stamp, or null if unset. */
  lastActivityMs(campaignId: string): Promise<number | null>
  /** Stamp the max-wait anchor — the first activity after a turn (§4.2).
   *  FIRST-ONLY (`SET NX`): a later call no-ops, so the ceiling is measured
   *  from the first unresponded activity, not the latest. */
  armFirstUnresponded(campaignId: string, ms: number): Promise<void>
  /** Read the max-wait anchor ms-epoch, or null if unset. */
  firstUnrespondedMs(campaignId: string): Promise<number | null>
  /** DEL the max-wait anchor (at turn flush — the batch is now responded) (§4.7). */
  clearFirstUnresponded(campaignId: string): Promise<void>
  /** Set the responded-seq watermark = max consumed seq, at turn flush (§4.7). */
  setRespondedSeq(campaignId: string, seq: number): Promise<void>
  /** Read the watermark; 0 if unset (the empty-session default — the first
   *  batch is `(0, max]`) (§4.3). */
  respondedSeq(campaignId: string): Promise<number>
  /** Set the `dm_responding` flag (token = the lock token) with a TTL, at lock
   *  acquire — marks a turn in flight for the drain guard (§4.7). */
  setResponding(campaignId: string, token: string): Promise<void>
  /** True iff a turn is in flight (the `dm_responding` flag exists) (§4.7). */
  isResponding(campaignId: string): Promise<boolean>
  /** Clear the `dm_responding` flag on lock release (§4.7). */
  clearResponding(campaignId: string): Promise<void>
  /** Set the explicit-pending flag when an `@dm` lands while a turn is in
   *  flight — drained immediately on release (§4.5/§4.7). */
  setExplicitPending(campaignId: string): Promise<void>
  /** Atomically read-and-clear the explicit-pending flag (`GETDEL`): true if it
   *  was set (drain one explicit follow-up), false otherwise. Take-once (§4.7). */
  takeExplicitPending(campaignId: string): Promise<boolean>
  /** The §4.8 cross-container terminal-error latch: `SET NX` on a per-turn key.
   *  Returns true iff THIS caller won the race (it should publish the
   *  `turn_error`), false if another path/container already claimed it — so
   *  exactly one `turn_error` ships per terminal turn cluster-wide. */
  claimTurnErrorPublish(turnId: string): Promise<boolean>
  /** §5 emitted-anything latch: SET NX keyed by turnId, set by the emitter
   *  BEFORE the first frame publish (set-after leaves a crash window that
   *  re-streams divergent prose), checked at job START (a stalled-reclaimed
   *  job doesn't arrive via a failure path). Cross-container by construction. */
  markTurnEmitted(turnId: string): Promise<void>
  wasTurnEmitted(turnId: string): Promise<boolean>
}

export function makeTriggerState(redis: Redis, keyPrefix: string): TriggerState {
  const base = (campaignId: string): string => `${keyPrefix}session:${campaignId}`
  const typingKey = (campaignId: string, userId: string): string =>
    `${base(campaignId)}:typing:${userId}`
  const typingPattern = (campaignId: string): string => `${base(campaignId)}:typing:*`
  const lastActivityKey = (campaignId: string): string => `${base(campaignId)}:last-activity`
  const firstUnrespondedKey = (campaignId: string): string => `${base(campaignId)}:first-unresponded`
  const respondedSeqKey = (campaignId: string): string => `${base(campaignId)}:responded-seq`
  const respondingKey = (campaignId: string): string => `${base(campaignId)}:dm_responding`
  const explicitKey = (campaignId: string): string => `${base(campaignId)}:dm-trigger-explicit`
  const latchKey = (turnId: string): string => `${keyPrefix}turn-error-published:${turnId}`
  const emittedKey = (turnId: string): string => `${keyPrefix}turn:${turnId}:emitted`

  // The `typing:` segment length, so listTyping can slice the userId suffix off
  // a matched key without a fragile index calc at the call site.
  const typingPrefixOf = (campaignId: string): string => `${base(campaignId)}:typing:`

  return {
    markTyping: async (campaignId, userId) => {
      await redis.set(typingKey(campaignId, userId), '1', 'EX', TYPING_TTL_S)
    },

    listTyping: async (campaignId) => {
      // SCAN, not KEYS: KEYS blocks the single-threaded Redis event loop over the
      // WHOLE keyspace — unacceptable on a shared ElastiCache cluster. SCAN is
      // cursor-paged and non-blocking; the per-campaign typing set is small
      // (a handful of members), so the full cursor walk is cheap. Mirrors
      // session-state.ts `countPresence`.
      const pattern = typingPattern(campaignId)
      const prefix = typingPrefixOf(campaignId)
      const userIds: string[] = []
      let cursor = '0'
      do {
        const [next, batch] = await redis.scan(cursor, 'MATCH', pattern, 'COUNT', 100)
        cursor = next
        for (const key of batch) {
          userIds.push(key.slice(prefix.length))
        }
      } while (cursor !== '0')
      return userIds
    },

    clearTyping: async (campaignId, userId) => {
      await redis.del(typingKey(campaignId, userId))
    },

    stampActivity: async (campaignId, ms) => {
      await redis.set(lastActivityKey(campaignId), String(ms))
    },

    lastActivityMs: async (campaignId) => readNumber(redis, lastActivityKey(campaignId)),

    armFirstUnresponded: async (campaignId, ms) => {
      // SET NX: first writer wins, so the max-wait ceiling is anchored to the
      // FIRST unresponded activity after a turn, not the latest. A later call
      // (the NX no-op) leaves the original stamp intact.
      await redis.set(firstUnrespondedKey(campaignId), String(ms), 'NX')
    },

    firstUnrespondedMs: async (campaignId) => readNumber(redis, firstUnrespondedKey(campaignId)),

    clearFirstUnresponded: async (campaignId) => {
      await redis.del(firstUnrespondedKey(campaignId))
    },

    setRespondedSeq: async (campaignId, seq) => {
      await redis.set(respondedSeqKey(campaignId), String(seq))
    },

    respondedSeq: async (campaignId) => {
      const raw = await redis.get(respondedSeqKey(campaignId))
      if (raw === null) return 0
      const n = Number(raw)
      return Number.isFinite(n) ? n : 0
    },

    setResponding: async (campaignId, token) => {
      await redis.set(respondingKey(campaignId), token, 'PX', DM_RESPONDING_TTL_MS)
    },

    isResponding: async (campaignId) => (await redis.exists(respondingKey(campaignId))) === 1,

    clearResponding: async (campaignId) => {
      await redis.del(respondingKey(campaignId))
    },

    setExplicitPending: async (campaignId) => {
      await redis.set(explicitKey(campaignId), '1')
    },

    takeExplicitPending: async (campaignId) => {
      // GETDEL: atomic read-and-clear, so two racing drains can't both observe
      // a pending flag (only one gets the value, the other gets null).
      const raw = await redis.getdel(explicitKey(campaignId))
      return raw !== null
    },

    claimTurnErrorPublish: async (turnId) => {
      // SET NX → 'OK' iff this call created the key (won the latch); null iff it
      // already existed (a sibling path/container already claimed it). The TTL
      // garbage-collects the latch so a long-lived process doesn't leak a key
      // per terminal turn.
      const res = await redis.set(latchKey(turnId), '1', 'EX', TURN_ERROR_LATCH_TTL_S, 'NX')
      return res === 'OK'
    },

    markTurnEmitted: async (turnId) => {
      // SET NX + EX: idempotent (a re-mark no-ops on the existing key) and
      // self-GC'ing. The emitter calls this BEFORE its first frame publish so a
      // crash between mark and publish still trips `wasTurnEmitted` on retry.
      await redis.set(emittedKey(turnId), '1', 'EX', TURN_EMITTED_LATCH_TTL_S, 'NX')
    },

    wasTurnEmitted: async (turnId) => (await redis.exists(emittedKey(turnId))) === 1,
  }
}

/** GET a key holding a ms-epoch (or any int), parse to Number, or null if unset
 *  / non-numeric. Shared by `lastActivityMs` + `firstUnrespondedMs` so the
 *  parse-or-null is written once. */
async function readNumber(redis: Redis, key: string): Promise<number | null> {
  const raw = await redis.get(key)
  if (raw === null) return null
  const n = Number(raw)
  return Number.isFinite(n) ? n : null
}
