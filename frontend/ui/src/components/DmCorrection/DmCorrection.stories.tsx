import type { Meta, StoryObj } from '@storybook/react-vite'
import { DmCorrection } from './DmCorrection.tsx'
import { DmMessage } from '../DmMessage/DmMessage.tsx'

// DmCorrection — the DM's errata register in the live transcript (myth-d6knq). A
// rare, legitimate amendment of something previously narrated, rendered as a
// set-apart errata slip: a ruled ledger-margin note in the machine face, laid into
// the record. NOT the DM narrative register — the mono face + the ink left rule say
// "this is a note about the story, not the story". Quiet by design: it reads as the
// record being kept honest, never as an alarm.
//
// Do: keep it terse and quiet — a correction is errata, not a retraction notice.
// Don't: colour it (no red/warning), badge it, or round it — the brand is square
//   1-bit paper; the distinction is the mono face + the ruled margin, nothing more.
// Content/i18n: `text` is DM DATA (never an i18n key); `label` is the resolved i18n
//   errata eyebrow the consumer passes.

const meta: Meta<typeof DmCorrection> = {
  title: 'Session/DmCorrection',
  component: DmCorrection,
  tags: ['autodocs'],
}

// eslint-disable-next-line no-restricted-syntax -- Storybook CSF requires the meta object as the module's default export.
export default meta

type Story = StoryObj<typeof DmCorrection>

// Test-double label (stories are i18n-exempt; the real i18n bundle resolves route-side).
const LABEL = 'Correction'

export const Default: Story = {
  name: 'Errata slip',
  args: {
    text: 'Earlier I said the gate was oak — it is iron, banded and cold. The rest of the room stands as described.',
    label: LABEL,
  },
}

export const Terse: Story = {
  name: 'Terse amendment',
  args: {
    text: 'The innkeeper is named Perrin, not Perry.',
    label: LABEL,
  },
}

// In situ: a correction set into the stream just after the DM prose it amends — the
// slip reads as clearly apart from the narration above it (the whole point).
export const InTranscript: Story = {
  name: 'Set into the transcript',
  render: () => (
    <div className="flex flex-col gap-[var(--space-2)]">
      <DmMessage
        text={
          'You push through into the guardroom. A heavy oak gate bars the far arch, its ' +
          'timbers grey with age.'
        }
        streaming={false}
      />
      <DmCorrection text="The gate is iron, not oak — banded and cold to the touch." label={LABEL} />
    </div>
  ),
}

// Mobile (~375px): the slip wraps a long amendment inside the column, no horizontal
// overflow — the min-w-0 / break-words discipline the transcript column relies on.
export const Narrow: Story = {
  name: 'Narrow (~375px)',
  render: () => (
    <div className="max-w-[375px]">
      <DmCorrection
        text="Correction: the caravan-master mentioned earlier is Halden of Westreach, not Holden — and he travels north, not south."
        label={LABEL}
      />
    </div>
  ),
}
