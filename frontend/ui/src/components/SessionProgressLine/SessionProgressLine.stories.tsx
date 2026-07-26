import type { Meta, StoryObj } from '@storybook/react-vite'
import { SessionProgressLine } from './SessionProgressLine.tsx'

// SessionProgressLine — where the table is in this session, as one quiet mono line
// in the between-turns chrome. The underlying signal is mechanical and COST-derived
// (token budget + context fill), which is exactly why it is rendered as a word and
// never as a meter: a bar or a "62%" over the fiction reads as money spent, not as
// story remaining.
//
// Do: keep it to one line in the mono record register; let the band lift the INK as
//   the session closes (tertiary → secondary → full); pass an already-resolved word.
// Don't: add a bar, a percentage, a numeral, a chip, a dot, or a colour; announce it
//   loudly (it is chrome beside the fiction, not an alarm); show it at all when there
//   is no signal yet — the surface renders nothing rather than guessing a band.
// Content/i18n: `label` is resolved route-side (play.progress.early|middle|late|close).

const meta: Meta<typeof SessionProgressLine> = {
  title: 'Session/SessionProgressLine',
  component: SessionProgressLine,
  tags: ['autodocs'],
  argTypes: {
    band: { control: 'inline-radio', options: ['early', 'middle', 'late', 'close'] },
  },
}

// eslint-disable-next-line no-restricted-syntax -- Storybook CSF requires the meta object as the module's default export.
export default meta

type Story = StoryObj<typeof SessionProgressLine>

// The real route copy (play.progress.*).
const EARLY = 'Early in the session'
const MIDDLE = 'Midway through the session'
const LATE = 'Nearing the end'
const CLOSE = 'The last stretch'

export const Early: Story = {
  name: 'Early (quiet — no end control on the surface yet)',
  args: { label: EARLY, band: 'early' },
}

export const Middle: Story = {
  name: 'Middle',
  args: { label: MIDDLE, band: 'middle' },
}

export const Late: Story = {
  name: 'Late (the end control surfaces alongside)',
  args: { label: LATE, band: 'late' },
}

export const Close: Story = {
  name: 'Close (full ink — the landing is here)',
  args: { label: CLOSE, band: 'close' },
}

// The four together: the whole vocabulary, and the only thing that changes across it.
export const AllBands: Story = {
  name: 'All four bands (the ink is the only escalation)',
  render: () => (
    <div className="flex flex-col gap-[var(--space-2)]">
      <SessionProgressLine label={EARLY} band="early" data-testid="band-early" />
      <SessionProgressLine label={MIDDLE} band="middle" data-testid="band-middle" />
      <SessionProgressLine label={LATE} band="late" data-testid="band-late" />
      <SessionProgressLine label={CLOSE} band="close" data-testid="band-close" />
    </div>
  ),
}
