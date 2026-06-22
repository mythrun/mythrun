import type { Meta, StoryObj } from '@storybook/react-vite'
import { Badge } from './Badge.tsx'

// Badge — a small inline status chip (a count, a state label, a tag). Flat 1-bit
// (§3): `rounded-none`, no shadow, mono `font-ui` (a badge is data). `neutral`
// (default) is the quiet brand chip; the four severities reuse the §4
// status-intent triad. A leaf with no ARIA role — the chip's TEXT carries the
// meaning; color is reinforcement, never the sole signal.
//
// Do: keep labels short (a word, a count, a state). Pick the variant that matches
//   the meaning, not the desired color.
// Don't: use a badge as the sole signal of something critical; pair it with text.
// Content/i18n: children are an i18n key the consumer resolves.

const meta: Meta<typeof Badge> = {
  title: 'Display/Badge',
  component: Badge,
  tags: ['autodocs'],
  argTypes: {
    variant: { control: 'inline-radio', options: ['neutral', 'success', 'warning', 'danger', 'info'] },
  },
  args: { variant: 'neutral', children: 'badge.label' },
}

// eslint-disable-next-line no-restricted-syntax -- Storybook CSF requires the meta object as the module's default export.
export default meta

type Story = StoryObj<typeof Badge>

export const Default: Story = {}

// Every variant in a row — the neutral brand chip + the four status intents.
export const Variants: Story = {
  render: () => (
    <div className="flex flex-wrap items-center gap-[var(--space-2)]">
      <Badge variant="neutral">neutral</Badge>
      <Badge variant="success">success</Badge>
      <Badge variant="warning">warning</Badge>
      <Badge variant="danger">danger</Badge>
      <Badge variant="info">info</Badge>
    </div>
  ),
}

// A count chip — the common "N unread / N members" use.
export const Count: Story = { args: { variant: 'info', children: '12' } }
