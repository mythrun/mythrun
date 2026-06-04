import type {
  Campaign,
  CampaignCharacter,
  CampaignInvite,
  CampaignMember,
  CampaignMemberRole,
  Character,
  CreditEntry,
  CreditSourceType,
  CreditType,
  Session,
  SessionMessage,
  SessionParticipant,
  SessionUsage,
  User,
  World,
} from './types.js'

// ─── DB row interfaces (snake_case, exactly as Postgres returns) ─────────────

export interface UserDbRow {
  readonly id: string
  readonly cognito_sub: string
  readonly username: string
  readonly display_name: string
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
  readonly is_demo: boolean
  readonly dev_bypass_access_filter: boolean
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

function toCampaignStatus(v: string): 'setup' | 'active' | 'archived' | 'failed' {
  if (v !== 'setup' && v !== 'active' && v !== 'archived' && v !== 'failed') {
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
    username: row.username,
    displayName: row.display_name,
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
    isDemo: row.is_demo,
    devBypassAccessFilter: row.dev_bypass_access_filter,
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

// ─── Session Usage (MYT-43) ──────────────────────────────────────────────────

export interface SessionUsageDbRow {
  readonly id: string
  readonly session_id: string
  readonly campaign_id: string
  readonly user_id: string
  readonly input_tokens: number
  readonly output_tokens: number
  readonly cache_write_tokens: number
  readonly cache_read_tokens: number
  /** pg returns NUMERIC as a string; we Number()-cast in toSessionUsage. */
  readonly estimated_cost_usd: string
  readonly created_at: Date
}

export function toSessionUsage(row: SessionUsageDbRow): SessionUsage {
  return {
    id: row.id,
    sessionId: row.session_id,
    campaignId: row.campaign_id,
    userId: row.user_id,
    inputTokens: row.input_tokens,
    outputTokens: row.output_tokens,
    cacheWriteTokens: row.cache_write_tokens,
    cacheReadTokens: row.cache_read_tokens,
    estimatedCostUsd: Number(row.estimated_cost_usd),
    createdAt: row.created_at,
  }
}

// ─── Credits ─────────────────────────────────────────────────────────────────

export interface CreditEntryDbRow {
  readonly id: string
  readonly user_id: string
  readonly credit_type: string
  readonly amount: number
  readonly source_type: string
  readonly source_id: string | null
  readonly granted_at: Date
  readonly expires_at: Date | null
}

function toCreditType(v: string): CreditType {
  if (v !== 'session' && v !== 'world_gen') {
    throw new Error(`unexpected credit_type value from DB: ${v}`)
  }
  return v
}

function toCreditSourceType(v: string): CreditSourceType {
  if (
    v !== 'purchase' &&
    v !== 'subscription' &&
    v !== 'gift' &&
    v !== 'trial' &&
    v !== 'refund' &&
    v !== 'debit'
  ) {
    throw new Error(`unexpected source_type value from DB: ${v}`)
  }
  return v
}

export function toCreditEntry(row: CreditEntryDbRow): CreditEntry {
  return {
    id: row.id,
    userId: row.user_id,
    creditType: toCreditType(row.credit_type),
    amount: row.amount,
    sourceType: toCreditSourceType(row.source_type),
    sourceId: row.source_id,
    grantedAt: row.granted_at,
    expiresAt: row.expires_at,
  }
}

// ─── Campaign Members ─────────────────────────────────────────────────────────

export interface CampaignMemberDbRow {
  readonly id: string
  readonly campaign_id: string
  readonly user_id: string
  readonly role: string
  readonly invite_accepted: boolean
  readonly joined_at: Date
}

function toCampaignMemberRole(v: string): CampaignMemberRole {
  if (v !== 'owner' && v !== 'player') {
    throw new Error(`unexpected campaign_members.role value from DB: ${v}`)
  }
  return v
}

export function toCampaignMember(row: CampaignMemberDbRow): CampaignMember {
  return {
    id: row.id,
    campaignId: row.campaign_id,
    userId: row.user_id,
    role: toCampaignMemberRole(row.role),
    inviteAccepted: row.invite_accepted,
    joinedAt: row.joined_at,
  }
}

// ─── Campaign Invites ─────────────────────────────────────────────────────────

export interface CampaignInviteDbRow {
  readonly id: string
  readonly campaign_id: string
  readonly created_by: string
  readonly invite_code: string
  readonly max_uses: number | null
  readonly uses: number
  readonly expires_at: Date | null
  readonly created_at: Date
}

export function toCampaignInvite(row: CampaignInviteDbRow, primary: boolean): CampaignInvite {
  return {
    id: row.id,
    campaignId: row.campaign_id,
    createdBy: row.created_by,
    inviteCode: row.invite_code,
    maxUses: row.max_uses,
    uses: row.uses,
    expiresAt: row.expires_at,
    createdAt: row.created_at,
    primary,
  }
}

export interface CharacterDbRow {
  readonly id: string
  readonly user_id: string
  readonly entity_id: string | null
  readonly name: string
  readonly level: number
  readonly class: string
  readonly species: string
  readonly background: string
  readonly str: number
  readonly dex: number
  readonly con: number
  readonly int: number
  readonly wis: number
  readonly cha: number
  readonly hit_points: number
  readonly max_hit_points: number
  readonly armor_class: number
  readonly proficiency_bonus: number
  readonly created_at: Date
  readonly updated_at: Date
}

export function toCharacter(row: CharacterDbRow): Character {
  return {
    id: row.id,
    userId: row.user_id,
    entityId: row.entity_id,
    name: row.name,
    level: row.level,
    class: row.class,
    species: row.species,
    background: row.background,
    str: row.str,
    dex: row.dex,
    con: row.con,
    int: row.int,
    wis: row.wis,
    cha: row.cha,
    hitPoints: row.hit_points,
    maxHitPoints: row.max_hit_points,
    armorClass: row.armor_class,
    proficiencyBonus: row.proficiency_bonus,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

export interface CampaignCharacterDbRow {
  readonly id: string
  readonly campaign_id: string
  readonly character_id: string
  readonly user_id: string
  readonly joined_at: Date
}

export function toCampaignCharacter(row: CampaignCharacterDbRow): CampaignCharacter {
  return {
    id: row.id,
    campaignId: row.campaign_id,
    characterId: row.character_id,
    userId: row.user_id,
    joinedAt: row.joined_at,
  }
}

// ─── Session Participants (MYT-65) ───────────────────────────────────────────

export interface SessionParticipantDbRow {
  readonly id: string
  readonly session_id: string
  readonly user_id: string
  readonly character_id: string
  readonly joined_at: Date
}

export function toSessionParticipant(row: SessionParticipantDbRow): SessionParticipant {
  return {
    id: row.id,
    sessionId: row.session_id,
    userId: row.user_id,
    characterId: row.character_id,
    joinedAt: row.joined_at,
  }
}

// ─── Session Messages (MYT-65) ───────────────────────────────────────────────

export interface SessionMessageDbRow {
  readonly id: string
  readonly session_id: string
  readonly seq: number
  readonly user_id: string | null
  readonly message_type: string
  readonly content: string
  readonly created_at: Date
}

export function toSessionMessage(row: SessionMessageDbRow): SessionMessage {
  return {
    id: row.id,
    sessionId: row.session_id,
    seq: row.seq,
    userId: row.user_id,
    messageType: row.message_type,
    content: row.content,
    createdAt: row.created_at,
  }
}
