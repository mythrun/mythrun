// Row types match the camelCase TS surface. snake_case DbRow types live in
// mappers.ts where the conversion happens. Identity fields (cognitoSub on
// User; etc.) are never part of Update types — see the spec §4.4.

export interface User {
  readonly id: string
  readonly cognitoSub: string
  readonly username: string
  readonly displayName: string
  readonly stripeCustomerId: string | null
  readonly freeTrialUsed: boolean
  readonly suspendedAt: Date | null
  readonly createdAt: Date
  readonly updatedAt: Date
}

export interface CreateUserInput {
  readonly cognitoSub: string
  readonly username: string
  readonly displayName: string
}

// Spelled-out (not Partial<Pick<...>>) so exactOptionalPropertyTypes
// behavior is intentional. Each key omitted → field unchanged. For
// nullable columns, the spec's COALESCE pattern means null in the
// patch ALSO means "unchanged" (it's the sentinel for "no update").
// Clearing nullable fields is out of scope; spec §4.4 documents the
// limitation.
export interface UserUpdate {
  readonly username?: string
  readonly displayName?: string
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
  readonly isDemo: boolean
  /**
   * myth-exac: dev-tool flag. When true (set on dev-tool-created worlds
   * only), the world-snapshot endpoint widens the access-level filter to
   * include `discoverable` + `secret` tiers — but ONLY when the requester
   * is also in bypass-auth (defense in depth). Production worlds default
   * to false; the flag is migration-014-pinned NOT NULL DEFAULT false.
   */
  readonly devBypassAccessFilter: boolean
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
  readonly status: 'setup' | 'active' | 'archived' | 'failed'
  readonly language: string
  readonly createdAt: Date
  readonly updatedAt: Date
}

export interface CreateCampaignInput {
  readonly worldId: string
  readonly createdBy: string
  readonly name: string
  readonly sourceWorldId?: string | null
  readonly status?: 'setup' | 'active' | 'archived' | 'failed'
  readonly language?: string
}

export interface CampaignUpdate {
  readonly name?: string
  readonly status?: 'setup' | 'active' | 'archived' | 'failed'
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
  /** MYT-74a §4 (migration 027): set once by the reconcile commit's
   *  conditional-update mutex (`markReconciled`); null until reconciled. */
  readonly reconciledAt: Date | null
}

export interface CreateSessionInput {
  /** Optional caller-supplied primary key. The MYT-65 /start route generates
   *  the id UP FRONT so the credit debit's idempotency sourceId (= sessionId)
   *  is known before the INSERT (atomicity ordering). Omitted → the repo
   *  mints a uuidv7. */
  readonly id?: string
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

// ─── Session Usage (MYT-43) ──────────────────────────────────────────────────

export interface SessionUsage {
  readonly id: string
  readonly sessionId: string
  readonly campaignId: string
  readonly userId: string
  readonly inputTokens: number
  readonly outputTokens: number
  readonly cacheWriteTokens: number
  readonly cacheReadTokens: number
  readonly estimatedCostUsd: number
  readonly createdAt: Date
}

// ─── Session Participants (MYT-65) ───────────────────────────────────────────
// Who is connected to a live session. A WS client join writes a row; a
// disconnect removes it. character_id is resolved server-side from the
// joiner's integrated character in the campaign — never supplied by the
// client (the schema's NOT NULL FK→characters enforces this).

export interface SessionParticipant {
  readonly id: string
  readonly sessionId: string
  readonly userId: string
  readonly characterId: string
  readonly joinedAt: Date
}

export interface JoinParticipantInput {
  readonly sessionId: string
  readonly campaignId: string
  readonly userId: string
}

// ─── Session Messages (MYT-65) ───────────────────────────────────────────────
// Append-only transcript of a live session. The WS chat transport persists
// every message here (persist-then-broadcast) and replays from it on
// reconnect. `seq` is a per-session monotonic counter owned by the WS route;
// UNIQUE(session_id, seq) guarantees a re-used seq fails loudly rather than
// silently corrupting replay. `userId` is null for system/DM-authored
// messages (no FK — the author may be the DM, not a user).

export interface SessionMessage {
  readonly id: string
  readonly sessionId: string
  readonly seq: number
  readonly userId: string | null
  readonly messageType: string
  readonly content: string
  readonly createdAt: Date
  /** MYT-68 §3.7 (migration 024): groups one DM turn's rows; null for player
   *  rows. turn_ordinal is the 0..n-1 in-turn order. The (turn_id, turn_ordinal)
   *  partial unique index makes the per-turn append idempotent. */
  readonly turnId: string | null
  readonly turnOrdinal: number | null
  /** MYT-74b §5 (migration 028): the originating turn-trigger kind, written onto
   *  every DM-authored row of a turn (shared, like turn_id); null for player rows
   *  + all pre-migration rows. The post-session analysis filters voice-excerpt
   *  selection on this so correction/farewell rows are structurally excluded
   *  (enforced ignorance). Closed set: explicit|solo|auto|correction|farewell. */
  readonly triggerKind: string | null
}

export interface AppendMessageInput {
  readonly sessionId: string
  readonly seq: number
  readonly userId: string | null
  readonly messageType: string
  readonly content: string
}

// ─── Credits ─────────────────────────────────────────────────────────────────

export type CreditType = 'session' | 'world_gen'

export type CreditSourceType = 'purchase' | 'subscription' | 'gift' | 'trial' | 'refund' | 'debit'

export interface CreditEntry {
  readonly id: string
  readonly userId: string
  readonly creditType: CreditType
  readonly amount: number // positive = grant, negative = debit
  readonly sourceType: CreditSourceType
  readonly sourceId: string | null
  readonly grantedAt: Date
  readonly expiresAt: Date | null
}

export interface GrantInput {
  readonly userId: string
  readonly creditType: CreditType
  readonly amount: number // must be > 0
  readonly sourceType: Exclude<CreditSourceType, 'debit'>
  readonly sourceId?: string | null
  readonly expiresAt?: Date | null
  /**
   * FK to the originating `purchases` row. Per migration 007's
   * `credit_ledger_source_link_chk`: REQUIRED when `sourceType='purchase'`,
   * MUST be NULL otherwise. Wired through to the INSERT so the §5.4.1
   * payment-mode handler can write valid à-la-carte grant rows.
   */
  readonly sourcePurchaseId?: string | null
  /**
   * FK to the originating `billing_history` row. Per migration 007's
   * `credit_ledger_source_link_chk`: REQUIRED when `sourceType` is
   * `'subscription'` or `'refund'`, MUST be NULL otherwise. Wired through
   * to the INSERT so §5.4.2 (subscription grant) + future refund-goodwill
   * handlers can write valid grant rows.
   */
  readonly sourceBillingHistoryId?: string | null
}

export interface DebitInput {
  readonly userId: string
  readonly creditType: CreditType
  readonly amount: number // must be > 0; recorded as negative in ledger
  readonly sourceId: string // REQUIRED — the per-user idempotency key
}

export interface ListEntriesOpts {
  readonly limit?: number | null // null/omit → no LIMIT clause
  readonly type?: CreditType
}

// ─── Atomic Debit / Try-Debit (MYT-43) ────────────────────────────────────────

/** Returned by `atomicDebit`. `consumedSourceType` is the source_type of
 *  the FIFO-oldest unexpired positive credit row at debit time. Under the
 *  trial/paid mutual-exclusion invariant maintained by grantInTx's auto-
 *  burn, all unexpired positive credits at any moment are the same
 *  source-type-class. The Session Runtime reads this to decide trial-mode
 *  vs full-mode. */
export interface AtomicDebitResult {
  readonly entry: CreditEntry
  readonly consumedSourceType: 'trial' | 'purchase' | 'subscription' | 'gift' | 'refund'
}

/** Returned by `tryDebitForSession`. The `ok: false` branch carries a
 *  `code: 'insufficient_credits'` discriminator + `available` and `required`
 *  amounts; the consuming HTTP route responds 402 Payment Required + this
 *  body. Other errors (UserNotFoundError, etc.) still throw. */
export type TryDebitResult =
  | { readonly ok: true; readonly consumedSourceType: AtomicDebitResult['consumedSourceType'] }
  | {
      readonly ok: false
      readonly code: 'insufficient_credits'
      readonly available: number
      readonly required: number
    }

// ─── Campaign Members ─────────────────────────────────────────────────────────

export type CampaignMemberRole = 'owner' | 'player'

export interface CampaignMember {
  readonly id: string
  readonly campaignId: string
  readonly userId: string
  readonly role: CampaignMemberRole
  readonly inviteAccepted: boolean
  readonly joinedAt: Date
}

// ─── Campaign Invites ─────────────────────────────────────────────────────────

export interface CampaignInvite {
  readonly id: string
  readonly campaignId: string
  readonly createdBy: string
  readonly inviteCode: string
  readonly maxUses: number | null
  readonly uses: number
  readonly expiresAt: Date | null
  readonly createdAt: Date
  readonly primary: boolean
}

export interface CampaignInvitePreview {
  readonly campaignName: string
  readonly ownerUsername: string
  readonly ownerDisplayName: string
  readonly valid: boolean
}

export interface CreateInviteInput {
  readonly campaignId: string
  readonly createdBy: string
}

export interface Character {
  readonly id: string
  readonly userId: string
  readonly entityId: string | null
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
  readonly hitPoints: number
  readonly maxHitPoints: number
  readonly armorClass: number
  readonly proficiencyBonus: number
  readonly createdAt: Date
  readonly updatedAt: Date
}

export interface CreateCharacterInput {
  readonly userId: string
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
  readonly hitPoints: number
  readonly maxHitPoints: number
  readonly armorClass: number
  readonly proficiencyBonus: number
}

export interface CampaignCharacter {
  readonly id: string
  readonly campaignId: string
  readonly characterId: string
  readonly userId: string
  readonly joinedAt: Date
}

// ─── Session Preps (MYT-61) ────────────────────────────────────────────────────
// Named SessionPrepRow (not SessionPrep) to avoid clashing with the Zod
// LLM-output type exported from src/llm/prep/stages/session-prep.ts.
export interface SessionPrepRow {
  readonly id: string
  readonly campaignId: string
  readonly sessionNumber: number
  readonly ftContext: string
  readonly sdPlaybook: string
  /** Player-facing DM introduction (MYT-101), tripwire-vetted at generation.
   *  NULL on pre-MYT-101 rows — /start fails soft (silent start + WARN). */
  readonly opening: string | null
  readonly snapshotId: string | null
  readonly createdAt: Date
}
