import { describe, it, expect, vi } from 'vitest'
import { useState } from 'react'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { axe } from 'jest-axe'
import { Drawer } from './Drawer.tsx'

// Drawer — the edge-handle side sheet (MYT-89 Phase D1). Three headline
// behaviors, in priority order:
//   1. MOUNT-PERSISTENCE: children keep their React state across close→open.
//      The sheet slides off-screen (transform) and goes `inert`; it never
//      unmounts. D3's wiki state (navigation, per-entry scroll) rides on this.
//   2. The HANDLE toggles: one control pinned at the right edge in both states,
//      accessible name flipping openLabel (summon) ↔ closeLabel (dismiss).
//   3. FOCUS: moves into the sheet on open, Tab stays contained while open,
//      Esc closes and focus returns to the handle — Modal's conventions.
// Like Modal, the sheet renders in a PORTAL; tests query from `screen`.

// A stateful child — proves the drawer never unmounts its children. If the
// implementation regresses to Radix's default unmount-on-close, the count
// resets to 0 and the persistence test fails.
function Counter() {
  const [count, setCount] = useState(0)
  return (
    <button
      type="button"
      onClick={() => {
        setCount((c) => c + 1)
      }}
    >
      count: {count}
    </button>
  )
}

const body = (
  <div>
    <button type="button">first</button>
    <button type="button">second</button>
  </div>
)

const baseProps = {
  title: 'drawer.title',
  openLabel: 'drawer.open',
  closeLabel: 'drawer.close',
} as const

// A drawer summoned by a tap on the surface BEHIND it — the reveal's graph-node
// tap, reduced to its essentials. The tap's pointerdown lands OUTSIDE the sheet
// (arming Radix's deferred outside-dismiss), and the same gesture's pointerup
// opens the drawer, so the trailing click delivers a dismissal to an
// already-open sheet. `elsewhere` is a plain outside target for the
// later-gesture case.
function SummonedByOutsideTap() {
  const [open, setOpen] = useState(false)
  return (
    <div>
      <button
        type="button"
        onPointerUp={() => {
          setOpen(true)
        }}
      >
        summon
      </button>
      <button type="button">elsewhere</button>
      <Drawer {...baseProps} open={open} onOpenChange={setOpen}>
        {body}
      </Drawer>
    </div>
  )
}

describe('Drawer', () => {
  it('is closed initially: no dialog in the a11y tree, the handle offers the summon label', () => {
    render(<Drawer {...baseProps}>{body}</Drawer>)
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'drawer.open' })).toBeInTheDocument()
  })

  it('the handle toggles: click opens (name flips to dismiss), click again closes (name flips back)', async () => {
    const user = userEvent.setup()
    render(<Drawer {...baseProps}>{body}</Drawer>)
    await user.click(screen.getByRole('button', { name: 'drawer.open' }))
    expect(await screen.findByRole('dialog')).toBeInTheDocument()
    const dismissHandle = screen.getByRole('button', { name: 'drawer.close' })
    await user.click(dismissHandle)
    await waitFor(() => {
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    })
    expect(screen.getByRole('button', { name: 'drawer.open' })).toBeInTheDocument()
  })

  it('uses the title as the dialog accessible name (aria-labelledby)', async () => {
    const user = userEvent.setup()
    render(<Drawer {...baseProps}>{body}</Drawer>)
    await user.click(screen.getByRole('button', { name: 'drawer.open' }))
    const dialog = await screen.findByRole('dialog')
    expect(dialog).toHaveAccessibleName('drawer.title')
  })

  // THE HEADLINE: children stay mounted across close→open, so their state
  // survives. This is what separates Drawer from Modal.
  it('retains children state across close/open (mount-persistent)', async () => {
    const user = userEvent.setup()
    render(
      <Drawer {...baseProps}>
        <Counter />
      </Drawer>,
    )
    await user.click(screen.getByRole('button', { name: 'drawer.open' }))
    await screen.findByRole('dialog')
    await user.click(screen.getByText('count: 0'))
    await user.click(screen.getByText('count: 1'))
    expect(screen.getByText('count: 2')).toBeInTheDocument()

    // Close — the content must STAY IN THE DOM (hidden + inert, not unmounted).
    await user.click(screen.getByRole('button', { name: 'drawer.close' }))
    await waitFor(() => {
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    })
    expect(screen.getByText('count: 2')).toBeInTheDocument()

    // Reopen — the counter resumes from 2, not 0.
    await user.click(screen.getByRole('button', { name: 'drawer.open' }))
    await screen.findByRole('dialog')
    expect(screen.getByText('count: 2')).toBeInTheDocument()
  })

  it('moves focus into the sheet on open', async () => {
    const user = userEvent.setup()
    render(<Drawer {...baseProps}>{body}</Drawer>)
    await user.click(screen.getByRole('button', { name: 'drawer.open' }))
    const dialog = await screen.findByRole('dialog')
    await waitFor(() => {
      expect(dialog.contains(document.activeElement)).toBe(true)
    })
  })

  it('contains Tab inside the sheet while open', async () => {
    const user = userEvent.setup()
    render(<Drawer {...baseProps}>{body}</Drawer>)
    await user.click(screen.getByRole('button', { name: 'drawer.open' }))
    const dialog = await screen.findByRole('dialog')
    await waitFor(() => {
      expect(dialog.contains(document.activeElement)).toBe(true)
    })
    // Tab repeatedly — focus must never escape the sheet subtree.
    for (let i = 0; i < 6; i++) {
      await user.tab()
      expect(dialog.contains(document.activeElement)).toBe(true)
    }
  })

  it('closes on Esc and returns focus to the handle', async () => {
    const user = userEvent.setup()
    render(<Drawer {...baseProps}>{body}</Drawer>)
    await user.click(screen.getByRole('button', { name: 'drawer.open' }))
    await screen.findByRole('dialog')
    await user.keyboard('{Escape}')
    await waitFor(() => {
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    })
    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'drawer.open' })).toHaveFocus()
    })
  })

  // The sheet stays mounted while closed (forceMount), so its dismiss listeners
  // exist even then — they must not leak spurious onOpenChange(false) events.
  it('does NOT fire onOpenChange for Esc or outside clicks while closed', async () => {
    const onOpenChange = vi.fn()
    const user = userEvent.setup()
    render(
      <div>
        <button type="button">outside</button>
        <Drawer {...baseProps} onOpenChange={onOpenChange}>
          {body}
        </Drawer>
      </div>,
    )
    await user.keyboard('{Escape}')
    await user.click(screen.getByText('outside'))
    expect(onOpenChange).not.toHaveBeenCalled()
  })

  it('controlled: open is driven by the prop and onOpenChange fires a boolean', async () => {
    const onOpenChange = vi.fn()
    const user = userEvent.setup()
    function Controlled() {
      const [open, setOpen] = useState(false)
      return (
        <Drawer
          {...baseProps}
          open={open}
          onOpenChange={(next) => {
            onOpenChange(next)
            setOpen(next)
          }}
        >
          {body}
        </Drawer>
      )
    }
    render(<Controlled />)
    await user.click(screen.getByRole('button', { name: 'drawer.open' }))
    await screen.findByRole('dialog')
    expect(onOpenChange).toHaveBeenCalledWith(true)
    expect(typeof onOpenChange.mock.calls[0]?.[0]).toBe('boolean')
    await user.keyboard('{Escape}')
    await waitFor(() => {
      expect(onOpenChange).toHaveBeenCalledWith(false)
    })
  })

  it('sheet carries the flat overlay tokens and hides by transform + inert while closed', async () => {
    const user = userEvent.setup()
    render(
      <Drawer {...baseProps} data-testid="sheet">
        {body}
      </Drawer>,
    )
    const sheet = screen.getByTestId('sheet')
    // Paper register: overlay surface, hard 1px edge, no radius, modal tier.
    expect(sheet).toHaveClass('bg-surface-overlay', 'rounded-none', 'border-l', 'border-border-strong')
    expect(sheet.className).toContain('z-[var(--z-modal)]')
    // Closed = translated off-screen + inert (out of the a11y tree and the tab
    // order), NOT unmounted, NOT display:none — a transform, so state survives.
    expect(sheet.className).toContain('data-[state=closed]:translate-x-full')
    expect(sheet.className).toContain('transition-transform')
    expect(sheet).toHaveAttribute('data-state', 'closed')
    expect(sheet).toHaveAttribute('inert')
    await user.click(screen.getByRole('button', { name: 'drawer.open' }))
    await waitFor(() => {
      expect(sheet).toHaveAttribute('data-state', 'open')
    })
    expect(sheet).not.toHaveAttribute('inert')
  })

  // myth-1k9qt — the sheet body is a flex COLUMN, so a child that declares
  // itself a fill (`flex-1 min-h-0`, i.e. `<Box grow>`) takes the sheet's
  // height and owns the scrolling itself. Without that, the body is the only
  // element that ever scrolls and a child's own scroll container never moves —
  // which silently voids per-page scroll memory (the wiki's, on mobile).
  it('the sheet body is a flex column so a fill child can own the scrolling', () => {
    render(
      <Drawer {...baseProps} data-testid="sheet">
        {body}
      </Drawer>,
    )
    const sheetBody = screen.getByTestId('sheet').querySelector('[data-mythrun-drawer-body]')
    expect(sheetBody).not.toBeNull()
    expect(sheetBody).toHaveClass('flex', 'flex-col', 'min-h-0', 'flex-1', 'overflow-y-auto')
  })

  // myth-cwhdk — Radix Dialog defers outside-dismiss to the gesture's trailing
  // CLICK, so the gesture that OPENS the drawer (a tap on the surface behind
  // it) armed a dismissal at its pointerdown and delivered it once the sheet
  // was already open: a one-gesture open→shut flash on real pointers. The
  // guard is gesture IDENTITY — the pointerdown the dismissal carries vs the
  // one in flight when the sheet opened — so consumers need no summon defer.
  it('survives the very gesture that summoned it (its armed outside-dismiss is ignored)', async () => {
    const user = userEvent.setup()
    render(<SummonedByOutsideTap />)
    await user.click(screen.getByText('summon'))
    expect(await screen.findByRole('dialog')).toBeInTheDocument()
  })

  it('a LATER outside gesture still dismisses (the guard is exactly one gesture wide)', async () => {
    const user = userEvent.setup()
    render(<SummonedByOutsideTap />)
    await user.click(screen.getByText('summon'))
    await screen.findByRole('dialog')
    await user.click(screen.getByText('elsewhere'))
    await waitFor(() => {
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    })
  })

  it('has no axe violations while open', async () => {
    const user = userEvent.setup()
    render(
      <Drawer {...baseProps} description="drawer.description">
        {body}
      </Drawer>,
    )
    await user.click(screen.getByRole('button', { name: 'drawer.open' }))
    await screen.findByRole('dialog')
    expect(await axe(document.body)).toHaveNoViolations()
  })

  it('has no axe violations while closed (the mounted-but-hidden sheet is clean)', async () => {
    render(<Drawer {...baseProps}>{body}</Drawer>)
    expect(await axe(document.body)).toHaveNoViolations()
  })
})
