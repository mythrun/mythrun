import { describe, expect, it } from 'vitest'
import { createRef } from 'react'
import { render } from '@testing-library/react'
import { WikiScrollFrame } from './WikiScrollFrame.tsx'

// WikiScrollFrame is the wiki's reading scroll region with an overflow affordance
// (myth-lcvv2): a persistent scrollbar + top/bottom fade masks that announce a
// definition running past the panel edge.

describe('WikiScrollFrame', () => {
  it('renders its children inside the scroll region', () => {
    const { getByText } = render(
      <WikiScrollFrame data-testid="scroll">
        <p>a long lore definition</p>
      </WikiScrollFrame>,
    )
    expect(getByText('a long lore definition')).toBeInTheDocument()
  })

  it('renders as a <div> by default and an <article> on request', () => {
    const { getByTestId, rerender } = render(
      <WikiScrollFrame data-testid="scroll">x</WikiScrollFrame>,
    )
    expect(getByTestId('scroll').tagName).toBe('DIV')
    rerender(
      <WikiScrollFrame as="article" data-testid="scroll">
        x
      </WikiScrollFrame>,
    )
    expect(getByTestId('scroll').tagName).toBe('ARTICLE')
  })

  it('forwards the scroll element to the caller ref (the shell scroll-memory handle)', () => {
    const ref = createRef<HTMLElement>()
    render(
      <WikiScrollFrame scrollRef={ref} data-testid="scroll">
        x
      </WikiScrollFrame>,
    )
    expect(ref.current).not.toBeNull()
    expect(ref.current?.getAttribute('data-testid')).toBe('scroll')
  })

  it('renders two aria-hidden fade masks that never enter the a11y tree', () => {
    const { container } = render(<WikiScrollFrame>x</WikiScrollFrame>)
    const fades = container.querySelectorAll('[aria-hidden="true"]')
    expect(fades).toHaveLength(2)
  })
})
