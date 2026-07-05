import { describe, expect, it, vi } from 'vitest'
import { render, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { axe } from 'jest-axe'
import type { WikiViewModel } from '@mythrun/client-core/contract'
import { WorldWiki } from './WorldWiki.tsx'

// WorldWiki is a browsable grouped tree over a borderless search field. Its whole
// surface is DOM (no Canvas), so these tests exercise it directly: every group +
// entity renders, a nested location indents UNDER its parent, activation (click +
// keyboard) fires onSelect, `selectedId` marks + opens the entity to its facts,
// and the `query` prop filters the tree (keeping a nested match's ancestor path).

const MODEL: WikiViewModel = {
  groups: [
    {
      kind: 'faction',
      entities: [
        {
          id: 'f1',
          name: 'The Tallow Guild',
          facts: [{ id: 'f1a', topic: 'Purpose', content: 'Renders tallow into rare unguents.' }],
        },
      ],
    },
    {
      kind: 'location',
      entities: [
        {
          id: 'l1',
          name: 'Ashfen Reach',
          facts: [{ id: 'l1a', topic: 'Terrain', content: 'A drowned delta of salt and reed.' }],
          children: [
            {
              id: 'l2',
              name: 'The Drowned Ward',
              facts: [{ id: 'l2a', topic: 'Note', content: 'Flooded at every high tide.' }],
            },
          ],
        },
        { id: 'l3', name: 'Sunspire', facts: [] },
      ],
    },
    { kind: 'npc', entities: [{ id: 'n1', name: 'Maeris Vale', facts: [] }] },
    { kind: 'item', entities: [{ id: 'i1', name: 'The Salt Ledger', facts: [] }] },
  ],
}

// The chrome labels are consumer-supplied (i18n) props — the DS owns no copy.
const LABELS = {
  searchLabel: 'Search the world',
  searchPlaceholder: 'Search',
  emptyLabel: 'Nothing here',
  groupLabels: { faction: 'Factions', location: 'Locations', npc: 'People', item: 'Items' },
} as const

describe('WorldWiki — grouped tree', () => {
  it('renders every group heading and entity from the model', () => {
    const { getByRole, getByText } = render(<WorldWiki model={MODEL} onSelect={vi.fn()} onQuery={vi.fn()} {...LABELS} />)
    for (const heading of ['Factions', 'Locations', 'People', 'Items']) {
      expect(getByRole('heading', { name: heading })).toBeInTheDocument()
    }
    for (const name of ['The Tallow Guild', 'Ashfen Reach', 'The Drowned Ward', 'Sunspire', 'Maeris Vale', 'The Salt Ledger']) {
      expect(getByText(name)).toBeInTheDocument()
    }
  })

  it('renders a nested location UNDER its parent (indented, not top-level)', () => {
    const { getByRole } = render(<WorldWiki model={MODEL} onSelect={vi.fn()} onQuery={vi.fn()} {...LABELS} />)
    const parentLi = getByRole('button', { name: 'Ashfen Reach' }).closest('li')
    expect(parentLi).not.toBeNull()
    // The child button lives inside the parent's <li> (nested), not as a sibling.
    const childButton = within(parentLi as HTMLElement).getByRole('button', { name: 'The Drowned Ward' })
    expect(childButton).toBeInTheDocument()
    // And it sits in a nested <ul> that is itself contained by the parent <li>.
    expect(parentLi).toContainElement(childButton.closest('ul'))
  })
})

describe('WorldWiki — selection', () => {
  it('calls onSelect(id) when an entity is activated (click)', async () => {
    const onSelect = vi.fn()
    const user = userEvent.setup()
    const { getByRole } = render(<WorldWiki model={MODEL} onSelect={onSelect} onQuery={vi.fn()} {...LABELS} />)
    await user.click(getByRole('button', { name: 'Maeris Vale' }))
    expect(onSelect).toHaveBeenCalledExactlyOnceWith('n1')
  })

  it('calls onSelect(id) on keyboard activation (Enter)', async () => {
    const onSelect = vi.fn()
    const user = userEvent.setup()
    const { getByRole } = render(<WorldWiki model={MODEL} onSelect={onSelect} onQuery={vi.fn()} {...LABELS} />)
    getByRole('button', { name: 'Ashfen Reach' }).focus()
    await user.keyboard('{Enter}')
    expect(onSelect).toHaveBeenCalledExactlyOnceWith('l1')
  })

  it('marks the selected entity via aria-current (prop-driven, no internal state)', () => {
    const { getByRole } = render(<WorldWiki model={MODEL} selectedId="n1" onSelect={vi.fn()} onQuery={vi.fn()} {...LABELS} />)
    expect(getByRole('button', { name: 'Maeris Vale' })).toHaveAttribute('aria-current', 'true')
    expect(getByRole('button', { name: 'Ashfen Reach' })).not.toHaveAttribute('aria-current')
  })

  it('opens the selected entity to its facts (and only the selected one)', () => {
    const { getByText, queryByText } = render(
      <WorldWiki model={MODEL} selectedId="l1" onSelect={vi.fn()} onQuery={vi.fn()} {...LABELS} />,
    )
    // Ashfen Reach (l1) is selected — its fact topic + content render.
    expect(getByText('Terrain')).toBeInTheDocument()
    expect(getByText('A drowned delta of salt and reed.')).toBeInTheDocument()
    // A non-selected entity's facts stay closed.
    expect(queryByText('Renders tallow into rare unguents.')).toBeNull()
  })
})

describe('WorldWiki — search', () => {
  it('calls onQuery when the search field is typed into', async () => {
    const onQuery = vi.fn()
    const user = userEvent.setup()
    const { getByRole } = render(<WorldWiki model={MODEL} onSelect={vi.fn()} onQuery={onQuery} {...LABELS} />)
    await user.type(getByRole('textbox', { name: 'Search the world' }), 'a')
    expect(onQuery).toHaveBeenCalledWith('a')
  })

  it('filters the tree by the query prop, keeping a nested match ancestor path', () => {
    const { getByText, queryByText } = render(
      <WorldWiki model={MODEL} query="drowned" onSelect={vi.fn()} onQuery={vi.fn()} {...LABELS} />,
    )
    // The nested match + its ancestor stay visible…
    expect(getByText('The Drowned Ward')).toBeInTheDocument()
    expect(getByText('Ashfen Reach')).toBeInTheDocument()
    // …while non-matching entities (and their now-empty groups) are hidden.
    expect(queryByText('Sunspire')).toBeNull()
    expect(queryByText('Maeris Vale')).toBeNull()
    expect(queryByText('People')).toBeNull()
    expect(queryByText('Locations')).toBeInTheDocument()
  })

  it('shows the empty-state note when the query matches nothing', () => {
    const { getByText } = render(
      <WorldWiki model={MODEL} query="zzzznomatch" onSelect={vi.fn()} onQuery={vi.fn()} {...LABELS} />,
    )
    expect(getByText('Nothing here')).toBeInTheDocument()
  })
})

describe('WorldWiki — a11y', () => {
  it('has no a11y violations', async () => {
    const { container } = render(
      <WorldWiki model={MODEL} selectedId="l1" onSelect={vi.fn()} onQuery={vi.fn()} {...LABELS} />,
    )
    expect(await axe(container)).toHaveNoViolations()
  })
})
