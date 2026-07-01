import type { Meta, StoryObj } from '@storybook/react-vite'
import type { WorldColor } from '@mythrun/contract/rest'
import { CoverDither } from './CoverDither.tsx'

// CoverDither — the card-scale dither COVER carrying a world's two-colour identity (the
// genesis / home-hub cover art). A FULL-FIELD texture that fills its host edge-to-edge and
// TILES the brand's locked 4×4-Bayer two-colour dither — distinct from `Dither`, which is a
// fixed transition STRIP (the page→footer band) framed by two solid sections. Reference pin:
// Return of the Obra Dinn.
//
// COLOUR is `from`→`to`, each a `WorldColor` — the curated cover set (the 12 avatar pigments
// + selected paper/ember ramp steps), R3, never a raw colour. The set spans two css-var
// namespaces (pigment → `--color-avatar-{name}`, ramp step → `--color-{name}`); a `from`
// like `sienna` resolves to `--color-avatar-sienna`, a `to` like `paper-100` to
// `--color-paper-100` — `worldColorCssVar` owns that switch.
//
// SQUARE-PIXEL CRISP at both sizes: the grain stays perfectly square as the host widens
// (more identical cells, never stretched ones). `band` is the wide card-cover banner;
// `swatch` is the mobile square crop.
//
// NOTE: the cover's brand sign-off (the dashboard "tiled wall") gates the SHIP; this catalogue
// shows the component at its real sizes for that review.

// A representative slice of the curated cover set for the controls (pigments + ramp steps).
const COLOR_OPTIONS: WorldColor[] = [
  'sienna', 'lapis', 'moss', 'iris', 'ember', 'umber',
  'paper-50', 'paper-100', 'paper-900', 'ember-100', 'ember-900',
]

// World-identity pairs that read clearly as covers (a pigment ground resolving into a paper
// or ember step, or the reverse) — the pigment carries the world's colour, the ramp step its
// light/dark register.
const PAIRS: { from: WorldColor; to: WorldColor; label: string }[] = [
  { from: 'sienna', to: 'paper-100', label: 'sienna → paper-100' },
  { from: 'lapis', to: 'paper-50', label: 'lapis → paper-50' },
  { from: 'moss', to: 'paper-900', label: 'moss → paper-900' },
  { from: 'iris', to: 'ember-900', label: 'iris → ember-900' },
  { from: 'umber', to: 'ember-100', label: 'umber → ember-100' },
  { from: 'paper-900', to: 'ember', label: 'paper-900 → ember' },
]

const meta: Meta<typeof CoverDither> = {
  title: 'Texture/CoverDither',
  component: CoverDither,
  tags: ['autodocs'],
  argTypes: {
    from: { control: 'select', options: COLOR_OPTIONS },
    to: { control: 'select', options: COLOR_OPTIONS },
    size: { control: 'inline-radio', options: ['band', 'swatch'] },
  },
  args: { from: 'sienna', to: 'paper-100', size: 'band' },
}

// eslint-disable-next-line no-restricted-syntax -- Storybook CSF requires the meta object as the module's default export.
export default meta

type Story = StoryObj<typeof CoverDither>

// The bare cover — fills its host width; its height comes from the size's aspect.
export const Default: Story = {
  render: (args) => (
    <div className="w-80 max-w-full">
      <CoverDither {...args} />
    </div>
  ),
}

// The card-cover BAND — a wide banner across the top of a campaign card. Several world
// identities, each a from→to dither tiled to fill the band.
export const Bands: Story = {
  render: () => (
    <div className="flex flex-wrap gap-[var(--space-4)]">
      {PAIRS.map((p) => (
        <figure key={p.label} className="flex w-64 max-w-full flex-col gap-[var(--space-2)]">
          <CoverDither from={p.from} to={p.to} size="band" />
          <figcaption className="font-ui text-xs text-ink-secondary">{p.label}</figcaption>
        </figure>
      ))}
    </div>
  ),
}

// The SWATCH — a self-sized small square (a fixed --space-8 / 48px tile); the leading
// world-identity chip in a compact list row. It does NOT fill its host (unlike the band),
// so no width wrapper is needed. The grain stays square; the dither tiles to fill.
export const Swatches: Story = {
  render: () => (
    <div className="flex flex-wrap gap-[var(--space-4)]">
      {PAIRS.map((p) => (
        <figure key={p.label} className="flex flex-col gap-[var(--space-2)]">
          <CoverDither from={p.from} to={p.to} size="swatch" />
          <figcaption className="font-ui text-xs text-ink-secondary">{p.label}</figcaption>
        </figure>
      ))}
    </div>
  ),
}

// BOTH sizes of one identity, side by side — the same from→to dither, the band aspect and
// the square crop. The grain dots are the same size in both; only the field shape changes.
export const BandAndSwatch: Story = {
  name: 'Band + swatch (one identity)',
  render: () => (
    <div className="flex flex-wrap items-start gap-[var(--space-4)]">
      <figure className="flex w-64 max-w-full flex-col gap-[var(--space-2)]">
        <CoverDither from="lapis" to="paper-50" size="band" />
        <figcaption className="font-ui text-xs text-ink-secondary">band</figcaption>
      </figure>
      <figure className="flex flex-col gap-[var(--space-2)]">
        <CoverDither from="lapis" to="paper-50" size="swatch" />
        <figcaption className="font-ui text-xs text-ink-secondary">swatch (48px)</figcaption>
      </figure>
    </div>
  ),
}
