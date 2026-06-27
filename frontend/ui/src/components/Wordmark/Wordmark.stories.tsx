import type { Meta, StoryObj } from '@storybook/react-vite'
import { Wordmark } from './Wordmark.tsx'

// Wordmark — the "Mythrun" logotype in the locked Tyma Garamont letterforms (brand
// guidelines → "Typography"). Theme-driven via the `--ink` token (ink on the light
// field, cream on dark — toggle the Storybook theme to see it flip). The locked
// 1618:771 aspect is preserved at any `size` (the rendered height).
const meta: Meta<typeof Wordmark> = {
  title: 'Brand/Wordmark',
  component: Wordmark,
  tags: ['autodocs'],
  argTypes: {
    size: { control: { type: 'number', min: 24, max: 160, step: 4 } },
    'aria-label': { control: 'text' },
  },
  args: { 'aria-label': 'Mythrun', size: 48 },
}

// eslint-disable-next-line no-restricted-syntax -- Storybook CSF requires the meta object as the module's default export.
export default meta

type Story = StoryObj<typeof Wordmark>

export const Default: Story = {}

export const Sizes: Story = {
  render: () => (
    <div className="flex flex-wrap items-end gap-[var(--space-6)] text-ink">
      <Wordmark aria-label="Mythrun" size={32} />
      <Wordmark aria-label="Mythrun" size={48} />
      <Wordmark aria-label="Mythrun" size={72} />
    </div>
  ),
}
