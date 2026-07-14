import type { Meta, StoryObj } from '@storybook/react-vite'
import { ScreenHarness, expectScreen } from '../storybook/screen-harness.tsx'

// Screens/Play (MYT-92) — the live-play composition through ScreenHarness: the REAL
// route tree at the play URL, so the composition layer (the AppFrame full-bleed
// content variant the play stage lives in) is gated, not just isolated primitives.
// The harness runs a dead network, so the identity read can't resolve and the route
// lands on its calm identity hold — the render gate (route-play) still fires, proving
// the composition mounts without crashing. The play surface's own registers +
// a11y/overflow are gated by the @mythrun/ui component stories (MessageStream,
// SessionInput, DmMessage, PlayerMessage, ThinkingIndicator, SessionStartBeat).

const meta: Meta<typeof ScreenHarness> = {
  title: 'Screens/Play',
  component: ScreenHarness,
  parameters: { layout: 'fullscreen', a11y: { test: 'off' } },
}
// eslint-disable-next-line no-restricted-syntax -- Storybook CSF requires the meta object as the module's default export.
export default meta
type Story = StoryObj<typeof ScreenHarness>

export const Default: Story = {
  render: () => <ScreenHarness entry="/campaigns/c-1/play" session="ready" />,
  play: expectScreen('route-play'),
}
