import type { Meta, StoryObj } from '@storybook/react-vite'
import { ScreenHarness, expectScreen } from '../storybook/screen-harness.tsx'

const meta: Meta<typeof ScreenHarness> = {
  title: 'Screens/Landing',
  component: ScreenHarness,
  parameters: { layout: 'fullscreen', a11y: { test: 'off' } },
}
// eslint-disable-next-line no-restricted-syntax -- Storybook CSF requires the meta object as the module's default export.
export default meta
type Story = StoryObj<typeof ScreenHarness>

// The landing is the ANONYMOUS marketing page: a signed-in (`ready`) visitor at
// `/` now redirects to `/home` (LandingRoute's authed bounce), so preview it as an
// anonymous visitor sees it — `unauthenticated` renders the landing regardless of
// the build's DEV flag (the `/?preview` dev escape hatch is DEV-only).
export const Default: Story = {
  render: () => <ScreenHarness entry="/" session="unauthenticated" />,
  play: expectScreen('route-landing'),
}
