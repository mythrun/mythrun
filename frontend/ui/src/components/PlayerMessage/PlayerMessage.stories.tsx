import type { Meta, StoryObj } from '@storybook/react-vite'
import { PlayerMessage } from './PlayerMessage.tsx'

// PlayerMessage — one human-at-the-table utterance in the live transcript. The
// mono (--font-ui) register is the whole point: the DM narrates in serif, the
// players speak in machine mono — the split IS the DM/player distinction. A quiet
// paper tint distinct from the DM, NO avatar, NO bubble, NO status dot. `pending`
// is the optimistic in-flight own-echo (a quiet dim, never a spinner). Sample
// names are realistic specimens (stories are lint-exempt).

const meta: Meta<typeof PlayerMessage> = {
  title: 'Session/PlayerMessage',
  component: PlayerMessage,
  tags: ['autodocs'],
  args: {
    displayName: 'Miklos',
    characterName: 'Kessa Vurm',
    text: 'I push the tavern door open and step through, one hand on my axe.',
    pending: false,
  },
}

// eslint-disable-next-line no-restricted-syntax -- Storybook CSF requires the meta object as the module's default export.
export default meta

type Story = StoryObj<typeof PlayerMessage>

export const Confirmed: Story = {
  name: 'Confirmed (server-echoed)',
}

export const Pending: Story = {
  name: 'Pending (optimistic, in-flight)',
  args: { pending: true },
}

// No finalized character yet — the identity line falls back to just the human
// handle (Task 16 passes `characterName=''`); no empty label leaks in.
export const NoCharacterYet: Story = {
  name: 'Unfinalized character (handle only)',
  args: { characterName: '', text: 'Give me a sec, still rolling up my wizard.' },
}

// A short exchange — several rows stacked the way MessageStream renders them.
// Distinct-tint bands, mono throughout, no bubbles.
export const Stream: Story = {
  name: 'Stream (several rows)',
  render: () => (
    <div className="flex flex-col gap-[var(--space-2)]">
      <PlayerMessage
        displayName="Miklos"
        characterName="Kessa Vurm"
        text="I push the tavern door open and step through, one hand on my axe."
        pending={false}
      />
      <PlayerMessage
        displayName="Ordric"
        characterName="Ordric Vane"
        text="Wait for me — I want to check the room for other exits first."
        pending={false}
      />
      <PlayerMessage
        displayName="Pell"
        characterName="Bramble Underbough"
        text="Too late. I'm already at the bar ordering."
        pending
      />
    </div>
  ),
}

// Narrow-viewport (~375px) with a long character name + a long unbroken token:
// the identity line wraps and the body breaks — no horizontal scroll.
export const Narrow: Story = {
  name: 'Narrow (~375px, long name + unbroken token)',
  args: {
    displayName: 'a-very-long-player-handle-that-keeps-going',
    characterName: 'Thaddeus Aurelius Blackwood the Third',
    text: 'Aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa — and then the door slammed.',
  },
  render: (args) => (
    <div className="max-w-[375px]">
      <PlayerMessage {...args} />
    </div>
  ),
}
