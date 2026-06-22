import type { Meta, StoryObj } from '@storybook/react-vite'
import type { AvatarColor } from '@mythrun/client-core/contract'
import { Avatar } from './Avatar.tsx'
import { AVATAR_COLOR_NAMES, avatarColorFor } from './avatar-color.ts'

// Avatar — an identity image with a deterministic INITIALS fallback (built on
// Radix's image-with-fallback primitive). SQUARE — 0px radius everywhere (§3, no
// rounded exception); the square frame matches the pixel-art register. The
// clustered variant (overlapping faces + `+N` overflow) is AvatarGroup, in its
// own story file.
//
// Do: pass a real `name` always — it's the accessible label AND the initials
//   source, so the avatar is named whether the image loads or not.
// Don't: rely on color/shape alone for identity; the name carries it.

// A VISIBLE, loadable image as a data URI — renders with no network so the image
// path is actually demonstrable offline (the old placeholder was a 1×1
// TRANSPARENT pixel: it "loaded" but showed nothing, so the Image story looked
// broken). This is a 4×2 multi-color PNG — deliberately NON-square so the
// `object-cover` crop into the square frame is visible. Not a brand asset.
const SAMPLE_IMAGE =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAQAAAACCAIAAADwyuo0AAAAI0lEQVR4nGO4E2XzYYtbxYKogIotDCcqFqRsOfHsUoVNVA8ArP4NXSITDrkAAAAASUVORK5CYII='

const meta: Meta<typeof Avatar> = {
  title: 'Identity/Avatar',
  component: Avatar,
  tags: ['autodocs'],
  argTypes: {
    name: { control: 'text' },
    src: { control: 'text' },
    size: { control: 'inline-radio', options: ['sm', 'md', 'lg'] },
    color: { control: 'select', options: [undefined, ...AVATAR_COLOR_NAMES] },
  },
  args: { name: 'Ada Lovelace', size: 'md' },
}

// eslint-disable-next-line no-restricted-syntax -- Storybook CSF requires the meta object as the module's default export.
export default meta

type Story = StoryObj<typeof Avatar>

// The initials fallback — no `src`, so 1–2 initials render on the quiet brand chip.
export const Initials: Story = {}

// A loaded image (the visible sample) — Radix renders it once it loads, cropped
// `object-cover` into the square frame; the Root still carries name as the label.
export const Image: Story = { args: { src: SAMPLE_IMAGE } }

// The image at all three sizes — same picture, object-cover into each square.
export const ImageSizes: Story = {
  render: () => (
    <div className="flex items-center gap-[var(--space-3)]">
      <Avatar name="Ada Lovelace" src={SAMPLE_IMAGE} size="sm" />
      <Avatar name="Ada Lovelace" src={SAMPLE_IMAGE} size="md" />
      <Avatar name="Ada Lovelace" src={SAMPLE_IMAGE} size="lg" />
    </div>
  ),
}

// A broken src — Radix's load-state swaps to the initials fallback.
export const BrokenImage: Story = { args: { src: 'https://example.test/missing.png' } }

// All three token sizes, side by side.
export const Sizes: Story = {
  render: () => (
    <div className="flex items-center gap-[var(--space-3)]">
      <Avatar name="Ada Lovelace" size="sm" />
      <Avatar name="Ada Lovelace" size="md" />
      <Avatar name="Ada Lovelace" size="lg" />
    </div>
  ),
}

// A single-word name → one initial.
export const SingleInitial: Story = { args: { name: 'Merlin' } }

// The 12 curated "scribe's pigments" — the named avatar palette. Each chip is a
// `bg-avatar-<name>` token with paper-50 initials (≥4.5:1, AA). The label under
// each swatch is the pigment name. Initials here are just the first two letters
// of the pigment name (so each swatch reads as its own color, not a person).
export const Pigments: Story = {
  render: () => (
    <div className="grid grid-cols-6 gap-[var(--space-4)]">
      {AVATAR_COLOR_NAMES.map((c: AvatarColor) => (
        <div key={c} className="flex flex-col items-center gap-[var(--space-2)]">
          <Avatar name={c} color={c} />
          <span className="font-ui text-xs text-ink-secondary">{c}</span>
        </div>
      ))}
    </div>
  ),
}

// Auto-assign demo — no `color` prop, so each name maps to a STABLE pigment via
// `avatarColorFor` (the same name always yields the same color). The caption
// under each face names the pigment the name resolved to.
const AUTO_NAMES = [
  'Ada Lovelace', 'Grace Hopper', 'Alan Turing', 'Edsger Dijkstra',
  'Ken Thompson', 'Barbara Liskov', 'Donald Knuth', 'Margaret Hamilton',
]
export const AutoAssign: Story = {
  render: () => (
    <div className="grid grid-cols-4 gap-[var(--space-4)]">
      {AUTO_NAMES.map((n) => (
        <div key={n} className="flex flex-col items-center gap-[var(--space-2)]">
          <Avatar name={n} />
          <span className="font-ui text-xs text-ink-secondary">{avatarColorFor(n)}</span>
        </div>
      ))}
    </div>
  ),
}

// The image variant is a BORDERED square (1px --border-strong on the root) — an
// image avatar is framed, not borderless. The picture is clipped object-cover
// inside the bordered frame.
export const BorderedImage: Story = { args: { src: SAMPLE_IMAGE } }
