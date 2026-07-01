import type { Meta, StoryObj } from '@storybook/react-vite'
import type { WorldColor } from '@mythrun/contract/rest'
import { CoverDither } from './CoverDither.tsx'

// CoverDither — the card-scale dither COVER carrying a world's two-colour identity (the
// genesis / home-hub cover art). A FULL-FIELD Bayer gradient that fills its host
// edge-to-edge — a true top→bottom sweep between the two world-colours — distinct from
// `Dither`, which is a fixed transition STRIP (the page→footer band) framed by two solid
// sections. Reference pin: Return of the Obra Dinn.
//
// COLOUR is a `from`/`to` pair, each a `WorldColor` — a `{ramp}-{step}` token (e.g.
// `verdigris-200`), R3, never a raw colour. The ends are ordered by ladder STEP, not
// argument order: the lower step is the sparse GROUND (top), the higher step the dense
// ACCENT (bottom). `worldColorCssVar` resolves each to `var(--color-{ramp}-{step})`.
//
// THEME-RESPONSIVE, NO RE-RENDER: the Bayer pattern is fixed; dark mode re-inks the SAME
// pattern by swapping the two colour values (ground → the hue's `-400`, accent → `-900`)
// under `.dark` — see the Re-ink story. Toggle the toolbar theme to watch any cover flip.
//
// `band` is the wide card-cover banner; `swatch` is the compact mobile list chip. GHOST:
// omit both ends for a still-generating world (a muted paper placeholder).

// A representative slice of the widened cover set for the controls (chromatic + paper).
const COLOR_OPTIONS: WorldColor[] = [
  'verdigris-200', 'moss-800', 'sienna-200', 'verdigris-800', 'rose-100', 'rose-800',
  'lapis-100', 'lapis-900', 'iris-200', 'iris-900', 'ochre-200', 'ember-800',
  'paper-100', 'paper-200',
]

// World-identity pairs that read clearly as covers — each ≥ 5 ladder rungs apart (the
// colour model's contrast floor), a mix of chromatic complements and monochromatic ramps.
const PAIRS: { from: WorldColor; to: WorldColor; label: string }[] = [
  { from: 'verdigris-200', to: 'moss-800', label: 'verdigris-200 → moss-800' },
  { from: 'sienna-200', to: 'verdigris-800', label: 'sienna-200 → verdigris-800' },
  { from: 'rose-100', to: 'rose-800', label: 'rose-100 → rose-800 (mono)' },
  { from: 'lapis-100', to: 'lapis-900', label: 'lapis-100 → lapis-900 (mono)' },
  { from: 'iris-200', to: 'iris-900', label: 'iris-200 → iris-900 (mono)' },
  { from: 'ochre-200', to: 'ember-800', label: 'ochre-200 → ember-800' },
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
  args: { from: 'verdigris-200', to: 'moss-800', size: 'band' },
}

// eslint-disable-next-line no-restricted-syntax -- Storybook CSF requires the meta object as the module's default export.
export default meta

type Story = StoryObj<typeof CoverDither>

// The bare cover — fills its host width; its height is the cover-band's own 5:3 extent.
export const Default: Story = {
  render: (args) => (
    <div className="w-56 max-w-full">
      <CoverDither {...args} />
    </div>
  ),
}

// The card-cover BANDS — the full-bleed banner across the top of a campaign card. Several
// world identities, each a step-ordered ground→accent gradient filling the field.
export const Bands: Story = {
  render: () => (
    <div className="flex flex-wrap gap-[var(--space-4)]">
      {PAIRS.map((p) => (
        <figure key={p.label} className="flex w-56 max-w-full flex-col gap-[var(--space-2)]">
          <CoverDither from={p.from} to={p.to} size="band" />
          <figcaption className="font-ui text-xs text-ink-secondary">{p.label}</figcaption>
        </figure>
      ))}
    </div>
  ),
}

// The SWATCHES — a self-sized 48px square; the leading world-identity chip in a compact
// mobile list row. The coarser grid keeps the grain visible at that size.
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

// RE-INK — the same identity in light and dark. The Bayer pattern is identical; dark mode
// swaps only the two colour values (ground → the hue's smouldering -400, accent →
// near-black -900), so the cover reads as a dark object with the colour glowing. The dark
// figure sits in a nested `.dark` surface; toggling the toolbar theme flips both at once.
export const ReInk: Story = {
  name: 'Re-ink (light vs dark)',
  render: () => (
    <div className="flex flex-wrap gap-[var(--space-4)]">
      <figure className="flex w-56 max-w-full flex-col gap-[var(--space-2)]">
        <CoverDither from="verdigris-200" to="moss-800" size="band" />
        <figcaption className="font-ui text-xs text-ink-secondary">light</figcaption>
      </figure>
      <figure className="dark flex w-56 max-w-full flex-col gap-[var(--space-2)] bg-bg p-[var(--space-2)]">
        <CoverDither from="verdigris-200" to="moss-800" size="band" />
        <figcaption className="font-ui text-xs text-ink-secondary">dark (re-inked)</figcaption>
      </figure>
    </div>
  ),
}

// GHOST — a still-generating world with no colour pick yet: a muted paper placeholder, at
// both sizes. Omit `from`/`to` entirely (the home hub renders this until the world lands).
export const Ghost: Story = {
  render: () => (
    <div className="flex flex-wrap items-start gap-[var(--space-4)]">
      <figure className="flex w-56 max-w-full flex-col gap-[var(--space-2)]">
        <CoverDither size="band" />
        <figcaption className="font-ui text-xs text-ink-secondary">band · generating</figcaption>
      </figure>
      <figure className="flex flex-col gap-[var(--space-2)]">
        <CoverDither size="swatch" />
        <figcaption className="font-ui text-xs text-ink-secondary">swatch · generating</figcaption>
      </figure>
    </div>
  ),
}

// BOTH sizes of one identity, side by side — the same step-ordered gradient at the band
// aspect and the square crop. The grain stays chunky in both; only the field shape changes.
export const BandAndSwatch: Story = {
  name: 'Band + swatch (one identity)',
  render: () => (
    <div className="flex flex-wrap items-start gap-[var(--space-4)]">
      <figure className="flex w-56 max-w-full flex-col gap-[var(--space-2)]">
        <CoverDither from="lapis-100" to="lapis-900" size="band" />
        <figcaption className="font-ui text-xs text-ink-secondary">band</figcaption>
      </figure>
      <figure className="flex flex-col gap-[var(--space-2)]">
        <CoverDither from="lapis-100" to="lapis-900" size="swatch" />
        <figcaption className="font-ui text-xs text-ink-secondary">swatch (48px)</figcaption>
      </figure>
    </div>
  ),
}
