import type { Meta, StoryObj } from '@storybook/react-vite'
import { Spinner } from './Spinner.tsx'

// Spinner — an indeterminate busy indicator. Per the brand's motion rule (§4),
// it PULSES OPACITY, it does NOT rotate: a row of square 1-bit pixels fading in
// a staggered wave. It exposes `role="status"` with an accessible name, so the
// busy state is announced to assistive tech (motion is never the sole signal),
// and it stays VISIBLE under `prefers-reduced-motion` (the resting opacity is 1).
//
// States (a static indicator): the only axis is SIZE (sm/md/lg). No
// hover/active/disabled — the spinner appears WHILE a control is loading (the
// control owns those states; e.g. Button's `loading` composes a Spinner).
// Color: the pixels use the `--ink` token; wrap in a `text-*`/parent context to
// place it on any surface.
//
// Do: pair with a disabled/aria-busy control during async work; supply a
//   meaningful `label` (an i18n key) describing what is loading.
// Don't: use it as the ONLY indication of progress for sighted users without
//   any accompanying text/affordance; never expect rotation — this brand fades.
// Content/i18n: `label` is an i18n KEY the consumer resolves (default 'Loading').

const meta: Meta<typeof Spinner> = {
  title: 'Feedback/Spinner',
  component: Spinner,
  tags: ['autodocs'],
  argTypes: {
    size: { control: 'inline-radio', options: ['sm', 'md', 'lg'] },
    label: { control: 'text' },
  },
}

// eslint-disable-next-line no-restricted-syntax -- Storybook CSF requires the meta object as the module's default export.
export default meta

type Story = StoryObj<typeof Spinner>

export const Default: Story = {
  args: { label: 'Loading your campaign' },
}

// The size axis (the dot footprint scales sm → lg).
export const Sizes: Story = {
  render: () => (
    <div className="flex items-center gap-[var(--space-5)] text-ink">
      <Spinner size="sm" />
      <Spinner size="md" />
      <Spinner size="lg" />
    </div>
  ),
}

// Tinting: the pixels inherit nothing from text color (they use the --ink token
// directly), but the indicator sits comfortably on any surface.
export const OnSurface: Story = {
  render: () => (
    <div className="bg-surface p-[var(--space-5)]">
      <Spinner size="lg" />
    </div>
  ),
}
