import { describe, expect, it, vi } from 'vitest'
import { render, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { axe } from 'jest-axe'
import { WikiHome } from './WikiHome.tsx'
import { WIKI_FIXTURE_MODEL, WIKI_FIXTURE_MODEL_BARE } from './wiki-fixture.ts'

// WikiHome is the wiki's landing. With an `introduction` on the model
// (myth-b9bap) it IS the world's front door — the world-name title, the
// grounding prose as paragraphs, the dig-deeper references — with the search +
// browse-by-kind index one scroll below; without one (a pre-migration world)
// it is the browse landing alone. Every entity row and reference is a
// navigation affordance (it OPENS the entity's page). These tests pin both
// variants plus the filter behavior the old tree already had (ancestor path
// kept, empty state).

const LABELS = {
  searchLabel: 'Search the world',
  searchPlaceholder: 'Search',
  emptyLabel: 'Nothing here',
  referencesLabel: 'Dig deeper',
  indexLabel: 'Index',
  glossaryLabel: 'Glossary',
  groupLabels: { faction: 'Factions', location: 'Locations', npc: 'People', item: 'Items' },
} as const

function renderHome(overrides: Partial<React.ComponentProps<typeof WikiHome>> = {}) {
  return render(
    <WikiHome
      model={WIKI_FIXTURE_MODEL_BARE}
      selectedId={undefined}
      onOpen={vi.fn()}
      query=""
      onQuery={vi.fn()}
      view="index"
      onViewChange={vi.fn()}
      {...LABELS}
      {...overrides}
    />,
  )
}

describe('WikiHome — search + browse-by-kind', () => {
  it('renders the search field, every group heading, and every entity row', () => {
    const { getByRole, getByText } = renderHome()
    expect(getByRole('textbox', { name: 'Search the world' })).toBeInTheDocument()
    for (const heading of ['Factions', 'Locations', 'People', 'Items']) {
      expect(getByRole('heading', { name: heading })).toBeInTheDocument()
    }
    for (const name of [
      'The Tallow Guild',
      'Ashfen Reach',
      'The Drowned Ward',
      'Sunspire',
      'Maeris Vale',
      'The Salt Ledger',
    ]) {
      expect(getByText(name)).toBeInTheDocument()
    }
  })

  it('keeps a nested location UNDER its parent (indented, not top-level)', () => {
    const { getByRole } = renderHome()
    const parentLi = getByRole('button', { name: 'Ashfen Reach' }).closest('li')
    expect(parentLi).not.toBeNull()
    const childButton = within(parentLi as HTMLElement).getByRole('button', { name: 'The Drowned Ward' })
    expect(parentLi).toContainElement(childButton.closest('ul'))
  })

  it('opens an entity on click — onOpen(id), the page navigation seam', async () => {
    const onOpen = vi.fn()
    const user = userEvent.setup()
    const { getByRole } = renderHome({ onOpen })
    await user.click(getByRole('button', { name: 'Maeris Vale' }))
    expect(onOpen).toHaveBeenCalledExactlyOnceWith('n-vale')
  })

  it('opens an entity on keyboard activation (Enter)', async () => {
    const onOpen = vi.fn()
    const user = userEvent.setup()
    const { getByRole } = renderHome({ onOpen })
    getByRole('button', { name: 'Ashfen Reach' }).focus()
    await user.keyboard('{Enter}')
    expect(onOpen).toHaveBeenCalledExactlyOnceWith('l-reach')
  })

  it('marks the graph-selected entity via aria-current (prop-driven)', () => {
    const { getByRole } = renderHome({ selectedId: 'n-vale' })
    expect(getByRole('button', { name: 'Maeris Vale' })).toHaveAttribute('aria-current', 'true')
    expect(getByRole('button', { name: 'Ashfen Reach' })).not.toHaveAttribute('aria-current')
  })

  it('calls onQuery when the search field is typed into', async () => {
    const onQuery = vi.fn()
    const user = userEvent.setup()
    const { getByRole } = renderHome({ onQuery })
    await user.type(getByRole('textbox', { name: 'Search the world' }), 'a')
    expect(onQuery).toHaveBeenCalledWith('a')
  })

  it('filters by the query prop, keeping a nested match ancestor path', () => {
    const { getByText, queryByText } = renderHome({ query: 'drowned' })
    expect(getByText('The Drowned Ward')).toBeInTheDocument()
    expect(getByText('Ashfen Reach')).toBeInTheDocument()
    expect(queryByText('Sunspire')).toBeNull()
    expect(queryByText('Maeris Vale')).toBeNull()
    expect(queryByText('People')).toBeNull()
    expect(getByText('Locations')).toBeInTheDocument()
  })

  it('shows the empty-state note when the query matches nothing', () => {
    const { getByText } = renderHome({ query: 'zzzznomatch' })
    expect(getByText('Nothing here')).toBeInTheDocument()
  })
})

describe('WikiHome — the Index/Glossary views (MYT-100)', () => {
  it('shows the segmented switch only when the world has a glossary', () => {
    const { getByRole } = renderHome({ model: WIKI_FIXTURE_MODEL })
    expect(getByRole('button', { name: 'Index' })).toBeInTheDocument()
    expect(getByRole('button', { name: 'Glossary' })).toBeInTheDocument()
  })

  it('omits the switch entirely for a world without a glossary', () => {
    const { queryByRole } = renderHome()
    expect(queryByRole('button', { name: 'Glossary' })).toBeNull()
    expect(queryByRole('button', { name: 'Index' })).toBeNull()
  })

  it('renders the glossary terms + definitions in the glossary view', () => {
    const { getByText } = renderHome({ model: WIKI_FIXTURE_MODEL, view: 'glossary' })
    // Term-sorted by the view model: ashfen < lampblack < tallow-run.
    for (const term of ['ashfen', 'lampblack', 'tallow-run']) {
      expect(getByText(term)).toBeInTheDocument()
    }
    expect(getByText(/what lampblack means here/)).toBeInTheDocument()
  })

  it('hides the browse groups while the glossary view is active', () => {
    const { queryByRole } = renderHome({ model: WIKI_FIXTURE_MODEL, view: 'glossary' })
    // The Factions heading (and the search field) belong to the index view.
    expect(queryByRole('heading', { name: 'Factions' })).toBeNull()
    expect(queryByRole('textbox', { name: 'Search the world' })).toBeNull()
  })

  it('reports a switch pick through onViewChange', async () => {
    const onViewChange = vi.fn()
    const user = userEvent.setup()
    const { getByRole } = renderHome({ model: WIKI_FIXTURE_MODEL, onViewChange })
    await user.click(getByRole('button', { name: 'Glossary' }))
    expect(onViewChange).toHaveBeenCalledExactlyOnceWith('glossary')
  })

  it('shows the empty note when a query matches no entity (index view)', () => {
    const { getByText } = renderHome({ model: WIKI_FIXTURE_MODEL, query: 'zzzznomatch' })
    expect(getByText('Nothing here')).toBeInTheDocument()
  })
})

describe('WikiHome — the introduction (the world\'s front door)', () => {
  const renderIntro = (overrides: Partial<React.ComponentProps<typeof WikiHome>> = {}) =>
    renderHome({ model: WIKI_FIXTURE_MODEL, ...overrides })

  it('opens on the world-name title, the prose as PARAGRAPHS, and the references', () => {
    const { getByRole, container } = renderIntro()
    // The title moment: the world's name as the intro heading.
    expect(getByRole('heading', { name: 'The Ashfen Reaches' })).toBeInTheDocument()
    // The two prose paragraphs render as separate <p>s — never a wall.
    const article = getByRole('article')
    const paragraphs = Array.from(article.querySelectorAll('p')).filter((p) =>
      p.textContent.includes('introduction paragraph'),
    )
    expect(paragraphs).toHaveLength(2)
    // The dig-deeper references under their section label, each a kind-labeled
    // link row (the RelatedFooter idiom).
    expect(within(article).getByText('Dig deeper')).toBeInTheDocument()
    expect(within(article).getByRole('button', { name: 'The Tallow Guild Factions' })).toBeInTheDocument()
    expect(within(article).getByRole('button', { name: 'Maeris Vale People' })).toBeInTheDocument()
    // The index (search + browse) is on the same surface, one scroll below.
    expect(getByRole('textbox', { name: 'Search the world' })).toBeInTheDocument()
    expect(within(container).getByText('Index')).toBeInTheDocument()
    expect(getByRole('heading', { name: 'Factions' })).toBeInTheDocument()
  })

  it('navigates from a dig-deeper reference — onOpen(id)', async () => {
    const onOpen = vi.fn()
    const user = userEvent.setup()
    const { getByRole } = renderIntro({ onOpen })
    await user.click(getByRole('button', { name: 'Maeris Vale People' }))
    expect(onOpen).toHaveBeenCalledExactlyOnceWith('n-vale')
  })

  it('renders the browse home alone when the model has no introduction', () => {
    const { queryByRole, queryByText, getByRole } = renderHome()
    expect(queryByRole('heading', { name: 'The Ashfen Reaches' })).toBeNull()
    expect(queryByRole('article')).toBeNull()
    expect(queryByText('Index')).toBeNull()
    expect(getByRole('textbox', { name: 'Search the world' })).toBeInTheDocument()
    expect(getByRole('heading', { name: 'Factions' })).toBeInTheDocument()
  })

  it('seats the retained scroll offset on mount (the shell\'s home scroll memory)', () => {
    const scrollRef = { current: null }
    const { container } = renderIntro({ scroll: 120, scrollRef })
    const scroller = scrollRef.current as HTMLElement | null
    expect(scroller).not.toBeNull()
    expect(container).toContainElement(scroller)
    expect(scroller?.scrollTop).toBe(120)
  })

  it('has no a11y violations on the introduction home', async () => {
    const { container } = renderIntro({ selectedId: 'f-guild' })
    expect(await axe(container)).toHaveNoViolations()
  })
})

describe('WikiHome — a11y', () => {
  it('has no a11y violations', async () => {
    const { container } = renderHome({ selectedId: 'f-guild' })
    expect(await axe(container)).toHaveNoViolations()
  })
})
