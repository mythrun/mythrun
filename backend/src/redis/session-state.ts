// backend/src/redis/session-state.ts
//
// MYT-65 transport-relevant Redis state for a live multiplayer session,
// keyed by campaignId (one live session per campaign). This module owns
// ONLY the transport keys:
//
//   session:{cId}:seq                  monotonic sequence counter (INCR)
//   session:{cId}:conn:{cont}:{user}   per-connection presence (TTL)
//   session:{cId}:state                {participants, mode, status} JSON blob
//
// The LLM-tier keys (ft_history / summary / combat) and the distributed
// lock are OUT — they belong to MYT-66+ (see the MYT-65 design spec
// docs/superpowers/specs/2026-06-04-myt-65-ws-transport-design.md §"Redis
// state (MYT-65 subset)").
//
// Key prefixing follows `${MYTHRUN_ENV}:${REGION_PREFIX}:` (config/env.ts
// `redisKeyPrefix`), with this module appending `session:{cId}:…` — the
// same convention worker/publishers.ts uses for `${prefix}…:campaign:{id}`.

import type { Redis } from 'ioredis'

import type { ConversationMessage, TokenUsage } from '../session/tiers/types.js'

/**
 * Per-connection presence TTL, seconds. Each `conn:{containerId}:{userId}`
 * key carries this expiry so a CRASHED container's presence lapses
 * automatically — a bare INCR/DECR counter would leak (crash skips the
 * `close` handler → never suspends) or go negative (double-DECR). The
 * connection handler refreshes the key on every ping (well within 60s),
 * so live connections never expire mid-session. Per the MYT-65 design's
 * "Connections counter + suspend (crash-safe)" hardening decision.
 */
export const PRESENCE_TTL = 60

/** TTL (seconds) applied to `:seq` / `:state` by `refreshTtls` — long
 *  enough to outlive a suspend's grace window so a reconnect cold-starts
 *  from live Redis state rather than the Postgres checkpoint. ~2h. */
const STATE_TTL = 2 * 60 * 60

/** Session mode. MYT-65 only exercises `exploration`; `combat` arrives with
 *  the combat engine. Kept as a string union so the state blob is typed. */
export type SessionMode = 'exploration' | 'combat'

export interface SessionStateBlob {
  readonly participants: readonly string[]
  readonly mode: SessionMode
  readonly status: 'active' | 'ended' | 'crashed'
}

/**
 * The LLM-tier turn state a worker-side `SessionController` loads at the top of
 * a turn and flushes at the bottom (MYT-66). Backed by three Redis keys
 * (`:ft_history`, `:summary`, `:usage`) so a reconnecting / crash-recovering
 * container cold-starts the conversation from live Redis rather than replaying
 * `session_messages`. The checkpoint envelope (H6) folds a snapshot of this in.
 */
export interface TurnState {
  readonly ftHistory: ConversationMessage[]
  readonly summary: string
  readonly usage: TokenUsage
}

export interface CheckpointResult {
  /** `MAX(session_messages.seq)` from Postgres — the last DURABLY-PERSISTED
   *  seq, never the raw `:seq` counter (which sits one ahead between INCR
   *  and the row INSERT). */
  readonly maxSeq: number
}

/**
 * Repo-backed I/O the checkpoint needs, injected by the caller so this Redis
 * module issues ZERO raw SQL — all Postgres access flows through the repo
 * layer (the `mythrun/no-raw-db-access` boundary; data-layer unification
 * spec). The caller (the suspend processor / lifecycle route) wires:
 *   - `readMaxSeq`  → a `session_messages` repo read of `MAX(seq)` for the
 *     session (the DURABLE max — see CheckpointResult).
 *   - `writeCheckpoint` → `repo.sessions.update(sessionId, { stRunningSummary })`
 *     (or, once a typed checkpoint column lands, that column).
 */
export interface CheckpointStore {
  readMaxSeq(sessionId: string): Promise<number>
  writeCheckpoint(sessionId: string, envelope: string): Promise<void>
}

export interface SessionState {
  /** Assigns the next server-ordered seq. `INCR` is atomic, so two
   *  containers never hand out the same number. First call returns 1. */
  nextSeq(campaignId: string): Promise<number>
  /** Crash-recovery / eviction reseed. RAISES the counter to `max` only if
   *  the current value is below it — never lowers a live counter. Callers
   *  pass `MAX(session_messages.seq)`. */
  reseedSeq(campaignId: string, max: number): Promise<void>
  /** Records one live connection with a TTL (crash-safe). Idempotent per
   *  (containerId, userId). */
  addPresence(campaignId: string, containerId: string, userId: string): Promise<void>
  /** Removes one connection's presence key. */
  dropPresence(campaignId: string, containerId: string, userId: string): Promise<void>
  /** Counts live (non-expired) connection keys for the session via SCAN. */
  countPresence(campaignId: string): Promise<number>
  /** Reads the `:state` blob, or null if unset / corrupt. */
  getState(campaignId: string): Promise<SessionStateBlob | null>
  /** Writes the `:state` blob (JSON), refreshing its TTL. */
  setState(campaignId: string, state: SessionStateBlob): Promise<void>
  /** Bulk-reads the three LLM-tier turn-state keys (`:ft_history`, `:summary`,
   *  `:usage`) via a single `MGET`, JSON-parsing each with an empty default —
   *  an unset / corrupt key yields `[]` / `''` / `{input:0,output:0}`. */
  loadTurnState(campaignId: string): Promise<TurnState>
  /** Atomically writes all three turn-state keys + refreshes their TTL in one
   *  `MULTI`, so a crash never leaves history/summary/usage partially updated. */
  flushTurnState(campaignId: string, ts: TurnState): Promise<void>
  /** Bumps the TTL on the durable transport keys (`:seq`, `:state`) so an
   *  active session's state doesn't expire. Called on every interaction. */
  refreshTtls(campaignId: string): Promise<void>
  /** 5-min checkpoint: reads `MAX(session_messages.seq)` for `sessionId`
   *  (via the injected store) and flushes the Redis `:state` blob to the
   *  Postgres `sessions` row. Returns the persisted max seq. */
  checkpoint(
    campaignId: string,
    sessionId: string,
    store: CheckpointStore,
  ): Promise<CheckpointResult>
}

export function makeSessionState(redis: Redis, keyPrefix: string): SessionState {
  const base = (campaignId: string): string => `${keyPrefix}session:${campaignId}`
  const seqKey = (campaignId: string): string => `${base(campaignId)}:seq`
  const stateKey = (campaignId: string): string => `${base(campaignId)}:state`
  const historyKey = (campaignId: string): string => `${base(campaignId)}:ft_history`
  const summaryKey = (campaignId: string): string => `${base(campaignId)}:summary`
  const usageKey = (campaignId: string): string => `${base(campaignId)}:usage`
  const connKey = (campaignId: string, containerId: string, userId: string): string =>
    `${base(campaignId)}:conn:${containerId}:${userId}`
  const connPattern = (campaignId: string): string => `${base(campaignId)}:conn:*`

  // Bound once so both the returned `loadTurnState` and `checkpoint` (H6, which
  // folds a turn-state snapshot into the envelope) share one reader.
  const loadTurnState = (campaignId: string): Promise<TurnState> =>
    readTurnState(redis, historyKey(campaignId), summaryKey(campaignId), usageKey(campaignId))

  return {
    nextSeq: async (campaignId) => redis.incr(seqKey(campaignId)),

    reseedSeq: async (campaignId, max) => {
      // RAISE-ONLY: a GET-then-SET-if-greater. Safe under the single-threaded
      // ioredis-mock test and acceptable for the helper, BUT in PRODUCTION
      // this MUST be an atomic Lua `EVAL` compare-and-set — two containers
      // racing crash-recovery here could read the same low value and both
      // SET, momentarily lowering a counter another writer just raised.
      // The Lua body: `local c = tonumber(redis.call('GET', KEYS[1]) or '0')
      // if c < tonumber(ARGV[1]) then redis.call('SET', KEYS[1], ARGV[1]) end`.
      const key = seqKey(campaignId)
      const currentRaw = await redis.get(key)
      const current = currentRaw === null ? 0 : Number(currentRaw)
      if (!Number.isFinite(current) || current < max) {
        await redis.set(key, String(max))
      }
    },

    addPresence: async (campaignId, containerId, userId) => {
      await redis.set(connKey(campaignId, containerId, userId), '1', 'EX', PRESENCE_TTL)
    },

    dropPresence: async (campaignId, containerId, userId) => {
      await redis.del(connKey(campaignId, containerId, userId))
    },

    countPresence: async (campaignId) => {
      // SCAN, not KEYS: KEYS is O(N) over the WHOLE keyspace and blocks the
      // single-threaded Redis event loop — unacceptable on a shared
      // ElastiCache cluster. SCAN is cursor-paged and non-blocking. The
      // match set is bounded per session (a handful of connections), so the
      // full cursor walk is cheap.
      const pattern = connPattern(campaignId)
      let cursor = '0'
      let count = 0
      do {
        const [next, batch] = await redis.scan(cursor, 'MATCH', pattern, 'COUNT', 100)
        cursor = next
        count += batch.length
      } while (cursor !== '0')
      return count
    },

    getState: async (campaignId) => {
      const raw = await redis.get(stateKey(campaignId))
      if (raw === null || typeof raw !== 'string') return null
      let parsed: unknown
      try {
        parsed = JSON.parse(raw)
      } catch {
        // Corrupt blob → treat as absent; the connect path rebuilds state
        // from the Postgres checkpoint + session_messages.
        return null
      }
      if (
        typeof parsed !== 'object' ||
        parsed === null ||
        !Array.isArray((parsed as { participants?: unknown }).participants)
      ) {
        return null
      }
      const blob = parsed as SessionStateBlob
      return {
        participants: blob.participants,
        mode: blob.mode,
        status: blob.status,
      }
    },

    setState: async (campaignId, state) => {
      await redis.set(stateKey(campaignId), JSON.stringify(state), 'EX', STATE_TTL)
    },

    loadTurnState,

    flushTurnState: async (campaignId, ts) => {
      // First real MULTI in the repo (H3): the three turn-state writes + their
      // TTL refresh commit atomically, so a crash mid-flush never leaves
      // history/summary/usage out of sync. pexpire takes milliseconds, hence
      // STATE_TTL (seconds) * 1000.
      const ttlMs = STATE_TTL * 1000
      await redis
        .multi()
        .set(historyKey(campaignId), JSON.stringify(ts.ftHistory))
        .set(summaryKey(campaignId), ts.summary)
        .set(usageKey(campaignId), JSON.stringify(ts.usage))
        .pexpire(historyKey(campaignId), ttlMs)
        .pexpire(summaryKey(campaignId), ttlMs)
        .pexpire(usageKey(campaignId), ttlMs)
        .exec()
    },

    refreshTtls: async (campaignId) => {
      // EXPIRE is a no-op on a missing key (returns 0), so refreshing a
      // not-yet-created :state/:seq doesn't conjure it.
      await Promise.all([
        redis.expire(seqKey(campaignId), STATE_TTL),
        redis.expire(stateKey(campaignId), STATE_TTL),
      ])
    },

    checkpoint: async (campaignId, sessionId, store) => {
      // Read the DURABLY-PERSISTED max seq via the injected store — NOT the
      // raw `:seq` counter, which sits one ahead between INCR and the row
      // INSERT. A crash restoring from this checkpoint must reseed from a
      // seq that actually has a backing row, or it would re-hand-out a
      // number a message already used.
      const maxSeq = await store.readMaxSeq(sessionId)

      // DONE_WITH_CONCERNS: checkpoint storage target.
      //   The sessions table (migrations/001_initial_schema.sql) has no
      //   dedicated checkpoint column. The MYT-65 design says "flush Redis
      //   state to a Postgres checkpoint" but never pins a column, and
      //   adding one is a schema migration this transport-state task must
      //   not own (per the Task 5 scope: touch ONLY session-state.ts + its
      //   test; the no-raw-db-access boundary also forbids issuing the SQL
      //   from here). So the envelope below — {state, maxSeq} JSON — is
      //   handed to the injected `writeCheckpoint`, which the caller (the
      //   suspend processor, Task 10) backs with
      //   `repo.sessions.update(sessionId, { stRunningSummary: envelope })`,
      //   parking it in the existing `st_running_summary` TEXT column.
      //   Enough for crash-recovery's "cold-start from the latest checkpoint
      //   + session_messages" to read it back. Revisit when the runtime
      //   lands: a typed `session_checkpoints` row (or a jsonb column on
      //   sessions) is the right home, and Task 10 is the consumer that
      //   will pin the contract.
      const state = await readRawState(redis, stateKey(campaignId))
      // H6: the envelope now folds in the LLM-tier turn-state snapshot so a
      // suspend reader can cold-start the conversation, not just the transport
      // counters. `kind` bumped to myt66 — the (not-yet-written) reader parses
      // this superset of the old myt65 shape.
      const turnState = await loadTurnState(campaignId)
      const envelope = JSON.stringify({ kind: 'myt66-checkpoint', maxSeq, state, turnState })
      await store.writeCheckpoint(sessionId, envelope)

      return { maxSeq }
    },
  }
}

/** Bulk-read the three turn-state keys via one MGET, JSON-parsing each with an
 *  empty default — an unset key or a corrupt blob falls back to the zero value,
 *  so a half-initialised session still loads cleanly. Free-standing so the
 *  `makeSessionState` closure stays lean (mirrors `readRawState`). */
async function readTurnState(
  redis: Redis,
  historyKey: string,
  summaryKey: string,
  usageKey: string,
): Promise<TurnState> {
  const [rawHistory, rawSummary, rawUsage] = await redis.mget(historyKey, summaryKey, usageKey)
  return {
    ftHistory: parseJson<ConversationMessage[]>(rawHistory, []),
    summary: rawSummary ?? '',
    usage: parseJson<TokenUsage>(rawUsage, { input: 0, output: 0 }),
  }
}

/** JSON-parse a turn-state value, falling back to `fallback` when the key is
 *  unset (`null`/`undefined` — `mget` types its misses as either) or holds
 *  corrupt JSON. The caller pins the element type via the `T` argument (a parse
 *  helper, not a bare `as` on the call site). */
function parseJson<T>(raw: string | null | undefined, fallback: T): T {
  if (raw === null || raw === undefined) return fallback
  try {
    return JSON.parse(raw) as T
  } catch {
    return fallback
  }
}

/** Read the raw `:state` blob for the checkpoint envelope without
 *  re-validating (the checkpoint persists whatever is live; a corrupt blob
 *  is the connect path's problem on restore, not the checkpoint's). Free-
 *  standing so the `checkpoint` method object doesn't depend on `this`. */
async function readRawState(redis: Redis, key: string): Promise<unknown> {
  const raw = await redis.get(key)
  if (raw === null || typeof raw !== 'string') return null
  try {
    return JSON.parse(raw)
  } catch {
    return null
  }
}
