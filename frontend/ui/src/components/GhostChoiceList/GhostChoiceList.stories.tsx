import type { Meta, StoryObj } from '@storybook/react-vite'
import { GhostChoiceList } from './GhostChoiceList.tsx'

// GhostChoiceList — a carded "paper" choice list (the flat 1-bit register),
// brought up to the LevelCard standard (ux-run1 myth-occld). Each item is a REAL
// <button> (native keyboard activation + a11y) that is a whole SELECTABLE CARD: a
// 1px interactive border on the surface fill, comfortable padding, a serif title
// over a quiet tertiary-ink sub-line, a docked ember "enter" arrow vertically
// centred against the card, and a decisive hover (edge → full ink + surface
// token-swap). The ENTIRE card is the click target; cards are separated by a gap
// (not hairline rules). Single column at every width; flat (0px radius).
//
// The canonical use is the creation forks: the campaign-create fork (two paths
// into world creation) and the character-create path chooser. Content/i18n:
// `title`/`subtitle` are display strings the consumer resolves.

const meta: Meta<typeof GhostChoiceList> = {
  title: 'Patterns/GhostChoiceList',
  component: GhostChoiceList,
  tags: ['autodocs'],
}

// eslint-disable-next-line no-restricted-syntax -- Storybook CSF requires the meta object as the module's default export.
export default meta

type Story = StoryObj<typeof GhostChoiceList>

// Per-item `onSelect` is nested inside `items`, so it can't ride the top-level
// `argTypes` action mapping other stories use; a shared no-op keeps the specimens
// declarative (expression body, so it's not an empty-function lint offender).
const noop = (): void => undefined

// The campaign-create fork — the two paths into world creation.
export const CampaignCreateFork: Story = {
  name: 'Campaign-create fork',
  render: () => (
    <div className="max-w-[520px] bg-bg p-[var(--space-6)]">
      <GhostChoiceList
        items={[
          {
            id: 'freeform',
            title: 'Start from an idea',
            subtitle: 'Describe a vibe, a place, a what-if — a sentence is enough.',
            onSelect: noop,
          },
          {
            id: 'guided',
            title: 'Build from what you love',
            subtitle: 'Answer a few prompts and let the world take shape.',
            onSelect: noop,
          },
        ]}
      />
    </div>
  ),
}

// The character-create path chooser — the two ways to make a character. The title
// is the choice, the subtitle the one-line description; each card carries a testId
// so the route can address one path.
export const CharacterCreateChooser: Story = {
  name: 'Character-create chooser',
  render: () => (
    <div className="max-w-[520px] bg-bg p-[var(--space-6)]">
      <GhostChoiceList
        items={[
          {
            id: 'freeform',
            title: 'Simply describe your character',
            subtitle: "Write what's important to you and Mythrun will fill in the rest.",
            onSelect: noop,
            testId: 'chooser-freeform',
          },
          {
            id: 'guided',
            title: 'Build step by step',
            subtitle: 'Pick from options, question by question.',
            onSelect: noop,
            testId: 'chooser-guided',
          },
        ]}
      />
    </div>
  ),
}

// Titles only — the subtitle is optional; the cards still stand on their own.
export const TitlesOnly: Story = {
  render: () => (
    <div className="max-w-[520px] bg-bg p-[var(--space-6)]">
      <GhostChoiceList
        items={[
          { id: 'a', title: 'Continue where you left off', onSelect: noop },
          { id: 'b', title: 'Begin something new', onSelect: noop },
          { id: 'c', title: 'Browse the archive', onSelect: noop },
        ]}
      />
    </div>
  ),
}
