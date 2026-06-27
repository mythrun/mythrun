import type { Meta, StoryObj } from '@storybook/react-vite'
import type { HeadingRole, TextRole } from '@mythrun/client-core/contract'
import { Dither } from './Dither.tsx'
import { Heading } from '../Heading/Heading.tsx'
import { Text } from '../Text/Text.tsx'
import { Stack } from '../Stack/Stack.tsx'

// Dither — the brand's ONLY sanctioned gradient, used as a pure TRANSITION DEVICE: a
// stepped 4×4 Bayer crossfade between two PALETTE colors (never a smooth gradient). It
// renders ONLY the dithered band — the solid `from` color above and `to` color below are
// the ADJACENT sections' own color, never drawn by the component, and nothing sits on it.
//
// COLOR is `from`→`to`, each a PALETTE TOKEN NAME (e.g. `paper-100` → `ember-600`),
// constrained to the 60 brand tokens (R3 — no raw color). The brand's sanctioned pairings
// are the canonical picks; the open from/to lets a consumer match an adjacent section's
// exact color.
//
// THE CANONICAL USE is the page→footer break (guidelines.md → "Footer. The canonical
// use."): cream page content above, the band, the dark REVERSED footer (light-on-dark)
// below — see the Footer story. Other sanctioned uses (splash / error / narrative→combat /
// OG cards) are the same gesture: the band bridges a light section into a dark one.
//
// NOT a generic "section divider": the brand forbids dither between same-color (cream-on-
// cream) sections — nothing to transition between, so those breaks use rules / whitespace.
// The dither only earns its place where two sections genuinely DIFFER in color (the footer
// being the archetype). Reference pin: Return of the Obra Dinn.

const HEADING: HeadingRole = 'heading'
const PROSE: TextRole = 'prose-body'
const CAPTION: TextRole = 'ui-caption'

// The palette token names the controls offer (the canonical ground + accent picks).
const PALETTE_OPTIONS = ['paper-100', 'paper-900', 'ember-600', 'ember-400'] as const

const meta: Meta<typeof Dither> = {
  title: 'Texture/Dither',
  component: Dither,
  tags: ['autodocs'],
  argTypes: {
    from: { control: 'inline-radio', options: PALETTE_OPTIONS },
    to: { control: 'inline-radio', options: PALETTE_OPTIONS },
    direction: { control: 'inline-radio', options: ['vertical', 'horizontal'] },
    scale: { control: 'inline-radio', options: ['preview', 'hero'] },
    flip: { control: 'boolean' },
  },
  args: { from: 'paper-100', to: 'ember-600', direction: 'vertical', scale: 'preview', flip: false },
}

// eslint-disable-next-line no-restricted-syntax -- Storybook CSF requires the meta object as the module's default export.
export default meta

type Story = StoryObj<typeof Dither>

// The bare band — just the dithered crossfade, cropped to the grain (no solid frame
// blocks). Fills its host's width; its height is the band's own fixed extent.
export const Default: Story = {
  render: (args) => (
    <div className="w-96 max-w-full">
      <Dither {...args} />
    </div>
  ),
}

// The three sanctioned pairings — the canonical from/to combinations (ground is always a
// paper step). Other palette picks are allowed; these are the brand-blessed defaults.
export const Pairings: Story = {
  render: () => (
    <div className="flex flex-wrap gap-[var(--space-4)]">
      <figure className="flex w-56 flex-col gap-[var(--space-2)]">
        <Dither from="paper-100" to="ember-600" />
        <figcaption className="font-ui text-xs text-ink-secondary">paper-100 → ember-600 (warm)</figcaption>
      </figure>
      <figure className="flex w-56 flex-col gap-[var(--space-2)]">
        <Dither from="paper-100" to="paper-900" />
        <figcaption className="font-ui text-xs text-ink-secondary">paper-100 → paper-900 (ink)</figcaption>
      </figure>
      <figure className="flex w-56 flex-col gap-[var(--space-2)]">
        <Dither from="paper-900" to="paper-100" />
        <figcaption className="font-ui text-xs text-ink-secondary">paper-900 → paper-100 (reverse)</figcaption>
      </figure>
    </div>
  ),
}

// Both axes. Vertical (the default) is the page→footer horizon; horizontal is the
// transposed ribbon. (Radial is forbidden — it reads as "glow".)
export const Axes: Story = {
  render: () => (
    <div className="flex flex-wrap items-start gap-[var(--space-4)]">
      <figure className="flex w-56 flex-col gap-[var(--space-2)]">
        <Dither direction="vertical" />
        <figcaption className="font-ui text-xs text-ink-secondary">vertical (default)</figcaption>
      </figure>
      <figure className="flex flex-col gap-[var(--space-2)]">
        <div className="h-56 w-40">
          <Dither direction="horizontal" />
        </div>
        <figcaption className="font-ui text-xs text-ink-secondary">horizontal</figcaption>
      </figure>
    </div>
  ),
}

// The genesis-screen CROWN orientation (sign-in / onboard). `flip` reverses the ramp so
// the band hangs from the TOP edge — the `to` accent dense at the top, fading DOWN into
// the `from` field — instead of rising from the bottom. The default and flipped bands are
// stacked so the inversion is obvious: the dense ends sit at opposite edges.
export const FlipCrown: Story = {
  name: 'Flip (the genesis crown)',
  render: () => (
    <div className="flex flex-wrap gap-[var(--space-4)]">
      <figure className="flex w-56 flex-col gap-[var(--space-2)]">
        <Dither from="paper-100" to="ember-600" />
        <figcaption className="font-ui text-xs text-ink-secondary">default — accent at the bottom</figcaption>
      </figure>
      <figure className="flex w-56 flex-col gap-[var(--space-2)]">
        <Dither from="paper-100" to="ember-600" flip />
        <figcaption className="font-ui text-xs text-ink-secondary">flip — accent at the TOP (crown)</figcaption>
      </figure>
    </div>
  ),
}

// Cell scale: 8px preview grain vs 6px hero grain. The grain must stay visible AS grain
// at display size — if it reads as noise, scale up.
export const Scale: Story = {
  render: () => (
    <div className="flex flex-wrap gap-[var(--space-4)]">
      <figure className="flex w-56 flex-col gap-[var(--space-2)]">
        <Dither scale="preview" />
        <figcaption className="font-ui text-xs text-ink-secondary">preview · 8px cell</figcaption>
      </figure>
      <figure className="flex w-56 flex-col gap-[var(--space-2)]">
        <Dither scale="hero" />
        <figcaption className="font-ui text-xs text-ink-secondary">hero · 6px cell</figcaption>
      </figure>
    </div>
  ),
}

// SQUARE-PIXEL PROOF — the same vertical band in three increasingly WIDE boxes. The cells
// must stay PERFECTLY SQUARE: a wider box gets MORE identical-width columns (the pattern
// tiles on the cross axis), never wider cells. The grain dots are the same size in all
// three; nothing stretches horizontally.
export const SquarePixelsHoldAsWidthGrows: Story = {
  name: 'Square pixels (widening box)',
  // Wide-by-design specimen: the middle figure is a fixed 448px (`w-[28rem]`) box —
  // the WHOLE point is to prove the cells stay square as the host WIDENS past mobile
  // (224 → 448 → full). Shrinking it to max-w-full would defeat the "tiles ×2" claim,
  // so the overflow gate skips this story (§5 opt-out).
  parameters: { overflowGate: false },
  render: () => (
    <div className="flex flex-col gap-[var(--space-4)]">
      <figure className="flex w-56 flex-col gap-[var(--space-2)]">
        <Dither from="paper-100" to="paper-900" scale="hero" />
        <figcaption className="font-ui text-xs text-ink-secondary">224px wide — one tile</figcaption>
      </figure>
      <figure className="flex w-[28rem] flex-col gap-[var(--space-2)]">
        <Dither from="paper-100" to="paper-900" scale="hero" />
        <figcaption className="font-ui text-xs text-ink-secondary">448px wide — tiles ×2 (cells unchanged)</figcaption>
      </figure>
      <figure className="flex w-full flex-col gap-[var(--space-2)]">
        <Dither from="paper-100" to="paper-900" scale="hero" />
        <figcaption className="font-ui text-xs text-ink-secondary">full width — tiles to fill (cells STILL square)</figcaption>
      </figure>
    </div>
  ),
}

// THE CANONICAL USE — the page→footer break. Cream content sits in its own section ABOVE
// the band; the band carries the crossfade down into the dark, REVERSED footer (a `.dark`
// section, so its text + chrome flip to light-on-dark) BELOW. Nothing is ever drawn on the
// band itself — the solid cream above and solid ink below are the two sections' own color,
// which the band's edges resolve into seamlessly (its `from` = the page's bg, its `to` =
// the footer's bg).
export const Footer: Story = {
  name: 'Footer (the canonical use)',
  render: () => (
    <div className="mx-auto w-[30rem] max-w-full">
      <div className="bg-bg px-[var(--space-5)] pb-[var(--space-7)] pt-[var(--space-6)]">
        <Stack gap={2}>
          <Heading level={2} role={HEADING}>
            Ready when you are
          </Heading>
          <Text as="p" role={PROSE}>
            Gather a party, name a world, and the Dungeon Master takes it from there.
          </Text>
        </Stack>
      </div>
      <Dither from="paper-100" to="paper-900" />
      {/* The reversed footer — a `.dark` section. `.dark` alone re-establishes the reversed
          surface (its bg = the flipped `--bg` = paper-900, exactly the dither's ink `to`,
          so the band resolves into it seamlessly) and the Text inherits the flipped light
          `--ink`. No bg/text classes needed. */}
      <div className="dark px-[var(--space-5)] py-[var(--space-6)]">
        <Stack gap={1}>
          <Text role={CAPTION}>Mythrun</Text>
          <Text role={CAPTION}>© 2026 · Terms · Privacy · Discord</Text>
        </Stack>
      </div>
    </div>
  ),
}
