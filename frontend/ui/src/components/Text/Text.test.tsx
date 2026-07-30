import { describe, it, expect } from 'vitest'
import { createRef } from 'react'
import { render } from '@testing-library/react'
import { axe } from 'jest-axe'
import { Text } from './Text.tsx'
import { TYPE_ROLE_CLASS } from '../../lib/typography.ts'

// Behavior-tested with RTL + jest-dom matchers. jsdom does not compute Tailwind
// styles, so the token CLASS the impl applies is the observable contract.

describe('Text', () => {
  it('renders its children in a span by default', () => {
    const { getByTestId } = render(<Text data-testid="t">hello</Text>)
    const el = getByTestId('t')
    expect(el.tagName).toBe('SPAN')
    expect(el).toHaveTextContent('hello')
  })

  it('renders a <p> when as="p"', () => {
    const { getByTestId } = render(
      <Text data-testid="t" as="p">
        para
      </Text>,
    )
    expect(getByTestId('t').tagName).toBe('P')
  })

  it('applies the prose-body role classes by default', () => {
    const { getByTestId } = render(<Text data-testid="t">x</Text>)
    expect(getByTestId('t')).toHaveClass(...TYPE_ROLE_CLASS['prose-body'].split(' '))
  })

  it.each(['subtitle', 'ui-label', 'ui-caption', 'data', 'meta', 'chrome', 'chrome-strong'] as const)(
    'applies the %s role classes',
    (role) => {
      const { getByTestId } = render(
        <Text data-testid="t" role={role}>
          x
        </Text>,
      )
      expect(getByTestId('t')).toHaveClass(...TYPE_ROLE_CLASS[role].split(' '))
    },
  )

  it('chrome: 14px mono, hairline tracking, no color facet (bar chrome)', () => {
    expect(TYPE_ROLE_CLASS.chrome).toBe('font-ui text-sm font-normal tracking-[0.01em]')
  })

  it("chrome-strong: the credit number — semibold, tabular, the bar's ONE accent", () => {
    expect(TYPE_ROLE_CLASS['chrome-strong']).toBe(
      'font-ui text-sm font-semibold tracking-[0.01em] tabular-nums text-accent-fg',
    )
  })

  it('truncates to a single line with an ellipsis when truncate is set', () => {
    const { getByTestId } = render(
      <Text data-testid="t" truncate>
        a very long label that cannot fit on one line
      </Text>,
    )
    expect(getByTestId('t')).toHaveClass('overflow-hidden', 'text-ellipsis', 'whitespace-nowrap')
  })

  it('does not truncate by default (wraps)', () => {
    const { getByTestId } = render(<Text data-testid="t">x</Text>)
    expect(getByTestId('t')).not.toHaveClass('whitespace-nowrap')
  })

  it('holds its width (shrink-0) when noShrink is set', () => {
    const { getByTestId } = render(
      <Text data-testid="t" noShrink>
        fixed
      </Text>,
    )
    expect(getByTestId('t')).toHaveClass('shrink-0')
  })

  it('does not set shrink-0 by default', () => {
    const { getByTestId } = render(<Text data-testid="t">x</Text>)
    expect(getByTestId('t')).not.toHaveClass('shrink-0')
  })

  it('carries an element id (the anchor for a field describedBy relationship)', () => {
    const { getByTestId } = render(
      <Text data-testid="t" id="hint-1">
        A feeling, a place, a scene.
      </Text>,
    )
    expect(getByTestId('t')).toHaveAttribute('id', 'hint-1')
  })

  it('forwards its ref to the underlying element', () => {
    const ref = createRef<HTMLElement>()
    render(
      <Text ref={ref} data-testid="t">
        x
      </Text>,
    )
    expect(ref.current).toBeInstanceOf(HTMLSpanElement)
  })

  it('has no axe violations', async () => {
    // `role` here is Text's typographic-role API prop (a TYPE_ROLES name), not
    // the DOM ARIA `role`. Passing it via a typed const (not a JSX string
    // literal) keeps jsx-a11y/aria-role — which only inspects literal role
    // attributes — from misreading the domain prop as an ARIA role.
    const role = 'ui-label' as const
    const { container } = render(<Text role={role}>label</Text>)
    expect(await axe(container)).toHaveNoViolations()
  })
})
