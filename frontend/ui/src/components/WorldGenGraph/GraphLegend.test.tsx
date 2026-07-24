import { describe, expect, it } from 'vitest'
import { render } from '@testing-library/react'
import { axe } from 'jest-axe'
import type { GraphNode } from '@mythrun/client-core/contract'
import { GraphLegend } from './GraphLegend.tsx'

// GraphLegend documents the graph's glyph vocabulary (myth-466cy): one shape·word
// entry per entity kind actually present, in a stable order, drawn only for kinds
// the consumer supplied a label for.

const node = (kind: string, name: string): GraphNode => ({
  synthKey: `s/${name}`,
  kind,
  name,
  displayId: `s/${name}`,
  state: 'live',
  lastEventIndex: 0,
})

const LABELS = {
  faction: 'Factions',
  location: 'Places',
  npc: 'People',
  item: 'Items',
}

describe('GraphLegend', () => {
  it('shows a key entry only for the kinds actually present', () => {
    const nodes = [node('faction', 'The Guild'), node('location', 'The Ward')]
    const { getByText, queryByText } = render(<GraphLegend nodes={nodes} labels={LABELS} />)
    expect(getByText('Factions')).toBeInTheDocument()
    expect(getByText('Places')).toBeInTheDocument()
    // No npc/item nodes → those keys are omitted even though labels exist.
    expect(queryByText('People')).toBeNull()
    expect(queryByText('Items')).toBeNull()
  })

  it('orders factions and locations ahead of people and items', () => {
    const nodes = [node('item', 'Ledger'), node('npc', 'Corr'), node('location', 'Ward'), node('faction', 'Guild')]
    const { getAllByRole } = render(<GraphLegend nodes={nodes} labels={LABELS} />)
    const items = getAllByRole('listitem').map((li) => li.textContent)
    expect(items).toEqual(['Factions', 'Places', 'People', 'Items'])
  })

  it('omits a present kind that has no resolved label (the DS invents no copy)', () => {
    const nodes = [node('faction', 'Guild'), node('pc', 'You')]
    const { getByText, queryByText } = render(<GraphLegend nodes={nodes} labels={LABELS} />)
    expect(getByText('Factions')).toBeInTheDocument()
    // 'pc' is present but LABELS carries no pc entry → no orphan swatch.
    expect(queryByText('You')).toBeNull()
  })

  it('renders nothing when no present kind carries a label', () => {
    const { container } = render(<GraphLegend nodes={[node('pc', 'You')]} labels={LABELS} />)
    expect(container.firstChild).toBeNull()
  })

  it('has no a11y violations', async () => {
    const nodes = [node('faction', 'Guild'), node('location', 'Ward'), node('npc', 'Corr'), node('item', 'Ledger')]
    const { container } = render(<GraphLegend nodes={nodes} labels={LABELS} />)
    expect(await axe(container)).toHaveNoViolations()
  })
})
