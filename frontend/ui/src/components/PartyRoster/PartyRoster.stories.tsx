import type { Meta, StoryObj } from '@storybook/react-vite'
import type { RosterMember } from '@mythrun/client-core/contract'
import { PartyRoster } from './PartyRoster.tsx'

// PartyRoster — the party-staging surface a player reaches once their character
// is confirmed. The owner sees the roster + the Begin (finalize) control; a member
// sees a waiting line. Solo (one member + the invite slot) is the common launch
// case. Pure/presentational: these specimens hand it fixed `members` snapshots +
// booleans; the real screen wires the callbacks + readiness from the client-core
// view-model. Member names/character names are realistic samples (stories are
// lint-exempt); status reads as PROSE, never a dot/chip (the brand rule).

const noop = (): void => undefined

// The resolved chrome labels the shell supplies (real MYT-100 copy).
const LABELS = {
  partyHeading: 'Your party',
  inviteSub: 'share a link · they join here',
  creating: 'choosing who they are…',
  gathering: 'just joined, making their character…',
  waiting: 'waiting for the party to gather…',
  beginSolo: 'begin the adventure →',
  beginParty: "everyone's ready, begin →",
}

// Solo — the viewer is the only real member; the `empty` slot is the invite row.
const SOLO: RosterMember[] = [
  { userId: 'u1', displayName: 'Miklos', characterName: 'Kessa Vurm — Human Fighter', status: 'ready', isViewer: true },
  { userId: 'invite', displayName: '', status: 'empty', isViewer: false },
]

// A full party with a laggard — two ready, one still creating (no character name
// yet → the "choosing who they are…" stand-in). The owner can begin now or wait.
const PARTY: RosterMember[] = [
  { userId: 'u1', displayName: 'Miklos', characterName: 'Kessa Vurm — Human Fighter', status: 'ready', isViewer: true },
  { userId: 'u2', displayName: 'Ordric', characterName: 'Ordric Vane — Elf Wizard', status: 'ready', isViewer: false },
  { userId: 'u3', displayName: 'Pell', status: 'creating', isViewer: false },
]

// A just-joined teammate — the owner is ready and Bree has joined via an invite but
// hasn't started her character yet (`gathering`). She reads as a real member row
// (the "just joined…" stand-in), NOT the dashed invite slot, and no synthetic invite
// row appears (the party is now 2 real members).
const GATHERING: RosterMember[] = [
  { userId: 'u1', displayName: 'Miklos', characterName: 'Kessa Vurm — Human Fighter', status: 'ready', isViewer: true },
  { userId: 'u2', displayName: 'Bree', status: 'gathering', isViewer: false },
]

const meta: Meta<typeof PartyRoster> = {
  title: 'Character/PartyRoster',
  component: PartyRoster,
  tags: ['autodocs'],
  args: { labels: LABELS, onBegin: noop, onInvite: noop },
  // A paper page ground + a reading measure (the consuming screen owns the width).
  decorators: [
    (Story) => (
      <div className="bg-bg p-[var(--space-6)]">
        <div className="mx-auto max-w-[520px]">
          <Story />
        </div>
      </div>
    ),
  ],
}

// eslint-disable-next-line no-restricted-syntax -- Storybook CSF requires the meta object as the module's default export.
export default meta

type Story = StoryObj<typeof PartyRoster>

// Solo owner — one member + the dashed invite slot, the solo Begin label enabled.
export const SoloOwner: Story = {
  name: 'Solo owner (the common launch case)',
  args: { members: SOLO, viewerIsOwner: true, canBegin: true },
}

// Full party, owner view — two ready + one creating; the party Begin label. The
// owner can begin now or wait for the laggard.
export const PartyOwner: Story = {
  name: 'Full party — owner (a laggard still creating)',
  args: { members: PARTY, viewerIsOwner: true, canBegin: true },
}

// Owner, not yet finalizable — the Begin control is present but disabled (the
// party isn't ready). Still the owner's view, just gated.
export const OwnerNotReady: Story = {
  name: 'Owner — begin disabled (party not ready)',
  args: { members: PARTY, viewerIsOwner: true, canBegin: false },
}

// A just-joined member — the owner (ready) plus Bree, who joined via the invite link
// but hasn't started her character (`gathering`). She renders as a real member row,
// never the invite affordance; the owner may begin (their own concept is ready).
export const PartyWithGatheringMember: Story = {
  name: 'Party — a just-joined member gathering',
  args: { members: GATHERING, viewerIsOwner: true, canBegin: true },
}

// Member (non-owner) view — no Begin control; a waiting line instead.
export const MemberWaiting: Story = {
  name: 'Member (non-owner) — waiting line',
  args: { members: PARTY, viewerIsOwner: false, canBegin: false },
}

// Mobile — the solo owner surface at ~375px; rows + the full-width Begin hold.
export const MobileSolo: Story = {
  name: 'Mobile — solo owner (~375px)',
  args: { members: SOLO, viewerIsOwner: true, canBegin: true },
  decorators: [
    (Story) => (
      <div className="bg-bg p-[var(--space-4)]">
        <div className="mx-auto max-w-[375px]">
          <Story />
        </div>
      </div>
    ),
  ],
}
