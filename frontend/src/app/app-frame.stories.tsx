import type { Meta, StoryObj } from '@storybook/react-vite'
import type { MeResponse } from '@mythrun/client-core'
import { ScreenHarness, expectScreen } from '../storybook/screen-harness.tsx'

const meta: Meta<typeof ScreenHarness> = {
  title: 'Screens/AppFrame',
  component: ScreenHarness,
  parameters: { layout: 'fullscreen', a11y: { test: 'off' } },
}
// eslint-disable-next-line no-restricted-syntax -- Storybook CSF requires the meta object as the module's default export.
export default meta
type Story = StoryObj<typeof ScreenHarness>

// The MYT-83 bug class: a long display name shoved the settings affordance off the
// right edge at 375px. The header must truncate to a single quiet row. The display
// name is now DATA (from `useMe()`, not an i18n key — MYT-99), so the adversarial
// name is seeded into the `['me']` cache via `seedMe`, not swapped as i18n copy.
const LONG_NAME_ME: MeResponse = {
  user: {
    id: 'dev-user-1',
    username: 'aldebaran',
    displayName: 'Aldebaran Featherstonehaugh-Wintermoor, Keeper of the Long Unbroken Title',
    freeTrialUsed: true,
    createdAt: '2026-01-01T00:00:00.000Z',
  },
}

// Hosted on the (empty) home hub — a stable authed route that always renders the
// frame — so the story isolates the HEADER's long-name behaviour: on desktop the
// name ellipsizes to a single quiet row; at 375px it collapses entirely (Show).
export const LongDisplayName: Story = {
  name: 'App frame · long display name truncates',
  render: () => <ScreenHarness entry="/home" session="ready" seedCampaigns={[]} seedMe={LONG_NAME_ME} />,
  play: expectScreen('app-frame'),
}
