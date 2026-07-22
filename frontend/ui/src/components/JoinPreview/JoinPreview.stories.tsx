import type { Meta, StoryObj } from '@storybook/react-vite'
import { JoinPreview } from './JoinPreview.tsx'

// JoinPreview — the public invite landing card on `/join/:code`. A visitor sees the
// campaign they were invited to, who invited them, and a single CTA that branches on
// whether they are signed in (accept inline vs sign in to join). Pure/presentational:
// these specimens hand it fixed props; the real route wires the preview fetch, the
// accept request, and navigation. Campaign/owner names are realistic samples (stories
// are lint-exempt). The chrome copy arrives resolved via `labels` (the DS owns no
// copy); these specimens use the real MYT-100 join.preview.* copy.

const noop = (): void => undefined

// The resolved chrome copy the shell supplies (real MYT-100 join.preview.* copy).
const LABELS = {
  eyebrow: "You've been invited",
  invitedBy: 'Invited by',
  accept: 'accept the invitation →',
  signin: 'sign in to join →',
  invalid: 'This invite is no longer valid.',
  full: 'This campaign is already full.',
  revoked: 'This invite link was turned off.',
  gone: 'This campaign is no longer available.',
  notFound: "That invite doesn't lead anywhere.",
  timeout: 'That took too long. Try again.',
  error: 'Something went wrong. Try again.',
}

const meta: Meta<typeof JoinPreview> = {
  title: 'Invite/JoinPreview',
  component: JoinPreview,
  tags: ['autodocs'],
  args: {
    labels: LABELS,
    campaignName: 'The Sunless Reach',
    ownerName: 'Miklos',
    valid: true,
    signedIn: true,
    accepting: false,
    arm: null,
    onAccept: noop,
    onSignIn: noop,
  },
  // A paper page ground the standalone receive card sits on; the route owns the
  // page frame, so the specimen just centres the card at a reading measure.
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

type Story = StoryObj<typeof JoinPreview>

// Signed-in — the common accept case: the accept CTA fires an inline join.
export const SignedIn: Story = {
  name: 'Signed in (accept inline)',
  args: { signedIn: true },
}

// Signed-out — a visitor who is not yet signed in; the CTA routes them to the
// guarded sign-in first, returning here to accept.
export const SignedOut: Story = {
  name: 'Signed out (sign in to join)',
  args: { signedIn: false },
}

// Invalid — the invite previewed but is revoked/expired (a 200 with `valid:false`),
// so the real campaign/owner still show under a calm invalid notice; no CTA.
export const Invalid: Story = {
  name: 'Invalid (revoked / expired)',
  args: { valid: false },
}

// Accepting — the signed-in accept request is in flight; the CTA is a busy,
// non-interactive spinner.
export const Accepting: Story = {
  name: 'Accepting (busy)',
  args: { signedIn: true, accepting: true },
}

// Full — a post-accept failure: the campaign filled up. The calm `info` notice
// explains it; the route decides where to send the visitor next.
export const FullNotice: Story = {
  name: 'Post-accept notice — campaign full',
  args: { signedIn: true, arm: 'full' },
}

// Revoked — a post-accept failure: the owner turned the link off between the
// preview and the accept. A calm `info` notice, again terminal for the route.
export const RevokedNotice: Story = {
  name: 'Post-accept notice — link revoked',
  args: { signedIn: true, arm: 'revoked' },
}

// Mobile — the signed-in receive card at ~375px. In `collapse` mode the card drops
// its border/surface and reads flush full-width; the serif name + CTA hold.
export const MobileSignedIn: Story = {
  name: 'Mobile — signed in (~375px)',
  args: { signedIn: true },
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
