import { describe, it, expect, vi } from 'vitest'
import { createRef, useState } from 'react'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { axe } from 'jest-axe'
import { Switch } from './Switch.tsx'

describe('Switch', () => {
  it('renders a switch role (Radix button), off by default', () => {
    render(<Switch />)
    const sw = screen.getByRole('switch')
    expect(sw.tagName).toBe('BUTTON')
    expect(sw).toHaveAttribute('aria-checked', 'false')
  })

  // KEYBOARD: Space toggles; onChange receives the BOOLEAN (not a DOM event).
  it('keyboard: Space toggles — onChange gets the boolean', async () => {
    const onChange = vi.fn()
    const user = userEvent.setup()
    render(<Switch onChange={onChange} />)
    const sw = screen.getByRole('switch')
    sw.focus()
    await user.keyboard(' ')
    expect(onChange).toHaveBeenCalledWith(true)
    expect(typeof onChange.mock.calls[0]?.[0]).toBe('boolean')
  })

  it('controlled: a state-bound onChange flips aria-checked', async () => {
    const user = userEvent.setup()
    function Controlled() {
      const [c, setC] = useState(false)
      return <Switch checked={c} onChange={setC} />
    }
    render(<Controlled />)
    const sw = screen.getByRole('switch')
    expect(sw).toHaveAttribute('aria-checked', 'false')
    await user.click(sw)
    expect(sw).toHaveAttribute('aria-checked', 'true')
  })

  it('uncontrolled with defaultChecked', async () => {
    const user = userEvent.setup()
    render(<Switch defaultChecked />)
    const sw = screen.getByRole('switch')
    expect(sw).toHaveAttribute('aria-checked', 'true')
    await user.click(sw)
    expect(sw).toHaveAttribute('aria-checked', 'false')
  })

  it('blocks toggling when disabled', async () => {
    const onChange = vi.fn()
    const user = userEvent.setup()
    render(<Switch disabled onChange={onChange} />)
    const sw = screen.getByRole('switch')
    expect(sw).toBeDisabled()
    await user.click(sw)
    expect(onChange).not.toHaveBeenCalled()
  })

  it('renders the optional inline label and toggles when the label is clicked', async () => {
    const onChange = vi.fn()
    const user = userEvent.setup()
    render(<Switch id="sw-dark" label="setting.dark_mode" onChange={onChange} />)
    expect(screen.getByText('setting.dark_mode')).toBeInTheDocument()
    await user.click(screen.getByText('setting.dark_mode'))
    expect(onChange).toHaveBeenCalledWith(true)
  })

  it('carries the flat 1-bit track + theme-aware focus-ring classes', () => {
    render(<Switch />)
    expect(screen.getByRole('switch')).toHaveClass(
      'border',
      'border-border-strong',
      'focus-visible:outline-2',
      'focus-visible:outline-offset-2',
      'focus-visible:outline-accent',
    )
  })

  it('is RECTANGULAR (0px radius) — track and thumb are rounded-none, no pill', () => {
    render(<Switch defaultChecked />)
    const sw = screen.getByRole('switch')
    expect(sw).toHaveClass('rounded-none')
    expect(sw).not.toHaveClass('rounded-full')
    // The thumb is the only child element; it stays square + still slides.
    const thumb = sw.querySelector('span')
    expect(thumb).not.toBeNull()
    expect(thumb).toHaveClass('rounded-none')
    expect(thumb).not.toHaveClass('rounded-full')
    // The slide transform survives the shape change (position IS the state).
    expect(thumb).toHaveClass('data-[state=checked]:translate-x-[var(--space-3)]')
  })

  it('forwards its ref to the underlying control', () => {
    const ref = createRef<HTMLButtonElement>()
    render(<Switch ref={ref} />)
    expect(ref.current).toBeInstanceOf(HTMLButtonElement)
  })

  it('maps describedBy → aria-describedby (the portable a11y relationship)', () => {
    const { rerender } = render(<Switch />)
    expect(screen.getByRole('switch')).not.toHaveAttribute('aria-describedby')
    rerender(<Switch describedBy="help-1 err-1" />)
    expect(screen.getByRole('switch')).toHaveAttribute('aria-describedby', 'help-1 err-1')
  })

  it('has no axe violations (labelled / on / disabled)', async () => {
    const { container } = render(
      <div>
        <Switch id="sw-inline" label="setting.dark_mode" />
        <label htmlFor="sw-on">On</label>
        <Switch id="sw-on" checked />
        <label htmlFor="sw-disabled">Disabled</label>
        <Switch id="sw-disabled" disabled />
      </div>,
    )
    expect(await axe(container)).toHaveNoViolations()
  })
})
