import type { Meta, StoryObj } from '@storybook/react-vite'
import { ThinkingIndicator } from './ThinkingIndicator.tsx'

// ThinkingIndicator — the quiet liveness line under the live-play transcript:
// "DM is thinking…" while a DM turn is open, plus player-typing presence. Purely
// presentational: each specimen hands it fixed booleans/names. The labels are
// realistic placeholders (MYT-100 owns the real copy); the names are sample
// data (stories are lint-exempt). The DM-thinking line carries the design system's
// Spinner (the locked diagonal dither wave) as its activity mark — the same busy
// indicator the app uses everywhere else; it self-freezes to a static dither under
// prefers-reduced-motion (toggle your OS setting to see it hold steady).

const THINKING_LABEL = 'the DM is thinking…'
const TYPING_LABEL = 'is typing…'

const meta: Meta<typeof ThinkingIndicator> = {
  title: 'Session/ThinkingIndicator',
  component: ThinkingIndicator,
  tags: ['autodocs'],
  args: { thinkingLabel: THINKING_LABEL, typingLabel: TYPING_LABEL },
  // A paper page ground so the quiet mono line reads as it does on the real screen.
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

type Story = StoryObj<typeof ThinkingIndicator>

// The DM is composing the next turn — the Spinner mark runs beside the line.
export const Thinking: Story = {
  name: 'DM thinking',
  args: { thinking: true, typingNames: [] },
}

// A single player is typing at the table.
export const OneTyper: Story = {
  name: 'One player typing',
  args: { thinking: false, typingNames: ['Kessa'] },
}

// The DM is thinking AND two players are typing — both quiet lines stack.
export const ThinkingAndTyping: Story = {
  name: 'Thinking + typing',
  args: { thinking: true, typingNames: ['Kessa', 'Bram'] },
}

// Idle — the live region stays mounted (to announce the next change) but shows
// nothing.
export const Idle: Story = {
  name: 'Idle (empty live region)',
  args: { thinking: false, typingNames: [] },
}
