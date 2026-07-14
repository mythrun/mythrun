import type { Meta, StoryObj } from '@storybook/react-vite'
import { SessionStartBeat } from './SessionStartBeat.tsx'

// SessionStartBeat — the beat that holds the screen between pressing Start and the
// first DM token. The 1-bit tile fills from the base (a reused Dither hatch rising
// with an ease-in "acceleration") beside the two phase rows. ONE beat, TWO labeled
// phases: `prep` (the SSE-driven atmospheric wait) and `connecting` (the short
// socket-connect boundary). Pure/presentational: the specimens hand it a fixed
// `phase`. The labels are realistic samples (stories are lint-exempt); the real
// screen passes the resolved [ph:] i18n strings.

const PREP_LABEL = 'the DM is preparing tonight’s session…'
const CONNECTING_LABEL = 'connecting to the table…'

const meta: Meta<typeof SessionStartBeat> = {
  title: 'Session/SessionStartBeat',
  component: SessionStartBeat,
  tags: ['autodocs'],
  args: { prepLabel: PREP_LABEL, connectingLabel: CONNECTING_LABEL },
  // A paper page ground so the loadwrap card reads as it does on the real screen.
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

type Story = StoryObj<typeof SessionStartBeat>

// Prep — the long atmospheric wait; the hatch is partway up, prep active in ember,
// connecting still ahead (dimmed but solid-token).
export const Prep: Story = {
  name: 'Prep (the DM is preparing)',
  args: { phase: 'prep', reducedMotion: false },
}

// Connecting — the socket-connect boundary; the hatch has risen to full (the beat
// landing), prep now done, connecting active.
export const Connecting: Story = {
  name: 'Connecting (socket boundary)',
  args: { phase: 'connecting', reducedMotion: false },
}

// Reduced motion — the same prep snapshot with every transition dropped (the fill
// snaps to its proportion; rows swap state with no fade — it lands instantly).
export const ReducedMotion: Story = {
  name: 'Reduced motion (prep, no transitions)',
  args: { phase: 'prep', reducedMotion: true },
}

// Narrow — the loadwrap at ~375px, confirming the figure + text column hold
// together (the text column is min-w-0, the figure a fixed base).
export const Narrow: Story = {
  name: 'Mobile (~375px)',
  render: (args) => (
    <div className="max-w-[375px]">
      <SessionStartBeat {...args} />
    </div>
  ),
  args: { phase: 'prep', reducedMotion: false },
}
