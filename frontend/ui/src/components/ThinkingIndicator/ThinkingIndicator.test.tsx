import { describe, it, expect } from 'vitest'
import { createRef } from 'react'
import { render, within } from '@testing-library/react'
import { axe } from 'jest-axe'
import { ThinkingIndicator } from './ThinkingIndicator.tsx'

// Behavior-tested with RTL + jest-dom (jsdom does not compute Tailwind, so the
// applied token classes are the observable contract). ThinkingIndicator is purely
// presentational — the useSession hook owns the CLEAR conditions, so these specs
// only pin what the current booleans/names render to. Load-bearing invariants: a
// polite live region is ALWAYS in the DOM (so a later state change is announced,
// not swallowed by a freshly-mounted region), the DM-thinking line carries the
// design system's Spinner as its activity mark wrapped in an `aria-hidden` span
// (so the Spinner's own role="status"/name does NOT double-announce against this
// component's live region — the line's text is the SOLE announcement), and idle
// renders no visible line.

const THINKING = '[ph: DM is thinking…]'
const TYPING = '[ph: is typing]'

describe('ThinkingIndicator', () => {
  it('renders the DM-thinking line while thinking', () => {
    const { getByTestId } = render(
      <ThinkingIndicator thinking typingNames={[]} thinkingLabel={THINKING} typingLabel={TYPING} />,
    )
    expect(getByTestId('thinking-indicator-thinking')).toHaveTextContent(THINKING)
  })

  it('renders the Spinner as the activity mark, wrapped aria-hidden so it does not double-announce', () => {
    const { getByTestId, getAllByRole } = render(
      <ThinkingIndicator thinking typingNames={[]} thinkingLabel={THINKING} typingLabel={TYPING} />,
    )
    const line = getByTestId('thinking-indicator-thinking')
    const mark = within(line).getByTestId('thinking-indicator-spinner')
    // The mark is the design system Spinner — its dither grid renders here (one
    // consistent "busy" language with the rest of the app, not a bespoke pulse).
    expect(mark.querySelector('[data-spinner-grid]')).not.toBeNull()
    // It is wrapped in an aria-hidden span: the Spinner carries its OWN
    // role="status"/aria-label, so hiding the whole subtree keeps this component's
    // live region the sole announcement (no double "Loading" + "DM is thinking…").
    expect(mark).toHaveAttribute('aria-hidden', 'true')
    // Concretely: exactly ONE announced live region survives (hidden roles are
    // excluded by default), and it is the component root — not the Spinner's status.
    const announced = getAllByRole('status')
    expect(announced).toHaveLength(1)
    expect(announced[0]).toBe(getByTestId('thinking-indicator'))
    // The Spinner's status node still exists in the DOM, but only inside the hidden
    // wrapper (neutralized for AT).
    expect(within(mark).getByRole('status', { hidden: true })).toBeInTheDocument()
  })

  it('renders typing presence from typingNames + the typing label', () => {
    const { getByTestId } = render(
      <ThinkingIndicator
        thinking={false}
        typingNames={['Kessa', 'Bram']}
        thinkingLabel={THINKING}
        typingLabel={TYPING}
      />,
    )
    const line = getByTestId('thinking-indicator-typing')
    expect(line).toHaveTextContent('Kessa')
    expect(line).toHaveTextContent('Bram')
    expect(line).toHaveTextContent(TYPING)
  })

  it('renders both the thinking and typing lines at once', () => {
    const { getByTestId } = render(
      <ThinkingIndicator
        thinking
        typingNames={['Kessa']}
        thinkingLabel={THINKING}
        typingLabel={TYPING}
      />,
    )
    expect(getByTestId('thinking-indicator-thinking')).toBeInTheDocument()
    expect(getByTestId('thinking-indicator-typing')).toBeInTheDocument()
  })

  it('keeps a polite live region in the DOM but shows no visible line when idle', () => {
    const { getByTestId, queryByTestId } = render(
      <ThinkingIndicator
        thinking={false}
        typingNames={[]}
        thinkingLabel={THINKING}
        typingLabel={TYPING}
      />,
    )
    const root = getByTestId('thinking-indicator')
    // The region persists so the next thinking/typing change is announced ...
    expect(root).toHaveAttribute('role', 'status')
    expect(root).toHaveAttribute('aria-live', 'polite')
    // ... but nothing is shown while idle.
    expect(queryByTestId('thinking-indicator-thinking')).toBeNull()
    expect(queryByTestId('thinking-indicator-typing')).toBeNull()
    expect(root).toHaveTextContent('')
  })

  it('renders the lines in the quiet mono register (font-ui)', () => {
    const { getByTestId } = render(
      <ThinkingIndicator
        thinking
        typingNames={['Kessa']}
        thinkingLabel={THINKING}
        typingLabel={TYPING}
      />,
    )
    expect(getByTestId('thinking-indicator-thinking').className).toMatch(/font-ui/)
    expect(getByTestId('thinking-indicator-typing').className).toMatch(/font-ui/)
  })

  it('forwards its ref to the live-region root', () => {
    const ref = createRef<HTMLDivElement>()
    render(
      <ThinkingIndicator
        ref={ref}
        thinking
        typingNames={[]}
        thinkingLabel={THINKING}
        typingLabel={TYPING}
      />,
    )
    expect(ref.current).toBeInstanceOf(HTMLDivElement)
  })

  it('has no axe violations across idle, thinking, typing, and both', async () => {
    const idle = render(
      <ThinkingIndicator thinking={false} typingNames={[]} thinkingLabel={THINKING} typingLabel={TYPING} />,
    )
    expect(await axe(idle.container)).toHaveNoViolations()
    const thinking = render(
      <ThinkingIndicator thinking typingNames={[]} thinkingLabel={THINKING} typingLabel={TYPING} />,
    )
    expect(await axe(thinking.container)).toHaveNoViolations()
    const typing = render(
      <ThinkingIndicator
        thinking={false}
        typingNames={['Kessa', 'Bram']}
        thinkingLabel={THINKING}
        typingLabel={TYPING}
      />,
    )
    expect(await axe(typing.container)).toHaveNoViolations()
    const both = render(
      <ThinkingIndicator thinking typingNames={['Kessa']} thinkingLabel={THINKING} typingLabel={TYPING} />,
    )
    expect(await axe(both.container)).toHaveNoViolations()
  })
})
