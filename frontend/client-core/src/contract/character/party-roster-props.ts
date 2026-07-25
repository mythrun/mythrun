import type { ReactNode } from 'react'
import type { RosterMember } from './types.ts'

// PartyRoster (MYT-90) — the party-finalize roster: the members and their creation
// state, plus the owner-only "begin the adventure" finalize control and the invite
// action. The live join + invite-link plumbing is MYT-91; this is the roster shell +
// the finalize control. Platform-neutral (§9): `onBegin`/`onInvite` are plain
// callbacks, never DOM events; owner-gating + begin-readiness arrive as booleans.

/** The roster's resolved chrome labels (the shell resolves i18n and passes them). */
export interface PartyRosterLabels {
  /** The panel heading (e.g. "Your party"; the member count is appended DS-side). */
  partyHeading: string
  /** The invite slot's sub-line (e.g. "Share a link · they join here"). */
  inviteSub: string
  /** A still-creating member's stand-in sub-line (e.g. "Choosing who they are…"). */
  creating: string
  /** A just-joined member's stand-in sub-line (e.g. "Just joined, making their character…"). */
  gathering: string
  /** The non-owner's waiting line (e.g. "Waiting for the party to gather…"). */
  waiting: string
  /** The owner's begin control when soloing (e.g. "Begin the adventure →"). */
  beginSolo: string
  /** The owner's begin control with a full party (e.g. "Everyone's ready, begin →"). */
  beginParty: string
  /** The owner's begin control while some members are NOT ready — the label carries
   *  the truth instead of a silent gray-out (ux-run2 myth-wfgfi), already count-
   *  resolved by the shell (e.g. "Begin with 1 of 3 ready →"). */
  beginPartial: string
  /** The partial-begin confirm prompt (count-resolved by the shell, e.g. "Two
   *  players aren't ready. Start anyway?"). */
  beginConfirmPrompt: string
  /** The partial-begin confirm verb (e.g. "Start anyway"). */
  beginConfirmYes: string
  /** The partial-begin dismiss verb (e.g. "Keep waiting"). */
  beginConfirmNo: string
}

/** Props for the party-finalize roster. */
export interface PartyRosterProps {
  /** The resolved chrome labels (the shell resolves i18n and passes them). */
  labels: PartyRosterLabels
  /** The party members, in display order. */
  members: RosterMember[]
  /** Whether the viewer owns the campaign (only the owner sees the begin control). */
  viewerIsOwner: boolean
  /** Whether the party is finalizable now (every member ready, or a solo owner). */
  canBegin: boolean
  /** The partial-begin confirm's CONTROLLED disclosure state (ux-run2 myth-wfgfi):
   *  `true` renders the inline confirm (prompt + confirm/dismiss verbs) in place of
   *  the begin control. The parent owns it — the roster stays fully controlled. */
  beginConfirming: boolean
  /** Ask to begin while members are not ready — the parent arms the inline confirm
   *  (sets `beginConfirming`); the actual finalize fires only from `onBegin`. */
  onRequestBegin: () => void
  /** Dismiss the partial-begin confirm without beginning. */
  onCancelBegin: () => void
  /** Fire the character-integration finalize pass and enter the opening scene. */
  onBegin: () => void
  /** Toggle the invite flow (share a join link). On the staging surface this opens
   *  the inline invite disclosure below the dashed slot (progressive disclosure). */
  onInvite: () => void
  /** The invite disclosure content (MYT-99g03), rendered between the roster and the
   *  Begin control when the owner opens the dashed slot — the SINGLE invite entry
   *  point on staging (no standalone invite block above the party). Omitted/undefined
   *  keeps the slot collapsed. The consuming surface supplies the wired quiet panel. */
  inviteExpansion?: ReactNode
}
