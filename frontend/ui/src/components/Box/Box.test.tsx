import { describe, it, expect } from 'vitest'
import { createRef } from 'react'
import { render, screen } from '@testing-library/react'
import { axe } from 'jest-axe'
import { Box } from './Box.tsx'

describe('Box', () => {
  it('renders its children inside a div', () => {
    const { getByTestId } = render(<Box data-testid="box">content</Box>)
    const el = getByTestId('box')
    expect(el.tagName).toBe('DIV')
    expect(el.textContent).toBe('content')
  })

  it('uses the base surface by default', () => {
    const { getByTestId } = render(<Box data-testid="box">x</Box>)
    expect(getByTestId('box').classList.contains('bg-surface')).toBe(true)
  })

  it('maps surface=raised to the raised surface token', () => {
    const { getByTestId } = render(
      <Box data-testid="box" surface="raised">
        x
      </Box>,
    )
    expect(getByTestId('box').classList.contains('bg-surface-raised')).toBe(true)
  })

  it('maps surface=overlay to the overlay surface token', () => {
    const { getByTestId } = render(
      <Box data-testid="box" surface="overlay">
        x
      </Box>,
    )
    expect(getByTestId('box').classList.contains('bg-surface-overlay')).toBe(true)
  })

  it('maps surface=reversed to the dark reversed surface', () => {
    const { getByTestId } = render(
      <Box data-testid="box" surface="reversed">
        x
      </Box>,
    )
    const el = getByTestId('box')
    // `.dark` re-establishes the reversed surface (base.css flips --bg/--ink);
    // `bg-bg` paints the flipped dark fill.
    expect(el.classList.contains('dark')).toBe(true)
    expect(el.classList.contains('bg-bg')).toBe(true)
  })

  it('maps surface=inverted to the theme-inverting surface', () => {
    const { getByTestId } = render(
      <Box data-testid="box" surface="inverted">
        x
      </Box>,
    )
    const el = getByTestId('box')
    // `.surface-inverted` flips with the page theme (dark on a light page, light on
    // a dark page); `bg-bg` paints the flipped fill.
    expect(el.classList.contains('surface-inverted')).toBe(true)
    expect(el.classList.contains('bg-bg')).toBe(true)
  })

  it('paints no background when surface=none (transparent landmark)', () => {
    const { getByTestId } = render(
      <Box data-testid="box" surface="none">
        x
      </Box>,
    )
    const el = getByTestId('box')
    expect(el.classList.contains('bg-surface')).toBe(false)
    expect(el.classList.contains('surface-inverted')).toBe(false)
    expect(el.classList.contains('bg-bg')).toBe(false)
  })

  it('floors the box at the viewport height when minHeight=screen', () => {
    const { getByTestId } = render(
      <Box data-testid="box" minHeight="screen">
        x
      </Box>,
    )
    expect(getByTestId('box').classList.contains('min-h-dvh')).toBe(true)
  })

  it('has no viewport floor by default', () => {
    const { getByTestId } = render(<Box data-testid="box">x</Box>)
    expect(getByTestId('box').classList.contains('min-h-dvh')).toBe(false)
  })

  it('applies the padding token class for the given SpaceToken', () => {
    const { getByTestId } = render(
      <Box data-testid="box" padding={5}>
        x
      </Box>,
    )
    expect(getByTestId('box').classList.contains('p-[var(--space-5)]')).toBe(true)
  })

  it('draws a strong border when border is set', () => {
    const { getByTestId } = render(
      <Box data-testid="box" border>
        x
      </Box>,
    )
    const el = getByTestId('box')
    expect(el.classList.contains('border')).toBe(true)
    expect(el.classList.contains('border-border-strong')).toBe(true)
  })

  it('has no border classes when border is unset', () => {
    const { getByTestId } = render(<Box data-testid="box">x</Box>)
    const el = getByTestId('box')
    expect(el.classList.contains('border-border-strong')).toBe(false)
  })

  it('renders the semantic element named by `as`', () => {
    render(<Box as="nav" data-testid="b">x</Box>)
    expect(screen.getByTestId('b').tagName).toBe('NAV')
  })

  it('renders a footer landmark with a reversed surface', () => {
    render(<Box as="footer" surface="reversed" data-testid="b">x</Box>)
    const el = screen.getByTestId('b')
    expect(el.tagName).toBe('FOOTER')
    expect(el.className).toContain('dark')
  })

  it('forwards its ref to the underlying div', () => {
    const ref = createRef<HTMLDivElement>()
    render(
      <Box ref={ref} data-testid="box">
        x
      </Box>,
    )
    expect(ref.current).toBeInstanceOf(HTMLDivElement)
  })

  it('has no axe violations', async () => {
    const { container } = render(
      <Box padding={4} surface="raised" border>
        <span>panel</span>
      </Box>,
    )
    expect(await axe(container)).toHaveNoViolations()
  })
})
