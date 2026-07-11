import type { Meta, StoryObj } from '@storybook/react-vite'
import { useState } from 'react'
import { LevelCard } from './LevelCard.tsx'
import type { CharacterLevel } from '@mythrun/client-core/contract'

// LevelCard — one owner-only starting-level pick (levels 1–5). The owner screen
// composes five of these into the "what level does your party begin at?" choice;
// picking one sets the party's shared starting level. The card is a REAL <button>
// (native click + keyboard), flat/square paper register, with an ember edge +
// inset ring on the selected pick. It is `w-full` and fills its cell, so the GRID
// (5-up on desktop) or the STACK (one column on mweb) is the parent's job — these
// stories supply that container.
//
// Content/i18n: `grantGloss` is the resolved "what this level grants" copy the
// shell passes in. The specimen glosses below are realistic samples (stories are
// lint-exempt).

const meta: Meta<typeof LevelCard> = {
  title: 'Character/LevelCard',
  component: LevelCard,
  tags: ['autodocs'],
}

// eslint-disable-next-line no-restricted-syntax -- Storybook CSF requires the meta object as the module's default export.
export default meta

type Story = StoryObj<typeof LevelCard>

// A shared no-op for the static specimens (expression body, so it's not an empty-
// function lint offender and doesn't return a bare `undefined`).
const noop = (): void => undefined

// The five launch levels + their plain-D&D grant glosses (mirrors the mockup).
const LEVELS: { level: CharacterLevel; grantGloss: string }[] = [
  { level: 1, grantGloss: 'Core class features. A true beginning.' },
  { level: 2, grantGloss: 'A second class feature; casters gain more slots.' },
  { level: 3, grantGloss: 'Your subclass. 2nd-level spells for full casters.' },
  { level: 4, grantGloss: 'First ability score improvement or feat.' },
  { level: 5, grantGloss: 'Extra Attack / 3rd-level spells. A real power spike.' },
]

// A tiny stateful harness so the specimen behaves like the real screen: clicking a
// card moves the ember selection. Seeds at level 3 (the mockup's chosen pick).
function LevelPicker({ columns }: { columns: string }): React.JSX.Element {
  const [picked, setPicked] = useState<CharacterLevel>(3)
  return (
    <div className="bg-bg p-[var(--space-6)]">
      <div className="grid gap-[var(--space-3)]" style={{ gridTemplateColumns: columns }}>
        {LEVELS.map(({ level, grantGloss }) => (
          <LevelCard
            key={level}
            level={level}
            grantGloss={grantGloss}
            selected={picked === level}
            onSelect={() => {
              setPicked(level)
            }}
          />
        ))}
      </div>
    </div>
  )
}

// Desktop — the five levels in a row, level 3 pre-selected (the ember edge + ring).
export const DesktopRow: Story = {
  name: 'Desktop — 5 across (level 3 selected)',
  render: () => <LevelPicker columns="repeat(5, 1fr)" />,
}

// Mobile — the same five cards stacked in a single column at ~375px.
export const MobileStacked: Story = {
  name: 'Mobile — stacked (~375px)',
  render: () => (
    <div className="mx-auto max-w-[375px]">
      <LevelPicker columns="1fr" />
    </div>
  ),
}

// The two selection states side by side (static — no harness), for a quick read of
// the unselected vs ember-selected treatment.
export const SelectionStates: Story = {
  name: 'Unselected vs selected',
  render: () => (
    <div className="grid max-w-[440px] grid-cols-2 gap-[var(--space-3)] bg-bg p-[var(--space-6)]">
      <LevelCard level={1} grantGloss="Core class features. A true beginning." selected={false} onSelect={noop} />
      <LevelCard level={3} grantGloss="Your subclass. 2nd-level spells." selected onSelect={noop} />
    </div>
  ),
}
