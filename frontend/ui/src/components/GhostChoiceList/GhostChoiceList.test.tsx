import { describe, it, expect, vi } from 'vitest'
import { createRef } from 'react'
import { render } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { axe } from 'jest-axe'
import { GhostChoiceList } from './GhostChoiceList.tsx'
import type { GhostChoiceItem } from '@mythrun/client-core/contract'

// The campaign-create fork: two borderless ghost choices split by hairline rules.
const fork = (
  onA = vi.fn(),
  onB = vi.fn(),
): GhostChoiceItem[] => [
  { id: 'freeform', title: 'Start from an idea', subtitle: 'Describe a vibe, a place, a what-if.', onSelect: onA },
  { id: 'guided', title: 'Build from what you love', subtitle: 'Answer a few prompts.', onSelect: onB },
]

describe('GhostChoiceList', () => {
  it('renders each item as a real <button> with its title', () => {
    const { getByRole } = render(<GhostChoiceList items={fork()} />)
    const a = getByRole('button', { name: /Start from an idea/ })
    const b = getByRole('button', { name: /Build from what you love/ })
    expect(a.tagName).toBe('BUTTON')
    expect(b.tagName).toBe('BUTTON')
  })

  it('renders exactly two choices', () => {
    const { getAllByRole } = render(<GhostChoiceList items={fork()} />)
    expect(getAllByRole('button')).toHaveLength(2)
  })

  it('frames AND separates the list with hairline rules (above first, between, below last)', () => {
    // Two items => three separator rules: one above, one between, one below.
    const { getAllByRole } = render(<GhostChoiceList items={fork()} />)
    expect(getAllByRole('separator')).toHaveLength(3)
  })

  it('renders the quiet subtitle text', () => {
    const { getByText } = render(<GhostChoiceList items={fork()} />)
    expect(getByText('Describe a vibe, a place, a what-if.')).toBeInTheDocument()
  })

  it("fires the chosen item's onSelect on click (and only that one)", async () => {
    const onA = vi.fn()
    const onB = vi.fn()
    const user = userEvent.setup()
    const { getByRole } = render(<GhostChoiceList items={fork(onA, onB)} />)
    await user.click(getByRole('button', { name: /Start from an idea/ }))
    expect(onA).toHaveBeenCalledOnce()
    expect(onB).not.toHaveBeenCalled()
  })

  it('fires onSelect on keyboard activation (Enter)', async () => {
    const onA = vi.fn()
    const user = userEvent.setup()
    const { getByRole } = render(<GhostChoiceList items={fork(onA)} />)
    getByRole('button', { name: /Start from an idea/ }).focus()
    await user.keyboard('{Enter}')
    expect(onA).toHaveBeenCalledOnce()
  })

  it('fires onSelect on keyboard activation (Space)', async () => {
    const onA = vi.fn()
    const user = userEvent.setup()
    const { getByRole } = render(<GhostChoiceList items={fork(onA)} />)
    getByRole('button', { name: /Start from an idea/ }).focus()
    await user.keyboard(' ')
    expect(onA).toHaveBeenCalledOnce()
  })

  it('is a GHOST, not a box: no border utility on the choice buttons', () => {
    const { getAllByRole } = render(<GhostChoiceList items={fork()} />)
    for (const btn of getAllByRole('button')) {
      expect(btn.className).not.toMatch(/(^|\s)border(\s|-|$)/)
    }
  })

  it('is flat (0px radius): rounded-none on the choice buttons', () => {
    const { getAllByRole } = render(<GhostChoiceList items={fork()} />)
    for (const btn of getAllByRole('button')) {
      expect(btn.className).toContain('rounded-none')
    }
  })

  it('forwards the ref to the list container', () => {
    const ref = createRef<HTMLDivElement>()
    render(<GhostChoiceList ref={ref} items={fork()} />)
    expect(ref.current).toBeInstanceOf(HTMLDivElement)
  })

  it('has no a11y violations', async () => {
    const { container } = render(<GhostChoiceList items={fork()} />)
    expect(await axe(container)).toHaveNoViolations()
  })
})
