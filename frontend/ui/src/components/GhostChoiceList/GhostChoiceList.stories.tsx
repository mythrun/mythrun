import type { Meta, StoryObj } from '@storybook/react-vite'
import { GhostChoiceList } from './GhostChoiceList.tsx'

// GhostChoiceList — a borderless "paper" choice list (the flat 1-bit register).
// Each item is a REAL <button> (native keyboard activation + a11y) styled as a
// ghost: transparent fill, a neutral surface token-swap on hover/press, a serif
// title over a quiet tertiary-ink sub-line, and a trailing ember arrow. NO
// border, NO box, NO glyph mark — the only chrome is the quiet Divider hairlines
// that FRAME and SEPARATE the choices (a rule above the first, between each, and
// below the last). Single column at every width; flat (0px radius).
//
// The canonical use is the campaign-create fork: two paths, no cards, no radios.
// Content/i18n: `title`/`subtitle` are display strings the consumer resolves.

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

// Titles only — the subtitle is optional; the list still frames and separates.
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
