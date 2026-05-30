import { type Pool } from 'pg'
import { createUsersRepo } from './users.js'
import { createWorldsRepo } from './worlds.js'
import { createCampaignsRepo } from './campaigns.js'
import { createSessionsRepo } from './sessions.js'
import { createCreditsRepo, grantInTx } from './credits.js'
import { createInvitesRepo } from './invites.js'
import { createCharactersRepo } from './characters.js'
import { createCharacterConceptsRepo } from './character-concepts.js'
import type { ClientLike } from './_types.js'
import type { GrantInput } from './types.js'
import { runTransaction, type RollbackSignal } from './_client.js'
import { type TxOpts } from '../db/transaction.js'

// TEMPORARY bindTx — EXPANDED IN T2.
//
// The full closure binder (worlds/campaigns/credits/characters/… every
// composable namespace, each method bound over the in-flight ClientLike)
// arrives in the next task. This minimal version binds only the one
// namespace the Task-1 transaction-mechanics tests need: `credits`, with
// `getWorldGenBalance` (the pool-peek / tx-locked-reread read — identical
// SQL to repo.credits.balance(userId, 'world_gen')) and `grantInTx`
// (delegates to the existing standalone composable). T2 replaces this whole
// function with the real binder.
function bindTx(c: ClientLike) {
  return {
    credits: {
      getWorldGenBalance: async (userId: string): Promise<number> => {
        const result = await c.query<{ balance: string }>(
          `SELECT COALESCE(SUM(amount), 0)::text AS balance
             FROM credit_ledger
            WHERE user_id = $1
              AND credit_type = 'world_gen'
              AND (expires_at IS NULL OR expires_at > now())`,
          [userId],
        )
        return Number(result.rows[0]?.balance ?? 0)
      },
      grantInTx: (input: GrantInput) => grantInTx(c, input),
    },
  }
}

/** Transaction-composable namespace surface bound to the in-flight tx client.
 *  Naturally lacks `.transaction` (added at the top level) and the
 *  self-managing methods (added only on the pool surface). T2 widens this. */
export type TxRepo = ReturnType<typeof bindTx>

export function createRepo(pool: Pool) {
  return {
    users: createUsersRepo(pool),
    worlds: createWorldsRepo(pool),
    campaigns: createCampaignsRepo(pool),
    sessions: createSessionsRepo(pool),
    credits: createCreditsRepo(pool),
    invites: createInvitesRepo(pool),
    characters: createCharactersRepo(pool),
    characterConcepts: createCharacterConceptsRepo(pool),
    transaction: <T>(
      fn: (tx: TxRepo) => Promise<T | RollbackSignal>,
      opts?: TxOpts,
    ): Promise<T | RollbackSignal> => runTransaction(pool, bindTx, fn, opts),
  }
}

export type Repo = ReturnType<typeof createRepo>

export { ROLLBACK, type RollbackSignal } from './_client.js'
