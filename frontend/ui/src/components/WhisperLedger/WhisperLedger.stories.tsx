import type { Meta, StoryObj } from '@storybook/react-vite'
import { WhisperLedger } from './WhisperLedger.tsx'

// WhisperLedger — the shared long-wait whisper column (ux-run2 myth-i2pdo): the
// current flavor line over a faint ledger of previously shown lines, newest
// first, oldest most faded. The growing list IS the progress texture — a wait
// that has visibly been lived through. Purely presentational: the composing
// surface (WorldGenLoading / SessionPreparing) owns the cycle (useWhisperCycle),
// the copy, and the cadence; under reduced motion the cycle holds and the
// ledger stays empty. Wholly decorative (aria-hidden) — the surface owns the
// busy semantics.
//
// Do: keep the ledger faint — it is texture, not content; let the current line
//   carry the voice.
// Don't: animate entries in (the settle is a hard swap — paper register); let
//   state ride on the opacity ladder (decoration only).

const meta: Meta<typeof WhisperLedger> = {
  title: 'Patterns/WhisperLedger',
  component: WhisperLedger,
  tags: ['autodocs'],
  decorators: [
    (Story) => (
      <div className="bg-bg p-[var(--space-6)]">
        <Story />
      </div>
    ),
  ],
}

// eslint-disable-next-line no-restricted-syntax -- Storybook CSF requires the meta object as the module's default export.
export default meta

type Story = StoryObj<typeof WhisperLedger>

// Real world-gen flavor copy (worldGen.flavor*) — the hero surface's register.
const HISTORY = ['The first grave is marked.', 'Waters spring forth.', 'A gift is given.', 'Languages find their words.']

// HERO — the world-gen calm wait: the current line carries a headline's job
// (~20px) because it is the only content on the screen (myth-xe38q).
export const Hero: Story = {
  args: { current: 'Ink is put to page.', history: HISTORY },
}

// SUB — the session-prep register: a quiet sub-line under a serif title.
export const Sub: Story = {
  args: { size: 'sub', current: 'The locals take their seats.', history: HISTORY.slice(0, 2) },
}

// FRESH — nothing settled yet (a fresh mount, or reduced motion holding the
// opening line): just the current whisper, no ledger.
export const Fresh: Story = {
  args: { current: 'The gods decide what to name themselves.', history: [] },
}
