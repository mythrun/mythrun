import { describe, it, expect } from 'vitest'
import { createRef } from 'react'
import { render } from '@testing-library/react'
import { axe } from 'jest-axe'
import { Grid } from './Grid.tsx'

describe('Grid', () => {
  it('renders its children inside a grid div', () => {
    const { getByTestId } = render(<Grid data-testid="grid">cells</Grid>)
    const el = getByTestId('grid')
    expect(el.tagName).toBe('DIV')
    expect(el.classList.contains('grid')).toBe(true)
    expect(el.textContent).toBe('cells')
  })

  it('defaults to a single column', () => {
    const { getByTestId } = render(<Grid data-testid="grid">x</Grid>)
    expect(getByTestId('grid').style.gridTemplateColumns).toBe('repeat(1, minmax(0, 1fr))')
  })

  it('sets a fixed column count via gridTemplateColumns', () => {
    const { getByTestId } = render(
      <Grid data-testid="grid" columns={3}>
        x
      </Grid>,
    )
    expect(getByTestId('grid').style.gridTemplateColumns).toBe('repeat(3, minmax(0, 1fr))')
  })

  it('uses an auto-fit track class when columns=auto-fit, sized by minColumnWidth', () => {
    const { getByTestId } = render(
      <Grid data-testid="grid" columns="auto-fit" minColumnWidth={7}>
        x
      </Grid>,
    )
    const el = getByTestId('grid')
    expect(el.classList.contains('grid-cols-[repeat(auto-fit,minmax(var(--space-7),1fr))]')).toBe(
      true,
    )
    // The arbitrary track class drives auto-fit, not the inline fixed-count style.
    expect(el.style.gridTemplateColumns).toBe('')
  })

  it('falls back to a sensible auto-fit minimum when minColumnWidth is omitted', () => {
    const { getByTestId } = render(
      <Grid data-testid="grid" columns="auto-fit">
        x
      </Grid>,
    )
    const el = getByTestId('grid')
    // Default min column width is --space-9 (the largest scale step).
    expect(el.classList.contains('grid-cols-[repeat(auto-fit,minmax(var(--space-9),1fr))]')).toBe(
      true,
    )
  })

  it('renders an inline auto-fill px track when columns=auto-fill + minColumnPx', () => {
    const { getByTestId } = render(
      <Grid data-testid="grid" columns="auto-fill" minColumnPx={230}>
        x
      </Grid>,
    )
    const el = getByTestId('grid')
    // A card-width (~230px) track lives OFF the --space scale, so it is an inline
    // px minmax, and auto-FILL keeps the card width stable (empty tracks are kept,
    // cards don't stretch) as the item count changes.
    expect(el.style.gridTemplateColumns).toBe('repeat(auto-fill, minmax(230px, 1fr))')
    // px auto-fill is inline; no auto-fit track class is applied.
    expect(el.className).not.toContain('grid-cols-')
  })

  it('falls back to the SpaceToken minimum for auto-fill when minColumnPx is omitted', () => {
    const { getByTestId } = render(
      <Grid data-testid="grid" columns="auto-fill" minColumnWidth={7}>
        x
      </Grid>,
    )
    // No px override — auto-fill reuses the --space token vocabulary, inline.
    expect(getByTestId('grid').style.gridTemplateColumns).toBe(
      'repeat(auto-fill, minmax(var(--space-7), 1fr))',
    )
  })

  it('defaults the auto-fill minimum to --space-9 when neither px nor token is given', () => {
    const { getByTestId } = render(
      <Grid data-testid="grid" columns="auto-fill">
        x
      </Grid>,
    )
    expect(getByTestId('grid').style.gridTemplateColumns).toBe(
      'repeat(auto-fill, minmax(var(--space-9), 1fr))',
    )
  })

  it('applies the gap token class for the given SpaceToken', () => {
    const { getByTestId } = render(
      <Grid data-testid="grid" gap={5}>
        x
      </Grid>,
    )
    expect(getByTestId('grid').classList.contains('gap-[var(--space-5)]')).toBe(true)
  })

  it('forwards its ref to the underlying div', () => {
    const ref = createRef<HTMLDivElement>()
    render(
      <Grid ref={ref} data-testid="grid">
        x
      </Grid>,
    )
    expect(ref.current).toBeInstanceOf(HTMLDivElement)
  })

  it('has no axe violations', async () => {
    const { container } = render(
      <Grid columns={2} gap={4}>
        <span>a</span>
        <span>b</span>
      </Grid>,
    )
    expect(await axe(container)).toHaveNoViolations()
  })
})
