import type { Meta, StoryObj } from '@storybook/react-vite'
import type { SessionRecap } from '@mythrun/client-core'
import { RecapView } from './recap.tsx'

// The post-play session recap (myth-lhp99). These specimens render the PURE
// RecapView over fixture rows — the fetching route (RecapData) wraps it in the app;
// here we show the three states the analysis read produces. Sample copy is realistic
// (stories are i18n-exempt); the real strings resolve route-side via i18n.

const LABELS = {
  title: 'The session ends',
  sessionLabel: (n: number) => `Session ${String(n)}`,
  summaryHeading: 'What happened',
  threadsHeading: 'Threads left open',
  cost: 'One session credit spent.',
  pending: 'Writing up the recap…',
  empty: 'No recap yet.',
  back: 'Back to campaign',
}

const READY: SessionRecap = {
  sessionNumber: 3,
  endedAt: '2026-07-24T02:00:00.000Z',
  status: 'ready',
  summary:
    'You crossed the frost-cracked plaza before dawn and traded the count’s letter for passage north. The dockmaster asked no questions, but her second did, and remembered your face.',
  emergingThreads: [
    'The count still expects an answer he will not get.',
    'The dockmaster’s second knows where you are headed.',
    'The dagger’s mark went unread; it is still in your pack.',
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

// Ready — the written recap: session label, what happened, threads left open, the
// honest one-credit cost line, and a way back.
export const Ready: Story = {
  render: () => <RecapView recap={READY} labels={LABELS} onBack={() => undefined} />,
}

// Pending — the just-ended beat: the analysis is still being written, so the calm
// "writing up the recap" line stands in for the prose while the surface polls.
export const Pending: Story = {
  render: () => (
    <RecapView
      recap={{ sessionNumber: 3, endedAt: null, status: 'pending' }}
      labels={LABELS}
      onBack={() => undefined}
    />
  ),
}

// Empty — a direct visit with no ended session to recap yet.
export const Empty: Story = {
  render: () => <RecapView recap={null} labels={LABELS} onBack={() => undefined} />,
}
