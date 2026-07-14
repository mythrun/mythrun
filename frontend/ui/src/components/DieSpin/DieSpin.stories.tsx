import { useState } from 'react'
import type { Meta, StoryObj } from '@storybook/react-vite'
import { DieSpin } from './DieSpin.tsx'

// DieSpin (MYT-93, spec §5) — the flat 2D OUTLINED d20 the RollCard spins. THIS
// STORY IS THE CANONICAL REFERENCE for the die glyph (a new brand mark — no
// pixelarticons dice exists; Miklos directed "a 2D outline in some 1-bit register,
// spun"). The motion is a STEPPED rotation — 8 discrete 45° steps ≈ one ~1s
// revolution, driven by a step counter, NEVER a smooth CSS transition (the motion
// analog of the brand's stepped Bayer dither). The landed `result` stamps the
// numeral in the die centre in `--font-ui`; `reducedMotion` lands instantly. The
// die is currentColor decoration (tint via a `text-*` token on the parent); the
// result also announces via a polite live region (motion is never the only signal).
//
// Do: drive `spinning` from real interaction (the RollCard's Roll press) and land
//   the numeral on `onSpinComplete`. Don't: interpolate the rotation smoothly, or
//   add a circle — the register is square/1-bit.
// Content/i18n: `resultLabel` is a resolved [ph:] SR string the consumer passes;
//   `result` is DATA (the numeral), never an i18n key.

const meta: Meta<typeof DieSpin> = {
  title: 'Session/DieSpin',
  component: DieSpin,
  tags: ['autodocs'],
  // The die is currentColor — frame it in the ink text tone so the outline reads.
  decorators: [
    (Story) => (
      <div className="text-ink">
        <Story />
      </div>
    ),
  ],
}

// eslint-disable-next-line no-restricted-syntax -- Storybook CSF requires the meta object as the module's default export.
export default meta

type Story = StoryObj<typeof DieSpin>

// The un-rolled die: the bare outline, no numeral.
export const Idle: Story = {
  args: {
    spinning: false,
    result: null,
    reducedMotion: false,
    onSpinComplete: () => undefined,
  },
}

// The landed die: the numeral stamped in the centre in --font-ui.
export const Result: Story = {
  args: {
    spinning: false,
    result: 17,
    reducedMotion: false,
    onSpinComplete: () => undefined,
    resultLabel: '[ph: you rolled a 17]',
  },
}

// A self-driving demo: press Roll to flip `spinning` true; the stepped spin runs
// (~1s) and lands the numeral on `onSpinComplete` — the RollCard's exact contract.
function SpinDemo({ reducedMotion }: { reducedMotion: boolean }): React.JSX.Element {
  const [spinning, setSpinning] = useState(false)
  const [result, setResult] = useState<number | null>(null)

  const roll = (): void => {
    setResult(Math.floor(Math.random() * 20) + 1)
    setSpinning(true)
  }

  return (
    <div className="flex flex-col items-center gap-[var(--space-4)] text-ink">
      <DieSpin
        spinning={spinning}
        result={result}
        reducedMotion={reducedMotion}
        onSpinComplete={() => {
          setSpinning(false)
        }}
        {...(result === null ? {} : { resultLabel: `[ph: you rolled a ${String(result)}]` })}
      />
      <button
        type="button"
        className="border border-border-strong px-[var(--space-3)] py-[var(--space-1)] font-ui text-sm uppercase tracking-wide"
        onClick={roll}
      >
        [ph: roll]
      </button>
    </div>
  )
}

// The stepped spin, driven end-to-end (Roll → spin → land).
export const Spinning: Story = {
  render: () => <SpinDemo reducedMotion={false} />,
}

// Reduced motion: the same Roll lands the numeral INSTANTLY (no spin churn).
export const ReducedMotion: Story = {
  name: 'Reduced motion (instant land)',
  render: () => <SpinDemo reducedMotion />,
}
