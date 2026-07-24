import type { Meta, StoryObj } from '@storybook/react-vite'
import { GhostHookList } from './GhostHookList.tsx'

// GhostHookList — a richer sibling of GhostChoiceList (the flat 1-bit register),
// carded to the LevelCard standard (ux-run1 myth-occld). Each item is a REAL
// <button> that is a whole SELECTABLE CARD: a 1px interactive border on the
// surface fill, comfortable padding, a decisive hover (edge → full ink + surface
// token-swap), and a STACKED serif title over an optional quiet place line over a
// prose paragraph capped to a readable measure, with a docked ember arrow
// vertically centred against the card. The ENTIRE card is the click target; cards
// are separated by a gap (not hairline rules). Single column at every width; flat
// (0px radius).
//
// The canonical use is the starting-situation pick: three opening hooks, each a
// title + a place + a prose paragraph. Content is DATA the consumer supplies
// (LLM-authored title/place/prose), not i18n keys.

const meta: Meta<typeof GhostHookList> = {
  title: 'Patterns/GhostHookList',
  component: GhostHookList,
  tags: ['autodocs'],
}

// eslint-disable-next-line no-restricted-syntax -- Storybook CSF requires the meta object as the module's default export.
export default meta

type Story = StoryObj<typeof GhostHookList>

// Per-item `onSelect` is nested inside `items`, so it can't ride the top-level
// `argTypes` action mapping; a shared no-op keeps the specimens declarative.
const noop = (): void => undefined

// The starting-situation pick — three opening hooks the owner chooses between.
export const StartingSituations: Story = {
  name: 'Starting-situation pick',
  render: () => (
    <div className="max-w-[560px] bg-bg p-[var(--space-6)]">
      <GhostHookList
        items={[
          {
            id: '0',
            title: 'The harbour at low tide',
            place: 'Ashfen Reach',
            prose:
              'A grey dawn over the mudflats. A fishing skiff has come in wrong — its lantern still lit, its crew gone. The harbourmaster is asking questions nobody wants to answer.',
            onSelect: noop,
          },
          {
            id: '1',
            title: 'A debt come due',
            place: 'The Salt Ledger',
            prose:
              'The counting-house wants what it is owed, and it has sent someone patient to collect. You have until the next bell to find another way to pay.',
            onSelect: noop,
          },
          {
            id: '2',
            title: 'Smoke over the moor',
            place: 'Greywater Fen',
            prose:
              'The beacon on the far ridge is burning out of season. No one lit it by custom. Whatever it means, it means it now.',
            onSelect: noop,
          },
        ]}
      />
    </div>
  ),
}

// Place omitted — the sub-line is optional; the cards still stand on their own.
export const PlaceOmitted: Story = {
  render: () => (
    <div className="max-w-[560px] bg-bg p-[var(--space-6)]">
      <GhostHookList
        items={[
          {
            id: 'a',
            title: 'An open road',
            prose: 'The map ends here and the world keeps going. Pick a direction and walk.',
            onSelect: noop,
          },
          {
            id: 'b',
            title: 'A closed door',
            prose: 'It was locked from the inside, and the key is gone. Someone wanted it that way.',
            onSelect: noop,
          },
        ]}
      />
    </div>
  ),
}
