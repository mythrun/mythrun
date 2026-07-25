import type { Meta, StoryObj } from '@storybook/react-vite'
import { Divider } from './Divider.tsx'

// Divider — a 1px decorative rule that separates content. Uses the quiet
// decorative --border token (sub-3:1 by design — it is chrome, not a control
// boundary; controls use --border-strong). Carries role="separator" with the
// matching aria-orientation, so assistive tech announces the break.

const meta: Meta<typeof Divider> = {
  title: 'Layout/Divider',
  component: Divider,
  tags: ['autodocs'],
  argTypes: {
    orientation: { control: 'inline-radio', options: ['horizontal', 'vertical'] },
    tone: { control: 'inline-radio', options: ['border', 'strong', 'ink'] },
  },
}

// eslint-disable-next-line no-restricted-syntax -- Storybook CSF requires the meta object as the module's default export.
export default meta

type Story = StoryObj<typeof Divider>

export const Horizontal: Story = {
  args: { orientation: 'horizontal' },
  render: (args) => (
    <div className="w-80">
      <p className="font-ui text-sm text-ink">Above the rule</p>
      <div className="py-[var(--space-3)]">
        <Divider {...args} />
      </div>
      <p className="font-ui text-sm text-ink">Below the rule</p>
    </div>
  ),
}

export const Vertical: Story = {
  args: { orientation: 'vertical' },
  render: (args) => (
    <div className="flex h-8 items-center gap-[var(--space-3)]">
      <span className="font-ui text-sm text-ink">Left</span>
      <Divider {...args} />
      <span className="font-ui text-sm text-ink">Right</span>
    </div>
  ),
}

// tone="strong" — the interactive-grade mid step: a rule that reads as PRESENT
// (a stepper's pending segment) without the completed-ink weight.
export const Strong: Story = {
  name: 'Tone · strong (pending segment)',
  args: { orientation: 'horizontal', tone: 'strong' },
}

// tone="ink" — the structural INK seam (dark paper-900 pigment), for a deliberate
// cut like a cover→body boundary. Unlike the soft default hairline it stays a dark
// line in dark mode too (toggle the toolbar theme). Shown over both surface tiers.
export const Ink: Story = {
  name: 'Tone · ink (structural seam)',
  args: { orientation: 'horizontal', tone: 'ink' },
  render: (args) => (
    <div className="w-80">
      <p className="font-ui text-sm text-ink">Cover</p>
      <div className="py-[var(--space-3)]">
        <Divider {...args} />
      </div>
      <p className="font-ui text-sm text-ink">Body</p>
    </div>
  ),
}
