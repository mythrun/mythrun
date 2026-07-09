import { useState } from 'react'
import type { Meta, StoryObj } from '@storybook/react-vite'
import { expect, userEvent, within } from 'storybook/test'
import { WorldWiki } from './WorldWiki.tsx'
import { WIKI_FIXTURE_MODEL } from './wiki-fixture.ts'

// WorldWiki — the browsable wiki the owner explores their newly-generated
// world through, as a real PLACE: a home landing (search over browse-by-kind
// groups) opening onto per-entity pages (mono kind tag over serif name, the
// composed fact body, RELATED cross-links, a quiet back button with per-page
// scroll memory). Flat 1-bit paper register — hairline rules, surface-swap
// hover, no boxes/cards/chips.

const meta: Meta<typeof WorldWiki> = {
  title: 'Patterns/WorldWiki/WorldWiki',
  component: WorldWiki,
  tags: ['autodocs'],
  parameters: { layout: 'fullscreen' },
}

// eslint-disable-next-line no-restricted-syntax -- Storybook CSF requires the meta object as the module's default export.
export default meta

type Story = StoryObj<typeof WorldWiki>

const LABELS = {
  searchLabel: '[placeholder for the search field label]',
  searchPlaceholder: '[placeholder for the search hint]',
  emptyLabel: '[placeholder for the empty-results note]',
  backLabel: '[placeholder for back]',
  relatedLabel: '[placeholder for related]',
  emptyBodyLabel: '[placeholder for the empty-page note]',
  groupLabels: {
    faction: '[placeholder for Factions]',
    location: '[placeholder for Locations]',
    npc: '[placeholder for People]',
    item: '[placeholder for Items]',
  },
} as const

function WikiDemo({ paneClass = 'h-[70vh]' }: { paneClass?: string }): React.JSX.Element {
  const [selectedId, setSelectedId] = useState<string>()
  const [query, setQuery] = useState('')
  return (
    <div className="min-h-dvh bg-bg p-[var(--space-6)]">
      <div className={`mx-auto max-w-sm ${paneClass}`}>
        <WorldWiki
          model={WIKI_FIXTURE_MODEL}
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

// The resting landing: search over the kind groups, every row a page opening.
export const Home: Story = {
  render: () => <WikiDemo />,
}

// The reader's journey, driven for real in the browser sweep: home → open The
// Tallow Guild → scroll the page → hop its RELATED link to Maeris Vale → back
// to the guild, where the SCROLL POSITION survives (the D3 stack's memory,
// proven in real Chromium — the pane is a fixed 16rem so the guild page
// genuinely overflows at every sweep viewport). The play() ends ON the
// populated guild page, so the 375/1280 overflow gate measures the page view.
export const Journey: Story = {
  render: () => <WikiDemo paneClass="h-64" />,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await userEvent.click(canvas.getByRole('button', { name: 'The Tallow Guild' }))
    await expect(canvas.getByRole('heading', { name: 'The Tallow Guild' })).toBeInTheDocument()
    // Scroll the page, remembering the browser-clamped real offset.
    const article = canvasElement.querySelector('article')
    if (article === null) throw new Error('the wiki page rendered no <article>')
    article.scrollTop = 9999
    const scrolled = article.scrollTop
    await expect(scrolled).toBeGreaterThan(0)
    // RELATED hop → the target's page, seated at the top.
    await userEvent.click(canvas.getByRole('button', { name: /Maeris Vale/ }))
    await expect(canvas.getByRole('heading', { name: 'Maeris Vale' })).toBeInTheDocument()
    await expect(article.scrollTop).toBe(0)
    // Back restores the guild page AND the reader's position, verbatim.
    await userEvent.click(canvas.getByRole('button', { name: '[placeholder for back]' }))
    await expect(canvas.getByRole('heading', { name: 'The Tallow Guild' })).toBeInTheDocument()
    await expect(article.scrollTop).toBe(scrolled)
  },
}
