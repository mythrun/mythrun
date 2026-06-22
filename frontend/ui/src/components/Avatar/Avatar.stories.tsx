import type { Meta, StoryObj } from '@storybook/react-vite'
import { Avatar } from './Avatar.tsx'

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
