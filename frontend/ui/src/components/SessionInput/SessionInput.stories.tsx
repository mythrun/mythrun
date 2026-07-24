import { useState } from 'react'
import type { Meta, StoryObj } from '@storybook/react-vite'
import { SessionInput } from './SessionInput.tsx'

// SessionInput — the live-play composer: a controlled text field, a Send
// affordance, and a prominent @DM summon. The @DM summon is a real, bordered
// `secondary` affordance — prominent (easy to find) but register-QUIET (paper-y,
// not ember-loud, not gamerspeak); Send is the primary action. Enter sends;
// Shift+Enter inserts a newline. `disabled` gates both intents while the session
// is ended / not-ready.
//
// Content/i18n: `placeholder` + `summonLabel` + `sendLabel` are resolved i18n
// strings the consumer supplies (the component hard-codes no copy); the stories
// show resolved specimen prose so the composer reads correctly in the catalogue.
// The visible `@dm` token composition + broadcast live at the route wire, not
// here — the button just fires `onSummonDm`.

const LABELS = {
  placeholder: 'Say or do something…',
  summonLabel: 'Ask the DM',
  sendLabel: 'Send',
}

// A controlled specimen — SessionInput is a controlled composer (value/onChange),
// so the catalogue drives the value the way the route wire will in the app.
function ComposerSpecimen({
  initial = '',
  disabled = false,
  busy = false,
}: {
  initial?: string
  disabled?: boolean
  busy?: boolean
}) {
  const [value, setValue] = useState(initial)
  return (
    <div className="mx-auto w-[40rem] max-w-full">
      <SessionInput
        value={value}
        onChange={setValue}
        onSend={() => {
          setValue('')
        }}
        onSummonDm={() => {
          setValue((v) => (v ? `${v} @dm` : '@dm'))
        }}
        disabled={disabled}
        busy={busy}
        busyLabel="The DM is writing…"
        placeholder={LABELS.placeholder}
        summonLabel={LABELS.summonLabel}
        sendLabel={LABELS.sendLabel}
      />
    </div>
  )
}

const meta: Meta<typeof SessionInput> = {
  title: 'Session/SessionInput',
  component: SessionInput,
  tags: ['autodocs'],
}

// eslint-disable-next-line no-restricted-syntax -- Storybook CSF requires the meta object as the module's default export.
export default meta

type Story = StoryObj<typeof SessionInput>

// Empty — the resting composer: a faint placeholder, the quiet @DM summon on the
// left, the primary Send on the right.
export const Empty: Story = {
  render: () => <ComposerSpecimen />,
}

// Typed — a message in progress. Enter would send; Shift+Enter adds a line.
export const Typed: Story = {
  render: () => <ComposerSpecimen initial="I edge toward the door and listen for footsteps." />,
}

// Disabled — both intents gated (session ended / not-ready): the field and both
// affordances are inert and muted.
export const Disabled: Story = {
  render: () => <ComposerSpecimen initial="The session has ended." disabled />,
}

// Busy — the DM is mid-turn (myth-dd63v). Send + @DM are gated and a quiet
// caption names why, but the field stays typeable so you can draft ahead; no
// send is ever silently swallowed.
export const Busy: Story = {
  render: () => <ComposerSpecimen initial="I press on into the dark." busy />,
}

// Mobile (~375px) — the composer at the mweb floor: the field is full-width and
// the affordance row stays legible with the @DM summon and Send at the ends.
export const Mobile: Story = {
  name: 'Mobile — ~375px',
  render: () => (
    <div className="mx-auto max-w-[375px] bg-bg p-[var(--space-4)]">
      <ComposerSpecimen />
    </div>
  ),
}
