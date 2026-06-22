import { describe, it, expect, vi } from 'vitest'
import { useState } from 'react'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { axe } from 'jest-axe'
import { Modal } from './Modal.tsx'

// Radix Dialog renders its overlay + panel in a PORTAL (outside the component
// root); these tests query the portal'd dialog from `screen` / `document.body`.
// The headline of this whole bead is FOCUS-TRAP + FOCUS-RETURN (Kraken I3): the
// most a11y-critical assertion in MYT-82. The jsdom Pointer-Capture +
// scrollIntoView + ResizeObserver shims live in vitest.setup.ts.
const body = (
  <div>
    <button type="button">first</button>
    <button type="button">second</button>
  </div>
)

describe('Modal', () => {
  it('is closed initially and opens from its trigger', async () => {
    const user = userEvent.setup()
    render(
      <Modal title="dialog.title" closeLabel="action.close" trigger={<button type="button">open</button>}>
        {body}
      </Modal>,
    )
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    await user.click(screen.getByText('open'))
    expect(await screen.findByRole('dialog')).toBeInTheDocument()
  })

  it('uses the title as the dialog accessible name (aria-labelledby)', async () => {
    const user = userEvent.setup()
    render(
      <Modal title="dialog.title" closeLabel="action.close" trigger={<button type="button">open</button>}>
        {body}
      </Modal>,
    )
    await user.click(screen.getByText('open'))
    const dialog = await screen.findByRole('dialog')
    expect(dialog).toHaveAccessibleName('dialog.title')
  })

  it('wires the description to aria-describedby when supplied', async () => {
    const user = userEvent.setup()
    render(
      <Modal
        title="dialog.title"
        description="dialog.body"
        closeLabel="action.close"
        trigger={<button type="button">open</button>}
      >
        {body}
      </Modal>,
    )
    await user.click(screen.getByText('open'))
    const dialog = await screen.findByRole('dialog')
    expect(dialog).toHaveAccessibleDescription('dialog.body')
  })

  // THE HEADLINE (Kraken I3): focus moves INTO the dialog on open, Tab is TRAPPED
  // inside, Esc closes, and focus RETURNS to the trigger.
  it('traps focus inside the dialog, and RETURNS focus to the trigger on Esc-close', async () => {
    const user = userEvent.setup()
    render(
      <Modal title="dialog.title" closeLabel="action.close" trigger={<button type="button">open</button>}>
        {body}
      </Modal>,
    )
    const trigger = screen.getByText('open')
    trigger.focus()
    await user.keyboard('{Enter}')

    const dialog = await screen.findByRole('dialog')
    // Focus moved INTO the dialog (not left on the trigger behind the scrim).
    await waitFor(() => {
      expect(dialog.contains(document.activeElement)).toBe(true)
    })

    // TRAP: Tab repeatedly — focus must never escape the dialog subtree.
    for (let i = 0; i < 6; i++) {
      await user.tab()
      expect(dialog.contains(document.activeElement)).toBe(true)
    }

    // Esc closes…
    await user.keyboard('{Escape}')
    await waitFor(() => {
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    })
    // …and RETURNS focus to the trigger.
    await waitFor(() => {
      expect(trigger).toHaveFocus()
    })
  })

  it('closes on scrim click by default', async () => {
    const user = userEvent.setup()
    render(
      <Modal title="dialog.title" closeLabel="action.close" trigger={<button type="button">open</button>}>
        {body}
      </Modal>,
    )
    await user.click(screen.getByText('open'))
    await screen.findByRole('dialog')
    // The scrim is the overlay element behind the panel.
    const scrim = document.querySelector('[data-mythrun-scrim]')
    if (scrim === null) throw new Error('scrim not found')
    await user.click(scrim)
    await waitFor(() => {
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    })
  })

  it('does NOT close on scrim click when closeOnScrimClick is false', async () => {
    const user = userEvent.setup()
    render(
      <Modal
        title="dialog.title"
        closeLabel="action.close"
        closeOnScrimClick={false}
        trigger={<button type="button">open</button>}
      >
        {body}
      </Modal>,
    )
    await user.click(screen.getByText('open'))
    await screen.findByRole('dialog')
    const scrim = document.querySelector('[data-mythrun-scrim]')
    if (scrim === null) throw new Error('scrim not found')
    await user.click(scrim)
    // Still open.
    expect(screen.getByRole('dialog')).toBeInTheDocument()
  })

  it('closes via the labelled close button and returns focus to the trigger', async () => {
    const user = userEvent.setup()
    render(
      <Modal title="dialog.title" closeLabel="action.close" trigger={<button type="button">open</button>}>
        {body}
      </Modal>,
    )
    const trigger = screen.getByText('open')
    await user.click(trigger)
    await screen.findByRole('dialog')
    await user.click(screen.getByRole('button', { name: 'action.close' }))
    await waitFor(() => {
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    })
    await waitFor(() => {
      expect(trigger).toHaveFocus()
    })
  })

  it('controlled: open is driven by the prop and onOpenChange fires a boolean', async () => {
    const onOpenChange = vi.fn()
    const user = userEvent.setup()
    function Controlled() {
      const [open, setOpen] = useState(false)
      return (
        <Modal
          title="dialog.title"
          closeLabel="action.close"
          open={open}
          onOpenChange={(next) => {
            onOpenChange(next)
            setOpen(next)
          }}
          trigger={<button type="button">open</button>}
        >
          {body}
        </Modal>
      )
    }
    render(<Controlled />)
    await user.click(screen.getByText('open'))
    await screen.findByRole('dialog')
    expect(onOpenChange).toHaveBeenCalledWith(true)
    expect(typeof onOpenChange.mock.calls[0]?.[0]).toBe('boolean')
    await user.keyboard('{Escape}')
    await waitFor(() => {
      expect(onOpenChange).toHaveBeenCalledWith(false)
    })
  })

  it('panel carries the flat overlay surface + z-modal + border tokens', async () => {
    const user = userEvent.setup()
    render(
      <Modal title="dialog.title" closeLabel="action.close" trigger={<button type="button">open</button>}>
        {body}
      </Modal>,
    )
    await user.click(screen.getByText('open'))
    const dialog = await screen.findByRole('dialog')
    expect(dialog).toHaveClass('bg-surface-overlay', 'rounded-none', 'border', 'border-border-strong')
    expect(dialog.className).toContain('z-[var(--z-modal)]')
  })

  it('has no axe violations when open', async () => {
    const user = userEvent.setup()
    render(
      <Modal
        title="dialog.title"
        description="dialog.body"
        closeLabel="action.close"
        trigger={<button type="button">open</button>}
      >
        {body}
      </Modal>,
    )
    await user.click(screen.getByText('open'))
    await screen.findByRole('dialog')
    // The dialog is portalled to document.body — scan the whole document.
    expect(await axe(document.body)).toHaveNoViolations()
  })
})
