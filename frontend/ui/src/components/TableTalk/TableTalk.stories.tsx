import type { Meta, StoryObj } from '@storybook/react-vite'
import { TableTalk } from './TableTalk.tsx'
import { PlayerMessage } from '../PlayerMessage/PlayerMessage.tsx'
import { DmMessage } from '../DmMessage/DmMessage.tsx'

// TableTalk — the marked out-of-character block in the live transcript
// (myth-1msig). An Ask-the-DM exchange framed in the table-note register: a mono
// eyebrow + a ruled slip mark the START of the aside, the attributed question
// rides inside in the players' mono, and the DM's serif answer closes with its
// own "Back to you." — the frame carries the boundary, so the pleasantry no
// longer has to.
//
// Do: keep the whole exchange INSIDE one frame — the transcript must never keep
//   the answer and hide the question.
// Don't: restyle the answer into mono (serif stays readable at answer length —
//   the boundary is the frame's job), badge it, or round it.
// Content/i18n: the question/answer are DATA; `label` is the resolved i18n
//   eyebrow the consumer passes.

const meta: Meta<typeof TableTalk> = {
  title: 'Session/TableTalk',
  component: TableTalk,
  tags: ['autodocs'],
}

// eslint-disable-next-line no-restricted-syntax -- Storybook CSF requires the meta object as the module's default export.
export default meta

type Story = StoryObj<typeof TableTalk>

// Test-double label (stories are i18n-exempt; the real i18n bundle resolves route-side).
const LABEL = 'Table talk'

export const Exchange: Story = {
  name: 'Question + answer',
  render: () => (
    <TableTalk label={LABEL}>
      <PlayerMessage
        displayName="Dev User 1"
        characterName="Corin Vale"
        text="@dm does Corin know what the brass key opens?"
        pending={false}
      />
      <DmMessage
        text={
          'What the key opens is not common knowledge at Corin’s tier. He has heard it said, in the way things get said without anyone claiming to know, that it belongs to the upper archive.\n\nBack to you.'
        }
        streaming={false}
      />
    </TableTalk>
  ),
}

export const QuestionAlone: Story = {
  name: 'Question framed alone (answer interrupted)',
  render: () => (
    <TableTalk label={LABEL}>
      <PlayerMessage
        displayName="Dev User 1"
        characterName="Corin Vale"
        text="@dm can I ask about the orrery later?"
        pending={false}
      />
    </TableTalk>
  ),
}

// In situ: the aside set between two narration rows — the frame reads as clearly
// apart from the serif story prose around it (the whole point).
export const InTranscript: Story = {
  name: 'In the stream (between narration)',
  render: () => (
    <div className="flex max-w-2xl flex-col gap-[var(--space-2)]">
      <DmMessage
        text="The orrery turns. Osric Fen has not stopped working the crank, though the rhythm has changed."
        streaming={false}
      />
      <TableTalk label={LABEL}>
        <PlayerMessage
          displayName="Dev User 1"
          characterName="Corin Vale"
          text="@dm what does the brass key open?"
          pending={false}
        />
        <DmMessage
          text="Not common knowledge at Corin’s tier — but the sound of that key on its cord means Vellin Ashar is somewhere above him. Back to you."
          streaming={false}
        />
      </TableTalk>
      <DmMessage text="From the upper tier, nothing. The erased ring passes the lamp-point." streaming={false} />
    </div>
  ),
}
