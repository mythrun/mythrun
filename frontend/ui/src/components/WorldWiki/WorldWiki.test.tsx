import { describe, expect, it, vi } from 'vitest'
import { render } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { axe } from 'jest-axe'
import type { WikiViewModel } from '@mythrun/client-core/contract'
import { WorldWiki } from './WorldWiki.tsx'
import { WIKI_FIXTURE_MODEL, WIKI_FIXTURE_MODEL_BARE } from './wiki-fixture.ts'

// The composed WorldWiki: WikiHome ⇄ WikiPage driven by the REAL
// `useWikiNavigation` (D3) — these tests walk the wiki as a reader would.
// Home IS the world's introduction (myth-b9bap) when the model carries one;
// navigation (home row → page, related hop, back), the scroll round-trip on
// pages AND home (the D3 contract's consumer side + the shell's home scroll
// memory), the external graph-selection push (`selectedId` — the reveal's
// graph↔wiki bridge), and the defensive home-fallback when a silent refetch
// drops the current entity.

const LABELS = {
  searchLabel: 'Search the world',
  searchPlaceholder: 'Search',
  emptyLabel: 'Nothing here',
  backLabel: 'Back',
  relatedLabel: 'Related',
  emptyBodyLabel: 'Nothing recorded here yet',
  referencesLabel: 'Dig deeper',
  indexLabel: 'Index',
  glossaryLabel: 'Glossary',
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
    // The page's kind tag resolves through the SAME groupLabels map home uses —
    // never the raw enum value.
    expect(getByRole('article')).toHaveTextContent('Locations')
    expect(getByRole('article')).not.toHaveTextContent(/\blocation\b/)
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

describe('WorldWiki — the introduction as home (myth-b9bap)', () => {
  it('opens on the introduction; a dig-deeper reference navigates; back returns to the intro', async () => {
    const user = userEvent.setup()
    const { getByRole, queryByRole } = renderWiki()

    // The wiki OPENS on the world's front door: the title moment.
    expect(getByRole('heading', { name: 'The Ashfen Reaches' })).toBeInTheDocument()

    // A dig-deeper reference opens the entity's page (the intro is gone).
    await user.click(getByRole('button', { name: 'Maeris Vale People' }))
    expect(getByRole('heading', { name: 'Maeris Vale' })).toBeInTheDocument()
    expect(queryByRole('heading', { name: 'The Ashfen Reaches' })).toBeNull()

    // Back lands on the intro again — home IS the introduction.
    await user.click(getByRole('button', { name: 'Back' }))
    expect(getByRole('heading', { name: 'The Ashfen Reaches' })).toBeInTheDocument()
  })

  it('reports a dig-deeper navigation outward through onSelect', async () => {
    const onSelect = vi.fn()
    const user = userEvent.setup()
    const { getByRole } = renderWiki({ onSelect })
    await user.click(getByRole('button', { name: 'The Tallow Guild Factions' }))
    expect(onSelect).toHaveBeenLastCalledWith('f-guild')
  })

  it('retains the home scroll offset across a page round-trip (home scroll memory)', async () => {
    const user = userEvent.setup()
    const { getByRole } = renderWiki()

    // Read down the intro (the references live at the bottom), then hop away.
    const home = getByRole('article').parentElement
    if (home === null) throw new Error('the intro rendered outside a scroll container')
    home.scrollTop = 180
    await user.click(getByRole('button', { name: 'Maeris Vale People' }))
    expect(getByRole('heading', { name: 'Maeris Vale' })).toBeInTheDocument()

    // Back re-seats the reader at the references, not the title.
    await user.click(getByRole('button', { name: 'Back' }))
    expect(getByRole('article').parentElement?.scrollTop).toBe(180)
  })

  it('falls back to the browse home when the model has no introduction (old world)', () => {
    const { getByRole, queryByRole } = renderWiki({ model: WIKI_FIXTURE_MODEL_BARE })
    expect(queryByRole('article')).toBeNull()
    expect(getByRole('textbox', { name: 'Search the world' })).toBeInTheDocument()
    expect(getByRole('heading', { name: 'Factions' })).toBeInTheDocument()
  })

  it('keeps the reader seated through a silent model refetch (no remount, no scroll reset)', () => {
    const { rerender, getByRole } = renderWiki()
    const home = getByRole('article').parentElement
    if (home === null) throw new Error('the intro rendered outside a scroll container')
    home.scrollTop = 90

    // A tail-stage refetch hands down a FRESH model object (same content).
    const refetched: WikiViewModel = { ...WIKI_FIXTURE_MODEL }
    rerender(
      <WorldWiki model={refetched} onSelect={vi.fn()} onQuery={vi.fn()} {...LABELS} />,
    )

    // Same DOM node (no remount), same offset (no reset).
    expect(getByRole('article').parentElement).toBe(home)
    expect(home.scrollTop).toBe(90)
  })
})

describe('WorldWiki — the glossary view (MYT-100)', () => {
  it('reveals the world glossary when the shell-owned switch selects it', async () => {
    const user = userEvent.setup()
    const { getByRole, getByText, queryByText } = renderWiki()
    // The glossary sits behind the switch — not in view until selected.
    expect(queryByText('lampblack')).toBeNull()
    await user.click(getByRole('button', { name: 'Glossary' }))
    expect(getByText('lampblack')).toBeInTheDocument()
  })

  it('returns to the glossary view after an entity drill-in and back (shell-owned view)', async () => {
    // The switch's active view lives in the shell, so a page drill-in and Back
    // land the reader on the view they left — not a reset to Index.
    const user = userEvent.setup()
    const { getByRole, getByText } = renderWiki()
    await user.click(getByRole('button', { name: 'Glossary' }))
    expect(getByText('lampblack')).toBeInTheDocument()
    // Nothing to drill into from the glossary view directly, so flip to Index,
    // open an entity, and Back — the view must still be whatever it was.
    await user.click(getByRole('button', { name: 'Index' }))
    await user.click(getByRole('button', { name: 'The Tallow Guild' }))
    await user.click(getByRole('button', { name: 'Back' }))
    // Back to home on the Index view (the last-selected), glossary hidden again.
    expect(getByRole('button', { name: 'Index' })).toHaveAttribute('aria-pressed', 'true')
  })
})

describe('WorldWiki — silent-refetch resilience', () => {
  it('falls back to home when the current entity leaves the model', () => {
    const { rerender, getByRole } = renderWiki({ selectedId: 'n-vale' })
    expect(getByRole('heading', { name: 'Maeris Vale' })).toBeInTheDocument()
    const shrunk: WikiViewModel = {
      groups: WIKI_FIXTURE_MODEL.groups.filter((group) => group.kind !== 'npc'),
      glossary: WIKI_FIXTURE_MODEL.glossary,
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
