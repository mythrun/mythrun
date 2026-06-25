import type { Meta, StoryObj } from '@storybook/react-vite'
import { ScreenHarness, expectScreen } from '../storybook/screen-harness.tsx'

const meta: Meta<typeof ScreenHarness> = {
  title: 'Screens/AppFrame',
  component: ScreenHarness,
  parameters: { layout: 'fullscreen', a11y: { test: 'off' } },
}
// eslint-disable-next-line no-restricted-syntax -- Storybook CSF requires the meta object as the module's default export.
export default meta
type Story = StoryObj<typeof ScreenHarness>

// The MYT-83 bug class: a long display name shoved the settings affordance off
// the right edge at 375px. The header must truncate to a single quiet row.
// The adversarial display name is hoisted to a module const (the home.stories
// `LONG_CAMPAIGNS` precedent) so the i18next/no-literal-string rail — which runs
// in jsx-only mode and checks JSX attribute values — doesn't flag it inline.
const LONG_DISPLAY_NAME: Readonly<Record<string, string>> = {
  'frame.displayName': 'Aldebaran Featherstonehaugh-Wintermoor, Keeper of the Long Unbroken Title',
}

export const LongDisplayName: Story = {
  name: 'App frame · long display name truncates',
  render: () => <ScreenHarness entry="/settings" session="ready" i18nOverrides={LONG_DISPLAY_NAME} />,
  play: expectScreen('app-frame'),
}
