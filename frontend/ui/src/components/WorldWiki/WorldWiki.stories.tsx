import { useState } from 'react'
import type { Meta, StoryObj } from '@storybook/react-vite'
import type { WikiViewModel } from '@mythrun/client-core/contract'
import { WorldWiki } from './WorldWiki.tsx'

// WorldWiki — the browsable wiki the owner explores their newly-generated world
// through. A borderless search field over a grouped tree (factions / locations /
// npcs / items); nested locations indent under their parent; the selected entity
// opens to its facts. Flat 1-bit paper register — hairline rules between groups, a
// quiet surface swap on the selected row, no boxes/cards/circles.

const meta: Meta<typeof WorldWiki> = {
  title: 'Patterns/WorldWiki',
  component: WorldWiki,
  tags: ['autodocs'],
  parameters: { layout: 'fullscreen' },
}

// eslint-disable-next-line no-restricted-syntax -- Storybook CSF requires the meta object as the module's default export.
export default meta

type Story = StoryObj<typeof WorldWiki>

// A small sample world with a nested location (Ashfen Reach → The Drowned Ward) and
// a handful of facts, the shape `toWikiViewModel` (D1) produces from a snapshot.
const MODEL: WikiViewModel = {
  groups: [
    {
      kind: 'faction',
      entities: [
        {
          id: 'f1',
          name: 'The Tallow Guild',
          facts: [
            { id: 'f1a', topic: 'Purpose', content: '[placeholder for a faction purpose]' },
            { id: 'f1b', topic: 'Reputation', content: '[placeholder for how the guild is regarded]' },
          ],
        },
      ],
    },
    {
      kind: 'location',
      entities: [
        {
          id: 'l1',
          name: 'Ashfen Reach',
          facts: [{ id: 'l1a', topic: 'Terrain', content: '[placeholder for the terrain of the reach]' }],
          children: [
            {
              id: 'l2',
              name: 'The Drowned Ward',
              facts: [{ id: 'l2a', topic: 'Note', content: '[placeholder for a note about the ward]' }],
            },
          ],
        },
        { id: 'l3', name: 'Sunspire', facts: [{ id: 'l3a', topic: 'Note', content: '[placeholder for a note about Sunspire]' }] },
      ],
    },
    { kind: 'npc', entities: [{ id: 'n1', name: 'Maeris Vale', facts: [{ id: 'n1a', topic: 'Role', content: '[placeholder for a role]' }] }] },
    { kind: 'item', entities: [{ id: 'i1', name: 'The Salt Ledger', facts: [] }] },
  ],
}

const LABELS = {
  searchLabel: '[placeholder for the search field label]',
  searchPlaceholder: '[placeholder for the search hint]',
  emptyLabel: '[placeholder for the empty-results note]',
  groupLabels: {
    faction: '[placeholder for Factions]',
    location: '[placeholder for Locations]',
    npc: '[placeholder for People]',
    item: '[placeholder for Items]',
  },
} as const

function WikiDemo({ initialQuery = '' }: { initialQuery?: string }): React.JSX.Element {
  const [selectedId, setSelectedId] = useState<string>()
  const [query, setQuery] = useState(initialQuery)
  return (
    <div className="min-h-dvh bg-bg p-[var(--space-6)]">
      <div className="mx-auto h-[70vh] max-w-sm">
        <WorldWiki
          model={MODEL}
          {...(selectedId !== undefined ? { selectedId } : {})}
          onSelect={setSelectedId}
          query={query}
          onQuery={setQuery}
          {...LABELS}
        />
      </div>
    </div>
  )
}

// The full tree, browsable: click an entity to open it to its facts; the nested
// ward indents under its parent reach.
export const Browsable: Story = {
  render: () => <WikiDemo />,
}

// The search-narrowed state: a preset query filters the tree to the matches (and
// the ancestor path of any nested hit); the field is live, so clearing it restores
// the full tree.
export const Filtered: Story = {
  render: () => <WikiDemo initialQuery="ward" />,
}
