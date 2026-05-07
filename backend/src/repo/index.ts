import { type Pool } from 'pg'
import { createUsersRepo } from './users.js'
import { createWorldsRepo } from './worlds.js'
import { createCampaignsRepo } from './campaigns.js'
import { createSessionsRepo } from './sessions.js'
import { createCreditsRepo } from './credits.js'
import { createInvitesRepo } from './invites.js'

export function createRepo(pool: Pool) {
  return {
    users: createUsersRepo(pool),
    worlds: createWorldsRepo(pool),
    campaigns: createCampaignsRepo(pool),
    sessions: createSessionsRepo(pool),
    credits: createCreditsRepo(pool),
    invites: createInvitesRepo(pool),
  }
}

export type Repo = ReturnType<typeof createRepo>
