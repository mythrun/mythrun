import type { Meta, StoryObj } from '@storybook/react-vite'
import { ThemeToggle } from './ThemeToggle.tsx'
import { ThemeProvider } from '../../theme/theme-provider.tsx'

// ThemeToggle — the canonical theme FAB (MYT-84). A square button with its own
// solid surface + strong border so it floats ABOVE the dither crown; the sun/moon
// glyph follows the active theme; ≥44px touch target; 0px radius. Click it to flip
// the page theme (it drives the ThemeProvider, which toggles `.dark` on <html>).
const meta: Meta<typeof ThemeToggle> = {
  title: 'Controls/ThemeToggle',
  component: ThemeToggle,
  parameters: { overflowGate: false },
  decorators: [
    (Story) => (
      <ThemeProvider>
        <Story />
      </ThemeProvider>
    ),
  ],
}
// eslint-disable-next-line no-restricted-syntax -- Storybook CSF requires the meta object as the module's default export.
export default meta
type Story = StoryObj<typeof ThemeToggle>

export const Default: Story = { args: { label: 'Theme' } }
