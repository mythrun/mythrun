import type { Meta, StoryObj } from '@storybook/react-vite'
import type { SessionRecap } from '@mythrun/client-core'
import { RecapView, type RecapIdentity } from './recap.tsx'

// The post-play session recap (myth-lhp99, reshaped by ux-run2 myth-r6b2p /
// myth-3lgh5 / myth-8x3uh into a durable document: identity header, paragraph
// beats, numbered thread index, quiet exits, receipt footnote). These specimens
// render the PURE RecapView over fixture rows — the fetching route (RecapData)
// wraps it in the app; here we show the three states the analysis read produces.
// Sample copy is realistic (stories are i18n-exempt); the real strings resolve
// route-side via i18n.

const LABELS = {
  title: 'The session ends',
  sessionLabel: (n: number) => `Session ${String(n)}`,
  formatDate: (iso: string) =>
    new Intl.DateTimeFormat('en', { dateStyle: 'long' }).format(new Date(iso)),
  summaryHeading: 'What happened',
  threadsHeading: 'Threads left open',
  threadsKeep: 'The threads will keep until next session.',
  cost: 'This session used one credit.',
  pending: 'Writing up the recap…',
  waitContract: "It will be waiting on the campaign page when it's ready. You don't have to stay.",
  copyLink: 'Copy link',
  copied: 'Link copied',
  empty: 'No recap yet.',
  back: 'Back to campaign',
}

const IDENTITY: RecapIdentity = {
  campaignName: 'The Drowned Cartography',
  party: ['Sable', 'Wren'],
}

// A multi-movement session: the writer emits short paragraphs broken on beats
// (blank-line separated), and the surface renders them as the document's body.
const READY: SessionRecap = {
  sessionNumber: 3,
  endedAt: '2026-07-24T02:00:00.000Z',
  status: 'ready',
  summary: [
    'You crossed the frost-cracked plaza before dawn and traded the count’s letter for passage north. The dockmaster asked no questions, but her second did, and remembered your face.',
    'Below decks, Wren found the crate the manifest never listed. It was nailed shut from the inside.',
    'The ship cleared the harbour chain at first light. Nobody on the quay waved.',
  ].join('\n\n'),
  emergingThreads: [
    'The count still expects an answer he will not get.',
    'The dockmaster’s second knows where you are headed.',
    'The crate below decks was nailed shut from the inside.',
    'The dagger’s mark went unread; it is still in your pack.',
    'The harbour chain was raised an hour early, on someone’s order.',
  ],
}

const meta: Meta<typeof RecapView> = {
  title: 'Screens/Recap',
  component: RecapView,
  parameters: { layout: 'padded' },
}
// eslint-disable-next-line no-restricted-syntax -- Storybook CSF requires the meta object as the module's default export.
export default meta
type Story = StoryObj<typeof RecapView>

// Ready — the written document: identity header (campaign · session, record
// line), paragraph beats, the numbered thread index, quiet exits (copy link over
// the back button), and the receipt footnote below the rule.
export const Ready: Story = {
  render: () => (
    <RecapView
      recap={READY}
      identity={IDENTITY}
      labels={LABELS}
      onBack={() => undefined}
      onCopyLink={() => Promise.resolve()}
    />
  ),
}

// Pending — the just-ended beat: the cluster seats in the upper third, the wait
// makes its contract (leaving is safe), and the page below the rule is the
// document's future home while the surface polls.
export const Pending: Story = {
  render: () => (
    <RecapView
      recap={{ sessionNumber: 3, endedAt: null, status: 'pending' }}
      identity={IDENTITY}
      labels={LABELS}
      onBack={() => undefined}
      onCopyLink={() => Promise.resolve()}
    />
  ),
}

// Empty — a direct visit with no ended session to recap yet.
export const Empty: Story = {
  render: () => (
    <RecapView recap={null} identity={IDENTITY} labels={LABELS} onBack={() => undefined} />
  ),
}
