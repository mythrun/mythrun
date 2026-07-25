import { describe, it, expect, vi } from 'vitest'
import { createRef } from 'react'
import { render } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { axe } from 'jest-axe'
import { GhostChoiceList } from './GhostChoiceList.tsx'
import type { GhostChoiceItem } from '@mythrun/client-core/contract'

// The campaign-create fork: two selectable option cards.
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

  it('cards the options (no hairline separators — the border carries the boundary)', () => {
    const { queryAllByRole } = render(<GhostChoiceList items={fork()} />)
    expect(queryAllByRole('separator')).toHaveLength(0)
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

  it('cards each option: a bounded interactive border on the choice buttons', () => {
    const { getAllByRole } = render(<GhostChoiceList items={fork()} />)
    for (const btn of getAllByRole('button')) {
      expect(btn.className).toContain('border-border-strong')
    }
  })

  it('renders the per-item testId on its button when supplied', () => {
    const items: GhostChoiceItem[] = [
      { id: 'a', title: 'First', onSelect: vi.fn(), testId: 'choice-a' },
      { id: 'b', title: 'Second', onSelect: vi.fn() },
    ]
    const { getByTestId, getByRole } = render(<GhostChoiceList items={items} />)
    expect(getByTestId('choice-a').tagName).toBe('BUTTON')
    // The item without a testId is unaffected — still a real, named button.
    expect(getByRole('button', { name: /Second/ })).toBeInTheDocument()
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

  it('stacks as a single column by default', () => {
    const ref = createRef<HTMLDivElement>()
    render(<GhostChoiceList ref={ref} items={fork()} />)
    expect(ref.current?.className).toContain('flex-col')
    expect(ref.current?.className).not.toContain('sm:grid-cols-2')
  })

  it('seats the choices side by side when columns=2 (restacking below sm)', () => {
    // ux-run2 myth-ma8yv (critique 024): a binary fork reads as two doors, not a
    // stack of bars — two columns at comfortable widths, one column at 375px.
    const ref = createRef<HTMLDivElement>()
    render(<GhostChoiceList ref={ref} items={fork()} columns={2} />)
    expect(ref.current?.className).toContain('grid')
    expect(ref.current?.className).toContain('grid-cols-1')
    expect(ref.current?.className).toContain('sm:grid-cols-2')
  })

  it('gives the side-by-side cards their taller (door, not letterbox) floor', () => {
    const { getAllByRole } = render(<GhostChoiceList items={fork()} columns={2} />)
    for (const btn of getAllByRole('button')) {
      expect(btn.className).toContain('min-h-[10rem]')
    }
  })

  it('keeps the stacked strips at their content height (no tall floor)', () => {
    const { getAllByRole } = render(<GhostChoiceList items={fork()} />)
    for (const btn of getAllByRole('button')) {
      expect(btn.className).not.toContain('min-h-[10rem]')
    }
  })

  it('has no a11y violations', async () => {
    const { container } = render(<GhostChoiceList items={fork()} />)
    expect(await axe(container)).toHaveNoViolations()
  })
})
