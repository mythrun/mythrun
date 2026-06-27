import type { Meta, StoryObj } from '@storybook/react-vite'
import { GoogleMark } from './GoogleMark.tsx'
import { DiscordMark } from './DiscordMark.tsx'

// Brand marks — the OFFICIAL third-party provider logos used inside the sign-in
// provider buttons (MYT-84 visual audit): Google's 4-color "G" and the Discord
// mark in its official blurple. These are EXTERNAL brand assets, not design-system
// glyphs — their colors are mandated by the providers' brand guidelines and live
// outside the token zone (`src/brand-marks/`, not `src/components/**`). Both are
// DECORATIVE (`aria-hidden`); the button label carries the meaning. Fixed ~20px and
// `shrink-0` so they hold size beside a shrinking label.
const meta: Meta = {
  title: 'Brand/Provider marks',
  parameters: { layout: 'centered' },
}

// eslint-disable-next-line no-restricted-syntax -- Storybook CSF requires the meta object as the module's default export.
export default meta

type Story = StoryObj

export const Marks: Story = {
  render: () => (
    <div className="flex items-center gap-[var(--space-5)]">
      <GoogleMark />
      <DiscordMark />
    </div>
  ),
}
