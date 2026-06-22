import type { Meta, StoryObj } from '@storybook/react-vite'
import { Box } from './Box.tsx'

// Box — the generic surface container. A token-padded panel on one of the three
// elevation surfaces (base / raised / overlay), optionally bordered with the
// interactive-grade --border-strong. The building block for cards and panels.

const meta: Meta<typeof Box> = {
  title: 'Layout/Box',
  component: Box,
  tags: ['autodocs'],
  argTypes: {
    padding: { control: 'select', options: [1, 2, 3, 4, 5, 6, 7, 8, 9] },
    surface: { control: 'inline-radio', options: ['base', 'raised', 'overlay'] },
    border: { control: 'boolean' },
  },
}

// eslint-disable-next-line no-restricted-syntax -- Storybook CSF requires the meta object as the module's default export.
export default meta

type Story = StoryObj<typeof Box>

export const Default: Story = {
  args: { padding: 4, surface: 'base' },
  render: (args) => (
    <Box {...args}>
      <span className="font-ui text-sm text-ink">Base surface, padding 4</span>
    </Box>
  ),
}

export const Bordered: Story = {
  args: { padding: 4, surface: 'base', border: true },
  render: (args) => (
    <Box {...args}>
      <span className="font-ui text-sm text-ink">Bordered panel</span>
    </Box>
  ),
}

export const Surfaces: Story = {
  name: 'Elevation surfaces',
  render: () => (
    <div className="flex flex-col gap-[var(--space-3)]">
      <Box padding={4} surface="base" border>
        <span className="font-ui text-sm text-ink">base · --surface</span>
      </Box>
      <Box padding={4} surface="raised" border>
        <span className="font-ui text-sm text-ink">raised · --surface-raised (popover)</span>
      </Box>
      <Box padding={4} surface="overlay" border>
        <span className="font-ui text-sm text-ink">overlay · --surface-overlay (modal)</span>
      </Box>
    </div>
  ),
}
