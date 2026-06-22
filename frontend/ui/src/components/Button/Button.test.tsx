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

  it('enforces a ≥44px hit-target (min-height) at every size', () => {
    for (const size of ['sm', 'md', 'lg'] as const) {
      const { getByRole, unmount } = render(<Button size={size}>x</Button>)
      expect(getByRole('button')).toHaveClass('min-h-[44px]')
      unmount()
    }
  })

  it('uses flat 1-bit corners (no radius)', () => {
    const { getByRole } = render(<Button>x</Button>)
    expect(getByRole('button')).toHaveClass('rounded-none')
  })

  it('applies the primary accent fill by default', () => {
    const { getByRole } = render(<Button>x</Button>)
    expect(getByRole('button')).toHaveClass('bg-accent', 'text-paper-50')
  })

  it('applies the secondary bordered neutral styling', () => {
    const { getByRole } = render(<Button variant="secondary">x</Button>)
    expect(getByRole('button')).toHaveClass('bg-surface', 'text-ink', 'border-border-strong')
  })

  it('applies the ghost transparent styling', () => {
    const { getByRole } = render(<Button variant="ghost">x</Button>)
    expect(getByRole('button')).toHaveClass('bg-transparent', 'text-ink')
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
