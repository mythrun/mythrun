// The party-finalize roster view-model (MYT-90): maps the character-creation-progress
// response into the roster rows the @mythrun/ui PartyRoster renders. It marks the
// viewer's own row, derives creating / ready / gathering status from each member's
// concept status, and orders the campaign owner (host) first — the owner may sit in
// the response's `missing[]` (not yet submitted), so ordering them first lets the
// caller read the owner's readiness off a known position when computing finalize
// eligibility (`viewerIsOwner` + the owner's own row being ready).
//
// A member in `missing[]` is `gathering` — a real joined teammate who hasn't started
// a character yet — NOT `empty` (MYT-91). `empty` is exclusively the synthetic invite
// slot the party-staging surface appends when soloing; the view-model never emits it,
// so a genuine teammate never renders as the "Invite a friend" affordance.
//
// Platform-independent BRAIN (R1): no React/DOM. Owner-finalize eligibility itself is
// the component's call (it has `viewerIsOwner`); this model just shapes the rows.

import type { RosterMember, RosterStatus } from '../contract/index.ts'

/** A member with a submitted concept (status passed through verbatim from the wire,
 *  including the post-integration `'integrated'` terminal state). */
export interface ProgressConcept {
  readonly userId: string
  readonly displayName: string
  readonly status: string
  readonly submittedAt: string
  readonly error?: unknown
}

/** A member who has not submitted a concept yet. */
export interface ProgressMissing {
  readonly userId: string
  readonly displayName: string
}

/** The GET /character-creation-progress response shape. */
export interface CharacterCreationProgress {
  readonly campaignId: string
  readonly totalMembers: number
  readonly concepts: readonly ProgressConcept[]
  readonly missing: readonly ProgressMissing[]
}

/** A finished character reads as `ready`; any in-flight concept reads as `creating`. */
function rosterStatus(conceptStatus: string): RosterStatus {
  return conceptStatus === 'completed' || conceptStatus === 'integrated' ? 'ready' : 'creating'
}

/** Stable partition placing the owner's row(s) first, preserving relative order
 *  otherwise. */
function ownerFirst(rows: readonly RosterMember[], ownerUserId: string): RosterMember[] {
  return [
    ...rows.filter((r) => r.userId === ownerUserId),
    ...rows.filter((r) => r.userId !== ownerUserId),
  ]
}

/** Map the progress response into roster rows: submitted concepts first (their
 *  derived status), then members with no concept yet (`gathering` — real joined
 *  teammates still building, never the `empty` invite slot), re-ordered so the owner
 *  leads. Each row is flagged `isViewer` for the current player. */
export function partyRosterViewModel(
  progress: CharacterCreationProgress,
  viewerUserId: string,
  ownerUserId: string,
): RosterMember[] {
  const rows: RosterMember[] = [
    ...progress.concepts.map((c) => ({
      userId: c.userId,
      displayName: c.displayName,
      status: rosterStatus(c.status),
      isViewer: c.userId === viewerUserId,
    })),
    ...progress.missing.map((m) => ({
      userId: m.userId,
      displayName: m.displayName,
      status: 'gathering' as const,
      isViewer: m.userId === viewerUserId,
    })),
  ]
  return ownerFirst(rows, ownerUserId)
}
