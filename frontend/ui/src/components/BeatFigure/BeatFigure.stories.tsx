import { useEffect, useState } from 'react'
import type { Meta, StoryObj } from '@storybook/react-vite'
import { BeatFigure } from './BeatFigure.tsx'

// BeatFigure — the loading-beat family's shared full-width quantized dither figure. `fill`
// advances a hard-binary Bayer meter in decelerating quantized frames (the front band shimmers
// in place between advances; the completed region is locked solid); `breathe` sweeps an
// indeterminate density wave with no progress (the no-progress ambient hold); `idle` is the
// nearly blank poised zero-state for accreting surfaces (ux-run3 myth-c96rf) — a faint pulse
// at the fill's origin, cell-wise emptier than any accretion state. The self-driving demos
// below step the PUBLIC props on a timer to preview the live feel (production drives them from
// real phase/beat state).

const meta: Meta<typeof BeatFigure> = {
  title: 'Foundations/BeatFigure',
  component: BeatFigure,
  tags: ['autodocs'],
  // A card ground at a realistic beat width so the frozen-paper figure reads as it does on the
  // real surface.
  decorators: [
    (Story) => (
      <div className="w-[520px] max-w-full rounded-none border border-border bg-surface p-[var(--space-4)]">
        <Story />
      </div>
    ),
  ],
}

// eslint-disable-next-line no-restricted-syntax -- Storybook CSF requires the meta object as the module's default export.
export default meta

type Story = StoryObj<typeof BeatFigure>

// Static fill snapshots (screenshot targets — the animation is driven, but a frozen level shows
// the resting composition at that proportion).
export const FillUnderway: Story = {
  name: 'Fill · 58% (reduced-motion still)',
  args: { mode: 'fill', level: 0.58, reducedMotion: true },
}

export const FillComplete: Story = {
  name: 'Fill · 100% (reduced-motion still)',
  args: { mode: 'fill', level: 1, reducedMotion: true },
}

export const FillEmpty: Story = {
  name: 'Fill · 0% (reduced-motion still)',
  args: { mode: 'fill', level: 0, reducedMotion: true },
}

// A self-driving fill: the level lands on a sequence of "beat completions" with dwell, so the
// decelerating quantized advance + the in-place front shimmer are both visible, then it resets.
const FILL_STOPS = [0, 0.25, 0.5, 0.75, 1]

function FillDriver(): React.JSX.Element {
  const [i, setI] = useState(0)
  useEffect(() => {
    const atEnd = i >= FILL_STOPS.length - 1
    const t = setTimeout(() => {
      setI((n) => (n >= FILL_STOPS.length - 1 ? 0 : n + 1))
    }, atEnd ? 2200 : 1500)
    return () => {
      clearTimeout(t)
    }
  }, [i])
  return <BeatFigure mode="fill" level={FILL_STOPS[i] ?? 0} reducedMotion={false} />
}

export const FillDriving: Story = {
  name: 'Fill · driving (demo advance)',
  render: () => <FillDriver />,
}

// A fill held at a fixed level under motion: it snaps to 0.58 on mount and then never advances
// (no progress change) — only the front band re-seeds, so the ink front SHIMMERS in place while
// the completed region stays LOCKED (bit-identical frame to frame). The two-question test made
// visible.
export const FillHolding: Story = {
  name: 'Fill · holding (front shimmers, body locked)',
  args: { mode: 'fill', level: 0.58, reducedMotion: false },
}

// The indeterminate breathing field — no progress; density travels diagonally, ~3s, re-seeded
// each cycle. It animates on mount (nothing to drive).
export const Breathing: Story = {
  name: 'Breathe · indeterminate',
  args: { mode: 'breathe', reducedMotion: false },
}

export const BreathingStill: Story = {
  name: 'Breathe · reduced-motion still',
  args: { mode: 'breathe', reducedMotion: true },
}

// The idle zero-state (ux-run3 myth-c96rf) — nearly blank: a faint slow pulse seated at the
// fill's origin. Must read unmistakably EMPTIER than FillUnderway (idle < any accretion).
export const Idle: Story = {
  name: 'Idle · poised zero-state',
  args: { mode: 'idle', reducedMotion: false },
}

export const IdleStill: Story = {
  name: 'Idle · reduced-motion still',
  args: { mode: 'idle', reducedMotion: true },
}

// Frozen-paper tone (the opt-in 1-bit relic) — kept for a small tile that wants it; on a
// full-width band the empty track becomes a bright paper slab on the dark card, which is why
// the default is the theme-flipping token tone.
export const PaperTone: Story = {
  name: 'Fill · paper relic (58%)',
  args: { mode: 'fill', level: 0.58, reducedMotion: true, tone: 'paper' },
}

// Narrow (~375px): the meter reflows to fewer columns, cells unchanged.
export const Narrow: Story = {
  name: 'Narrow (~340px)',
  render: () => (
    <div className="w-[340px]">
      <BeatFigure mode="fill" level={0.58} reducedMotion={false} />
    </div>
  ),
}
