import type { Meta, StoryObj } from '@storybook/react-vite'
import { SessionPreparing } from './SessionPreparing.tsx'

// SessionPreparing — the calm between-sessions hold (myth-ep74g). When a session has
// just ended and the next one isn't startable yet, the play route sits here while the
// start-flow hook backoff-polls in the background. One unhurried atmospheric line over
// a breathing 1-bit figure — no itinerary, no spinner, no retry storm. Same paper /
// ordered-Bayer register as SessionStartBeat so the two beats read as one family.
//
// Do: keep it quiet and unhurried — the wait can run a minute or two; the figure's
//   slow breath is the only motion.
// Don't: add a progress bar, a countdown, or a "retry now" button — the hook owns the
//   cadence; this surface just holds the screen calmly.
// Content/i18n: `label` / `detail` are resolved [ph:] chrome the consumer passes.

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

// Test-double copy (stories are i18n-exempt; the real [ph:] bundle resolves route-side).
const LABEL = 'The DM is preparing the next session…'
const DETAIL = 'This can take a moment.'

export const Default: Story = {
  name: 'Preparing (breathing)',
  args: { label: LABEL, detail: DETAIL, reducedMotion: false },
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
