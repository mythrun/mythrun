import { useState } from 'react'
import type { Meta, StoryObj } from '@storybook/react-vite'
import { WikiHome } from './WikiHome.tsx'
import { WIKI_FIXTURE_MODEL, WIKI_FIXTURE_MODEL_BARE } from './wiki-fixture.ts'

// WikiHome — the wiki's landing. With an introduction on the model it is the
// world's front door: the serif world-name title, the grounding prose as
// paragraphs, the dig-deeper references, then the mono INDEX label over the
// search + browse-by-kind groups — one scrolling field-guide surface. Without
// one (a pre-migration world) it is the browse landing alone. Flat 1-bit
// paper register: hairline rules between sections, no boxes or chips.

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
  referencesLabel: '[placeholder for dig deeper]',
  indexLabel: '[placeholder for index]',
  groupLabels: {
    faction: '[placeholder for Factions]',
    location: '[placeholder for Locations]',
    npc: '[placeholder for People]',
    item: '[placeholder for Items]',
  },
} as const

interface HomeDemoProps {
  initialQuery?: string
  model?: typeof WIKI_FIXTURE_MODEL
}

function HomeDemo({ initialQuery = '', model = WIKI_FIXTURE_MODEL }: HomeDemoProps): React.JSX.Element {
  const [selectedId, setSelectedId] = useState<string>()
  const [query, setQuery] = useState(initialQuery)
  return (
    <div className="min-h-dvh bg-bg p-[var(--space-6)]">
      <div className="mx-auto h-[70vh] max-w-sm">
        <WikiHome
          model={model}
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

// The front door: the world-name title moment over the intro prose, the
// dig-deeper references, and the search + browse index one scroll below.
// Opening a row marks it here (the composed WorldWiki navigates to the page
// instead — see Patterns/WorldWiki/WorldWiki).
export const Introduction: Story = {
  render: () => <HomeDemo />,
}

// A pre-migration world (no introduction): the browse landing alone — the
// search field pinned over the scrolling groups. The graceful absence.
export const BrowseOnly: Story = {
  render: () => <HomeDemo model={WIKI_FIXTURE_MODEL_BARE} />,
}

// The search-narrowed state: a preset query filters the groups (keeping a
// nested match's ancestor path); the field is live, so clearing it restores
// the full browse view.
export const Filtered: Story = {
  render: () => <HomeDemo initialQuery="ward" />,
}
