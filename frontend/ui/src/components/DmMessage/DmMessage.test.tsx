import { describe, it, expect } from 'vitest'
import { createRef } from 'react'
import { render } from '@testing-library/react'
import { axe } from 'jest-axe'
import { DmMessage } from './DmMessage.tsx'
import { TYPE_ROLE_CLASS } from '../../lib/typography.ts'

// Behavior-tested with RTL + jest-dom (jsdom does not compute Tailwind styles,
// so the applied token classes are the observable contract). DmMessage is a THIN
// wrapper: it fixes the DM register (Source Serif 4 prose on a quiet paper tint)
// over the shipped StreamingProse and does NOT re-implement the caret. The
// load-bearing invariants: the prose renders in the `prose-body` serif role
// (byte-identical to a settled `<Text role="prose-body">` — the zero-reflow
// handoff StreamingProse guarantees), the DM row carries its distinct paper
// tint, and `streaming` drives StreamingProse's writing caret + SR annotation.

describe('DmMessage', () => {
  it('renders the DM prose in a serif prose-body <p>', () => {
    const { container } = render(<DmMessage text="A quiet valley." streaming={false} />)
    const p = container.querySelector('p')
    expect(p).not.toBeNull()
    expect(p).toHaveTextContent('A quiet valley.')
    // Serif narrative register — the same prose-body role classes StreamingProse
    // applies, so the streaming→settled handoff never reflows.
    expect(p).toHaveClass(...TYPE_ROLE_CLASS['prose-body'].split(' '))
  })

  it('sits on the DM paper tint (the distinct narrative surface)', () => {
    const { container } = render(<DmMessage text="A quiet valley." streaming={false} />)
    const row = container.querySelector('[data-dm-message]')
    expect(row).not.toBeNull()
    // The narrative register: a quiet warm paper lift (bg-surface), distinct from
    // the player row's tint. A utility (not a frozen var), so it flips under .dark.
    expect(row).toHaveClass('bg-surface')
  })

  it('shows the writing caret while streaming', () => {
    const { container } = render(<DmMessage text="A quiet" streaming />)
    const caret = container.querySelector('[data-streaming-caret]')
    expect(caret).not.toBeNull()
    expect(caret).toHaveAttribute('aria-hidden', 'true')
    // The passage announces in-progress to AT.
    expect(container.querySelector('p')).toHaveAttribute('aria-busy', 'true')
  })

  it('drops the caret and busy state when the turn settles', () => {
    const { container } = render(<DmMessage text="A quiet valley." streaming={false} />)
    expect(container.querySelector('[data-streaming-caret]')).toBeNull()
    expect(container.querySelector('p')).not.toHaveAttribute('aria-busy')
  })

  it('announces the writingLabel to AT only while streaming', () => {
    const { queryByText, rerender } = render(
      <DmMessage text="A qui" streaming writingLabel="DM is writing" />,
    )
    expect(queryByText('DM is writing')).not.toBeNull()
    rerender(<DmMessage text="A quiet valley." streaming={false} writingLabel="DM is writing" />)
    expect(queryByText('DM is writing')).toBeNull()
  })

  it('forwards its ref to the DM row element', () => {
    const ref = createRef<HTMLDivElement>()
    render(<DmMessage ref={ref} text="x" streaming={false} />)
    expect(ref.current).toBeInstanceOf(HTMLDivElement)
    expect(ref.current).toHaveAttribute('data-dm-message')
  })

  it('has no axe violations, streaming and settled', async () => {
    const streaming = render(<DmMessage text="A qui" streaming writingLabel="DM is writing" />)
    expect(await axe(streaming.container)).toHaveNoViolations()
    const settled = render(<DmMessage text="A quiet valley." streaming={false} />)
    expect(await axe(settled.container)).toHaveNoViolations()
  })
})
