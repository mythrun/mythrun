import { useState } from 'react'
import type { Meta, StoryObj } from '@storybook/react-vite'
import { WikiHome } from './WikiHome.tsx'
import { WIKI_FIXTURE_MODEL } from './wiki-fixture.ts'

// WikiHome — the wiki's landing: the borderless search field over the
// browse-by-kind groups (nested locations indent under their parent). Every
// row opens its entity's page. Flat 1-bit paper register: hairline rules
// between groups, no boxes or chips.

const meta: Meta<typeof WikiHome> = {
  title: 'Patterns/WorldWiki/WikiHome',
  component: WikiHome,
  tags: ['autodocs'],
  parameters: { layout: 'fullscreen' },
}

// eslint-disable-next-line no-restricted-syntax -- Storybook CSF requires the meta object as the module's default export.
export default meta

type Story = StoryObj<typeof WikiHome>

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

function HomeDemo({ initialQuery = '' }: { initialQuery?: string }): React.JSX.Element {
  const [selectedId, setSelectedId] = useState<string>()
  const [query, setQuery] = useState(initialQuery)
  return (
    <div className="min-h-dvh bg-bg p-[var(--space-6)]">
      <div className="mx-auto h-[70vh] max-w-sm">
        <WikiHome
          model={WIKI_FIXTURE_MODEL}
          selectedId={selectedId}
          onOpen={setSelectedId}
          query={query}
          onQuery={setQuery}
          {...LABELS}
        />
      </div>
    </div>
  )
}

// The full browse view; opening a row marks it here (the composed WorldWiki
// navigates to the page instead — see Patterns/WorldWiki/WorldWiki).
export const Default: Story = {
  render: () => <HomeDemo />,
}

// The search-narrowed state: a preset query filters the groups (keeping a
// nested match's ancestor path); the field is live, so clearing it restores
// the full browse view.
export const Filtered: Story = {
  render: () => <HomeDemo initialQuery="ward" />,
}
