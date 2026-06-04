import type { Pool } from 'pg'
import type { Redis } from 'ioredis'
import type { Repo } from './repo/index.js'
import type { WorldGenQueueLike } from './routes/campaigns.js'
import type { CharacterCreationQueueLike } from './routes/campaign-characters.js'
import type { SessionPrepQueueLike } from './routes/session-preps.js'
import type { SuspendQueueLike } from './session/session-suspend.js'

export interface AppDeps {
  pg: Pool
  redisRealtime: Redis
  redisBatch: Redis
  /** Per-environment+region prefix for Redis keys, e.g. "production:use1:".
   *  Threaded through to ws-ticket helpers (and any future Redis-keyed
   *  subsystem) so staging+prod sharing one ElastiCache cluster don't
   *  share keyspace. Derived in env.ts as ${MYTHRUN_ENV}:${REGION_PREFIX}:. */
  redisKeyPrefix: string
  repo: Repo
  /** BullMQ Queue handle for `world-gen` jobs. Constructed in server.ts at
   *  boot (after Redis is reachable) and threaded into the campaigns plugin
   *  registration so POST /api/campaigns + POST /resume can enqueue. Typed
   *  as the minimal WorldGenQueueLike contract — the plugin doesn't need
   *  BullMQ's full generic-heavy class type, and tests inject hand-rolled
   *  spies that satisfy the same shape. */
  worldGenQueue: WorldGenQueueLike
  /** myth-epo4 T22 / MYT-53: BullMQ Queue handle for `campaign-setup` jobs
   *  (per-player character creation). Optional because tests and the
   *  boot-gate-disabled fallback path don't construct a real queue — the
   *  plugin route returns 503 'queue_not_ready' in that state. Typed as the
   *  minimal CharacterCreationQueueLike contract; routes only call `.add()`. */
  characterCreationQueue?: CharacterCreationQueueLike
  /** MYT-63: BullMQ Queue handle for `session-prep` jobs. Constructed in
   *  server.ts at boot (after Redis is reachable) and threaded into the
   *  session-prep trigger plugin so the trigger route can enqueue. Required —
   *  mirrors worldGenQueue (boot invariant). Typed as the minimal
   *  SessionPrepQueueLike contract; the route only calls `.add()`. */
  sessionPrepQueue: SessionPrepQueueLike
  /** MYT-65 Task 11: BullMQ Queue handle for `session-suspend` jobs (built on
   *  redisBatch in server.ts). Threaded into the WS session route so the
   *  connection handler can `scheduleSuspend` on the last player's disconnect
   *  and `cancelSuspend` on a returning player. Typed as the minimal
   *  SuspendQueueLike contract (add/getJob/remove); the raw BullMQ Queue is
   *  closed at shutdown in server.ts. Required — the WS transport is a boot
   *  invariant of the gated binary. */
  sessionSuspendQueue: SuspendQueueLike
}
