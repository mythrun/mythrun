import type { Meta, StoryObj } from '@storybook/react-vite'
import { HorizontalLockup } from './HorizontalLockup.tsx'

// HorizontalLockup — the SECONDARY (mark-on-right) lockup: wordmark left, mark right
// (brand guidelines → "The lockups → Secondary lockup"). For wide/short headers —
// nav bars, narrow headers, email signatures. Monochrome, theme-driven via the
// `--ink` token (flips to cream on the dark field). The locked aspect is preserved
// at any `size` (the rendered height).
const meta: Meta<typeof HorizontalLockup> = {
  title: 'Brand/HorizontalLockup',
  component: HorizontalLockup,
  tags: ['autodocs'],
  argTypes: {
    size: { control: { type: 'number', min: 24, max: 160, step: 4 } },
    'aria-label': { control: 'text' },
  },
  args: { 'aria-label': 'Mythrun', size: 56 },
}

// eslint-disable-next-line no-restricted-syntax -- Storybook CSF requires the meta object as the module's default export.
export default meta

type Story = StoryObj<typeof HorizontalLockup>

export const Default: Story = {}

export const Sizes: Story = {
  render: () => (
    <div className="flex flex-col items-start gap-[var(--space-5)] text-ink">
      <HorizontalLockup aria-label="Mythrun" size={40} />
      <HorizontalLockup aria-label="Mythrun" size={56} />
      <HorizontalLockup aria-label="Mythrun" size={80} />
    </div>
  ),
}
