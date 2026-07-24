import type { Meta, StoryObj } from '@storybook/react-vite'
import { SessionPreparing } from './SessionPreparing.tsx'

// SessionPreparing — the calm between-sessions hold (myth-ep74g; MYT-102 timer
// revamp). When a session has just ended and the next one isn't startable yet, the
// play route sits here while the start-flow hook backoff-polls in the background.
// An unhurried atmospheric line over an AMBIENT breathing square, plus a coarse
// wait line so the player knows roughly how long and that nothing has broken.
//
// Do: keep it quiet and unhurried; the breathing SQUARE reads as ambient texture,
//   not a progress bar; show a COARSE estimate ("2 min remaining") when a baseline
//   holds, and the "still working…" line once it exhausts.
// Don't: reshape the figure back into a full-width band (it reads as an unfilled
//   progress bar — the confusion this revamp fixed); add a ticking M:SS or a
//   "retry now" button — the hook owns the cadence.
// Content/i18n: `label` / `detail` / `countdownLabel` / `stalledLabel` are resolved
//   chrome the consumer passes (the route owns the timing).

const meta: Meta<typeof SessionPreparing> = {
  title: 'Session/SessionPreparing',
  component: SessionPreparing,
  tags: ['autodocs'],
  argTypes: {
    reducedMotion: { control: 'boolean' },
  },
}

// eslint-disable-next-line no-restricted-syntax -- Storybook CSF requires the meta object as the module's default export.
export default meta

type Story = StoryObj<typeof SessionPreparing>

// Test-double copy (stories are i18n-exempt; the real i18n bundle resolves route-side).
const LABEL = 'The DM is preparing the next session…'
const DETAIL = 'This can take a moment.'

export const Default: Story = {
  name: 'Preparing (cold-start — detail fallback)',
  args: { label: LABEL, detail: DETAIL, reducedMotion: false },
}

// With a coarse estimate — a prep-duration baseline exists, so the beat shows how
// much longer (minute-granular, never a ticking M:SS). The estimate replaces the
// calm detail fallback.
export const WithCountdown: Story = {
  name: 'With estimate (coarse)',
  args: { label: LABEL, detail: DETAIL, countdownLabel: '2 min remaining', reducedMotion: false },
}

// Stalled — the estimate exhausted (or the wait ran long with no baseline): the
// "still working" line answers "has it broken?" without a stuck bar.
export const Stalled: Story = {
  name: 'Stalled (taking longer than usual)',
  args: {
    label: LABEL,
    detail: DETAIL,
    stalledLabel: 'Still working. This is taking longer than usual.',
    reducedMotion: false,
  },
}

export const LabelOnly: Story = {
  name: 'Label only',
  args: { label: LABEL, reducedMotion: false },
}

export const ReducedMotion: Story = {
  name: 'Reduced motion (still figure)',
  args: { label: LABEL, detail: DETAIL, reducedMotion: true },
}

// Mobile (~375px): the atmospheric line + detail wrap inside the column, no overflow.
export const Narrow: Story = {
  name: 'Narrow (~375px)',
  render: () => (
    <div className="max-w-[375px]">
      <SessionPreparing
        label="The DM is preparing the next session…"
        detail="Weaving the threads of what happened last time into what comes next."
        reducedMotion={false}
      />
    </div>
  ),
}
