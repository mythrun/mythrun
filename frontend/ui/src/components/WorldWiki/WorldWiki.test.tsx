import { describe, expect, it, vi } from 'vitest'
import { render } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { axe } from 'jest-axe'
import type { WikiViewModel } from '@mythrun/client-core/contract'
import { WorldWiki } from './WorldWiki.tsx'
import { WIKI_FIXTURE_MODEL } from './wiki-fixture.ts'

// The composed WorldWiki: WikiHome ⇄ WikiPage driven by the REAL
// `useWikiNavigation` (D3) — these tests walk the wiki as a reader would.
// Navigation (home row → page, related hop, back), the scroll round-trip
// (the D3 contract's consumer side), the external graph-selection push
// (`selectedId` — the reveal's graph↔wiki bridge), and the defensive
// home-fallback when a silent refetch drops the current entity.

const LABELS = {
  searchLabel: 'Search the world',
  searchPlaceholder: 'Search',
  emptyLabel: 'Nothing here',
  backLabel: 'Back',
  relatedLabel: 'Related',
  emptyBodyLabel: 'Nothing recorded here yet',
  groupLabels: { faction: 'Factions', location: 'Locations', npc: 'People', item: 'Items' },
} as const

function renderWiki(overrides: Partial<React.ComponentProps<typeof WorldWiki>> = {}) {
  return render(
    <WorldWiki model={WIKI_FIXTURE_MODEL} onSelect={vi.fn()} onQuery={vi.fn()} {...LABELS} {...overrides} />,
  )
}

describe('WorldWiki — the composed journey', () => {
  it('walks home → entity page → related hop → back → back → home', async () => {
    const user = userEvent.setup()
    const { getByRole, queryByRole } = renderWiki()

    // Home: the search + browse landing.
    expect(getByRole('textbox', { name: 'Search the world' })).toBeInTheDocument()

    // Open an entity from a kind group → its page (heading + body).
    await user.click(getByRole('button', { name: 'The Tallow Guild' }))
    expect(getByRole('heading', { name: 'The Tallow Guild' })).toBeInTheDocument()
    expect(queryByRole('textbox', { name: 'Search the world' })).toBeNull()

    // Hop a RELATED link → the target's page.
    await user.click(getByRole('button', { name: /Maeris Vale/ }))
    expect(getByRole('heading', { name: 'Maeris Vale' })).toBeInTheDocument()

    // Back → the guild page again; back again → home.
    await user.click(getByRole('button', { name: 'Back' }))
    expect(getByRole('heading', { name: 'The Tallow Guild' })).toBeInTheDocument()
    await user.click(getByRole('button', { name: 'Back' }))
    expect(getByRole('textbox', { name: 'Search the world' })).toBeInTheDocument()
  })

  it('notifies onSelect for internal navigation, keeping the graph in step', async () => {
    const onSelect = vi.fn()
    const user = userEvent.setup()
    const { getByRole } = renderWiki({ onSelect })
    await user.click(getByRole('button', { name: 'The Tallow Guild' }))
    expect(onSelect).toHaveBeenLastCalledWith('f-guild')
    await user.click(getByRole('button', { name: /Maeris Vale/ }))
    expect(onSelect).toHaveBeenLastCalledWith('n-vale')
  })
})

describe('WorldWiki — scroll memory', () => {
  it('round-trips the reader position: scroll, hop away, come back', async () => {
    const user = userEvent.setup()
    const { getByRole } = renderWiki()

    await user.click(getByRole('button', { name: 'The Tallow Guild' }))
    const article = getByRole('article')
    article.scrollTop = 140

    // A fresh page starts at the top…
    await user.click(getByRole('button', { name: /Maeris Vale/ }))
    expect(getByRole('article').scrollTop).toBe(0)

    // …and back restores the recorded offset verbatim.
    await user.click(getByRole('button', { name: 'Back' }))
    expect(getByRole('article').scrollTop).toBe(140)
  })
})

describe('WorldWiki — external selection (the graph↔wiki bridge)', () => {
  it('pushes the entity page when selectedId changes from outside', () => {
    const { rerender, getByRole } = renderWiki()
    rerender(
      <WorldWiki
        model={WIKI_FIXTURE_MODEL}
        selectedId="l-spire"
        onSelect={vi.fn()}
        onQuery={vi.fn()}
        {...LABELS}
      />,
    )
    expect(getByRole('heading', { name: 'Sunspire' })).toBeInTheDocument()
    // Sunspire is the empty-body specimen: the calm note + its related reading.
    expect(getByRole('article')).toHaveTextContent('Nothing recorded here yet')
    expect(getByRole('button', { name: /The Tallow Guild/ })).toBeInTheDocument()
  })

  it('dedups a re-selection of the entity already in view (no self-stack)', async () => {
    const user = userEvent.setup()
    const { rerender, getByRole } = renderWiki({ selectedId: 'l-spire' })
    expect(getByRole('heading', { name: 'Sunspire' })).toBeInTheDocument()
    // A re-render with the SAME selection must not stack the page on itself…
    rerender(
      <WorldWiki
        model={WIKI_FIXTURE_MODEL}
        selectedId="l-spire"
        onSelect={vi.fn()}
        onQuery={vi.fn()}
        {...LABELS}
      />,
    )
    // …so one Back lands home, not on a second copy of the page.
    await user.click(getByRole('button', { name: 'Back' }))
    expect(getByRole('textbox', { name: 'Search the world' })).toBeInTheDocument()
  })
})

describe('WorldWiki — silent-refetch resilience', () => {
  it('falls back to home when the current entity leaves the model', () => {
    const { rerender, getByRole } = renderWiki({ selectedId: 'n-vale' })
    expect(getByRole('heading', { name: 'Maeris Vale' })).toBeInTheDocument()
    const shrunk: WikiViewModel = {
      groups: WIKI_FIXTURE_MODEL.groups.filter((group) => group.kind !== 'npc'),
    }
    rerender(
      <WorldWiki model={shrunk} selectedId="n-vale" onSelect={vi.fn()} onQuery={vi.fn()} {...LABELS} />,
    )
    expect(getByRole('textbox', { name: 'Search the world' })).toBeInTheDocument()
  })
})

describe('WorldWiki — a11y', () => {
  it('has no violations on home', async () => {
    const { container } = renderWiki()
    expect(await axe(container)).toHaveNoViolations()
  })

  it('has no violations on an entity page', async () => {
    const { container } = renderWiki({ selectedId: 'f-guild' })
    expect(await axe(container)).toHaveNoViolations()
  })
})
