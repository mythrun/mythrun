import { describe, expect, it, vi } from 'vitest'
import { render } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { axe } from 'jest-axe'
import { WikiPage } from './WikiPage.tsx'
import { wikiFixtureEntity } from './wiki-fixture.ts'

// WikiPage is one entity as a PLACE: kind tag over a serif name, the composed
// fact body (or the calm empty state when the world recorded nothing), and the
// RELATED footer carrying cross-navigation. These tests pin the plan's second
// and third named behaviors — body + RELATED + back — plus the scroll-restore
// half of the D3 contract (the page seats the reader at the entry's retained
// offset when it becomes current).

const LABELS = {
  backLabel: 'Back',
  relatedLabel: 'Related',
  emptyBodyLabel: 'Nothing recorded here yet',
} as const

function renderPage(overrides: Partial<React.ComponentProps<typeof WikiPage>> = {}) {
  return render(
    <WikiPage
      entity={wikiFixtureEntity('f-guild')}
      kindLabel="Faction"
      onBack={vi.fn()}
      onOpenRelated={vi.fn()}
      {...LABELS}
      {...overrides}
    />,
  )
}

describe('WikiPage — title + body', () => {
  it('renders the entity name as a heading with its RESOLVED kind-tag copy', () => {
    const { getByRole, getByText, queryByText } = renderPage()
    expect(getByRole('heading', { name: 'The Tallow Guild' })).toBeInTheDocument()
    // The tag is the consumer-resolved label, never the raw enum value.
    expect(getByText('Faction')).toBeInTheDocument()
    expect(queryByText('faction')).toBeNull()
  })

  it('composes the body from the facts — topic over content, in order', () => {
    const { getByText } = renderPage()
    expect(getByText('Purpose')).toBeInTheDocument()
    expect(getByText(/placeholder for the guild purpose/)).toBeInTheDocument()
    expect(getByText('Reputation')).toBeInTheDocument()
    expect(getByText(/how the guild is regarded/)).toBeInTheDocument()
  })

  it('shows the calm empty state for an empty-body entity — no fake prose', () => {
    const { getByText, queryByText } = renderPage({
      entity: wikiFixtureEntity('l-spire'),
      kindLabel: 'Location',
    })
    expect(getByText('Nothing recorded here yet')).toBeInTheDocument()
    expect(queryByText(/placeholder for/)).toBeNull()
  })

  it('renders the prose kernel as PARAGRAPHS above the fact passages (MYT-102)', () => {
    const { getByRole, getByText } = renderPage()
    const article = getByRole('article')
    // Two kernel paragraphs — separate <p>s, never a wall.
    const kernelParagraphs = Array.from(article.querySelectorAll('p')).filter((p) =>
      p.textContent.includes('kernel paragraph'),
    )
    expect(kernelParagraphs).toHaveLength(2)
    // The description reads FIRST: the kernel precedes the first fact topic.
    const firstKernel = kernelParagraphs[0] as HTMLElement
    const firstTopic = getByText('Purpose')
    expect(firstKernel.compareDocumentPosition(firstTopic) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  })

  it('renders a kernel-ONLY page: the description, no fact topics, no empty note', () => {
    const { getByText, queryByText } = renderPage({
      entity: wikiFixtureEntity('l-mill'),
      kindLabel: 'Location',
    })
    expect(getByText(/mill described in prose/)).toBeInTheDocument()
    expect(queryByText('Nothing recorded here yet')).toBeNull()
  })
})

describe('WikiPage — related + back', () => {
  it('renders the RELATED links — real relationship-bearing fixture', () => {
    const { getByText, getByRole } = renderPage()
    expect(getByText('Related')).toBeInTheDocument()
    // The guild's three relationship endpoints, with de-snaked labels.
    expect(getByRole('button', { name: /Maeris Vale/ })).toBeInTheDocument()
    expect(getByText('sworn to')).toBeInTheDocument()
    expect(getByRole('button', { name: /Sunspire/ })).toBeInTheDocument()
    expect(getByText('watched by')).toBeInTheDocument()
    expect(getByRole('button', { name: /The Drowned Ward/ })).toBeInTheDocument()
    expect(getByText('seated at')).toBeInTheDocument()
  })

  it('an empty-body entity still shows its related reading', () => {
    const { getByText, getByRole } = renderPage({
      entity: wikiFixtureEntity('l-spire'),
      kindLabel: 'Location',
    })
    expect(getByText('Nothing recorded here yet')).toBeInTheDocument()
    expect(getByRole('button', { name: /The Tallow Guild/ })).toBeInTheDocument()
  })

  it('a related link opens its target — onOpenRelated(entityId)', async () => {
    const onOpenRelated = vi.fn()
    const user = userEvent.setup()
    const { getByRole } = renderPage({ onOpenRelated })
    await user.click(getByRole('button', { name: /Maeris Vale/ }))
    expect(onOpenRelated).toHaveBeenCalledExactlyOnceWith('n-vale')
  })

  it('the back button fires onBack (native button — keyboard operable)', async () => {
    const onBack = vi.fn()
    const user = userEvent.setup()
    const { getByRole } = renderPage({ onBack })
    getByRole('button', { name: 'Back' }).focus()
    await user.keyboard('{Enter}')
    expect(onBack).toHaveBeenCalledOnce()
  })
})

describe('WikiPage — scroll restore', () => {
  it('seats the reader at the retained scroll offset when the page mounts', () => {
    const { getByRole } = renderPage({ scroll: 140 })
    expect(getByRole('article').scrollTop).toBe(140)
  })

  it('re-seats when the entity changes under the same mounted container', () => {
    const { getByRole, rerender } = renderPage({ scroll: 140 })
    expect(getByRole('article').scrollTop).toBe(140)
    rerender(
      <WikiPage
        entity={wikiFixtureEntity('n-vale')}
        kindLabel="Person"
        onBack={vi.fn()}
        onOpenRelated={vi.fn()}
        scroll={0}
        {...LABELS}
      />,
    )
    expect(getByRole('article').scrollTop).toBe(0)
  })
})

describe('WikiPage — a11y', () => {
  it('has no a11y violations', async () => {
    const { container } = renderPage()
    expect(await axe(container)).toHaveNoViolations()
  })
})
