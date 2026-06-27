import type { Meta, StoryObj } from '@storybook/react-vite'
import { Lockup } from './Lockup.tsx'

// Lockup — the brand's PRIMARY (stacked) lockup: the quill mark ABOVE the wordmark,
// monochrome ink-on-cream (brand guidelines → "The lockups → Primary lockup
// (stacked)"). The default brand identity for site headers and the sign-in title
// composition. The artwork is theme-driven: it paints in `currentColor` tinted by the
// `--ink` token, so it is ink on the light field and CREAM on the dark field (toggle
// the Storybook theme to see it flip). The locked 1032:778 aspect is preserved at any
// `size` (the rendered height).
const meta: Meta<typeof Lockup> = {
  title: 'Brand/Lockup',
  component: Lockup,
  tags: ['autodocs'],
  argTypes: {
    size: { control: { type: 'number', min: 32, max: 512, step: 8 } },
    'aria-label': { control: 'text' },
  },
  args: { 'aria-label': 'Mythrun', size: 128 },
}

// eslint-disable-next-line no-restricted-syntax -- Storybook CSF requires the meta object as the module's default export.
export default meta

type Story = StoryObj<typeof Lockup>

// The default stacked lockup at the canonical genesis-screen size.
export const Default: Story = {}

// The size axis — the rendered height; the width tracks the locked aspect, so the
// composition never distorts.
export const Sizes: Story = {
  render: () => (
    <div className="flex flex-wrap items-end gap-[var(--space-6)] text-ink">
      <Lockup aria-label="Mythrun" size={64} />
      <Lockup aria-label="Mythrun" size={128} />
      <Lockup aria-label="Mythrun" size={192} />
    </div>
  ),
}
