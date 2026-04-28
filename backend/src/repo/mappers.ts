import type { Campaign, Session, User, World } from './types.js'

// ─── DB row interfaces (snake_case, exactly as Postgres returns) ─────────────

export interface UserDbRow {
  readonly id: string
  readonly cognito_sub: string
  readonly email: string
  readonly display_name: string
  readonly username: string
  readonly avatar_url: string | null
  readonly auth_provider: string
  readonly stripe_customer_id: string | null
  readonly free_trial_used: boolean
  readonly suspended_at: Date | null
  readonly created_at: Date
  readonly updated_at: Date
}

export interface WorldDbRow {
  readonly id: string
  readonly created_by: string
  readonly source_world_id: string | null
  readonly name: string
  readonly concept: string
  readonly tone: string | null
  readonly themes: string | null
  readonly geography_summary: string | null
  readonly political_summary: string | null
  readonly era: string | null
  readonly key_tensions: string | null
  readonly world_overview: string | null
  readonly follow_up_questions: string | null
  readonly starting_situations: string | null
  readonly is_public: boolean
  readonly fork_count: number
  readonly status: string
  readonly language: string
  readonly moderation_status: string
  readonly created_at: Date
  readonly updated_at: Date
}

export interface CampaignDbRow {
  readonly id: string
  readonly world_id: string
  readonly source_world_id: string | null
  readonly created_by: string
  readonly name: string
  readonly status: string
  readonly language: string
  readonly created_at: Date
  readonly updated_at: Date
}

export interface SessionDbRow {
  readonly id: string
  readonly campaign_id: string
  readonly session_number: number
  readonly status: string
  readonly started_at: Date
  readonly ended_at: Date | null
  readonly summary: string | null
  readonly st_running_summary: string | null
  readonly handoff: string | null
}

// ─── Narrowing helpers ─────────────────────────────────────────────────────────
//
// CHECK constraints in the schema guarantee these column values are within
// known sets, but the helpers throw loudly if a future migration adds an
// option without updating the TS types. Defense in depth.

function toAuthProvider(v: string): 'google' | 'discord' {
  if (v !== 'google' && v !== 'discord') {
    throw new Error(`unexpected auth_provider value from DB: ${v}`)
  }
  return v
}

function toWorldStatus(v: string): 'generating' | 'complete' | 'failed' {
  if (v !== 'generating' && v !== 'complete' && v !== 'failed') {
    throw new Error(`unexpected world status value from DB: ${v}`)
  }
  return v
}

function toModerationStatus(v: string): 'unreviewed' | 'approved' | 'flagged' | 'removed' {
  if (v !== 'unreviewed' && v !== 'approved' && v !== 'flagged' && v !== 'removed') {
    throw new Error(`unexpected moderation_status value from DB: ${v}`)
  }
  return v
}

function toCampaignStatus(v: string): 'setup' | 'active' | 'archived' {
  if (v !== 'setup' && v !== 'active' && v !== 'archived') {
    throw new Error(`unexpected campaign status value from DB: ${v}`)
  }
  return v
}

function toSessionStatus(v: string): 'active' | 'ended' | 'crashed' {
  if (v !== 'active' && v !== 'ended' && v !== 'crashed') {
    throw new Error(`unexpected session status value from DB: ${v}`)
  }
  return v
}

// ─── Row mappers ──────────────────────────────────────────────────────────────

export function toUser(row: UserDbRow): User {
  return {
    id: row.id,
    cognitoSub: row.cognito_sub,
    email: row.email,
    displayName: row.display_name,
    username: row.username,
    avatarUrl: row.avatar_url,
    authProvider: toAuthProvider(row.auth_provider),
    stripeCustomerId: row.stripe_customer_id,
    freeTrialUsed: row.free_trial_used,
    suspendedAt: row.suspended_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

export function toWorld(row: WorldDbRow): World {
  return {
    id: row.id,
    createdBy: row.created_by,
    sourceWorldId: row.source_world_id,
    name: row.name,
    concept: row.concept,
    tone: row.tone,
    themes: row.themes,
    geographySummary: row.geography_summary,
    politicalSummary: row.political_summary,
    era: row.era,
    keyTensions: row.key_tensions,
    worldOverview: row.world_overview,
    followUpQuestions: row.follow_up_questions,
    startingSituations: row.starting_situations,
    isPublic: row.is_public,
    forkCount: row.fork_count,
    status: toWorldStatus(row.status),
    language: row.language,
    moderationStatus: toModerationStatus(row.moderation_status),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

export function toCampaign(row: CampaignDbRow): Campaign {
  return {
    id: row.id,
    worldId: row.world_id,
    sourceWorldId: row.source_world_id,
    createdBy: row.created_by,
    name: row.name,
    status: toCampaignStatus(row.status),
    language: row.language,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

export function toSession(row: SessionDbRow): Session {
  return {
    id: row.id,
    campaignId: row.campaign_id,
    sessionNumber: row.session_number,
    status: toSessionStatus(row.status),
    startedAt: row.started_at,
    endedAt: row.ended_at,
    summary: row.summary,
    stRunningSummary: row.st_running_summary,
    handoff: row.handoff,
  }
}
