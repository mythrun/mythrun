import { describe, it, expect, vi } from 'vitest'
import { createRef } from 'react'
import { render } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { axe } from 'jest-axe'
import { GhostHookList } from './GhostHookList.tsx'
import type { GhostHookItem } from '@mythrun/client-core/contract'

// The starting-situation pick: three selectable hook cards, each stacking a title
// over a place over a prose paragraph.
const hooks = (
  onA = vi.fn(),
  onB = vi.fn(),
  onC = vi.fn(),
): GhostHookItem[] => [
  { id: '0', title: 'The harbour at low tide', place: 'Ashfen Reach', prose: 'A skiff has come in wrong.', onSelect: onA },
  { id: '1', title: 'A debt come due', place: 'The Salt Ledger', prose: 'The counting-house wants what it is owed.', onSelect: onB },
  { id: '2', title: 'Smoke over the moor', place: 'Greywater Fen', prose: 'The beacon is burning out of season.', onSelect: onC },
]

describe('GhostHookList', () => {
  it('renders each hook as a real <button> named by its title', () => {
    const { getByRole } = render(<GhostHookList items={hooks()} />)
    for (const title of ['The harbour at low tide', 'A debt come due', 'Smoke over the moor']) {
      const btn = getByRole('button', { name: new RegExp(title) })
      expect(btn.tagName).toBe('BUTTON')
    }
  })

  it('renders exactly three hooks', () => {
    const { getAllByRole } = render(<GhostHookList items={hooks()} />)
    expect(getAllByRole('button')).toHaveLength(3)
  })

  it('shows the title, the place, AND the prose paragraph for each hook', () => {
    const { getByText } = render(<GhostHookList items={hooks()} />)
    expect(getByText('The harbour at low tide')).toBeInTheDocument()
    expect(getByText('Ashfen Reach')).toBeInTheDocument()
    expect(getByText('A skiff has come in wrong.')).toBeInTheDocument()
  })

  it('omits the place line when a hook has no place', () => {
    const { queryByText } = render(
      <GhostHookList items={[{ id: 'x', title: 'An open road', prose: 'Pick a direction.', onSelect: vi.fn() }]} />,
    )
    // Only the two supplied strings render; nothing stands in for the absent place.
    expect(queryByText('An open road')).toBeInTheDocument()
    expect(queryByText('Pick a direction.')).toBeInTheDocument()
  })

  it('cards the hooks (no hairline separators — the border carries the boundary)', () => {
    const { queryAllByRole } = render(<GhostHookList items={hooks()} />)
    expect(queryAllByRole('separator')).toHaveLength(0)
  })

  it("fires the chosen hook's onSelect on click (and only that one)", async () => {
    const onA = vi.fn()
    const onB = vi.fn()
    const user = userEvent.setup()
    const { getByRole } = render(<GhostHookList items={hooks(onA, onB)} />)
    await user.click(getByRole('button', { name: /The harbour at low tide/ }))
    expect(onA).toHaveBeenCalledOnce()
    expect(onB).not.toHaveBeenCalled()
  })

  it('fires onSelect on keyboard activation (Enter)', async () => {
    const onA = vi.fn()
    const user = userEvent.setup()
    const { getByRole } = render(<GhostHookList items={hooks(onA)} />)
    getByRole('button', { name: /The harbour at low tide/ }).focus()
    await user.keyboard('{Enter}')
    expect(onA).toHaveBeenCalledOnce()
  })

  it('cards each hook: a bounded interactive border on the hook buttons', () => {
    const { getAllByRole } = render(<GhostHookList items={hooks()} />)
    for (const btn of getAllByRole('button')) {
      expect(btn.className).toContain('border-border-strong')
    }
  })

  it('is flat (0px radius): rounded-none on the hook buttons', () => {
    const { getAllByRole } = render(<GhostHookList items={hooks()} />)
    for (const btn of getAllByRole('button')) {
      expect(btn.className).toContain('rounded-none')
    }
  })

  it('forwards the ref to the list container', () => {
    const ref = createRef<HTMLDivElement>()
    render(<GhostHookList ref={ref} items={hooks()} />)
    expect(ref.current).toBeInstanceOf(HTMLDivElement)
  })

  it('has no a11y violations', async () => {
    const { container } = render(<GhostHookList items={hooks()} />)
    expect(await axe(container)).toHaveNoViolations()
  })
})
