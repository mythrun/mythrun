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

// A 1×1 transparent PNG data URI — a real, loadable image for the "with image"
// stories (no network in Storybook). Not a brand asset; just a placeholder pixel.
const PIXEL =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M8AAAMBAQDJ/pLvAAAAAElFTkSuQmCC'

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

// A loaded image (the placeholder pixel) — alt = name.
export const Image: Story = { args: { src: PIXEL } }

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
