import type { Meta, StoryObj } from '@storybook/react-vite'
import { Stack } from './Stack.tsx'

// Stack — the flex layout primitive. Composes a one-axis arrangement with a
// token-spaced gap and main/cross-axis alignment. Use it instead of raw flex
// utilities so spacing stays on the --space scale and the layout ports to native.

const meta: Meta<typeof Stack> = {
  title: 'Layout/Stack',
  component: Stack,
  tags: ['autodocs'],
  argTypes: {
    direction: { control: 'inline-radio', options: ['row', 'column'] },
    gap: { control: 'select', options: [1, 2, 3, 4, 5, 6, 7, 8, 9] },
    align: { control: 'select', options: ['start', 'center', 'end', 'stretch'] },
    justify: { control: 'select', options: ['start', 'center', 'end', 'between'] },
  },
}

// eslint-disable-next-line no-restricted-syntax -- Storybook CSF requires the meta object as the module's default export.
export default meta

type Story = StoryObj<typeof Stack>

// A few demo cells so the gap + alignment are visible against the surface.
function Cell({ label }: { readonly label: string }): React.JSX.Element {
  return (
    <div className="bg-surface border border-border-strong px-[var(--space-4)] py-[var(--space-2)] font-ui text-sm text-ink">
      {label}
    </div>
  )
}

export const Vertical: Story = {
  args: { gap: 3 },
  render: (args) => (
    <Stack {...args}>
      <Cell label="One" />
      <Cell label="Two" />
      <Cell label="Three" />
    </Stack>
  ),
}

export const Horizontal: Story = {
  args: { direction: 'row', gap: 3 },
  render: (args) => (
    <Stack {...args}>
      <Cell label="One" />
      <Cell label="Two" />
      <Cell label="Three" />
    </Stack>
  ),
}

export const SpacedBetween: Story = {
  name: 'Row · justify between',
  args: { direction: 'row', justify: 'between' },
  render: (args) => (
    <div className="w-96">
      <Stack {...args}>
        <Cell label="Left" />
        <Cell label="Right" />
      </Stack>
    </div>
  ),
}

export const CenterAligned: Story = {
  name: 'Column · align center',
  args: { align: 'center', gap: 4 },
  render: (args) => (
    <Stack {...args}>
      <Cell label="Short" />
      <Cell label="A longer cell" />
    </Stack>
  ),
}
