import type { Meta, StoryObj } from '@storybook/react-vite'
import type { TextRole } from '@mythrun/client-core/contract'
import { Spinner } from './Spinner.tsx'
import { Button } from '../Button/Button.tsx'
import { Card, CardBody } from '../Card/Card.tsx'
import { Text } from '../Text/Text.tsx'

// Spinner — the brand's SIGNATURE "dither develop" loader. Per the motion rule
// (§4) it does NOT rotate: a small ember-on-paper square whose 4×4 Bayer dither
// FILLS and RECEDES on a slow opacity loop (~3.7s/cycle) — like ink developing
// on the page. It exposes `role="status"` with an accessible name (the busy
// state is announced to AT; motion is never the sole signal), and under
// `prefers-reduced-motion` it settles to a LEGIBLE STATIC ~50% dither (never a
// blank box).
//
// States (a static indicator): the only axis is SIZE (sm/md/lg → the icon token
// scale). It composes INTO a loading control — Button's `loading` renders a
// Spinner beside the label — so the in-context stories below are the real test.
// Color: the lit cells use the `accent` (ember) token over the `surface` paper
// ground — theme-aware, so it reads on both light and warm-dark surfaces.
//
// Do: pair with a disabled/aria-busy control during async work; supply a
//   meaningful `label` (an i18n key) describing what is loading.
// Don't: use it as the ONLY indication of progress for sighted users without
//   any accompanying text/affordance; never expect rotation — this brand develops.
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

// Mono caption role, held as a value so it reaches Text as a variable (not a
// literal `role="..."` attribute the jsx-a11y/aria-role lint would flag).
const UI_CAPTION: TextRole = 'ui-caption'

export const Default: Story = {
  args: { label: 'Loading your campaign' },
}

// The size axis — the develop square scales sm → md → lg on the icon token grid.
export const Sizes: Story = {
  render: () => (
    <div className="flex items-center gap-[var(--space-5)]">
      <Spinner size="sm" />
      <Spinner size="md" />
      <Spinner size="lg" />
    </div>
  ),
}

// THE PRIMARY REAL CONTEXT: inside a loading Button. The control owns the
// disabled/aria-busy state; the Spinner develops beside the still-visible label.
export const InLoadingButton: Story = {
  render: () => (
    <div className="flex flex-col items-start gap-[var(--space-4)]">
      <Button loading>Generating world</Button>
      <Button variant="secondary" loading>
        Saving
      </Button>
      <Button size="lg" loading>
        Rolling initiative
      </Button>
    </div>
  ),
}

// A panel / "DM is thinking" loading state — the spinner centered in a content
// area with a line of mono caption, as a real session-loading surface looks.
export const InThinkingPanel: Story = {
  render: () => (
    <Card>
      <CardBody>
        <div className="flex flex-col items-center justify-center gap-[var(--space-3)] py-[var(--space-6)]">
          <Spinner size="lg" label="The DM is thinking" />
          <Text role={UI_CAPTION}>The DM is thinking…</Text>
        </div>
      </CardBody>
    </Card>
  ),
}

// On a surface — the develop square sits comfortably on any paper tier (the
// cells are the ember token over the surface ground, so it reads on both themes).
export const OnSurface: Story = {
  render: () => (
    <div className="bg-surface p-[var(--space-5)]">
      <Spinner size="lg" />
    </div>
  ),
}

// REDUCED MOTION (note): under `prefers-reduced-motion: reduce` the develop loop
// freezes and the Spinner settles to a LEGIBLE STATIC ~50% dither — never a blank
// box. To eyeball it, enable "Reduce motion" in your OS accessibility settings
// (or emulate it via the browser devtools rendering panel) and reload: the square
// holds a fixed dithered pattern instead of animating.
export const ReducedMotionNote: Story = {
  render: () => (
    <div className="flex flex-col items-start gap-[var(--space-3)]">
      <Spinner size="lg" label="Loading (static under reduced motion)" />
      <Text role={UI_CAPTION}>
        Enable OS &quot;reduce motion&quot; → the develop freezes to a static dither (not blank).
      </Text>
    </div>
  ),
}
