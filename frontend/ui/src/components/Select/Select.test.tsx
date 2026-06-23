import { describe, it, expect, vi } from 'vitest'
import { createRef, useState } from 'react'
import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { axe } from 'jest-axe'
import { Select } from './Select.tsx'

const OPTIONS = [
  { value: 'human', label: 'race.human' },
  { value: 'elf', label: 'race.elf' },
  { value: 'dwarf', label: 'race.dwarf' },
] as const

// Radix Select renders a real listbox in a PORTAL (outside the component root);
// these tests query the portal'd content from `screen` / `document.body`. The
// jsdom Pointer-Capture + scrollIntoView shims live in vitest.setup.ts (a known
// jsdom gap), so the keyboard-open path actually runs.
describe('Select', () => {
  it('renders a combobox trigger showing the placeholder when empty', () => {
    render(<Select options={OPTIONS} placeholder="pick.race" />)
    const trigger = screen.getByRole('combobox')
    expect(trigger.tagName).toBe('BUTTON')
    expect(trigger).toHaveTextContent('pick.race')
  })

  it('reflects a controlled value as the trigger label', () => {
    render(<Select options={OPTIONS} value="elf" />)
    expect(screen.getByRole('combobox')).toHaveTextContent('race.elf')
  })

  // KEYBOARD: open with ArrowDown, move with arrows, select with Enter — assert
  // onChange got the VALUE STRING (not a DOM event).
  it('keyboard: opens, navigates with arrows, selects with Enter — onChange gets the value string', async () => {
    const onChange = vi.fn()
    const user = userEvent.setup()
    render(<Select options={OPTIONS} onChange={onChange} placeholder="pick.race" />)

    const trigger = screen.getByRole('combobox')
    trigger.focus()
    // Open with ArrowDown (Radix opens + focuses the first/selected item).
    await user.keyboard('{ArrowDown}')
    await waitFor(() => {
      expect(screen.getByRole('listbox')).toBeInTheDocument()
    })

    // Navigate down one (human -> elf) and commit with Enter.
    await user.keyboard('{ArrowDown}{Enter}')

    await waitFor(() => {
      expect(onChange).toHaveBeenCalled()
    })
    expect(onChange).toHaveBeenCalledWith('elf')
    expect(typeof onChange.mock.calls[0]?.[0]).toBe('string')
  })

  it('keyboard: opens with Enter and selects the highlighted option', async () => {
    const onChange = vi.fn()
    const user = userEvent.setup()
    render(<Select options={OPTIONS} onChange={onChange} placeholder="pick.race" />)

    screen.getByRole('combobox').focus()
    await user.keyboard('{Enter}')
    await waitFor(() => {
      expect(screen.getByRole('listbox')).toBeInTheDocument()
    })
    // First option is highlighted on open; Enter commits it.
    await user.keyboard('{Enter}')

    await waitFor(() => {
      expect(onChange).toHaveBeenCalledWith('human')
    })
  })

  it('pointer: clicking an option selects it and reports the value', async () => {
    const onChange = vi.fn()
    const user = userEvent.setup()
    render(<Select options={OPTIONS} onChange={onChange} placeholder="pick.race" />)

    await user.click(screen.getByRole('combobox'))
    const listbox = await screen.findByRole('listbox')
    await user.click(within(listbox).getByText('race.dwarf'))

    await waitFor(() => {
      expect(onChange).toHaveBeenCalledWith('dwarf')
    })
  })

  it('sets aria-invalid + the 2px danger border ONLY when invalid', () => {
    const { rerender } = render(<Select options={OPTIONS} />)
    const trigger = screen.getByRole('combobox')
    expect(trigger).not.toHaveAttribute('aria-invalid', 'true')
    expect(trigger).not.toHaveClass('border-border-danger')

    rerender(<Select options={OPTIONS} invalid />)
    expect(trigger).toHaveAttribute('aria-invalid', 'true')
    // The standardized 2px danger border (no bg wash).
    expect(trigger).toHaveClass('border-2', 'border-border-danger')
  })

  it('disabled trigger does not open', async () => {
    const onChange = vi.fn()
    const user = userEvent.setup()
    render(<Select options={OPTIONS} disabled onChange={onChange} />)
    const trigger = screen.getByRole('combobox')
    expect(trigger).toBeDisabled()
    await user.click(trigger)
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument()
  })

  it('carries the flat 1-bit + theme-aware focus-ring classes on the trigger', () => {
    render(<Select options={OPTIONS} />)
    expect(screen.getByRole('combobox')).toHaveClass(
      'rounded-none',
      'border',
      'border-border-strong',
      'focus-visible:outline-2',
      'focus-visible:outline-offset-2',
      'focus-visible:outline-accent',
    )
  })

  it('forwards its ref to the trigger button', () => {
    const ref = createRef<HTMLButtonElement>()
    render(<Select options={OPTIONS} ref={ref} />)
    expect(ref.current).toBeInstanceOf(HTMLButtonElement)
  })

  it('controlled: a state-bound onChange updates the displayed selection', async () => {
    const user = userEvent.setup()
    function Controlled() {
      const [v, setV] = useState('human')
      return <Select options={OPTIONS} value={v} onChange={setV} placeholder="pick.race" />
    }
    render(<Controlled />)
    expect(screen.getByRole('combobox')).toHaveTextContent('race.human')
    await user.click(screen.getByRole('combobox'))
    await user.click(within(await screen.findByRole('listbox')).getByText('race.elf'))
    await waitFor(() => {
      expect(screen.getByRole('combobox')).toHaveTextContent('race.elf')
    })
  })

  it('maps describedBy → aria-describedby on the trigger', () => {
    const { rerender } = render(<Select options={OPTIONS} placeholder="pick.race" />)
    expect(screen.getByRole('combobox')).not.toHaveAttribute('aria-describedby')
    rerender(<Select options={OPTIONS} placeholder="pick.race" describedBy="help-1 err-1" />)
    expect(screen.getByRole('combobox')).toHaveAttribute('aria-describedby', 'help-1 err-1')
  })

  it('has no axe violations (labelled / invalid / disabled)', async () => {
    const { container } = render(
      <div>
        <label htmlFor="s-default">Race</label>
        <Select id="s-default" options={OPTIONS} placeholder="pick.race" />
        <label htmlFor="s-invalid">Invalid</label>
        <Select id="s-invalid" options={OPTIONS} invalid placeholder="pick.race" />
        <label htmlFor="s-disabled">Disabled</label>
        <Select id="s-disabled" options={OPTIONS} disabled placeholder="pick.race" />
      </div>,
    )
    expect(await axe(container)).toHaveNoViolations()
  })
})
