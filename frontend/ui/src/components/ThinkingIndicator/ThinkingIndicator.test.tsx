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
// brand's sanctioned opacity pulse on a decorative SQUARE mark (frozen under
// prefers-reduced-motion by base.css; the steady prose is the non-motion signal),
// and idle renders no visible line.

const THINKING = '[ph: DM is thinking…]'
const TYPING = '[ph: is typing]'

describe('ThinkingIndicator', () => {
  it('renders the DM-thinking line while thinking', () => {
    const { getByTestId } = render(
      <ThinkingIndicator thinking typingNames={[]} thinkingLabel={THINKING} typingLabel={TYPING} />,
    )
    expect(getByTestId('thinking-indicator-thinking')).toHaveTextContent(THINKING)
  })

  it('pulses a decorative square mark on the thinking line (the sanctioned opacity fade)', () => {
    const { getByTestId } = render(
      <ThinkingIndicator thinking typingNames={[]} thinkingLabel={THINKING} typingLabel={TYPING} />,
    )
    const line = getByTestId('thinking-indicator-thinking')
    const mark = within(line).getByTestId('thinking-indicator-pulse')
    // Decorative ember mark — the pulse is the brand's only sanctioned motion (an
    // opacity fade); base.css freezes it under reduced motion, and the steady
    // prose remains the non-motion signal. Square (no circle/dot) per the register.
    expect(mark).toHaveAttribute('aria-hidden', 'true')
    expect(mark).toHaveClass('bg-accent', 'animate-pulse')
    expect(mark.className).not.toMatch(/rounded-full/)
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
