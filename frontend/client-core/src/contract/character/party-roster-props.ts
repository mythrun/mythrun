import type { RosterMember } from './types.ts'

// PartyRoster (MYT-90) — the party-finalize roster: the members and their creation
// state, plus the owner-only "begin the adventure" finalize control and the invite
// action. The live join + invite-link plumbing is MYT-91; this is the roster shell +
// the finalize control. Platform-neutral (§9): `onBegin`/`onInvite` are plain
// callbacks, never DOM events; owner-gating + begin-readiness arrive as booleans.

/** Props for the party-finalize roster. */
export interface PartyRosterProps {
  /** The party members, in display order. */
  members: RosterMember[]
  /** Whether the viewer owns the campaign (only the owner sees the begin control). */
  viewerIsOwner: boolean
  /** Whether the party is finalizable now (every member ready, or a solo owner). */
  canBegin: boolean
  /** Fire the character-integration finalize pass and enter the opening scene. */
  onBegin: () => void
  /** Open the invite flow (share a join link). */
  onInvite: () => void
}
