import type { Meta, StoryObj } from '@storybook/react-vite'
import type { TextRole } from '@mythrun/client-core/contract'
import { Spinner } from './Spinner.tsx'
import { Button } from '../Button/Button.tsx'
import { Card, CardBody } from '../Card/Card.tsx'
import { Text } from '../Text/Text.tsx'

// Spinner — the brand's SIGNATURE "diagonal dither wave" loader. Per the motion
// rule (§4) it does NOT rotate: a small dither square (a 12×12 grid of HARD binary
// cells) where a continuous wave flows the lit dither up the diagonal on a loop
// (~1.8s/period), with two notched corners (top-left + bottom-right) cut out. It
// exposes `role="status"` with an accessible name (the busy state is announced to
// AT; motion is never the sole signal), and under `prefers-reduced-motion` it
// settles to a LEGIBLE STATIC ~40% dither (never a blank box).
//
// States (a static indicator): SIZE (xs/sm/md/lg → 12/24/36/48px) and TONE. It
// composes INTO a loading control — Button's `loading` renders a Spinner beside
// the label — so the in-context stories below are the real test.
// Color: the GROUND is transparent (off-cells, notch + box show whatever is behind
// the spinner through, never a drawn paper tile); the lit pixels are currentColor.
// `tone="accent"` (default) paints them the brand ember; `tone="inherit"` takes the
// surrounding text color, so inside a colored control (Button/IconButton) the
// pixels match the label/icon and read against the fill.
//
// Do: pair with a disabled/aria-busy control during async work; supply a
//   meaningful `label` (an i18n key) describing what is loading.
// Don't: use it as the ONLY indication of progress for sighted users without
//   any accompanying text/affordance; never expect rotation — this brand flows.
// Content/i18n: `label` is an i18n KEY the consumer resolves (default 'Loading').

const meta: Meta<typeof Spinner> = {
  title: 'Feedback/Spinner',
  component: Spinner,
  tags: ['autodocs'],
  argTypes: {
    size: { control: 'inline-radio', options: ['xs', 'sm', 'md', 'lg'] },
    tone: { control: 'inline-radio', options: ['accent', 'inherit'] },
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

// The size axis — the wave square scales xs → sm → md → lg in WHOLE-pixel cells
// (1/2/3/4px → 12/24/36/48px), so every size lands crisp (no sub-pixel mush). xs
// (12px, 1px cells) is the tightest crisp size, sized for the in-button slot; at
// 1px-per-cell the dither reads as a fine grain rather than discrete squares.
export const Sizes: Story = {
  render: () => (
    <div className="flex items-center gap-[var(--space-5)]">
      <Spinner size="xs" />
      <Spinner size="sm" />
      <Spinner size="md" />
      <Spinner size="lg" />
    </div>
  ),
}

// THE PRIMARY REAL CONTEXT: inside a loading Button. The control owns the
// disabled/aria-busy state; the wave flows beside the still-visible label. The
// in-button spinner is sized to be PROPORTIONATE to the label — sm/md buttons get
// the 12px `xs` spinner (balanced beside the 12/14px label), lg gets the 24px `sm`
// spinner (matched to its bigger 16px label).
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

// On a surface — the transparent-ground wave square sits on any paper tier: the
// off-cells/notch show the surface THROUGH (no drawn paper tile), and the lit
// ember pixels (default `accent` tone) read on both themes.
export const OnSurface: Story = {
  render: () => (
    <div className="bg-surface p-[var(--space-5)]">
      <Spinner size="lg" />
    </div>
  ),
}

// TONE on a colored fill — the negative-space fix made visible. On the ember
// `accent` fill, the DEFAULT `accent` tone would be ember-on-ember (invisible), so
// inside a control we pass `tone="inherit"`: the pixels take the foreground color
// (paper here) and read against the fill. The ground is transparent, so the
// off-cells show the ember fill through. (Button/IconButton pass this for you.)
export const OnColoredFill: Story = {
  name: 'Tone (inherit vs accent on a colored fill)',
  render: () => (
    <div className="flex items-center gap-[var(--space-5)]">
      <div className="flex items-center gap-[var(--space-3)] bg-accent p-[var(--space-4)] text-paper-50">
        <Spinner size="lg" tone="inherit" label="Loading (inherits the paper foreground)" />
        <Text role={UI_CAPTION}>tone=&quot;inherit&quot; → paper pixels on ember</Text>
      </div>
      <div className="bg-surface p-[var(--space-4)]">
        <Spinner size="lg" tone="accent" label="Loading (brand ember)" />
      </div>
    </div>
  ),
}

// REDUCED MOTION (note): under `prefers-reduced-motion: reduce` the wave loop
// never starts and the Spinner paints a LEGIBLE STATIC ~40% dither — never a blank
// box (the notched corners still cut). To eyeball it, enable "Reduce motion" in
// your OS accessibility settings (or emulate it via the browser devtools rendering
// panel) and reload: the square holds a fixed dithered pattern instead of flowing.
export const ReducedMotionNote: Story = {
  render: () => (
    <div className="flex flex-col items-start gap-[var(--space-3)]">
      <Spinner size="lg" label="Loading (static under reduced motion)" />
      <Text role={UI_CAPTION}>
        Enable OS &quot;reduce motion&quot; → the wave freezes to a static dither (not blank).
      </Text>
    </div>
  ),
}
