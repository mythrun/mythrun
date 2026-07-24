import { afterEach, describe, expect, it } from 'vitest'
import { render, screen, cleanup } from '@testing-library/react'
import { CoverCardAdd } from './CoverCardAdd.tsx'

// CoverCardAdd — the dashed create tile (MYT-3jb55). It carries the label (the
// wrapping link's accessible name), takes CoverCard's dashed 3:2 register, and
// either fixes its width to match the sibling covers or fills the grid track.

afterEach(cleanup)

describe('CoverCardAdd', () => {
  it('renders the action label', () => {
    render(<CoverCardAdd label="New campaign" />)
    expect(screen.getByText('New campaign')).toBeDefined()
  })

  it('takes the dashed cover-shaped register', () => {
    render(<CoverCardAdd label="New campaign" data-testid="add" />)
    const { className } = screen.getByTestId('add')
    expect(className).toContain('border-dashed')
    expect(className).toContain('aspect-[2/3]')
  })

  it('fixes the width to match the sibling covers when given', () => {
    render(<CoverCardAdd label="New campaign" width={230} data-testid="add" />)
    const tile = screen.getByTestId('add')
    expect(tile.style.width).toBe('230px')
    expect(tile.className).not.toContain('w-full')
  })

  it('fills the container (w-full) when no width is given', () => {
    render(<CoverCardAdd label="New campaign" data-testid="add" />)
    const tile = screen.getByTestId('add')
    expect(tile.style.width).toBe('')
    expect(tile.className).toContain('w-full')
  })
})
