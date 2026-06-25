import type { Meta, StoryObj } from '@storybook/react-vite'
import { ScreenHarness, expectScreen } from '../storybook/screen-harness.tsx'

const meta: Meta<typeof ScreenHarness> = {
  title: 'Screens/NotFound',
  component: ScreenHarness,
  parameters: { layout: 'fullscreen', a11y: { test: 'off' } },
}
// eslint-disable-next-line no-restricted-syntax -- Storybook CSF requires the meta object as the module's default export.
export default meta
type Story = StoryObj<typeof ScreenHarness>

export const Dithered: Story = {
  name: '404 · dithered dead end',
  render: () => <ScreenHarness entry="/no-such-path" session="ready" />,
  play: expectScreen('not-found'),
}
