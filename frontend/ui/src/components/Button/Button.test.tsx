import { describe, it, expect, vi } from 'vitest'
import { createRef } from 'react'
import { render } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { axe } from 'jest-axe'
import { Button } from './Button.tsx'

describe('Button', () => {
  it('renders a real <button> with its accessible name', () => {
    const { getByRole } = render(<Button>Save</Button>)
    const el = getByRole('button', { name: 'Save' })
    expect(el.tagName).toBe('BUTTON')
  })

  it('defaults to type="button" (never an accidental form submit)', () => {
    const { getByRole } = render(<Button>x</Button>)
    expect(getByRole('button')).toHaveAttribute('type', 'button')
  })

  it('honours an explicit type="submit"', () => {
    const { getByRole } = render(<Button type="submit">x</Button>)
    expect(getByRole('button')).toHaveAttribute('type', 'submit')
  })

  it('calls onPress on click', async () => {
    const onPress = vi.fn()
    const user = userEvent.setup()
    const { getByRole } = render(<Button onPress={onPress}>go</Button>)
    await user.click(getByRole('button'))
    expect(onPress).toHaveBeenCalledOnce()
  })

  it('calls onPress on keyboard activation (Enter)', async () => {
    const onPress = vi.fn()
    const user = userEvent.setup()
    const { getByRole } = render(<Button onPress={onPress}>go</Button>)
    getByRole('button').focus()
    await user.keyboard('{Enter}')
    expect(onPress).toHaveBeenCalledOnce()
  })

  it('calls onPress on keyboard activation (Space)', async () => {
    const onPress = vi.fn()
    const user = userEvent.setup()
    const { getByRole } = render(<Button onPress={onPress}>go</Button>)
    getByRole('button').focus()
    await user.keyboard(' ')
    expect(onPress).toHaveBeenCalledOnce()
  })

  it('does NOT call onPress when disabled (click or keyboard)', async () => {
    const onPress = vi.fn()
    const user = userEvent.setup()
    const { getByRole } = render(
      <Button onPress={onPress} disabled>
        go
      </Button>,
    )
    const el = getByRole('button')
    expect(el).toBeDisabled()
    await user.click(el)
    el.focus()
    await user.keyboard('{Enter}')
    await user.keyboard(' ')
    expect(onPress).not.toHaveBeenCalled()
  })

  it('does NOT call onPress when loading (click or keyboard)', async () => {
    const onPress = vi.fn()
    const user = userEvent.setup()
    const { getByRole } = render(
      <Button onPress={onPress} loading>
        go
      </Button>,
    )
    const el = getByRole('button')
    // Loading makes the control non-interactive (disabled while busy).
    expect(el).toBeDisabled()
    await user.click(el)
    el.focus()
    await user.keyboard('{Enter}')
    await user.keyboard(' ')
    expect(onPress).not.toHaveBeenCalled()
  })

  it('exposes aria-busy + a Spinner when loading, keeping the label visible', () => {
    const { getByRole } = render(<Button loading>Saving</Button>)
    const el = getByRole('button')
    expect(el).toHaveAttribute('aria-busy', 'true')
    // The Spinner (role=status) renders inside the button…
    expect(el.querySelector('[role="status"]')).not.toBeNull()
    // …and the label stays visible alongside it (width doesn't collapse).
    expect(el).toHaveTextContent('Saving')
  })

  it('renders a proportionate in-button spinner: sm/md → 12px (xs), lg → 24px (sm)', () => {
    // The in-button spinner must sit balanced next to the label, not tower over
    // it. sm/md buttons (12/14px labels) get the 12px 'xs' spinner; the bigger lg
    // control (16px label) gets the 24px 'sm' spinner. The grid width reveals the
    // chosen Spinner size (xs=12px, sm=24px) — whole-pixel, crisp.
    const expected: Record<'sm' | 'md' | 'lg', string> = {
      sm: '12px',
      md: '12px',
      lg: '24px',
    }
    for (const size of ['sm', 'md', 'lg'] as const) {
      const { getByRole, unmount } = render(
        <Button size={size} loading>
          Saving
        </Button>,
      )
      const grid = getByRole('button').querySelector<HTMLElement>('[data-spinner-grid]')
      expect(grid?.style.width).toBe(expected[size])
      unmount()
    }
  })

  it('renders the loading spinner with tone="inherit" so the pixels match the label color', () => {
    // The in-button spinner must read against the control fill: its pixels take
    // the label color (paper on the ember primary fill, ink on secondary/ghost),
    // NOT the brand ember — an ember spinner on the ember primary would vanish.
    // `tone="inherit"` ⇒ the Spinner grid carries NO `text-accent` (it inherits
    // the button's text color), and the negative space stays transparent.
    const { getByRole } = render(<Button loading>Saving</Button>)
    const grid = getByRole('button').querySelector('[data-spinner-grid]')
    expect(grid?.className).not.toMatch(/\btext-accent\b/)
    expect(grid?.className).not.toMatch(/bg-(surface|paper|accent|ember)/)
    // The pixels themselves are currentColor.
    const cell = grid?.querySelector('[data-spinner-cell]')
    expect(cell?.className).toMatch(/\bbg-current\b/)
  })

  it('does NOT set aria-busy when not loading', () => {
    const { getByRole } = render(<Button>x</Button>)
    expect(getByRole('button')).not.toHaveAttribute('aria-busy', 'true')
  })

  it('carries the theme-aware focus-ring outline classes', () => {
    const { getByRole } = render(<Button>x</Button>)
    expect(getByRole('button')).toHaveClass(
      'focus-visible:outline-2',
      'focus-visible:outline-offset-2',
      'focus-visible:outline-accent',
    )
  })

  it('enforces a ≥44px touch target on COARSE pointers only (visual height stays --control-*)', () => {
    // WCAG 2.5.5: the 44px target matters on touch. On a fine pointer the visual
    // size hierarchy (32/40/48) is what matters, so the 44px floor rides the
    // `pointer-coarse:` variant and the base must NOT force a blanket min-height.
    for (const size of ['sm', 'md', 'lg'] as const) {
      const { getByRole, unmount } = render(<Button size={size}>x</Button>)
      const el = getByRole('button')
      expect(el).toHaveClass('pointer-coarse:min-h-[44px]')
      // No unconditional min-h-[44px] inflating the desktop visual box.
      expect(el).not.toHaveClass('min-h-[44px]')
      unmount()
    }
  })

  it('renders distinct visual heights per size (--control-sm/md/lg, not a blanket floor)', () => {
    const heights: Record<'sm' | 'md' | 'lg', string> = {
      sm: 'h-[var(--control-sm)]',
      md: 'h-[var(--control-md)]',
      lg: 'h-[var(--control-lg)]',
    }
    for (const size of ['sm', 'md', 'lg'] as const) {
      const { getByRole, unmount } = render(<Button size={size}>x</Button>)
      expect(getByRole('button')).toHaveClass(heights[size])
      unmount()
    }
  })

  it('scales the font 12/14/16 per step so sizes are clearly distinct (sm text-xs)', () => {
    const fonts: Record<'sm' | 'md' | 'lg', string> = {
      sm: 'text-xs',
      md: 'text-sm',
      lg: 'text-base',
    }
    for (const size of ['sm', 'md', 'lg'] as const) {
      const { getByRole, unmount } = render(<Button size={size}>x</Button>)
      expect(getByRole('button')).toHaveClass(fonts[size])
      unmount()
    }
  })

  it('uses flat 1-bit corners (no radius)', () => {
    const { getByRole } = render(<Button>x</Button>)
    expect(getByRole('button')).toHaveClass('rounded-none')
  })

  it('applies the primary accent fill + hover/active token-swap by default', () => {
    const { getByRole } = render(<Button>x</Button>)
    expect(getByRole('button')).toHaveClass(
      'bg-accent',
      'text-paper-50',
      'hover:bg-accent-hover',
      'active:bg-accent-active',
    )
  })

  it('applies the secondary bordered neutral styling + hover/active pressed state', () => {
    const { getByRole } = render(<Button variant="secondary">x</Button>)
    expect(getByRole('button')).toHaveClass(
      'bg-surface',
      'text-ink',
      'border-border-strong',
      'hover:bg-surface-hover',
      'active:bg-surface-active',
    )
  })

  it('applies the ghost transparent styling + hover/active pressed state', () => {
    const { getByRole } = render(<Button variant="ghost">x</Button>)
    expect(getByRole('button')).toHaveClass(
      'bg-transparent',
      'text-ink',
      'hover:bg-surface-hover',
      'active:bg-surface-active',
    )
  })

  it('gives secondary AND ghost a pressed (active) state (was primary-only)', () => {
    for (const variant of ['secondary', 'ghost'] as const) {
      const { getByRole, unmount } = render(<Button variant={variant}>x</Button>)
      expect(getByRole('button')).toHaveClass('active:bg-surface-active')
      unmount()
    }
  })

  it('forwards its ref to the underlying button', () => {
    const ref = createRef<HTMLButtonElement>()
    render(<Button ref={ref}>x</Button>)
    expect(ref.current).toBeInstanceOf(HTMLButtonElement)
  })

  it('has no axe violations (default / disabled / loading)', async () => {
    const { container } = render(
      <div>
        <Button>Save</Button>
        <Button disabled>Disabled</Button>
        <Button loading>Saving</Button>
      </div>,
    )
    expect(await axe(container)).toHaveNoViolations()
  })
})
