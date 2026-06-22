import { describe, it, expect } from 'vitest'
import type { ReactNode } from 'react'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { axe } from 'jest-axe'
import { Tooltip, TooltipProvider } from './Tooltip.tsx'

// Radix Tooltip appears on hover AND keyboard focus; the trigger must be an
// already-labelled control (the tooltip is SUPPLEMENTARY, not the name). A
// TooltipProvider ancestor supplies the shared timing context. These tests wire
// the provider and exercise the keyboard-focus open path (the touch-free a11y
// route). Radix renders the bubble in a portal; `delayDuration={0}` removes the
// open delay so the assertions don't race the timer.
function wrap(ui: ReactNode) {
  return <TooltipProvider delayDuration={0}>{ui}</TooltipProvider>
}

describe('Tooltip', () => {
  it('appears on keyboard FOCUS of the trigger (not just hover)', async () => {
    const user = userEvent.setup()
    render(
      wrap(
        <Tooltip content="tip.save" trigger={<button type="button">save</button>} />,
      ),
    )
    // Tab to the trigger — focus opens the tooltip.
    await user.tab()
    expect(screen.getByText('save')).toHaveFocus()
    await waitFor(() => {
      expect(screen.getByRole('tooltip')).toBeInTheDocument()
    })
    expect(screen.getByRole('tooltip')).toHaveTextContent('tip.save')
  })

  it('appears on hover and hides on Escape', async () => {
    const user = userEvent.setup()
    render(
      wrap(<Tooltip content="tip.save" trigger={<button type="button">save</button>} />),
    )
    await user.hover(screen.getByText('save'))
    await waitFor(() => {
      expect(screen.getByRole('tooltip')).toBeInTheDocument()
    })
    await user.keyboard('{Escape}')
    await waitFor(() => {
      expect(screen.queryByRole('tooltip')).not.toBeInTheDocument()
    })
  })

  it('describes the trigger (aria-describedby) — supplementary, not the name', async () => {
    const user = userEvent.setup()
    render(
      wrap(<Tooltip content="tip.save" trigger={<button type="button">save</button>} />),
    )
    await user.tab()
    await screen.findByRole('tooltip')
    // The trigger keeps its OWN accessible name ("save"); the tooltip is a
    // DESCRIPTION layered on top, never the name.
    const triggerBtn = screen.getByRole('button', { name: 'save' })
    expect(triggerBtn).toHaveAccessibleName('save')
    expect(triggerBtn).toHaveAccessibleDescription('tip.save')
  })

  it('bubble carries the raised surface + z-tooltip + border tokens', async () => {
    const user = userEvent.setup()
    render(
      wrap(
        <Tooltip content="tip.save" trigger={<button type="button">save</button>} data-testid="tip" />,
      ),
    )
    await user.tab()
    const bubble = await screen.findByTestId('tip')
    expect(bubble).toHaveClass('bg-surface-raised', 'rounded-none', 'border', 'border-border-strong')
    expect(bubble.className).toContain('z-[var(--z-tooltip)]')
  })

  it('has no axe violations with the tooltip open', async () => {
    const user = userEvent.setup()
    const { container } = render(
      wrap(<Tooltip content="tip.save" trigger={<button type="button">save</button>} />),
    )
    await user.tab()
    await screen.findByRole('tooltip')
    expect(await axe(container)).toHaveNoViolations()
  })
})
