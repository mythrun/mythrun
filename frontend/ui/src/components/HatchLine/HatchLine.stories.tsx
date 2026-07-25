import type { Meta, StoryObj } from '@storybook/react-vite'
import { HatchLine } from './HatchLine.tsx'

// HatchLine — the flow escape-hatch line (ux-run2 myth-vjl7d). A quiet mono
// prompt with the actionable phrase underlined in accent: the offer to leave a
// guided path, present on every step, aligned to the flow column's left edge.

const meta: Meta<typeof HatchLine> = {
  title: 'Controls/HatchLine',
  component: HatchLine,
  tags: ['autodocs'],
}

// eslint-disable-next-line no-restricted-syntax -- Storybook CSF requires the meta object as the module's default export.
export default meta

type Story = StoryObj<typeof HatchLine>

export const Default: Story = {
  args: {
    prompt: 'Feeling constrained?',
    action: 'Describe your world yourself.',
  },
}

export const AllAction: Story = {
  name: 'All-action (no prompt)',
  args: {
    action: 'Try building from things you love.',
  },
}
