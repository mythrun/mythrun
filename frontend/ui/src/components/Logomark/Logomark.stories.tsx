import type { Meta, StoryObj } from '@storybook/react-vite'
import { Logomark } from './Logomark.tsx'

// Logomark — the canonical 64-logical PIXEL-ART mark (brand guidelines → "The
// mark"). Scales CRISP (shape-rendering=crispEdges; nearest-neighbor character is
// the point — smooth scaling destroys it). `ink` (default) is theme-driven via the
// `--ink` token (flips to cream on the dark field, the in-lockup treatment); `ember`
// is the brand accent for the mark used ALONE on a cream field. Minimum legible
// size is 48px (below that, the 32 favicon — out of scope).
const meta: Meta<typeof Logomark> = {
  title: 'Brand/Logomark',
  component: Logomark,
  tags: ['autodocs'],
  argTypes: {
    size: { control: { type: 'number', min: 48, max: 256, step: 8 } },
    tone: { control: 'inline-radio', options: ['ink', 'ember'] },
    'aria-label': { control: 'text' },
  },
  args: { 'aria-label': 'Mythrun', size: 64, tone: 'ink' },
}

// eslint-disable-next-line no-restricted-syntax -- Storybook CSF requires the meta object as the module's default export.
export default meta

type Story = StoryObj<typeof Logomark>

export const Default: Story = {}

// The two tones — ink (theme-driven) and the ember accent (the mark used alone).
export const Tones: Story = {
  render: () => (
    <div className="flex items-end gap-[var(--space-6)]">
      <Logomark aria-label="Mythrun" tone="ink" />
      <Logomark aria-label="Mythrun" tone="ember" />
    </div>
  ),
}

// The size axis (square 1:1). At every step the pixel grid stays crisp.
export const Sizes: Story = {
  render: () => (
    <div className="flex items-end gap-[var(--space-5)] text-ink">
      <Logomark aria-label="Mythrun" size={48} />
      <Logomark aria-label="Mythrun" size={64} />
      <Logomark aria-label="Mythrun" size={128} />
    </div>
  ),
}
