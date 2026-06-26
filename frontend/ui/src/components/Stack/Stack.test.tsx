import { describe, it, expect } from 'vitest'
import { createRef } from 'react'
import { render, screen } from '@testing-library/react'
import { axe } from 'jest-axe'
import { Stack } from './Stack.tsx'

// Behavior-tested with RTL + native DOM assertions (the harness registers
// jest-axe, not jest-dom). We assert the token CLASS the impl applies — jsdom
// does not compute Tailwind styles, so the class name is the observable contract.

describe('Stack', () => {
  it('renders its children inside a div', () => {
    const { getByTestId } = render(<Stack data-testid="stack">hello</Stack>)
    const el = getByTestId('stack')
    expect(el.tagName).toBe('DIV')
    expect(el.textContent).toBe('hello')
  })

  it('is a flex column by default', () => {
    const { getByTestId } = render(<Stack data-testid="stack">x</Stack>)
    const el = getByTestId('stack')
    expect(el.classList.contains('flex')).toBe(true)
    expect(el.classList.contains('flex-col')).toBe(true)
  })

  it('lays out as a row when direction=row', () => {
    const { getByTestId } = render(
      <Stack data-testid="stack" direction="row">
        x
      </Stack>,
    )
    expect(getByTestId('stack').classList.contains('flex-row')).toBe(true)
  })

  it('applies the gap token class for the given SpaceToken', () => {
    const { getByTestId } = render(
      <Stack data-testid="stack" gap={4}>
        x
      </Stack>,
    )
    expect(getByTestId('stack').classList.contains('gap-[var(--space-4)]')).toBe(true)
  })

  it('maps align to the corresponding align-items class', () => {
    const { getByTestId } = render(
      <Stack data-testid="stack" align="center">
        x
      </Stack>,
    )
    expect(getByTestId('stack').classList.contains('items-center')).toBe(true)
  })

  it('maps justify=between to justify-content: space-between', () => {
    const { getByTestId } = render(
      <Stack data-testid="stack" justify="between">
        x
      </Stack>,
    )
    expect(getByTestId('stack').classList.contains('justify-between')).toBe(true)
  })

  it('applies min-w-0 to its children so they can shrink under constraint', () => {
    const { getByTestId } = render(<Stack data-testid="stack">x</Stack>)
    expect(getByTestId('stack').classList.contains('[&>*]:min-w-0')).toBe(true)
  })

  it('wraps children onto multiple lines when wrap is set', () => {
    const { getByTestId } = render(
      <Stack data-testid="stack" direction="row" wrap>
        x
      </Stack>,
    )
    expect(getByTestId('stack').classList.contains('flex-wrap')).toBe(true)
  })

  it('does not wrap by default', () => {
    const { getByTestId } = render(<Stack data-testid="stack">x</Stack>)
    expect(getByTestId('stack').classList.contains('flex-wrap')).toBe(false)
  })

  it('forwards its ref to the underlying div', () => {
    const ref = createRef<HTMLDivElement>()
    render(
      <Stack ref={ref} data-testid="stack">
        x
      </Stack>,
    )
    expect(ref.current).toBeInstanceOf(HTMLDivElement)
  })

  it('applies the dvh floor when minHeight="screen"', () => {
    render(<Stack minHeight="screen" data-testid="s" />)
    expect(screen.getByTestId('s').className).toContain('min-h-dvh')
  })

  it('applies flex-grow when grow', () => {
    render(<Stack grow data-testid="s" />)
    expect(screen.getByTestId('s').className).toContain('grow')
  })

  it('has no axe violations', async () => {
    const { container } = render(
      <Stack gap={3} align="center" justify="between">
        <span>a</span>
        <span>b</span>
      </Stack>,
    )
    expect(await axe(container)).toHaveNoViolations()
  })
})
