import { forwardRef } from 'react'
import type { PartyRosterLabels, PartyRosterProps, RosterMember } from '@mythrun/client-core/contract'
import { cn } from '../../lib/cn.ts'
import { Button } from '../Button/Button.tsx'

// PartyRoster (MYT-90 character creation) — the party-staging surface a player
// lands on once their own character is confirmed. It lists the party (each
// member's creation state), offers the owner the Begin (finalize) control, and
// shows a member a waiting line. A real teammate who has joined but not started a
// character is `gathering` — a member row, NOT the invite affordance. The `empty`
// row IS the invite affordance: a single synthetic slot the party-staging surface
// appends when soloing (`withInviteSlot`), rendered as a dashed CTA firing
// `onInvite`. Pure/presentational — it renders from props and fires the neutral
// `onBegin`/`onInvite` callbacks; no flow/network/readiness logic (that lives in the
// client-core view-model — `viewerIsOwner`/`canBegin` arrive as already-decided
// booleans).
//
// BRAND — status is PROSE, never a dot/chip/badge (the non-negotiable rule): the
// mockup's bordered `.status` pill is deliberately NOT ported. A member's state
// reads as plain mono text — the character name (or a "choosing who they are…" /
// "just joined…" stand-in) on the sub-line, plus a terse "ready"/"creating…"/
// "gathering…" marker whose only emphasis is ink weight/ember COLOR, not a
// container. No circles/dots: the
// per-member tile is a SQUARE 1-bit hatch placeholder (no avatar), flat corners
// (`rounded-none`) everywhere.
//
// The member tile is a decorative diagonal hatch drawn with the theme-aware
// `--ink-tertiary` token (a bare `var(--…)` semantic alias that flips light/dark,
// NOT a frozen `--color-*`), on a paper (`bg-bg`) ground inside an ink-edged
// square. The empty (invite) slot drops the hatch and dashes the edge.
//
// Responsive: a plain flex column of full-width rows — each row is `flex` with a
// `min-w-0` name column (so a long name truncates rather than overflowing) and a
// `shrink-0` marker. It reads the same at a desktop measure and at ~375px; the
// consuming screen owns the max-width.
//
// COPY — the evocative display strings (the invite sub-line, the creating/gathering
// stand-ins, the waiting line, the two begin-control labels) arrive resolved via
// `labels` (MYT-100 grew the contract these props, exactly as the interim placeholder convention anticipated). The remaining terse, generic chrome the component still
// emits itself — "you", "Invite a friend"/"+ invite", and the terse status markers
// ("ready"/"creating…"/"gathering…") — is NOT part of the MYT-100 label contract and
// stays as fixed chrome.
const YOU_MARK = 'you'
const INVITE_NAME = 'Invite a friend'
const INVITE_MARK = '+ invite'

// The status a member row renders as — every real-member state (the `empty` invite
// slot renders through InviteRow, never here).
type MemberStatus = 'creating' | 'ready' | 'gathering'

// The terse status marker per state (prose, not a chip).
const STATUS_MARK: Record<MemberStatus, string> = {
  ready: 'ready',
  creating: 'creating…',
  gathering: 'gathering…',
}
// Marker emphasis is COLOR on the text itself (never a filled/bordered pill):
// ready settles to quiet secondary ink; creating draws the eye in ember; gathering
// (just joined, not yet building) sits quietest in tertiary ink.
const STATUS_TONE: Record<MemberStatus, string> = {
  ready: 'text-ink-secondary',
  creating: 'text-accent-fg',
  gathering: 'text-ink-tertiary',
}

// The decorative 1-bit hatch — a diagonal repeat in the theme-aware ink-tertiary
// token over a transparent ground (drawn on the tile's `bg-bg`). A bare `var(--…)`
// value carries no raw color, so it is token-driven, not ad-hoc (R3).
const TILE_HATCH = 'repeating-linear-gradient(45deg, var(--ink-tertiary) 0 1px, transparent 1px 5px)'

const ROOT_CLASS = 'flex min-w-0 flex-col gap-[var(--space-5)]'
// The panel eyebrow — ember mono, matching the mockup's `panelhdr`.
const PANEL_LABEL_CLASS = 'font-ui text-xs font-medium uppercase tracking-wide text-accent-fg'
// The roster list — a flat column of full-width rows.
const ROSTER_CLASS = 'flex list-none flex-col gap-[var(--space-2)] p-0'
// A member row — a flat paper card with an ink edge (SQUARE), the tile + name
// column + trailing marker on one centered line.
const MEMBER_CLASS = cn(
  'flex items-center gap-[var(--space-3)] rounded-none border border-border-strong bg-surface',
  'p-[var(--space-3)]',
)
// The square 1-bit tile — an ink-edged paper square carrying the hatch.
const TILE_CLASS = 'block size-10 flex-none rounded-none border border-border-strong bg-bg'
const TILE_EMPTY_CLASS = 'block size-10 flex-none rounded-none border border-dashed border-border bg-bg'
// The name column — grows and shrinks; the name truncates before it overflows.
const WHO_CLASS = 'flex min-w-0 flex-1 flex-col gap-[2px]'
const NAME_CLASS = 'truncate font-body text-base font-semibold leading-tight text-ink'
const YOU_CLASS = 'font-ui text-xs uppercase tracking-wide text-accent-fg'
const SUB_CLASS = 'truncate font-ui text-xs tracking-wide text-ink-tertiary'
const STATUS_CLASS = 'shrink-0 font-ui text-xs uppercase tracking-wide'
// The invite slot — the same row, dashed and interactive (a real button).
const INVITE_CLASS = cn(
  'flex w-full items-center gap-[var(--space-3)] rounded-none border border-dashed border-border bg-bg',
  'cursor-pointer p-[var(--space-3)] text-left',
  'hover:bg-surface-hover active:bg-surface-active',
  'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent-fg',
)
const INVITE_MARK_CLASS = 'shrink-0 font-ui text-xs uppercase tracking-wide text-accent-fg'
// The actions region — a column so a single Begin button stretches full-width.
const ACTIONS_CLASS = 'flex flex-col gap-[var(--space-2)]'
const WAITING_CLASS = 'font-ui text-xs uppercase tracking-wide text-ink-tertiary'

// The sub-line under a member's name: a made character shows its name; a still-
// creating member shows the "choosing…" stand-in; a just-joined (gathering) member
// shows the joined-not-started stand-in; a ready member with no name yet shows none.
function memberSubline(member: RosterMember, labels: PartyRosterLabels): string | undefined {
  if (member.characterName !== undefined) return member.characterName
  if (member.status === 'creating') return labels.creating
  if (member.status === 'gathering') return labels.gathering
  return undefined
}

// One real-member (creating/ready/gathering) row. The `empty` invite slot renders
// through InviteRow, never here.
function MemberRow({ member, labels }: { member: RosterMember; labels: PartyRosterLabels }): React.JSX.Element {
  // The invite slot is excluded upstream, so any non-`empty` status maps to its own
  // marker; a stray `empty` (defensive) settles to the quiet `ready` marker.
  const status: MemberStatus = member.status === 'empty' ? 'ready' : member.status
  const sub = memberSubline(member, labels)
  return (
    <li data-testid="party-roster-member" data-status={member.status} className={MEMBER_CLASS}>
      <span aria-hidden="true" className={TILE_CLASS} style={{ backgroundImage: TILE_HATCH }} />
      <span className={WHO_CLASS}>
        <span className={NAME_CLASS}>
          {member.displayName}
          {member.isViewer && (
            <>
              {/* eslint-disable-next-line mythrun-ui/no-untranslated-jsx-text -- interpunct separator notation, not translatable copy */}
              {' · '}
              <span data-testid="party-roster-you" className={YOU_CLASS}>
                {YOU_MARK}
              </span>
            </>
          )}
        </span>
        {sub !== undefined && <span className={SUB_CLASS}>{sub}</span>}
      </span>
      <span data-testid="party-roster-status" className={cn(STATUS_CLASS, STATUS_TONE[status])}>
        {STATUS_MARK[status]}
      </span>
    </li>
  )
}

// The invite slot — a dashed, keyboard-accessible row (a real <button>).
function InviteRow({ onInvite, inviteSub }: { onInvite: () => void; inviteSub: string }): React.JSX.Element {
  return (
    <li>
      <button type="button" data-testid="party-roster-invite" onClick={onInvite} className={INVITE_CLASS}>
        <span aria-hidden="true" className={TILE_EMPTY_CLASS} />
        <span className={WHO_CLASS}>
          <span className={NAME_CLASS}>{INVITE_NAME}</span>
          <span className={SUB_CLASS}>{inviteSub}</span>
        </span>
        <span className={INVITE_MARK_CLASS}>{INVITE_MARK}</span>
      </button>
    </li>
  )
}

export const PartyRoster = forwardRef<HTMLDivElement, PartyRosterProps>(function PartyRoster(
  { labels, members, viewerIsOwner, canBegin, onBegin, onInvite },
  ref,
) {
  // The invite slot is chrome, not a player — exclude it from the count + label
  // solo/party choice so an injected invite row never reads as a second member.
  const realCount = members.filter((m) => m.status !== 'empty').length
  const beginLabel = realCount <= 1 ? labels.beginSolo : labels.beginParty

  return (
    <div ref={ref} data-testid="party-roster" className={ROOT_CLASS}>
      <p className={PANEL_LABEL_CLASS}>
        {/* eslint-disable-next-line mythrun-ui/no-untranslated-jsx-text -- punctuation notation (count parens), not translatable copy */}
        {labels.partyHeading} ({realCount})
      </p>
      <ul className={ROSTER_CLASS}>
        {members.map((member) =>
          member.status === 'empty' ? (
            <InviteRow key={member.userId} onInvite={onInvite} inviteSub={labels.inviteSub} />
          ) : (
            <MemberRow key={member.userId} member={member} labels={labels} />
          ),
        )}
      </ul>
      <div className={ACTIONS_CLASS}>
        {viewerIsOwner ? (
          <Button variant="primary" size="lg" disabled={!canBegin} onPress={onBegin}>
            {beginLabel}
          </Button>
        ) : (
          <p data-testid="party-roster-waiting" className={WAITING_CLASS}>
            {labels.waiting}
          </p>
        )}
      </div>
    </div>
  )
})
