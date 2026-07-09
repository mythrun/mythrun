import { describe, expect, it, vi } from 'vitest'
import { render, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { axe } from 'jest-axe'
import { WikiHome } from './WikiHome.tsx'
import { WIKI_FIXTURE_MODEL } from './wiki-fixture.ts'

// WikiHome is the wiki's landing: the search field over the browse-by-kind
// groups, every entity row a navigation affordance (it OPENS the entity's page
// — no inline fact dropdown anymore). These tests pin the plan's first named
// behavior: search + kind groups with clickable entities, plus the filter
// behavior the old tree already had (ancestor path kept, empty state).

const LABELS = {
  searchLabel: 'Search the world',
  searchPlaceholder: 'Search',
  emptyLabel: 'Nothing here',
  groupLabels: { faction: 'Factions', location: 'Locations', npc: 'People', item: 'Items' },
} as const

function renderHome(overrides: Partial<React.ComponentProps<typeof WikiHome>> = {}) {
  return render(
    <WikiHome
      model={WIKI_FIXTURE_MODEL}
      selectedId={undefined}
      onOpen={vi.fn()}
      query=""
      onQuery={vi.fn()}
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

describe('WikiHome — a11y', () => {
  it('has no a11y violations', async () => {
    const { container } = renderHome({ selectedId: 'f-guild' })
    expect(await axe(container)).toHaveNoViolations()
  })
})
