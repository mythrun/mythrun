import { describe, expect, it, vi } from 'vitest'
import { render } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { RelatedFooter } from './RelatedFooter.tsx'
import { wikiFixtureEntity } from './wiki-fixture.ts'

// RelatedFooter is the page's cross-navigation: the entity's `related` links
// (D2's UUID-resolved, both-directions view-model field) as plain rows — target
// name as the link, de-snaked relationship label as the quiet annotation.

const GUILD_RELATED = wikiFixtureEntity('f-guild').related

describe('RelatedFooter', () => {
  it('renders the section label and one row per related link', () => {
    const { getByText, getAllByRole } = render(
      <RelatedFooter related={GUILD_RELATED} label="Related" onOpen={vi.fn()} />,
    )
    expect(getByText('Related')).toBeInTheDocument()
    expect(getAllByRole('listitem')).toHaveLength(3)
    for (const [name, label] of [
      ['Maeris Vale', 'sworn to'],
      ['Sunspire', 'watched by'],
      ['The Drowned Ward', 'seated at'],
    ] as const) {
      expect(getByText(name)).toBeInTheDocument()
      expect(getByText(label)).toBeInTheDocument()
    }
  })

  it('opens the link target on activation — onOpen(entityId)', async () => {
    const onOpen = vi.fn()
    const user = userEvent.setup()
    const { getByRole } = render(
      <RelatedFooter related={GUILD_RELATED} label="Related" onOpen={onOpen} />,
    )
    await user.click(getByRole('button', { name: /Sunspire/ }))
    expect(onOpen).toHaveBeenCalledExactlyOnceWith('l-spire')
  })

  it('renders nothing at all for an entity with no related links', () => {
    const { container } = render(<RelatedFooter related={[]} label="Related" onOpen={vi.fn()} />)
    expect(container.firstChild).toBeNull()
  })
})
