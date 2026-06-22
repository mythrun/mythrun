import type { Meta, StoryObj } from '@storybook/react-vite'
import { Dither } from './Dither.tsx'

// Dither — the brand's ONLY sanctioned gradient. NEVER a smooth gradient: a
// stepped two-color transition rendered as a 4×4 ordered Bayer dither, exactly
// per the LOCKED brand formula (guidelines.md → "The dither formula"). Reference
// pin: Return of the Obra Dinn. Color comes from a sanctioned token `pairing`
// (ground is always a paper step; ember-ground + semantic colors are forbidden).
//
// This story is the brand-texture SHOWCASE — the three pairings, both axes, both
// cell scales, and the canonical "wordmark over the solid ground, dither below"
// composition (splash / footer / error screens).
//
// Allowed uses (guidelines.md): footer, splash / loading, narrative→combat
// transition, error / 404 / offline, OG share images, print accents. NOT for
// section dividers, under body text, or behind the mark itself (the lockup sits
// ABOVE the band, not inside it).

const meta: Meta<typeof Dither> = {
  title: 'Texture/Dither',
  component: Dither,
  tags: ['autodocs'],
  argTypes: {
    pairing: { control: 'inline-radio', options: ['light-ember', 'light-ink', 'dark-cream'] },
    direction: { control: 'inline-radio', options: ['vertical', 'horizontal'] },
    scale: { control: 'inline-radio', options: ['preview', 'hero'] },
  },
  args: { pairing: 'light-ember', direction: 'vertical', scale: 'preview' },
}

// eslint-disable-next-line no-restricted-syntax -- Storybook CSF requires the meta object as the module's default export.
export default meta

type Story = StoryObj<typeof Dither>

// The canonical warm pairing, vertical (ground above, accent below).
export const Default: Story = {
  render: (args) => (
    <div className="h-72 w-96 max-w-full">
      <Dither {...args} />
    </div>
  ),
}

// The three sanctioned pairings, side by side — the only color combinations the
// brand allows (ground is always a paper step).
export const Pairings: Story = {
  render: () => (
    <div className="flex flex-wrap gap-[var(--space-4)]">
      <figure className="flex flex-col gap-[var(--space-2)]">
        <div className="h-72 w-56">
          <Dither pairing="light-ember" />
        </div>
        <figcaption className="font-ui text-xs text-ink-secondary">light → ember (canonical warm)</figcaption>
      </figure>
      <figure className="flex flex-col gap-[var(--space-2)]">
        <div className="h-72 w-56">
          <Dither pairing="light-ink" />
        </div>
        <figcaption className="font-ui text-xs text-ink-secondary">light → ink (quiet monochrome)</figcaption>
      </figure>
      <figure className="flex flex-col gap-[var(--space-2)]">
        <div className="h-72 w-56">
          <Dither pairing="dark-cream" />
        </div>
        <figcaption className="font-ui text-xs text-ink-secondary">dark → cream (reverse)</figcaption>
      </figure>
    </div>
  ),
}

// Both axes. Vertical is the default (a horizon); horizontal is the allowed
// section-break ribbon. (Radial is forbidden — it reads as "glow".)
export const Axes: Story = {
  render: () => (
    <div className="flex flex-wrap gap-[var(--space-4)]">
      <figure className="flex flex-col gap-[var(--space-2)]">
        <div className="h-72 w-56">
          <Dither direction="vertical" />
        </div>
        <figcaption className="font-ui text-xs text-ink-secondary">vertical (default)</figcaption>
      </figure>
      <figure className="flex flex-col gap-[var(--space-2)]">
        <div className="h-56 w-96">
          <Dither direction="horizontal" />
        </div>
        <figcaption className="font-ui text-xs text-ink-secondary">horizontal</figcaption>
      </figure>
    </div>
  ),
}

// Cell scale: 8px preview grain vs 6px hero grain. The grain must stay visible AS
// grain — if it reads as noise, scale up.
export const Scale: Story = {
  render: () => (
    <div className="flex flex-wrap gap-[var(--space-4)]">
      <figure className="flex flex-col gap-[var(--space-2)]">
        <div className="h-72 w-56">
          <Dither scale="preview" />
        </div>
        <figcaption className="font-ui text-xs text-ink-secondary">preview · 8px cell</figcaption>
      </figure>
      <figure className="flex flex-col gap-[var(--space-2)]">
        <div className="h-72 w-56">
          <Dither scale="hero" />
        </div>
        <figcaption className="font-ui text-xs text-ink-secondary">hero · 6px cell</figcaption>
      </figure>
    </div>
  ),
}

// The canonical composition — content sits on the solid GROUND at the top; the
// dither carries the transition below (splash / loading / error screens). The
// content stays accessible; the texture behind it is aria-hidden.
export const ContentOverTexture: Story = {
  render: () => (
    <div className="h-96 w-96 max-w-full">
      <Dither pairing="dark-cream" scale="hero">
        <div className="flex h-96 flex-col items-center gap-[var(--space-3)] p-[var(--space-6)]">
          <p className="font-body text-2xl text-ink">[placeholder for the Mythrun wordmark]</p>
          <p className="font-ui text-xs text-ink-secondary">[placeholder for a loading line]</p>
        </div>
      </Dither>
    </div>
  ),
}
