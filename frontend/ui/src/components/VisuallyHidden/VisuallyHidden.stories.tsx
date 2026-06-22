import type { Meta, StoryObj } from '@storybook/react-vite'
import { VisuallyHidden } from './VisuallyHidden.tsx'

// VisuallyHidden — screen-reader-only wrapper. Its children are removed from the
// visual layout but remain in the accessibility tree, so an icon-only control
// can carry a real accessible name. Nothing renders visibly; inspect the
// accessibility panel (or a screen reader) to see the label.

const meta: Meta<typeof VisuallyHidden> = {
  title: 'Typography/VisuallyHidden',
  component: VisuallyHidden,
  tags: ['autodocs'],
}

// eslint-disable-next-line no-restricted-syntax -- Storybook CSF requires the meta object as the module's default export.
export default meta

type Story = StoryObj<typeof VisuallyHidden>

export const LabellingAnIconButton: Story = {
  name: 'Labelling an icon button',
  render: () => (
    <button type="button" className="border border-border-strong p-[var(--space-2)]">
      <span aria-hidden="true">✕</span>
      <VisuallyHidden>Close dialog</VisuallyHidden>
    </button>
  ),
}
