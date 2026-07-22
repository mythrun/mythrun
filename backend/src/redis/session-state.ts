// backend/src/redis/session-state.ts
//
// MYT-65 transport-relevant Redis state for a live multiplayer session,
// keyed by campaignId (one live session per campaign). This module owns
// ONLY the transport keys:
//
//   session:{cId}:seq                          monotonic sequence counter (INCR)
//   session:{cId}:conn:{cont}:{user}:{connId}  per-connection presence (TTL)
//   session:{cId}:state                        {participants, mode, status} JSON blob
//
// The LLM-tier turn-state keys are `:summary`, `:usage`, and (MYT-69)
// `:usage:st`. As of MYT-68 the FT transcript is PG-direct (reconstructed from
// session_messages — §3.7), so the former `:ft_history` Redis key is RETIRED.
// As of MYT-69, `:summary` is the ST job's artifact (setRunningSummary is its
// only writer; the turn flush is usage-only) and the ST's spend rides the
// dedicated `:usage:st` counter. The distributed lock + combat keys are still OUT — they belong to
// MYT-66+ (see the MYT-65 design spec
// docs/superpowers/specs/2026-06-04-myt-65-ws-transport-design.md §"Redis
// state (MYT-65 subset)").
//
// Key prefixing follows `${MYTHRUN_ENV}:${REGION_PREFIX}:` (config/env.ts
// `redisKeyPrefix`), with this module appending `session:{cId}:…` — the
// same convention worker/publishers.ts uses for `${prefix}…:campaign:{id}`.

import type { Redis } from 'ioredis'

import type { TokenUsage } from '../session/tiers/types.js'

/**
 * Per-connection presence TTL, seconds. Each `conn:{containerId}:{userId}:{connId}`
 * key carries this expiry so a CRASHED container's presence lapses
 * automatically — a bare INCR/DECR counter would leak (crash skips the
 * `close` handler → never suspends) or go negative (double-DECR). The
 * connection handler refreshes the key on every ping (well within 60s),
 * so live connections never expire mid-session. Per the MYT-65 design's
 * "Connections counter + suspend (crash-safe)" hardening decision.
 *
 * myth-wat0m: the key is now keyed per-CONNECTION (a `{connId}` suffix), not
 * per-user, so a user's multiple tabs each hold an independent key. Closing one
 * tab drops only that tab's key; the user stays present while another tab lives.
 */
export const PRESENCE_TTL = 60

/** TTL (seconds) applied to `:seq` / `:state` by `refreshTtls` — long
 *  enough to outlive a suspend's grace window so a reconnect cold-starts
 *  from live Redis state rather than the Postgres checkpoint. ~2h. */
const STATE_TTL = 2 * 60 * 60

/** TTL (seconds) on the `:ending` once-only end flag (MYT-74a T11). Sized to
 *  comfortably outlive the end orchestration + the reconcile job's retries so a
 *  late inbound frame after an end is still dropped, while a crash between
 *  mark-and-reconcile eventually self-heals (the durable interlock is the
 *  reconcile worker's `reconciled_at` gate, not this flag). ~1h. */
const ENDING_TTL = 60 * 60

/** Session mode. MYT-65 only exercises `exploration`; `combat` arrives with
 *  the combat engine. Kept as a string union so the state blob is typed. */
type SessionMode = 'exploration' | 'combat'

export interface SessionStateBlob {
  readonly participants: readonly string[]
  readonly mode: SessionMode
  readonly status: 'active' | 'ended' | 'crashed'
  /** MYT-68: the enforced-ignorance-safe prep doc (session_preps.ft_context),
   *  parked on the state blob so a turn worker reads it without a PG round-trip.
   *  Optional — absent on sessions started before the prep wiring lands. */
  readonly ftContext?: string
  /** MYT-68: the world's tonal register, threaded into FT prompting. */
  readonly worldTone?: string
  /** MYT-72: the campaign's world id, cached on the state blob so a turn worker
   *  resolves it (for the world-knowledge lookup tools) without a PG round-trip
   *  every turn. Optional — absent on sessions whose blob predates this cache;
   *  the turn worker's `resolveWorldId` back-fills it via repo.campaigns. */
  readonly worldId?: string
}

/** MYT-75 — the combat outcome tier. A deterministic skill-check-style roll
 *  (DC + d20 + party modifier) lands in one of four bands; the band picks the
 *  narrative envelope the FT writes within. Enforced-ignorance-safe: it carries
 *  no plot, only the mechanical shape of how the fight went. */
export type CombatTier = 'routed' | 'pyrrhic' | 'costly' | 'decisive'

/** The hard constraints the matched `CombatTier` imposes on the FT's combat
 *  prose — the L1 analogue of the skill-check outcome table. The FT writes
 *  within these bounds; it never invents a worse (or better) result than the
 *  deterministic roll allows. */
export interface CombatEnvelope {
  readonly partyWins: boolean
  readonly minDownedPcs: number
  readonly minAggregateHpLossFraction: number
  readonly allowPcDeathNarration: boolean
}

/** The deterministic resolution of a combat: the roll, its tier, the prose
 *  seed for that tier, and the `CombatEnvelope` the FT must honour. The LLM
 *  never rolls — this is computed in code (the "LLM never generates random
 *  numbers" principle) and injected as a constraint. */
export interface CombatOutcome {
  readonly tier: CombatTier
  readonly dc: number
  readonly roll: number
  readonly total: number
  readonly tierProse: string
  readonly envelope: CombatEnvelope
}

/** The Scribe-grade structured summary the FT/Scribe emits once a fight is
 *  resolved (L1). Persisted on the combat blob so the post-combat world-state
 *  update reads casualties / HP deltas / loot without re-deriving them from
 *  prose. */
export interface CombatSummaryL1 {
  readonly outcome: 'victory' | 'defeat' | 'flee' | 'other'
  readonly outcomeDescription: string
  readonly casualties: readonly {
    name: string
    type: 'pc' | 'npc'
    fate: 'dead' | 'unconscious' | 'fled' | 'captured'
  }[]
  readonly hpChanges: readonly {
    combatant: string
    hpBefore: number
    hpAfter: number
    maxHp: number
  }[]
  readonly conditionsRemaining: readonly { combatant: string; condition: string }[]
  readonly loot: readonly { source: string; items: readonly string[] }[]
}

/** The resolved-combat payload: the structured L1 summary. Wrapped in an
 *  object so the contract can grow (e.g. a prose field) without churning every
 *  call site. `null` on the blob until the fight resolves. */
interface CombatResult {
  readonly summary: CombatSummaryL1
}

/** The `session:{cId}:combat` Redis blob (MYT-75). Holds the setup the combat
 *  was entered with (enemies / environment / surprise / initiative), the
 *  deterministic `CombatOutcome`, and — once resolved — the `CombatResult`.
 *  `status` flips `resolving` → `resolved`; `result` is `null` until then. */
export interface CombatStateBlob {
  readonly status: 'resolving' | 'resolved'
  readonly enemies: readonly { name: string; description: string; count: number }[]
  readonly environment: string
  readonly surprise: 'none' | 'players_surprised' | 'enemies_surprised'
  readonly initiative: readonly { combatant: string; roll: number }[]
  readonly outcome: CombatOutcome
  readonly result: CombatResult | null
}

/**
 * The LLM-tier turn state a worker-side `SessionController` loads at the top of
 * a turn and flushes at the bottom (MYT-66). Backed by two Redis keys
 * (`:summary`, `:usage`). As of MYT-68 the FT transcript is PG-direct
 * (reconstructed from `session_messages` — §3.7), so the former `:ft_history`
 * key is RETIRED and no longer round-trips through here. The checkpoint
 * envelope (H6) folds a snapshot of what remains in.
 */
export interface TurnState {
  readonly summary: string
  readonly usage: TokenUsage
}

interface CheckpointResult {
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
   *  (containerId, userId, connId) — myth-wat0m: keyed per-CONNECTION so a
   *  user's multiple tabs each hold their own key. */
  addPresence(
    campaignId: string,
    containerId: string,
    userId: string,
    connId: string,
  ): Promise<void>
  /** Removes ONE connection's presence key (by connId) — never a sibling tab's. */
  dropPresence(
    campaignId: string,
    containerId: string,
    userId: string,
    connId: string,
  ): Promise<void>
  /** Counts DISTINCT users with ≥1 live (non-expired) connection, via SCAN. The
   *  suspend gate reads this: `=== 0` means the session is genuinely empty (the
   *  last connection of the last user has dropped), regardless of how many tabs
   *  any one user held. A user with two tabs counts once. */
  countPresence(campaignId: string): Promise<number>
  /** Counts one user's live connections (their open tabs / devices) via SCAN.
   *  Drives the player_joined/player_left gating: broadcast a join only on a
   *  user's FIRST connection and a left only when their LAST one drops. */
  userConnectionCount(campaignId: string, userId: string): Promise<number>
  /** Reads the `:state` blob, or null if unset / corrupt. */
  getState(campaignId: string): Promise<SessionStateBlob | null>
  /** Writes the `:state` blob (JSON), refreshing its TTL. */
  setState(campaignId: string, state: SessionStateBlob): Promise<void>
  /** Bulk-reads the two LLM-tier turn-state keys (`:summary`, `:usage`) via a
   *  single `MGET`, JSON-parsing each with an empty default — an unset /
   *  corrupt key yields `''` / `{input:0,output:0}`. */
  loadTurnState(campaignId: string): Promise<TurnState>
  /** Writes the `:usage` key + refreshes its TTL. USAGE-ONLY as of MYT-69 (§7):
   *  the `:summary` key is the ST job's artifact (`setRunningSummary` is its
   *  only writer). A blind summary SET here would clobber the ST's background
   *  write — the turn worker reads `:usage` at turn start, accumulates across a
   *  minutes-long render, and SETs at flush; an ST summary write in that window
   *  would be erased by the stale-read-then-SET. The param is narrowed to
   *  `{ usage }` so the signature is honest about what it persists. */
  flushTurnState(campaignId: string, ts: { readonly usage: TokenUsage }): Promise<void>
  /** Writes the `:summary` key (plain SET) with the state TTL. The ST job is the
   *  ONLY writer (MYT-69 §7). The turn flush no longer refreshes the summary's
   *  TTL, so this writer must apply it — a gate-quiet stretch must not let the
   *  ST's running summary lapse mid-session. */
  setRunningSummary(campaignId: string, summary: string): Promise<void>
  /** Atomic `INCRBY` of the DEDICATED `:usage:st` key (MYT-69 §7). The ST job's
   *  token spend tracks separately from `:usage` because the shared-key
   *  alternative (Lua/WATCH) provably can't survive the turn worker's
   *  stale-read-then-SET — its blind flush would erase a shared increment. */
  incrUsageSt(campaignId: string, tokens: number): Promise<void>
  /** Total session token spend: the `:usage` blob's `input + output` PLUS the
   *  `:usage:st` counter, summed. The §7 budget gate reads this. */
  totalUsageTokens(campaignId: string): Promise<number>
  /** Session-boundary hygiene (§8, called from the `/start` route): DELs the
   *  spend + summary keys (`:usage`, `:usage:st`, `:summary`) so a fresh session
   *  starts with a clean budget and no stale running summary. */
  resetSessionSpend(campaignId: string): Promise<void>
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
  /** MYT-74a T11 — atomically claim the once-only session-end interlock.
   *  `SET … NX` on `session:{cId}:ending`: returns `true` for the FIRST caller
   *  (the flag was unset) and `false` thereafter. The explicit `end_session`
   *  frame and the budget auto-end (T12) both call `endSession`, which races
   *  through this gate so the two collapse to a SINGLE end. The key carries a
   *  TTL so a crash between mark-and-reconcile self-heals (the reconcile worker's
   *  own §4 `reconciled_at` gate is the durable interlock; this flag only fences
   *  the in-process end orchestration + the inbound drop-gate). */
  tryMarkEnding(campaignId: string): Promise<boolean>
  /** MYT-74a T11 — read the session-end flag. The WS inbound handler checks this
   *  at the top of every frame and DROPS the frame when set (no new turn after
   *  an end has begun). A missing key (never ended, or the TTL reaped a stale
   *  flag) reads `false`. */
  isEnding(campaignId: string): Promise<boolean>
  /** myth-x4ca4 — release the `:ending` fence at finalize. The flag's two jobs
   *  (fence the in-process end orchestration; drop inbound frames while the row
   *  is still 'active') both expire when `markEnded` flips the row — from then
   *  on /start's active-session + reconcile_pending preconditions own every
   *  window. Without this DEL the 1h TTL blocked the campaign's NEXT /start for
   *  up to an hour after every clean end. Idempotent (DEL of a missing key). */
  clearEnding(campaignId: string): Promise<void>
  /** MYT-75 — read the `:combat` blob, or null if unset / corrupt. The session
   *  is in combat mode (the `:state` blob's `mode`) iff this returns non-null. */
  getCombatState(campaignId: string): Promise<CombatStateBlob | null>
  /** MYT-75 — write the `:combat` blob (JSON) with the state TTL. */
  setCombatState(campaignId: string, state: CombatStateBlob): Promise<void>
  /** MYT-75 — DEL the `:combat` blob AND the `:resumed` interlock, so a session
   *  that re-enters combat later can claim the resume gate again. Called when a
   *  fight resolves and the session returns to exploration. */
  clearCombatState(campaignId: string): Promise<void>
  /** MYT-75 — atomically claim the once-only combat-resume interlock.
   *  `SET … NX` on `session:{cId}:resumed`: returns `true` for the FIRST caller
   *  and `false` thereafter, so a crash-recovery resume of an in-flight fight
   *  runs exactly once even if two containers race the reconnect. The key carries
   *  a TTL so a flag stranded by a crash self-heals; `clearCombatState` releases
   *  it on resolution so a subsequent fight resumes anew. */
  tryMarkResumed(campaignId: string): Promise<boolean>
}

export function makeSessionState(redis: Redis, keyPrefix: string): SessionState {
  const base = (campaignId: string): string => `${keyPrefix}session:${campaignId}`
  const seqKey = (campaignId: string): string => `${base(campaignId)}:seq`
  const stateKey = (campaignId: string): string => `${base(campaignId)}:state`
  const summaryKey = (campaignId: string): string => `${base(campaignId)}:summary`
  const usageKey = (campaignId: string): string => `${base(campaignId)}:usage`
  const usageStKey = (campaignId: string): string => `${base(campaignId)}:usage:st`
  const endingKey = (campaignId: string): string => `${base(campaignId)}:ending`
  const combatKey = (campaignId: string): string => `${base(campaignId)}:combat`
  const resumedKey = (campaignId: string): string => `${base(campaignId)}:resumed`
  const connKey = (
    campaignId: string,
    containerId: string,
    userId: string,
    connId: string,
  ): string => `${base(campaignId)}:conn:${containerId}:${userId}:${connId}`
  const connPattern = (campaignId: string): string => `${base(campaignId)}:conn:*`
  const connPrefix = (campaignId: string): string => `${base(campaignId)}:conn:`

  // Bound once so both the returned `loadTurnState` and `checkpoint` (H6, which
  // folds a turn-state snapshot into the envelope) share one reader.
  const loadTurnState = (campaignId: string): Promise<TurnState> =>
    readTurnState(redis, summaryKey(campaignId), usageKey(campaignId))

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

    addPresence: async (campaignId, containerId, userId, connId) => {
      await redis.set(connKey(campaignId, containerId, userId, connId), '1', 'EX', PRESENCE_TTL)
    },

    dropPresence: async (campaignId, containerId, userId, connId) => {
      await redis.del(connKey(campaignId, containerId, userId, connId))
    },

    countPresence: async (campaignId) => {
      // Distinct users with ≥1 live connection (a multi-tab user counts once).
      const userIds = await scanConnUserIds(
        redis,
        connPattern(campaignId),
        connPrefix(campaignId),
      )
      return new Set(userIds).size
    },

    userConnectionCount: async (campaignId, userId) => {
      const userIds = await scanConnUserIds(
        redis,
        connPattern(campaignId),
        connPrefix(campaignId),
      )
      return userIds.filter((u) => u === userId).length
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
        // Pass the optional MYT-68 fields through only when they are present
        // as strings (under exactOptionalPropertyTypes we omit the key
        // entirely rather than set it to undefined).
        ...(typeof blob.ftContext === 'string' ? { ftContext: blob.ftContext } : {}),
        ...(typeof blob.worldTone === 'string' ? { worldTone: blob.worldTone } : {}),
        ...(typeof blob.worldId === 'string' ? { worldId: blob.worldId } : {}),
      }
    },

    setState: async (campaignId, state) => {
      await redis.set(stateKey(campaignId), JSON.stringify(state), 'EX', STATE_TTL)
    },

    loadTurnState,

    flushTurnState: (campaignId, ts) => flushUsage(redis, usageKey(campaignId), ts.usage),

    setRunningSummary: async (campaignId, summary) => {
      // The ST job is the ONLY writer (MYT-69 §7). SET with the state TTL — the
      // turn flush no longer refreshes the summary's TTL, so this writer must
      // apply it or a gate-quiet stretch could let the ST's memory lapse
      // mid-session.
      await redis.set(summaryKey(campaignId), summary, 'EX', STATE_TTL)
    },

    incrUsageSt: async (campaignId, tokens) => {
      // §7: a DEDICATED key, atomic INCRBY. The shared-`:usage` alternative
      // (Lua/WATCH) provably can't survive the turn worker's stale-read-then-SET
      // — its blind flush would erase a shared increment.
      await redis.incrby(usageStKey(campaignId), tokens)
    },

    totalUsageTokens: (campaignId) =>
      readTotalUsageTokens(redis, usageKey(campaignId), usageStKey(campaignId)),

    resetSessionSpend: async (campaignId) => {
      // §8 session-boundary hygiene (called from the `/start` route): a fresh
      // session starts with a clean budget and no stale running summary.
      await redis.del(usageKey(campaignId), usageStKey(campaignId), summaryKey(campaignId))
    },

    refreshTtls: async (campaignId) => {
      // EXPIRE is a no-op on a missing key (returns 0), so refreshing a
      // not-yet-created :state/:seq/:combat doesn't conjure it.
      await Promise.all([
        redis.expire(seqKey(campaignId), STATE_TTL),
        redis.expire(stateKey(campaignId), STATE_TTL),
        redis.expire(combatKey(campaignId), STATE_TTL),
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
      // H6: the envelope folds in the LLM-tier turn-state snapshot so a suspend
      // reader can cold-start the conversation, not just the transport
      // counters.
      const turnState = await loadTurnState(campaignId)
      // `kind` bumped to myt69 — the FLUSH shape changed (usage-only; the ST
      // job now owns `:summary` via setRunningSummary — §7), so the checkpoint
      // reader (suspend/recovery path) MUST fail loud on the old myt68 shape
      // rather than silently read a stale flush contract. The envelope STILL
      // folds the running summary in via loadTurnState (cold-start recovery
      // persists it into sessions.st_running_summary — deliberate; the
      // player-facing leak fix was the T7 route allowlist, not removing this
      // persist). Superset of the transport-only shape — still carries
      // {state, maxSeq}.
      const envelope = JSON.stringify({ kind: 'myt69-checkpoint', maxSeq, state, turnState })
      await store.writeCheckpoint(sessionId, envelope)

      return { maxSeq }
    },

    tryMarkEnding: async (campaignId) => {
      // SET NX is atomic: the first end (explicit frame OR budget auto-end) wins
      // and gets 'OK'; a racing second end gets null and short-circuits. The TTL
      // self-heals a flag stranded by a crash mid-end (the durable interlock is
      // the reconcile worker's reconciled_at gate — see the interface doc).
      const result = await redis.set(endingKey(campaignId), '1', 'EX', ENDING_TTL, 'NX')
      return result === 'OK'
    },

    isEnding: async (campaignId) => {
      // EXISTS is 1 when the flag is set, 0 when unset / TTL-reaped.
      return (await redis.exists(endingKey(campaignId))) === 1
    },

    clearEnding: async (campaignId) => {
      // myth-x4ca4: idempotent release at finalize — see the interface doc.
      await redis.del(endingKey(campaignId))
    },

    getCombatState: async (campaignId) => {
      const raw = await redis.get(combatKey(campaignId))
      if (raw === null || typeof raw !== 'string') return null
      try {
        // Corrupt blob → treat as absent (mirrors getState's parse arm); the
        // connect/recovery path rebuilds combat from the Postgres checkpoint.
        return JSON.parse(raw) as CombatStateBlob
      } catch {
        return null
      }
    },

    setCombatState: async (campaignId, state) => {
      await redis.set(combatKey(campaignId), JSON.stringify(state), 'EX', STATE_TTL)
    },

    clearCombatState: async (campaignId) => {
      // DEL both keys: a re-entered fight must be able to claim the resume gate
      // again, so the once-only `:resumed` flag is released alongside `:combat`.
      await redis.del(combatKey(campaignId), resumedKey(campaignId))
    },

    tryMarkResumed: async (campaignId) => {
      // SET NX is atomic: the first resume (the winning crash-recovery path)
      // gets 'OK'; a racing second container gets null and short-circuits, so an
      // in-flight fight resumes exactly once. The TTL self-heals a stranded flag;
      // clearCombatState releases it so a later fight resumes anew.
      const result = await redis.set(resumedKey(campaignId), '1', 'EX', ENDING_TTL, 'NX')
      return result === 'OK'
    },
  }
}

/**
 * SCAN all live per-connection presence keys for a session and return the userId
 * embedded in each — WITH multiplicity (one entry per live connection). Callers
 * derive the distinct-user count (`countPresence`) and a single user's connection
 * count (`userConnectionCount`) from this list.
 *
 * SCAN, not KEYS: KEYS is O(N) over the WHOLE keyspace and blocks the
 * single-threaded Redis event loop — unacceptable on a shared ElastiCache
 * cluster. SCAN is cursor-paged and non-blocking, and the match set is bounded
 * per session (a handful of connections), so the full walk is cheap.
 *
 * Parse: strip the known `session:{cId}:conn:` prefix, then split the remainder
 * on ':'. The userId is the SECOND segment in BOTH the current
 * `{container}:{userId}:{connId}` shape and the pre-myth-wat0m `{container}:{userId}`
 * shape (the new shape just appends a connId), so a ROLLING DEPLOY that still has
 * old-shape keys in flight parses correctly — no under-count that could suspend a
 * live session or spuriously churn presence. containerId/userId/connId are all
 * colon-free UUIDs, so index 1 is unambiguously the userId.
 */
async function scanConnUserIds(
  redis: Redis,
  pattern: string,
  prefix: string,
): Promise<string[]> {
  const userIds: string[] = []
  let cursor = '0'
  do {
    const [next, batch] = await redis.scan(cursor, 'MATCH', pattern, 'COUNT', 100)
    cursor = next
    for (const key of batch) {
      const userId = key.slice(prefix.length).split(':')[1]
      if (userId !== undefined && userId !== '') userIds.push(userId)
    }
  } while (cursor !== '0')
  return userIds
}

/** Bulk-read the two turn-state keys via one MGET, JSON-parsing each with an
 *  empty default — an unset key or a corrupt blob falls back to the zero value,
 *  so a half-initialised session still loads cleanly. Free-standing so the
 *  `makeSessionState` closure stays lean (mirrors `readRawState`). */
async function readTurnState(
  redis: Redis,
  summaryKey: string,
  usageKey: string,
): Promise<TurnState> {
  const [rawSummary, rawUsage] = await redis.mget(summaryKey, usageKey)
  return {
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

/** USAGE-ONLY flush as of MYT-69 (§7): the `:summary` key is the ST job's
 *  artifact (`setRunningSummary` is its only writer). A blind summary SET here
 *  would clobber the ST's background write — the turn worker reads `:usage` at
 *  turn start, accumulates across a minutes-long render, and SETs at flush; an
 *  ST summary write in that window would be erased by the stale-read-then-SET.
 *  Single SET + TTL refresh in one MULTI so a crash mid-flush never leaves
 *  usage written without its expiry. pexpire takes milliseconds, hence
 *  STATE_TTL (seconds) * 1000. Free-standing so the factory closure stays lean. */
async function flushUsage(redis: Redis, usageKeyName: string, usage: TokenUsage): Promise<void> {
  await redis
    .multi()
    .set(usageKeyName, JSON.stringify(usage))
    .pexpire(usageKeyName, STATE_TTL * 1000)
    .exec()
}

/** §7 budget gate: turn usage (the `:usage` blob's input+output) PLUS the ST
 *  job's separately-tracked `:usage:st` counter. Free-standing so the factory
 *  closure stays lean (same pattern as the other readers above). */
async function readTotalUsageTokens(
  redis: Redis,
  usageKeyName: string,
  usageStKeyName: string,
): Promise<number> {
  const [rawUsage, rawSt] = await redis.mget(usageKeyName, usageStKeyName)
  const turnUsage = parseJson<TokenUsage>(rawUsage, { input: 0, output: 0 })
  const stTokens = rawSt === null || rawSt === undefined ? 0 : Number(rawSt)
  return turnUsage.input + turnUsage.output + (Number.isFinite(stTokens) ? stTokens : 0)
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
