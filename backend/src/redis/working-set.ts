// backend/src/redis/working-set.ts
//
// MYT-73 ephemeral session WORKING SET: proposed narrative facts produced
// during a live session (FT deltas, ST injections, retcons) that have NOT yet
// been reconciled into the durable world store. In-session only, keyed by
// campaignId (one live session per campaign), backed by a single Redis LIST:
//
//   session:{cId}:workingset    a list of WorkingSetItem JSON strings
//
// The list is APPEND-ONLY in the hot path: a turn worker `RPUSH`es its new
// items atomically so concurrent turns never lose an item to a load-blob /
// mutate / SET race (the failure mode a JSON-blob `:state`-style key would
// have). Eviction (`evictIfOver`) is the one rewrite path and is deliberately
// NON-atomic (DEL + RPUSH); it is only ever called from the lock-guarded
// post-turn Scribe job, which holds the per-session lock (MYT-66), so no
// concurrent append can interleave with the rewrite.
//
// Key prefixing follows the same `${MYTHRUN_ENV}:${REGION_PREFIX}:` convention
// as session-state.ts (this module appends `session:{cId}:workingset`), and the
// key TTL reuses session-state's STATE_TTL (~2h) so an idle working set lapses
// on the same schedule as the rest of the session's Redis state.

import type { Redis } from 'ioredis'

import type { WorkingSetItem } from '../session/working-set/types.js'

/** TTL (seconds) applied to the working-set key. Matches session-state.ts's
 *  STATE_TTL (~2h) so an idle session's working set lapses on the same schedule
 *  as its `:seq` / `:state` keys. Kept local to avoid coupling this module's
 *  export surface to session-state.ts; the value is the shared session TTL. */
const STATE_TTL = 2 * 60 * 60

export interface WorkingSetRepo {
  /** Reads the full working set in insertion order. Missing key → `[]`. */
  load(campaignId: string): Promise<WorkingSetItem[]>
  /** Atomically appends items (one `RPUSH` of all JSON strings). Empty input is
   *  a no-op. Refreshes the key TTL. */
  append(campaignId: string, items: readonly WorkingSetItem[]): Promise<void>
  /** Caps the list at `cap` by dropping the OLDEST public (`ft_delta`) items;
   *  non-public (`st_injection` / `retcon`) items are NEVER evicted. Non-atomic
   *  rewrite — lock-guarded caller only (see module header). */
  evictIfOver(campaignId: string, cap: number): Promise<void>
  /** Drops the working set entirely (session end / reconciliation flush). */
  clear(campaignId: string): Promise<void>
}

export function makeWorkingSetRepo(redis: Redis, keyPrefix: string): WorkingSetRepo {
  const key = (campaignId: string): string => `${keyPrefix}session:${campaignId}:workingset`

  return {
    load: async (campaignId) => {
      const raw = await redis.lrange(key(campaignId), 0, -1)
      return raw.map((s) => JSON.parse(s) as WorkingSetItem)
    },

    append: async (campaignId, items) => {
      if (items.length === 0) return
      const k = key(campaignId)
      // One RPUSH of all items is atomic — concurrent turns appending to the
      // same list interleave at the command boundary, never losing an item.
      await redis.rpush(k, ...items.map((i) => JSON.stringify(i)))
      // Refresh the TTL so an actively-appended working set doesn't expire.
      await redis.expire(k, STATE_TTL)
    },

    evictIfOver: async (campaignId, cap) => {
      const k = key(campaignId)
      const raw = await redis.lrange(k, 0, -1)
      if (raw.length <= cap) return
      const items = raw.map((s) => JSON.parse(s) as WorkingSetItem)

      // Partition into never-evict (ST injections + retcons) vs evictable
      // public (FT deltas). Non-public items are kept regardless of cap.
      const isPublic = (i: WorkingSetItem): boolean => i.source === 'ft_delta'
      const nonPublicCount = items.filter((i) => !isPublic(i)).length

      // How many public items the cap leaves room for, after reserving every
      // non-public slot — FLOORED AT 1 so we always retain the NEWEST public
      // item (the spec's "evict only the oldest public" rule: a turn's just-
      // proposed fact must survive its own eviction pass). The floor only bites
      // when non-public already fills/exceeds the cap; in that case the working
      // set stays over-cap by design (non-public are never dropped) and we log.
      const publicBudget = Math.max(1, cap - nonPublicCount)

      // Drop the OLDEST public items: keep only the last `publicBudget` of them.
      // Walk the list once in original order, keeping every non-public item and
      // the most-recent `publicBudget` public items.
      const publicIndices = items.flatMap((item, idx) => (isPublic(item) ? [idx] : []))
      const keepPublicFrom = publicIndices.length - publicBudget
      const keptPublic = new Set(publicIndices.slice(Math.max(0, keepPublicFrom)))

      const kept = items.filter((item, idx) => !isPublic(item) || keptPublic.has(idx))

      if (kept.length === items.length) return // nothing actually dropped

      // Non-atomic rewrite (DEL + RPUSH). Safe ONLY because the caller (the
      // post-turn Scribe job) holds the per-session lock — no concurrent append
      // can interleave. The kept items preserve original order.
      await redis.del(k)
      if (kept.length > 0) {
        await redis.rpush(k, ...kept.map((i) => JSON.stringify(i)))
        await redis.expire(k, STATE_TTL)
      }
      if (kept.length > cap) {
        // Non-public items alone exceed the cap; they are never dropped, so the
        // working set stays over-cap by design. Surface it for ops visibility.
        console.warn(
          `[working-set] campaign ${campaignId}: ${String(kept.length)} items exceed cap ${String(cap)} ` +
            `after keeping ${String(nonPublicCount)} non-public (st_injection/retcon) items`,
        )
      }
    },

    clear: async (campaignId) => {
      await redis.del(key(campaignId))
    },
  }
}
