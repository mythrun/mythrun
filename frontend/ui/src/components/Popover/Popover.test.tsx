import { describe, it, expect, vi } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { axe } from 'jest-axe'
import { Popover } from './Popover.tsx'

// Radix Popover renders interactive content in a PORTAL. Unlike a Tooltip it can
// hold buttons/links/a form. Headline behaviors: opens from the trigger on
// click/keyboard, focus moves into the content, Esc closes + returns focus to the
// trigger. The jsdom shims (pointer-capture, ResizeObserver) live in vitest.setup.
const trigger = <button type="button">open</button>
const content = (
  <div>
    <button type="button">inside</button>
  </div>
)

describe('Popover', () => {
  it('is closed initially and opens from the trigger', async () => {
    const user = userEvent.setup()
    render(<Popover trigger={trigger} label="popover.entity">{content}</Popover>)
    expect(screen.queryByText('inside')).not.toBeInTheDocument()
    await user.click(screen.getByText('open'))
    expect(await screen.findByText('inside')).toBeInTheDocument()
  })

  it('keyboard: opens on Enter and moves focus into the content', async () => {
    const user = userEvent.setup()
    render(<Popover trigger={trigger} label="popover.entity">{content}</Popover>)
    screen.getByText('open').focus()
    await user.keyboard('{Enter}')
    const inside = await screen.findByText('inside')
    await waitFor(() => {
      expect(inside.closest('[role="dialog"]')?.contains(document.activeElement) ?? document.activeElement === inside).toBe(true)
    })
  })

  // Esc closes AND returns focus to the trigger (Radix focus management).
  it('Esc closes and returns focus to the trigger', async () => {
    const user = userEvent.setup()
    render(<Popover trigger={trigger} label="popover.entity">{content}</Popover>)
    const triggerEl = screen.getByText('open')
    triggerEl.focus()
    await user.keyboard('{Enter}')
    await screen.findByText('inside')
    await user.keyboard('{Escape}')
    await waitFor(() => {
      expect(screen.queryByText('inside')).not.toBeInTheDocument()
    })
    await waitFor(() => {
      expect(triggerEl).toHaveFocus()
    })
  })

  it('controlled: open is driven by the prop and onOpenChange fires a boolean', async () => {
    const onOpenChange = vi.fn()
    const user = userEvent.setup()
    render(
      <Popover trigger={trigger} label="popover.entity" open onOpenChange={onOpenChange}>
        {content}
      </Popover>,
    )
    expect(await screen.findByText('inside')).toBeInTheDocument()
    await user.keyboard('{Escape}')
    await waitFor(() => {
      expect(onOpenChange).toHaveBeenCalledWith(false)
    })
    expect(typeof onOpenChange.mock.calls[0]?.[0]).toBe('boolean')
  })

  it('gives the dialog-role content an accessible name from label', async () => {
    const user = userEvent.setup()
    render(
      <Popover trigger={trigger} label="popover.entity">
        {content}
      </Popover>,
    )
    await user.click(screen.getByText('open'))
    const panel = await screen.findByRole('dialog')
    expect(panel).toHaveAccessibleName('popover.entity')
  })

  it('content carries the raised popover surface + z-popover + border tokens', async () => {
    const user = userEvent.setup()
    render(
      <Popover trigger={trigger} label="popover.entity" data-testid="pop">
        {content}
      </Popover>,
    )
    await user.click(screen.getByText('open'))
    const panel = await screen.findByTestId('pop')
    expect(panel).toHaveClass('bg-surface-raised', 'rounded-none', 'border', 'border-border-strong')
    expect(panel.className).toContain('z-[var(--z-popover)]')
  })

  it('has no axe violations when open', async () => {
    const user = userEvent.setup()
    render(<Popover trigger={trigger} label="popover.entity">{content}</Popover>)
    await user.click(screen.getByText('open'))
    await screen.findByText('inside')
    expect(await axe(document.body)).toHaveNoViolations()
  })
})
