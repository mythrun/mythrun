import type { Meta, StoryObj } from '@storybook/react-vite'
import { Icon } from './Icon.tsx'
import { GLYPHS } from './glyphs.ts'
import { Stack } from '../Stack/Stack.tsx'
import { Text } from '../Text/Text.tsx'

// Icon — a single glyph from the swappable Pixelarticons set, tinted by the
// current text color (`currentColor`). Two a11y modes (discriminated): a
// DECORATIVE icon is hidden from assistive tech (`aria-hidden`) and lets the
// adjacent text carry the meaning; a LABELLED icon is exposed as `role="img"`
// with an accessible name (an i18n key the app supplies).
//
// States (icon is a static leaf): the meaningful axes are SIZE (sm/md/lg →
// --icon-sm/md/lg = 16/20/24px) and the a11y MODE (decorative vs labelled). No
// hover/active/disabled/loading/invalid — those live on the controls that
// COMPOSE Icon (IconButton, Button). Color is inherited: wrap in any `text-*`
// token to tint.
//
// Do: use `decorative` next to a text label; use `label` for a standalone glyph
//   (e.g. an icon-only button needs the accessible name).
// Don't: rely on color alone to convey meaning; pass a raw hex tint (use a
//   `text-*` token on a parent).
// Content/i18n: `label` is an i18n KEY the consumer resolves — never a raw
//   string in app code.

const ICON_NAMES = Object.keys(GLYPHS) as (keyof typeof GLYPHS)[]

const meta: Meta<typeof Icon> = {
  title: 'Display/Icon',
  component: Icon,
  tags: ['autodocs'],
  argTypes: {
    name: { control: 'select', options: ICON_NAMES },
    size: { control: 'inline-radio', options: ['sm', 'md', 'lg'] },
    label: { control: 'text' },
    decorative: { control: 'boolean' },
  },
}

// eslint-disable-next-line no-restricted-syntax -- Storybook CSF requires the meta object as the module's default export.
export default meta

type Story = StoryObj<typeof Icon>

export const Decorative: Story = {
  args: { name: 'check', decorative: true },
}

export const Labelled: Story = {
  args: { name: 'search', label: 'Search' },
}

// The size axis (16 / 20 / 24px), tinted by the surrounding text color.
export const Sizes: Story = {
  render: () => (
    <div className="flex items-center gap-[var(--space-4)] text-ink">
      <Icon name="arrow-right" size="sm" decorative />
      <Icon name="arrow-right" size="md" decorative />
      <Icon name="arrow-right" size="lg" decorative />
    </div>
  ),
}

// `currentColor` tinting — the same glyph inherits each token text color.
export const Tinted: Story = {
  render: () => (
    <div className="flex items-center gap-[var(--space-4)]">
      <Icon name="plus" size="lg" decorative />
      <span className="text-accent-fg">
        <Icon name="plus" size="lg" decorative />
      </span>
      <span className="text-danger">
        <Icon name="plus" size="lg" decorative />
      </span>
    </div>
  ),
}

// The full catalogue of glyphs shipped today.
export const Catalogue: Story = {
  render: () => (
    <div className="flex flex-wrap items-center gap-[var(--space-5)] text-ink">
      {ICON_NAMES.map((name) => (
        <div key={name} className="flex flex-col items-center gap-[var(--space-1)]">
          <Icon name={name} size="lg" decorative />
          <span className="font-ui text-xs text-ink-secondary">{name}</span>
        </div>
      ))}
    </div>
  ),
}

// Entity type glyphs (MYT-94) — the leading glyph on an entity mention/popover:
// person (npc) / pin (location) / banner (faction). Monochrome by design (no
// entity-type color, spec §6); the glyph is the ONLY type differentiator.
export const EntityTypeGlyphs: Story = {
  name: 'Entity type glyphs',
  render: () => (
    <div className="flex items-center gap-[var(--space-5)] text-ink">
      {(
        [
          ['entity-npc', 'npc'],
          ['entity-location', 'location'],
          ['entity-faction', 'faction'],
        ] as const
      ).map(([name, kind]) => (
        <div key={name} className="flex flex-col items-center gap-[var(--space-1)]">
          <Icon name={name} size="lg" decorative />
          <span className="font-ui text-xs text-ink-secondary">{kind}</span>
        </div>
      ))}
    </div>
  ),
}

export const HoldsSizeBesideShrinkingText: Story = {
  name: 'Holds size beside shrinking text',
  render: () => (
    <div className="max-w-[200px]">
      <Stack direction="row" align="center" gap={2}>
        <Icon name="search" decorative />
        <Text role="ui-label" truncate>
          A long string that must shrink, not the icon
        </Text>
      </Stack>
    </div>
  ),
}
