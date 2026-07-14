import type { CampaignSummary } from '@mythrun/client-core'

// The pure routing decision (spec §3.3). Extracted from the character surface so it
// stays a single, exhaustively unit-testable function with no React/endpoint deps.

export type CharacterRouteKind =
  | 'situation'
  | 'level'
  | 'create'
  | 'hold'
  | 'loading'
  | 'reveal'
  | 'staging'
  | 'failure-concept'
  | 'failure-integration'
  | 'play'

export interface CharacterRouteSignals {
  /** `campaigns.status`. */
  readonly campaignStatus: CampaignSummary['status']
  /** `CampaignSummary.creator === null` ⟹ owner. */
  readonly isOwner: boolean
  /** `starting_situation_index` is set. */
  readonly situationChosen: boolean
  /** `starting_level` is set. */
  readonly levelSet: boolean
  /** The viewer's own concept status — `'none'` when they have no row yet. */
  readonly conceptStatus: string
  /** The viewer's own `confirmed_at` is set ("This is me"). */
  readonly confirmed: boolean
}

/** Map the three viewer-relative signals to a screen, per the §3.3 table. Terminal
 *  gates (campaign failed → integration-failure; active/integrated → play) win over
 *  the setup branches; within `setup` the owner's situation→level beats gate the
 *  per-concept states. A `submitted` (freshly resubmittable) row buckets with `none`
 *  → create; every unknown status falls to create too (safe default). */
export function deriveCharacterRoute(s: CharacterRouteSignals): CharacterRouteKind {
  if (s.campaignStatus === 'failed') return 'failure-integration'
  if (s.campaignStatus === 'active' || s.conceptStatus === 'integrated') return 'play'
  // campaign 'setup' (or 'archived' — a fallback that never enters creation).
  if (!s.situationChosen) return s.isOwner ? 'situation' : 'hold'
  if (!s.levelSet) return s.isOwner ? 'level' : 'hold'
  switch (s.conceptStatus) {
    case 'processing':
      return 'loading'
    case 'failed':
      return 'failure-concept'
    case 'completed':
      return s.confirmed ? 'staging' : 'reveal'
    case 'none':
    case 'submitted':
    default:
      return 'create'
  }
}
