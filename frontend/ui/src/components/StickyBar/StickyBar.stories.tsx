import type { Meta, StoryObj } from '@storybook/react-vite'
import { StickyBar } from './StickyBar.tsx'
import { Button } from '../Button/Button.tsx'
import { HorizontalLockup } from '../HorizontalLockup/HorizontalLockup.tsx'

// StickyBar — the app frame's sticky top bar (spec 2026-07-30 §Scroll
// mechanics). Owns EVERY scroll-visual mechanic so app code never needs a
// className: `position: sticky; top: 0`, fluid brand-slot height + vertical
// padding (clamp), the `--space-6` gutter matching the content Box, and
// ZERO-CLS elevation — `elevated` swaps the always-present bottom border
// transparent → `--border` and transform-scales the brand slot to 0.82 from
// `sm` up; the layout box never changes, so the hairline's arrival and the
// compaction shift nothing.
//
// StickyBar is DUMB: `elevated` is a plain prop. The consumer owns the scroll
// observer (an IntersectionObserver sentinel above the content) and flips the
// prop; these specimens drive it directly.

const meta: Meta<typeof StickyBar> = {
  title: 'Layout/StickyBar',
  component: StickyBar,
  tags: ['autodocs'],
  parameters: { layout: 'fullscreen' },
  args: {
    elevated: false,
    brand: <HorizontalLockup aria-label="Mythrun" size="fluid" />,
    children: (
      <div className="flex items-center gap-[var(--space-2)]">
        <Button variant="ghost">nav.worlds</Button>
        <Button variant="ghost">nav.account</Button>
      </div>
    ),
  },
}

// eslint-disable-next-line no-restricted-syntax -- Storybook CSF requires the meta object as the module's default export.
export default meta

type Story = StoryObj<typeof StickyBar>

// At rest — the bottom border is MOUNTED but transparent (the zero-CLS
// reservation); the brand slot is uncompacted at its fluid clamp height.
export const Rest: Story = {}

// Elevated — the hairline colors in and the brand slot compacts to 0.82 (from
// `sm` up). Compare with Rest: nothing below the bar moves.
export const Elevated: Story = {
  args: { elevated: true },
}

// Inside a tall scroll container — scroll the box and the bar stays pinned to
// its top. `elevated` is still driven by the prop (toggle it in the controls):
// StickyBar has no observer of its own.
export const InAScrollContainer: Story = {
  render: (args) => (
    <div className="h-[320px] overflow-y-auto bg-bg">
      <StickyBar {...args} />
      <div className="flex flex-col gap-[var(--space-4)] p-[var(--space-6)] font-body text-sm text-ink">
        {Array.from({ length: 24 }, (_, i) => (
          <p key={i}>[placeholder for scrolled page content, line {i + 1}]</p>
        ))}
      </div>
    </div>
  ),
}
