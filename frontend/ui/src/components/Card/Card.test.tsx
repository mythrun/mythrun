import { describe, it, expect } from 'vitest'
import { createRef } from 'react'
import { render } from '@testing-library/react'
import { axe } from 'jest-axe'
import { Card, CardHeader, CardBody, CardFooter } from './Card.tsx'

describe('Card', () => {
  it('renders its children inside a div', () => {
    const { getByTestId } = render(<Card data-testid="card">content</Card>)
    const el = getByTestId('card')
    expect(el.tagName).toBe('DIV')
    expect(el.textContent).toBe('content')
  })

  it('uses the base surface by default with the strong border, flat (no radius)', () => {
    const { getByTestId } = render(<Card data-testid="card">x</Card>)
    const el = getByTestId('card')
    expect(el.classList.contains('bg-surface')).toBe(true)
    expect(el.classList.contains('border')).toBe(true)
    expect(el.classList.contains('border-border-strong')).toBe(true)
    expect(el.classList.contains('rounded-none')).toBe(true)
    expect(el.classList.contains('overflow-hidden')).toBe(true)
  })

  it('maps surface=raised to the raised surface token', () => {
    const { getByTestId } = render(
      <Card data-testid="card" surface="raised">
        x
      </Card>,
    )
    expect(getByTestId('card').classList.contains('bg-surface-raised')).toBe(true)
  })

  it('imposes no implicit role (neutral generic container)', () => {
    const { getByTestId } = render(<Card data-testid="card">x</Card>)
    expect(getByTestId('card').getAttribute('role')).toBeNull()
  })

  it('forwards its ref to the underlying div', () => {
    const ref = createRef<HTMLDivElement>()
    render(
      <Card ref={ref} data-testid="card">
        x
      </Card>,
    )
    expect(ref.current).toBeInstanceOf(HTMLDivElement)
  })

  it('has no axe violations', async () => {
    const { container } = render(
      <Card surface="raised">
        <CardHeader>title</CardHeader>
        <CardBody>body</CardBody>
        <CardFooter>action</CardFooter>
      </Card>,
    )
    expect(await axe(container)).toHaveNoViolations()
  })
})

describe('CardHeader', () => {
  it('renders children with a bottom decorative divider and token padding', () => {
    const { getByTestId } = render(<CardHeader data-testid="hdr">head</CardHeader>)
    const el = getByTestId('hdr')
    expect(el.textContent).toBe('head')
    expect(el.classList.contains('border-b')).toBe(true)
    expect(el.classList.contains('border-border')).toBe(true)
    expect(el.classList.contains('p-[var(--space-4)]')).toBe(true)
  })

  it('forwards its ref', () => {
    const ref = createRef<HTMLDivElement>()
    render(<CardHeader ref={ref}>x</CardHeader>)
    expect(ref.current).toBeInstanceOf(HTMLDivElement)
  })
})

describe('CardBody', () => {
  it('renders children with token padding and no divider', () => {
    const { getByTestId } = render(<CardBody data-testid="body">main</CardBody>)
    const el = getByTestId('body')
    expect(el.textContent).toBe('main')
    expect(el.classList.contains('p-[var(--space-4)]')).toBe(true)
    expect(el.classList.contains('border-b')).toBe(false)
    expect(el.classList.contains('border-t')).toBe(false)
  })

  it('forwards its ref', () => {
    const ref = createRef<HTMLDivElement>()
    render(<CardBody ref={ref}>x</CardBody>)
    expect(ref.current).toBeInstanceOf(HTMLDivElement)
  })
})

describe('CardFooter', () => {
  it('renders children with a top decorative divider and token padding', () => {
    const { getByTestId } = render(<CardFooter data-testid="ftr">foot</CardFooter>)
    const el = getByTestId('ftr')
    expect(el.textContent).toBe('foot')
    expect(el.classList.contains('border-t')).toBe(true)
    expect(el.classList.contains('border-border')).toBe(true)
    expect(el.classList.contains('p-[var(--space-4)]')).toBe(true)
  })

  it('forwards its ref', () => {
    const ref = createRef<HTMLDivElement>()
    render(<CardFooter ref={ref}>x</CardFooter>)
    expect(ref.current).toBeInstanceOf(HTMLDivElement)
  })
})

describe('Card composition', () => {
  it('renders header, body, and footer in source order', () => {
    const { getByTestId } = render(
      <Card data-testid="card">
        <CardHeader data-testid="hdr">H</CardHeader>
        <CardBody data-testid="body">B</CardBody>
        <CardFooter data-testid="ftr">F</CardFooter>
      </Card>,
    )
    const card = getByTestId('card')
    const order = Array.from(card.children).map((c) => c.getAttribute('data-testid'))
    expect(order).toEqual(['hdr', 'body', 'ftr'])
    expect(card.textContent).toBe('HBF')
  })
})
