import type { Meta, StoryObj } from '@storybook/react-vite'
import { InvitePanel } from './InvitePanel.tsx'

// InvitePanel — the owner's share surface on the campaign page: one primary invite
// link plus copy / native-share / replace. Pure/presentational: these specimens
// hand it a fixed link + booleans; the real campaign page wires the callbacks +
// clipboard / navigator.share port. State reads as prose, a field, or the Banner —
// never a dot/chip (the brand rule). The interim link is a realistic sample
// (stories are lint-exempt).

const noop = (): void => undefined

const LINK = 'https://mythrun.com/join/ABC123'

// The resolved chrome copy the shell supplies (real MYT-100 campaign.invite.* copy).
const LABELS = {
  panelHeading: 'Invite',
  hint: 'Share this link · friends join your party here',
  loading: 'Preparing your invite link…',
  noLink: 'No active link, create one to invite',
  linkLabel: 'Invite link',
  create: 'Create a link',
  copy: 'Copy link',
  copied: 'Copied',
  share: 'Share',
  replace: 'Replace link',
  limit: "You've reached the invite limit. Replace the existing link instead.",
  error: 'Something went wrong. Try again.',
}

const meta: Meta<typeof InvitePanel> = {
  title: 'Invite/InvitePanel',
  component: InvitePanel,
  tags: ['autodocs'],
  args: { labels: LABELS, onCopy: noop, onShare: noop, onRevoke: noop, onCreate: noop },
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

type Story = StoryObj<typeof InvitePanel>

// Ready — a live link, native share available, nothing pending. The common owner
// view: copy, share, or replace the link.
export const Ready: Story = {
  name: 'Ready (link + copy + share)',
  args: { inviteUrl: LINK, loading: false, canShare: true, copied: false, notice: null },
}

// No native share (a desktop browser without navigator.share) — copy + replace only,
// no share affordance at all.
export const NoShare: Story = {
  name: 'No native share (copy + replace only)',
  args: { inviteUrl: LINK, loading: false, canShare: false, copied: false, notice: null },
}

// The transient copied acknowledgement — the copy control reads "Copied" while the
// route's ~2s timer runs.
export const Copied: Story = {
  name: 'Copied (transient ack)',
  args: { inviteUrl: LINK, loading: false, canShare: true, copied: true, notice: null },
}

// Loading — the primary link is still resolving; a calm line, no field or actions.
export const Loading: Story = {
  name: 'Loading (link resolving)',
  args: { inviteUrl: null, loading: true, canShare: true, copied: false, notice: null },
}

// No link — post-revoke with no fresh link yet: the panel offers to mint one.
export const NoLink: Story = {
  name: 'No link (create affordance)',
  args: { inviteUrl: null, loading: false, canShare: true, copied: false, notice: null },
}

// Cap reached — a calm warning Banner (a soft limit, not a failure); the existing
// link stays usable.
export const CapReached: Story = {
  name: 'Cap reached (calm notice)',
  args: { inviteUrl: LINK, loading: false, canShare: true, copied: false, notice: 'cap-reached' },
}

// A transient error — the danger Banner over the still-usable link.
export const ErrorNotice: Story = {
  name: 'Error (transient failure)',
  args: { inviteUrl: LINK, loading: false, canShare: true, copied: false, notice: 'error' },
}

// Mobile — the ready surface at ~375px; the link field is full-width and the action
// row wraps.
export const MobileReady: Story = {
  name: 'Mobile — ready (~375px)',
  args: { inviteUrl: LINK, loading: false, canShare: true, copied: false, notice: null },
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
