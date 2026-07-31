// backend/src/routes/campaign-characters.ts
//
// MYT-53 per-player character-creation routes. This file was split when it
// grew past the 400-line module cap: it is now the thin composer that owns
// the shared plugin opts / queue types and registers the cohesive route
// modules it was decomposed into. The registered plugin (`campaignCharactersPlugin`)
// and the exported queue types keep their identity — app.ts, server-queues,
// app-deps, and the route tests import from here unchanged.
//
// The routes now live in:
//   - campaign-setup-routes.ts     — starting-situation / starting-level (owner)
//                                     + GET starting-situations (member)
//   - character-concept-routes.ts  — POST /characters submit + reset + confirm (member)
//   - character-roster-routes.ts   — GET /characters roster + creation-progress (member)
//   - world-read-routes.ts         — GET character sheet / hierarchy / random-tables (member)
//   - campaign-lifecycle-routes.ts — finalize-character-creation + archive (owner)
//
// Each sub-plugin builds its own repo via `createRepo(opts.pool)` and carries
// the same route paths, methods, schemas, auth, and `pipelineRoute` markers
// as before the split. The onRoute/onReady pipeline-routes contract hooks are
// installed on the root app (app.ts), so routes registered inside these nested
// plugins still trigger the forward/reverse contract checks.

import type { FastifyPluginAsync } from 'fastify'
import type { Pool } from 'pg'
import { campaignSetupRoutes } from './campaign-setup-routes.js'
import { characterConceptRoutes } from './character-concept-routes.js'
import { characterRosterRoutes } from './character-roster-routes.js'
import { worldReadRoutes } from './world-read-routes.js'
import { campaignLifecycleRoutes } from './campaign-lifecycle-routes.js'

// Per-player MYT-53 jobs carry `{ campaignId, userId }`; the campaign-
// scoped MYT-54 T11 'character-integration' job carries
// `{ campaignId, ownerUserId }`. Both names land on the same
// `campaign-setup` queue (see worker.ts router), so the single .add()
// surface here admits either payload via a discriminated union on `name`.
// Existing implementers (server.ts buildCharacterCreationQueue, the test
// spies) forward through to BullMQ's `Queue.add()`, which already accepts
// arbitrary job-data shapes — the narrowing here is purely the route
// plugin's compile-time contract.
export type CharacterCreationJobData =
  | { campaignId: string; userId: string }
  | { campaignId: string; ownerUserId: string }

export interface CharacterCreationQueueLike {
  add(
    name: 'character-creation' | 'character-integration',
    data: CharacterCreationJobData,
    opts?: { jobId?: string },
  ): Promise<unknown>
  /** Task 9 (llm-outage-resilience §3.2): the campaigns resume arm checks job
   *  existence before re-adding (see CharacterCreationResumeQueueLike). The
   *  JobLike slice mirrors WorldGenJobLike. */
  getJob(jobId: string): Promise<{
    isCompleted(): Promise<boolean> | boolean
    isFailed(): Promise<boolean> | boolean
  } | null | undefined>
}

export interface Opts {
  readonly pool: Pool
  // Explicit `| undefined` rather than `?:` so app.ts can pass the value
  // through unconditionally without a conditional-spread branch (and we
  // don't need a buildApp test specifically for the no-queue boot path).
  readonly characterCreationQueue: CharacterCreationQueueLike | undefined
}

// Composes the per-player character-creation route modules. Registering each
// as a nested plugin keeps route registration encapsulation-neutral (routes
// are global to the instance; there are no shared decorators/hooks to leak),
// so behavior is identical to the former single-plugin file.
export const campaignCharactersPlugin: FastifyPluginAsync<Opts> = async (app, opts) => {
  await app.register(campaignSetupRoutes, opts)
  await app.register(characterConceptRoutes, opts)
  await app.register(characterRosterRoutes, opts)
  await app.register(worldReadRoutes, opts)
  await app.register(campaignLifecycleRoutes, opts)
}
