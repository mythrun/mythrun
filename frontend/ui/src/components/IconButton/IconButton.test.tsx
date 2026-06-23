import { describe, it, expect, vi } from 'vitest'
import { createRef } from 'react'
import { render } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { axe } from 'jest-axe'
import { IconButton } from './IconButton.tsx'

describe('IconButton', () => {
  it('renders a real <button> whose accessible name comes from `label`', () => {
    // The #1 icon-button a11y bug is a nameless control. The button carries the
    // name (aria-label); the inner glyph must NOT contribute its own name.
    const { getByRole } = render(<IconButton icon="close" label="Close dialog" />)
    const el = getByRole('button', { name: 'Close dialog' })
    expect(el.tagName).toBe('BUTTON')
    expect(el).toHaveAttribute('aria-label', 'Close dialog')
  })

  it('renders its Icon as DECORATIVE (aria-hidden), so the name is the button label only', () => {
    const { getByRole } = render(<IconButton icon="close" label="Close" />)
    const el = getByRole('button')
    const svg = el.querySelector('svg')
    expect(svg).not.toBeNull()
    // Decorative icon → hidden from AT, no role=img, no own aria-label.
    expect(svg).toHaveAttribute('aria-hidden', 'true')
    expect(svg).not.toHaveAttribute('aria-label')
    expect(svg).not.toHaveAttribute('role', 'img')
  })

  it('calls onPress on click', async () => {
    const onPress = vi.fn()
    const user = userEvent.setup()
    const { getByRole } = render(<IconButton icon="plus" label="Add" onPress={onPress} />)
    await user.click(getByRole('button'))
    expect(onPress).toHaveBeenCalledOnce()
  })

  it('calls onPress on keyboard activation (Enter + Space)', async () => {
    const onPress = vi.fn()
    const user = userEvent.setup()
    const { getByRole } = render(<IconButton icon="plus" label="Add" onPress={onPress} />)
    const el = getByRole('button')
    el.focus()
    await user.keyboard('{Enter}')
    await user.keyboard(' ')
    expect(onPress).toHaveBeenCalledTimes(2)
  })

  it('does NOT call onPress when disabled', async () => {
    const onPress = vi.fn()
    const user = userEvent.setup()
    const { getByRole } = render(
      <IconButton icon="plus" label="Add" onPress={onPress} disabled />,
    )
    const el = getByRole('button')
    expect(el).toBeDisabled()
    await user.click(el)
    el.focus()
    await user.keyboard('{Enter}')
    expect(onPress).not.toHaveBeenCalled()
  })

  it('does NOT call onPress when loading + exposes aria-busy with a Spinner replacing the icon', async () => {
    const onPress = vi.fn()
    const user = userEvent.setup()
    const { getByRole } = render(
      <IconButton icon="plus" label="Adding" onPress={onPress} loading />,
    )
    const el = getByRole('button')
    expect(el).toBeDisabled()
    expect(el).toHaveAttribute('aria-busy', 'true')
    // Spinner replaces the icon while busy.
    expect(el.querySelector('[role="status"]')).not.toBeNull()
    expect(el.querySelector('svg')).toBeNull()
    await user.click(el)
    expect(onPress).not.toHaveBeenCalled()
  })

  it('enforces a ≥44px touch hit-target on both axes (coarse pointer only)', () => {
    for (const size of ['sm', 'md', 'lg'] as const) {
      const { getByRole, unmount } = render(
        <IconButton icon="close" label="Close" size={size} />,
      )
      // Icon-only: both axes floor at 44px on touch — but only on a COARSE pointer,
      // so the visual --control-* square stays distinct (sm 32 / md 40 / lg 48) on
      // desktop. A blanket min would force sm + md both to 44px (identical).
      expect(getByRole('button')).toHaveClass(
        'pointer-coarse:min-w-[44px]',
        'pointer-coarse:min-h-[44px]',
      )
      expect(getByRole('button')).not.toHaveClass('min-w-[44px]', 'min-h-[44px]')
      unmount()
    }
  })

  it('gives secondary + ghost a pressed (active) state', () => {
    const sec = render(<IconButton icon="close" label="Close" variant="secondary" />)
    expect(sec.getByRole('button')).toHaveClass('active:bg-surface-active')
    sec.unmount()
    const ghost = render(<IconButton icon="close" label="Close" variant="ghost" />)
    expect(ghost.getByRole('button')).toHaveClass('active:bg-surface-active')
  })

  it('carries the theme-aware focus-ring outline classes', () => {
    const { getByRole } = render(<IconButton icon="close" label="Close" />)
    expect(getByRole('button')).toHaveClass(
      'focus-visible:outline-2',
      'focus-visible:outline-offset-2',
      'focus-visible:outline-accent',
    )
  })

  it('uses flat 1-bit corners (no radius)', () => {
    const { getByRole } = render(<IconButton icon="close" label="Close" />)
    expect(getByRole('button')).toHaveClass('rounded-none')
  })

  it('forwards its ref to the underlying button', () => {
    const ref = createRef<HTMLButtonElement>()
    render(<IconButton ref={ref} icon="close" label="Close" />)
    expect(ref.current).toBeInstanceOf(HTMLButtonElement)
  })

  it('has no axe violations (default / disabled / loading)', async () => {
    const { container } = render(
      <div>
        <IconButton icon="close" label="Close" />
        <IconButton icon="close" label="Close (disabled)" disabled />
        <IconButton icon="plus" label="Adding" loading />
      </div>,
    )
    expect(await axe(container)).toHaveNoViolations()
  })
})
