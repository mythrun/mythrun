// Row types match the camelCase TS surface. snake_case DbRow types live in
// mappers.ts where the conversion happens. Identity fields (cognitoSub,
// email, authProvider on User; etc.) are never part of Update types — see
// the spec §4.4.

export interface User {
  readonly id: string
  readonly cognitoSub: string
  readonly email: string
  readonly displayName: string
  readonly username: string
  readonly avatarUrl: string | null
  readonly authProvider: 'google' | 'discord'
  readonly stripeCustomerId: string | null
  readonly freeTrialUsed: boolean
  readonly suspendedAt: Date | null
  readonly createdAt: Date
  readonly updatedAt: Date
}

export interface CreateUserInput {
  readonly cognitoSub: string
  readonly email: string
  readonly displayName: string
  readonly username: string
  readonly avatarUrl?: string | null
  readonly authProvider: 'google' | 'discord'
}

// Spelled-out (not Partial<Pick<...>>) so exactOptionalPropertyTypes
// behavior is intentional. Each key omitted → field unchanged. For
// nullable columns, the spec's COALESCE pattern means null in the
// patch ALSO means "unchanged" (it's the sentinel for "no update").
// Clearing nullable fields is out of scope; spec §4.4 documents the
// limitation.
export interface UserUpdate {
  readonly displayName?: string
  readonly username?: string
  readonly avatarUrl?: string | null
  readonly stripeCustomerId?: string | null
  readonly freeTrialUsed?: boolean
}

export interface World {
  readonly id: string
  readonly createdBy: string
  readonly sourceWorldId: string | null
  readonly name: string
  readonly concept: string
  readonly tone: string | null
  readonly themes: string | null
  readonly geographySummary: string | null
  readonly politicalSummary: string | null
  readonly era: string | null
  readonly keyTensions: string | null
  readonly worldOverview: string | null
  readonly followUpQuestions: string | null
  readonly startingSituations: string | null
  readonly isPublic: boolean
  readonly forkCount: number
  readonly status: 'generating' | 'complete' | 'failed'
  readonly language: string
  readonly moderationStatus: 'unreviewed' | 'approved' | 'flagged' | 'removed'
  readonly createdAt: Date
  readonly updatedAt: Date
}

export interface CreateWorldInput {
  readonly createdBy: string
  readonly name: string
  readonly concept: string
  readonly sourceWorldId?: string | null
  readonly tone?: string | null
  readonly themes?: string | null
  readonly geographySummary?: string | null
  readonly politicalSummary?: string | null
  readonly era?: string | null
  readonly keyTensions?: string | null
  readonly worldOverview?: string | null
  readonly followUpQuestions?: string | null
  readonly startingSituations?: string | null
  readonly isPublic?: boolean
  readonly status?: 'generating' | 'complete' | 'failed'
  readonly language?: string
}

export interface WorldUpdate {
  readonly name?: string
  readonly concept?: string
  readonly tone?: string | null
  readonly themes?: string | null
  readonly geographySummary?: string | null
  readonly politicalSummary?: string | null
  readonly era?: string | null
  readonly keyTensions?: string | null
  readonly worldOverview?: string | null
  readonly followUpQuestions?: string | null
  readonly startingSituations?: string | null
  readonly isPublic?: boolean
  readonly moderationStatus?: 'unreviewed' | 'approved' | 'flagged' | 'removed'
  readonly language?: string
}

export interface Campaign {
  readonly id: string
  readonly worldId: string
  readonly sourceWorldId: string | null
  readonly createdBy: string
  readonly name: string
  readonly status: 'setup' | 'active' | 'archived'
  readonly language: string
  readonly createdAt: Date
  readonly updatedAt: Date
}

export interface CreateCampaignInput {
  readonly worldId: string
  readonly createdBy: string
  readonly name: string
  readonly sourceWorldId?: string | null
  readonly status?: 'setup' | 'active' | 'archived'
  readonly language?: string
}

export interface CampaignUpdate {
  readonly name?: string
  readonly status?: 'setup' | 'active' | 'archived'
  readonly language?: string
}

export interface Session {
  readonly id: string
  readonly campaignId: string
  readonly sessionNumber: number
  readonly status: 'active' | 'ended' | 'crashed'
  readonly startedAt: Date
  readonly endedAt: Date | null
  readonly summary: string | null
  readonly stRunningSummary: string | null
  readonly handoff: string | null
}

export interface CreateSessionInput {
  readonly campaignId: string
  readonly sessionNumber: number
  readonly status?: 'active' | 'ended' | 'crashed'
}

export interface SessionUpdate {
  readonly status?: 'active' | 'ended' | 'crashed'
  readonly endedAt?: Date | null
  readonly summary?: string | null
  readonly stRunningSummary?: string | null
  readonly handoff?: string | null
}

// ─── Credits ─────────────────────────────────────────────────────────────────

export type CreditType = 'session' | 'world_gen'

export type CreditSourceType =
  | 'purchase'
  | 'subscription'
  | 'gift'
  | 'trial'
  | 'refund'
  | 'debit'

export interface CreditEntry {
  readonly id: string
  readonly userId: string
  readonly creditType: CreditType
  readonly amount: number              // positive = grant, negative = debit
  readonly sourceType: CreditSourceType
  readonly sourceId: string | null
  readonly grantedAt: Date
  readonly expiresAt: Date | null
}

export interface GrantInput {
  readonly userId: string
  readonly creditType: CreditType
  readonly amount: number              // must be > 0
  readonly sourceType: Exclude<CreditSourceType, 'debit'>
  readonly sourceId?: string | null
  readonly expiresAt?: Date | null
}

export interface DebitInput {
  readonly userId: string
  readonly creditType: CreditType
  readonly amount: number              // must be > 0; recorded as negative in ledger
  readonly sourceId: string            // REQUIRED — the per-user idempotency key
}

export interface ListEntriesOpts {
  readonly limit?: number | null       // null/omit → no LIMIT clause
  readonly type?: CreditType
}
