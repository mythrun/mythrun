import type { Meta, StoryObj } from '@storybook/react-vite'
import { expectScreen } from '../storybook/screen-harness.tsx'
import {
  BillingSurfaceSpecimen,
  NON_SUBSCRIBER_BALANCE,
  SUBSCRIBER_BALANCE,
} from '../storybook/billing-surface-specimen.tsx'

// Screens/Billing — the Sessions & Billing surface (MYT-95), at `/billing` since
// the NavBar IA rename. The surface reads three billing suspense queries, so
// (like Screens/CampaignPage) it is rendered DIRECTLY against a seeded,
// never-stale cache: the dead-API route tree would suspend those reads forever.
// The 375/1280 overflow gate measures the real composition at both breakpoints.
// NonSubscriber → every tier reads `subscribe`; Subscriber → the active tier
// reads `manage` (marked current), higher tiers `upgrade`, and NONE reads
// `subscribe` (the double-subscribe guard, spec §4). The surface reads
// `useLocation` (the #buy deep-link scroll); the specimen owns the MemoryRouter
// that satisfies it (the Screens/CampaignPage precedent).
const meta: Meta<typeof BillingSurfaceSpecimen> = {
  title: 'Screens/Billing',
  component: BillingSurfaceSpecimen,
  parameters: { layout: 'fullscreen', a11y: { test: 'off' } },
}
// eslint-disable-next-line no-restricted-syntax -- Storybook CSF requires the meta object as the module's default export.
export default meta
type Story = StoryObj<typeof BillingSurfaceSpecimen>

export const NonSubscriber: Story = {
  render: () => <BillingSurfaceSpecimen balance={NON_SUBSCRIBER_BALANCE} />,
  play: expectScreen('sessions-billing'),
}
export const Subscriber: Story = {
  render: () => <BillingSurfaceSpecimen balance={SUBSCRIBER_BALANCE} />,
  play: expectScreen('sessions-billing'),
}
