import { type Pool } from 'pg'
import { usersNs, selfManagingUsers } from './users.js'
import { worldsNs } from './worlds.js'
import { campaignsNs } from './campaigns.js'
import { sessionsNs } from './sessions.js'
import { sessionPrepsNs } from './session-preps.js'
import { creditsNs, selfManagingCredits } from './credits.js'
import { invitesNs, selfManagingInvites } from './invites.js'
import { charactersNs } from './characters.js'
import { characterConceptsNs } from './character-concepts.js'
import { entitiesNs } from './entities.js'
import { factsNs } from './facts.js'
import { proseKernelsNs } from './prose-kernels.js'
import { relationshipsNs } from './relationships.js'
import { entityHierarchyNs } from './entity-hierarchy.js'
import { statBlocksNs } from './stat-blocks.js'
import { purchasesNs } from './purchases.js'
import { userSubscriptionsNs } from './user-subscriptions.js'
import { stripeEventsNs } from './stripe-events.js'
import { billingHistoryNs } from './billing-history.js'
import { pipelineRunsNs } from './pipeline-runs.js'
import { randomTablesNs } from './random-tables.js'
import { settingsNs } from './settings.js'
import { healthNs } from './health.js'
import { worldInventoryNs } from './world-inventory.js'
import type { ClientLike } from './_types.js'
import { runTransaction, type RollbackSignal } from './_client.js'
import { type TxOpts } from '../db/transaction.js'

/**
 * Closure-bind every transaction-composable namespace over a single
 * ClientLike. `createRepo(pool)` binds the pool (the default reads + single-
 * statement-write surface); `repo.transaction` binds the in-flight tx client
 * (`runTransaction(pool, bindTx, …)`). One method body, two bindings, zero
 * per-method duplication.
 *
 * Only composable namespaces appear here. The connection-owning self-managing
 * methods (`credits.atomicDebit`/`grant`/`tryDebitForSession`,
 * `invites.create`/`acceptInvite`, `users.getByCognitoSubWithTimeout`) are
 * added ONLY on the pool surface by `createRepo` — so `TxRepo =
 * ReturnType<typeof bindTx>` mechanically excludes them. Calling
 * `tx.credits.atomicDebit` is a compile error, not a silent second-connection
 * write. (See the data-layer-repo-unification design, "Two idioms".)
 */
function bindTx(c: ClientLike) {
  return {
    users: usersNs(c),
    worlds: worldsNs(c),
    campaigns: campaignsNs(c),
    sessions: sessionsNs(c),
    sessionPreps: sessionPrepsNs(c),
    credits: creditsNs(c),
    invites: invitesNs(c),
    characters: charactersNs(c),
    characterConcepts: characterConceptsNs(c),
    // Tier-2 standalone modules (T5): delegating binders co-located in each
    // module file. All are single-statement-composable — no connection-owning
    // self-managing methods — so they bind cleanly on both pool and tx.
    entities: entitiesNs(c),
    facts: factsNs(c),
    proseKernels: proseKernelsNs(c),
    relationships: relationshipsNs(c),
    entityHierarchy: entityHierarchyNs(c),
    statBlocks: statBlocksNs(c),
    purchases: purchasesNs(c),
    userSubscriptions: userSubscriptionsNs(c),
    stripeEvents: stripeEventsNs(c),
    billingHistory: billingHistoryNs(c),
    pipelineRuns: pipelineRunsNs(c),
    randomTables: randomTablesNs(c),
    settings: settingsNs(c),
    // Liveness-probe namespace (`repo.health.ping()` → SELECT 1). Composable —
    // a single read — so it binds on both pool and tx surfaces.
    health: healthNs(c),
    // Composite multi-table read (entities + prose + facts + relationships).
    // Replaces the former `repo.pool` escape hatch used by world-dump's
    // `loadWorldInventory`: a bespoke read now homed behind the repo boundary.
    worldInventory: worldInventoryNs(c),
  }
}

/** Transaction-composable namespace surface bound to the in-flight tx client.
 *  Naturally lacks `.transaction` (added at the top level by createRepo) and
 *  the self-managing methods (added only on the pool surface). */
export type TxRepo = ReturnType<typeof bindTx>

export function createRepo(pool: Pool) {
  const base = bindTx(pool)
  return {
    ...base,
    // Pool surface = composable ∪ self-managing for the namespaces that own
    // their own connection/lock discipline.
    credits: { ...base.credits, ...selfManagingCredits(pool) },
    invites: { ...base.invites, ...selfManagingInvites(pool) },
    users: { ...base.users, ...selfManagingUsers(pool) },
    transaction: <T>(
      fn: (tx: TxRepo) => Promise<T | RollbackSignal>,
      opts?: TxOpts,
    ): Promise<T | RollbackSignal> => runTransaction(pool, bindTx, fn, opts),
  }
}

export type Repo = ReturnType<typeof createRepo>

export { ROLLBACK, type RollbackSignal, expectCommitted } from './_client.js'
