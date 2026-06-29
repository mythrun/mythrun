import { describe, it, expect, vi } from 'vitest'
import { createRef, useState } from 'react'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { axe } from 'jest-axe'
import { Switch } from './Switch.tsx'

describe('Switch', () => {
  // ── Behaviour + a11y (contract-level) ──

  it('renders a switch role (Radix button), off by default', () => {
    render(<Switch />)
    const sw = screen.getByRole('switch')
    expect(sw.tagName).toBe('BUTTON')
    expect(sw).toHaveAttribute('aria-checked', 'false')
  })

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

  // ── The clean flat-1-bit slider ──

  it('is RECTANGULAR (0px radius) — track + thumb are rounded-none, no pill', () => {
    render(<Switch defaultChecked />)
    const sw = screen.getByRole('switch')
    expect(sw).toHaveClass('rounded-none')
    expect(sw).not.toHaveClass('rounded-full')
    const thumb = sw.querySelector('span')
    expect(thumb).not.toBeNull()
    expect(thumb).toHaveClass('rounded-none')
    expect(thumb).not.toHaveClass('rounded-full')
    // The slide IS the state — position survives the shape.
    expect(thumb).toHaveClass('translate-x-0', 'data-[state=checked]:translate-x-[24px]')
  })

  it('matches the form controls: thin border off → ember fill on, theme-aware focus ring', () => {
    render(<Switch />)
    expect(screen.getByRole('switch')).toHaveClass(
      'border-solid',
      'border-border-strong',
      'bg-surface',
      'data-[state=checked]:bg-accent',
      'data-[state=checked]:border-accent',
      'focus-visible:outline-2',
      'focus-visible:outline-offset-2',
      'focus-visible:outline-accent-fg',
    )
  })

  it('has a VISIBLE thumb in BOTH states — contrasting token color per state', () => {
    // OFF → ink thumb on the surface track; ON → surface thumb on the accent track.
    // Never the track-matching paper-50 (the old vanish bug).
    render(<Switch />)
    const thumb = screen.getByRole('switch').querySelector('span')
    expect(thumb).not.toBeNull()
    expect(thumb).toHaveClass('bg-ink')
    expect(thumb).toHaveClass('data-[state=checked]:bg-surface')
    expect(thumb).not.toHaveClass('bg-paper-50')
  })

  it('sizes to a compact toggle with whole-pixel geometry', () => {
    render(<Switch />)
    const sw = screen.getByRole('switch')
    expect(sw.style.width).toBe('48px')
    expect(sw.style.height).toBe('24px')
    const thumb = sw.querySelector('span')
    expect(thumb?.style.width).toBe('18px')
    expect(thumb?.style.height).toBe('18px')
  })

  it('uses tokens only — no raw color in the rendered markup', () => {
    const { container } = render(<Switch defaultChecked />)
    const html = container.innerHTML
    expect(html).not.toMatch(/#[0-9a-fA-F]{3,8}/)
    expect(html).not.toMatch(/(rgba?|hsla?|oklch|oklab)\(/)
  })
})
