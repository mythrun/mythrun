import { describe, it, expect } from 'vitest'
import { createRef } from 'react'
import { render } from '@testing-library/react'
import { axe } from 'jest-axe'
import { Heading } from './Heading.tsx'
import { TYPE_ROLE_CLASS } from '../../lib/typography.ts'

describe('Heading', () => {
  it.each([1, 2, 3, 4, 5, 6] as const)('renders an h%i for level=%i', (level) => {
    const { getByTestId } = render(
      <Heading data-testid="h" level={level}>
        title
      </Heading>,
    )
    expect(getByTestId('h').tagName).toBe(`H${String(level)}`)
  })

  it('applies the heading role classes by default', () => {
    const { getByTestId } = render(
      <Heading data-testid="h" level={2}>
        x
      </Heading>,
    )
    expect(getByTestId('h')).toHaveClass(...TYPE_ROLE_CLASS.heading.split(' '))
  })

  it.each(['display', 'headline', 'title'] as const)('applies the %s role classes', (role) => {
    const { getByTestId } = render(
      <Heading data-testid="h" level={1} role={role}>
        x
      </Heading>,
    )
    expect(getByTestId('h')).toHaveClass(...TYPE_ROLE_CLASS[role].split(' '))
  })

  it('decouples semantic level from visual role (h3 can read at display size)', () => {
    // `role` is Heading's visual-role API prop (a TYPE_ROLES name), not the DOM
    // ARIA `role`. Passing it via a typed const (not a JSX string literal) keeps
    // jsx-a11y/aria-role from misreading the domain prop as an ARIA role.
    const role = 'display' as const
    const { getByTestId } = render(
      <Heading data-testid="h" level={3} role={role}>
        x
      </Heading>,
    )
    const el = getByTestId('h')
    expect(el.tagName).toBe('H3')
    expect(el).toHaveClass(...TYPE_ROLE_CLASS.display.split(' '))
  })

  it('forwards its ref to the underlying heading element', () => {
    const ref = createRef<HTMLHeadingElement>()
    render(
      <Heading ref={ref} data-testid="h" level={1}>
        x
      </Heading>,
    )
    expect(ref.current).toBeInstanceOf(HTMLHeadingElement)
  })

  it('has no axe violations', async () => {
    const { container } = render(<Heading level={1}>Page title</Heading>)
    expect(await axe(container)).toHaveNoViolations()
  })
})
