import { describe, it, expect, vi } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { axe } from 'jest-axe'
import { Menu } from './Menu.tsx'

const ITEMS = [
  { value: 'rename', label: 'menu.rename' },
  { value: 'duplicate', label: 'menu.duplicate' },
  { value: 'delete', label: 'menu.delete' },
] as const

const trigger = <button type="button">actions</button>

describe('Menu', () => {
  it('is closed initially and opens on click', async () => {
    const user = userEvent.setup()
    render(<Menu trigger={trigger} items={ITEMS} />)
    expect(screen.queryByRole('menu')).not.toBeInTheDocument()
    await user.click(screen.getByText('actions'))
    expect(await screen.findByRole('menu')).toBeInTheDocument()
  })

  // KEYBOARD: opens on Enter, ArrowDown navigates items, Enter selects (fires the
  // neutral onSelect with the item VALUE).
  it('keyboard: opens on Enter, ArrowDown navigates, Enter selects — onSelect gets the value', async () => {
    const onSelect = vi.fn()
    const user = userEvent.setup()
    render(<Menu trigger={trigger} items={ITEMS} onSelect={onSelect} />)

    screen.getByText('actions').focus()
    await user.keyboard('{Enter}')
    await screen.findByRole('menu')

    // First item is focused on open; ArrowDown moves to the second; Enter selects it.
    await user.keyboard('{ArrowDown}{Enter}')
    await waitFor(() => {
      expect(onSelect).toHaveBeenCalledWith('duplicate')
    })
    expect(typeof onSelect.mock.calls[0]?.[0]).toBe('string')
  })

  it('keyboard: opens on ArrowDown as well', async () => {
    const user = userEvent.setup()
    render(<Menu trigger={trigger} items={ITEMS} />)
    screen.getByText('actions').focus()
    await user.keyboard('{ArrowDown}')
    expect(await screen.findByRole('menu')).toBeInTheDocument()
  })

  // Esc closes AND returns focus to the trigger.
  it('Esc closes and returns focus to the trigger', async () => {
    const user = userEvent.setup()
    render(<Menu trigger={trigger} items={ITEMS} />)
    const triggerEl = screen.getByText('actions')
    triggerEl.focus()
    await user.keyboard('{Enter}')
    await screen.findByRole('menu')
    await user.keyboard('{Escape}')
    await waitFor(() => {
      expect(screen.queryByRole('menu')).not.toBeInTheDocument()
    })
    await waitFor(() => {
      expect(triggerEl).toHaveFocus()
    })
  })

  it('pointer: clicking an item selects it and reports the value', async () => {
    const onSelect = vi.fn()
    const user = userEvent.setup()
    render(<Menu trigger={trigger} items={ITEMS} onSelect={onSelect} />)
    await user.click(screen.getByText('actions'))
    await user.click(await screen.findByRole('menuitem', { name: 'menu.delete' }))
    await waitFor(() => {
      expect(onSelect).toHaveBeenCalledWith('delete')
    })
  })

  it('a disabled item is present but not selectable', async () => {
    const items = [
      { value: 'a', label: 'menu.a' },
      { value: 'b', label: 'menu.b', disabled: true },
    ]
    const onSelect = vi.fn()
    const user = userEvent.setup()
    render(<Menu trigger={trigger} items={items} onSelect={onSelect} />)
    await user.click(screen.getByText('actions'))
    const disabledItem = await screen.findByRole('menuitem', { name: 'menu.b' })
    expect(disabledItem).toHaveAttribute('data-disabled')
    await user.click(disabledItem)
    expect(onSelect).not.toHaveBeenCalled()
  })

  it('controlled: onOpenChange fires a boolean', async () => {
    const onOpenChange = vi.fn()
    const user = userEvent.setup()
    render(<Menu trigger={trigger} items={ITEMS} onOpenChange={onOpenChange} />)
    await user.click(screen.getByText('actions'))
    await screen.findByRole('menu')
    expect(onOpenChange).toHaveBeenCalledWith(true)
    expect(typeof onOpenChange.mock.calls[0]?.[0]).toBe('boolean')
  })

  it('menu content carries the raised surface + z-dropdown + border tokens', async () => {
    const user = userEvent.setup()
    render(<Menu trigger={trigger} items={ITEMS} data-testid="menu" />)
    await user.click(screen.getByText('actions'))
    const panel = await screen.findByTestId('menu')
    expect(panel).toHaveClass('bg-surface-raised', 'rounded-none', 'border', 'border-border-strong')
    expect(panel.className).toContain('z-[var(--z-dropdown)]')
  })

  it('renders a header row as a non-interactive label, not a menuitem (spec: identity header)', async () => {
    const user = userEvent.setup()
    render(
      <Menu
        trigger={<button>open</button>}
        items={[
          { header: true, label: 'Idrisa the Bold' },
          { value: 'logout', label: 'Log out' },
        ]}
        data-testid="menu-content"
      />,
    )
    await user.click(screen.getByText('open'))
    // The header is visible text but NOT a menuitem…
    expect(screen.getByText('Idrisa the Bold')).toBeInTheDocument()
    expect(screen.getAllByRole('menuitem')).toHaveLength(1)
    // …and is not keyboard-highlightable: ArrowDown from open lands on Log out.
    await user.keyboard('{ArrowDown}')
    expect(screen.getByRole('menuitem', { name: 'Log out' })).toHaveAttribute('data-highlighted')
  })

  it('caps content width and truncates long labels (spec: portal overflow is gate-invisible)', async () => {
    const user = userEvent.setup()
    const longHeader = 'H'.repeat(120)
    const longItem = 'I'.repeat(120)
    render(
      <Menu
        trigger={<button>open</button>}
        items={[
          { header: true, label: longHeader },
          { value: 'a', label: longItem },
        ]}
        data-testid="menu-content"
      />,
    )
    await user.click(screen.getByText('open'))
    expect(screen.getByTestId('menu-content').className).toContain('max-w-')
    // The ellipsis must live on a block-level label SPAN, not the flex row:
    // text-overflow only applies to block containers, so `truncate` on the flex
    // row hard-clips mid-glyph with no '…'. Pin both row types: the label span
    // carries truncate + min-w-0, the row container carries no truncate.
    for (const long of [longHeader, longItem]) {
      const label = screen.getByText(long)
      expect(label.className).toContain('truncate')
      expect(label.className).toContain('min-w-0')
      expect(label.parentElement).not.toBeNull()
      expect(label.parentElement?.className).not.toContain('truncate')
    }
  })

  it('highlights items with the raised-tier hover token (dark-theme visibility fix)', async () => {
    const user = userEvent.setup()
    render(<Menu trigger={<button>open</button>} items={[{ value: 'a', label: 'A' }]} />)
    await user.click(screen.getByText('open'))
    expect(screen.getByRole('menuitem').className).toContain('bg-surface-raised-hover')
    expect(screen.getByRole('menuitem').className).not.toContain('data-[highlighted]:bg-surface-hover')
  })

  it('renders a separator row as a separator, not a menuitem; keyboard skips it', async () => {
    const user = userEvent.setup()
    render(
      <Menu
        trigger={<button>open</button>}
        items={[
          { value: 'billing', label: 'Sessions & billing' },
          { separator: true },
          { value: 'logout', label: 'Log out' },
        ]}
        data-testid="menu-content"
      />,
    )
    await user.click(screen.getByText('open'))
    expect(screen.getAllByRole('separator')).toHaveLength(1)
    expect(screen.getAllByRole('menuitem')).toHaveLength(2)
    // ArrowDown from the first item lands on Log out — the separator is not a stop.
    await user.keyboard('{ArrowDown}{ArrowDown}')
    expect(screen.getByRole('menuitem', { name: 'Log out' })).toHaveAttribute('data-highlighted')
  })

  it("placement='bar-end': end-aligned, trigger-width floor, collision-padded (the app-bar dropdown rule-set)", async () => {
    const user = userEvent.setup()
    render(
      <Menu
        trigger={<button>open</button>}
        items={[{ value: 'a', label: 'A' }]}
        placement="bar-end"
        data-testid="menu-content"
      />,
    )
    await user.click(screen.getByText('open'))
    const panel = screen.getByTestId('menu-content')
    // End-aligned: the menu's trailing edge shares the trigger's trailing edge
    // (the bar's content gutter line) instead of Radix's centered default, which
    // collision-shifts into the viewport edge from right-side chrome.
    expect(panel).toHaveAttribute('data-align', 'end')
    // Anchored width: at least the trigger, never less than 12rem.
    expect(panel.className).toContain('min-w-[max(12rem,var(--radix-dropdown-menu-trigger-width))]')
    expect(panel.className).not.toContain('min-w-[10rem]')
  })

  it('default placement keeps the inline-menu geometry (centered, 10rem floor)', async () => {
    const user = userEvent.setup()
    render(<Menu trigger={<button>open</button>} items={[{ value: 'a', label: 'A' }]} data-testid="menu-content" />)
    await user.click(screen.getByText('open'))
    const panel = screen.getByTestId('menu-content')
    expect(panel).toHaveAttribute('data-align', 'center')
    expect(panel.className).toContain('min-w-[10rem]')
  })

  it('has no axe violations when open', async () => {
    const user = userEvent.setup()
    render(<Menu trigger={trigger} items={ITEMS} />)
    await user.click(screen.getByText('actions'))
    await screen.findByRole('menu')
    // Scan the whole document so the PORTALLED menu is included. `region` is a
    // page-STRUCTURE best-practice rule (all content must sit in a landmark) — an
    // app-shell concern, not a component one; the portalled popper wrapper is a
    // bare div by design, so we disable just that rule here and keep every
    // component-level a11y rule active.
    expect(await axe(document.body, { rules: { region: { enabled: false } } })).toHaveNoViolations()
  })
})
