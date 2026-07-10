import { useState } from 'react'
import type { Meta, StoryObj } from '@storybook/react-vite'
import { expect, userEvent, within } from 'storybook/test'
import { WorldWiki } from './WorldWiki.tsx'
import { WIKI_FIXTURE_MODEL, WIKI_FIXTURE_MODEL_BARE } from './wiki-fixture.ts'

// WorldWiki — the browsable wiki the owner explores their newly-generated
// world through, as a real PLACE: home is the world's INTRODUCTION (the serif
// world-name title, the grounding prose, dig-deeper references, then the
// search + browse index one scroll below — or the browse landing alone for a
// pre-migration world), opening onto per-entity pages (mono kind tag over
// serif name, the composed fact body, RELATED cross-links, a quiet back
// button with per-page scroll memory). Flat 1-bit paper register — hairline
// rules, surface-swap hover, no boxes/cards/chips.

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
  referencesLabel: '[placeholder for dig deeper]',
  indexLabel: '[placeholder for index]',
  groupLabels: {
    faction: '[placeholder for Factions]',
    location: '[placeholder for Locations]',
    npc: '[placeholder for People]',
    item: '[placeholder for Items]',
  },
} as const

interface WikiDemoProps {
  paneClass?: string
  model?: typeof WIKI_FIXTURE_MODEL
}

function WikiDemo({ paneClass = 'h-[70vh]', model = WIKI_FIXTURE_MODEL }: WikiDemoProps): React.JSX.Element {
  const [selectedId, setSelectedId] = useState<string>()
  const [query, setQuery] = useState('')
  return (
    <div className="min-h-dvh bg-bg p-[var(--space-6)]">
      <div className={`mx-auto max-w-sm ${paneClass}`}>
        <WorldWiki
          model={model}
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

// The resting landing: the world's introduction — the title moment, the
// prose, the dig-deeper references — with the search + browse index below.
export const Home: Story = {
  render: () => <WikiDemo />,
}

// A pre-migration world (no introduction): home is the browse landing alone.
export const HomeBrowseOnly: Story = {
  render: () => <WikiDemo model={WIKI_FIXTURE_MODEL_BARE} />,
}

// The reader's journey, driven for real in the browser sweep: the wiki OPENS
// on the intro → read down to the dig-deeper references → open The Tallow
// Guild → scroll the page → hop its RELATED link to Maeris Vale → back to the
// guild (page scroll survives — the D3 stack's memory) → back to the INTRO,
// re-seated at the references (the shell's home scroll memory), all proven in
// real Chromium — the pane is a fixed 16rem so both the intro home and the
// guild page genuinely overflow at every sweep viewport. The play() ends on
// the intro home, so the 375/1280 overflow gate measures the front door.
export const Journey: Story = {
  render: () => <WikiDemo paneClass="h-64" />,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    // The wiki opens on the world's front door.
    await expect(canvas.getByRole('heading', { name: 'The Ashfen Reaches' })).toBeInTheDocument()
    // Read down the intro (the references live at the bottom), remembering the
    // browser-clamped real offset.
    const intro = canvasElement.querySelector('article')
    const home = intro?.parentElement
    if (home === null || home === undefined) throw new Error('the intro rendered no scroll container')
    home.scrollTop = 200
    const homeScrolled = home.scrollTop
    await expect(homeScrolled).toBeGreaterThan(0)
    // A dig-deeper reference opens the entity's page.
    await userEvent.click(
      canvas.getByRole('button', { name: 'The Tallow Guild [placeholder for Factions]' }),
    )
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
    // Back again lands on the INTRO, re-seated where the reader left it.
    await userEvent.click(canvas.getByRole('button', { name: '[placeholder for back]' }))
    await expect(canvas.getByRole('heading', { name: 'The Ashfen Reaches' })).toBeInTheDocument()
    const homeAgain = canvasElement.querySelector('article')?.parentElement
    await expect(homeAgain?.scrollTop).toBe(homeScrolled)
  },
}
