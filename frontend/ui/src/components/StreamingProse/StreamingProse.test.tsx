import { describe, it, expect } from 'vitest'
import { createRef } from 'react'
import { render } from '@testing-library/react'
import { axe } from 'jest-axe'
import { StreamingProse } from './StreamingProse.tsx'
import { TYPE_ROLE_CLASS } from '../../lib/typography.ts'

// Behavior-tested with RTL + jest-dom matchers (jsdom does not compute
// Tailwind styles, so the applied token classes are the observable contract).
// The load-bearing invariants: the prose renders byte-identical in type
// classes to <Text role="prose-body" as="p"> (zero-reflow handoff when the
// stream finishes), and the caret exists ONLY while `writing` — decorative
// (aria-hidden), ember-inked, pulsing on the brand's sanctioned opacity fade.

describe('StreamingProse', () => {
  it('renders the text in a <p> carrying the prose-body role classes', () => {
    const { getByTestId } = render(<StreamingProse data-testid="sp" text="A quiet valley." />)
    const el = getByTestId('sp')
    expect(el.tagName).toBe('P')
    expect(el).toHaveTextContent('A quiet valley.')
    expect(el).toHaveClass(...TYPE_ROLE_CLASS['prose-body'].split(' '))
  })

  it('shows the writing caret while writing: decorative, ember, opacity-pulse', () => {
    const { getByTestId, container } = render(
      <StreamingProse data-testid="sp" text="A quiet" writing />,
    )
    const caret = container.querySelector('[data-streaming-caret]')
    expect(caret).not.toBeNull()
    expect(caret).toHaveAttribute('aria-hidden', 'true')
    expect(caret).toHaveClass('bg-accent', 'animate-pulse')
    // The passage announces in-progress to AT.
    expect(getByTestId('sp')).toHaveAttribute('aria-busy', 'true')
  })

  it('drops the caret and the busy state when writing ends', () => {
    const { getByTestId, container } = render(
      <StreamingProse data-testid="sp" text="A quiet valley." writing={false} />,
    )
    expect(container.querySelector('[data-streaming-caret]')).toBeNull()
    expect(getByTestId('sp')).not.toHaveAttribute('aria-busy')
  })

  it('announces the writingLabel to AT only while writing', () => {
    const { queryByText, rerender } = render(
      <StreamingProse text="A qui" writing writingLabel="still writing" />,
    )
    expect(queryByText('still writing')).not.toBeNull()
    rerender(<StreamingProse text="A quiet valley." writingLabel="still writing" />)
    expect(queryByText('still writing')).toBeNull()
  })

  it('renders inline emphasis as <em>/<strong> once settled (myth-5syk3)', () => {
    const { container } = render(
      <StreamingProse data-testid="sp" text="the *order*, then **V. L. K.**" writing={false} />,
    )
    expect(container.querySelector('em')).toHaveTextContent('order')
    expect(container.querySelector('strong')).toHaveTextContent('V. L. K.')
    // No literal asterisk ever reaches the reader.
    expect(container.textContent).not.toContain('*')
  })

  it('strips emphasis markers while writing — no literal asterisk flashes mid-stream', () => {
    const { getByTestId, container } = render(
      <StreamingProse data-testid="sp" text="the *ord" writing />,
    )
    // Mid-stream the opener has arrived but not the closer; the marker is hidden.
    expect(getByTestId('sp')).toHaveTextContent('the ord')
    expect(container.textContent).not.toContain('*')
    expect(container.querySelector('em')).toBeNull()
  })

  it('forwards its ref to the paragraph element', () => {
    const ref = createRef<HTMLParagraphElement>()
    render(<StreamingProse ref={ref} text="x" />)
    expect(ref.current).toBeInstanceOf(HTMLParagraphElement)
  })

  it('has no axe violations, writing and settled', async () => {
    const writing = render(<StreamingProse text="A qui" writing writingLabel="still writing" />)
    expect(await axe(writing.container)).toHaveNoViolations()
    const settled = render(<StreamingProse text="A quiet valley." />)
    expect(await axe(settled.container)).toHaveNoViolations()
  })
})
