import { describe, it, expect, vi } from 'vitest'
import { createRef, useState } from 'react'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { axe } from 'jest-axe'
import type { CheckedState } from '@mythrun/client-core/contract'
import { Checkbox } from './Checkbox.tsx'

describe('Checkbox', () => {
  it('renders a checkbox role (Radix button), unchecked by default', () => {
    render(<Checkbox />)
    const box = screen.getByRole('checkbox')
    expect(box.tagName).toBe('BUTTON')
    expect(box).toHaveAttribute('aria-checked', 'false')
  })

  // KEYBOARD: Space toggles; onChange receives the BOOLEAN (not a DOM event).
  it('keyboard: Space toggles — onChange gets the boolean', async () => {
    const onChange = vi.fn()
    const user = userEvent.setup()
    render(<Checkbox onChange={onChange} />)
    const box = screen.getByRole('checkbox')
    box.focus()
    await user.keyboard(' ')
    expect(onChange).toHaveBeenCalledWith(true)
    expect(typeof onChange.mock.calls[0]?.[0]).toBe('boolean')
  })

  it('controlled: a state-bound onChange flips aria-checked', async () => {
    const user = userEvent.setup()
    function Controlled() {
      const [c, setC] = useState<CheckedState>(false)
      return <Checkbox checked={c} onChange={setC} />
    }
    render(<Controlled />)
    const box = screen.getByRole('checkbox')
    expect(box).toHaveAttribute('aria-checked', 'false')
    await user.click(box)
    expect(box).toHaveAttribute('aria-checked', 'true')
  })

  // Indeterminate is a VALUE (checked: 'indeterminate'); it renders the minus
  // indicator (mixed), and aria-checked is "mixed".
  it('indeterminate: renders the minus indicator + aria-checked="mixed"', () => {
    render(<Checkbox checked="indeterminate" />)
    const box = screen.getByRole('checkbox')
    expect(box).toHaveAttribute('aria-checked', 'mixed')
    // The minus glyph (not the check) is shown for the mixed state.
    expect(box.querySelector('svg')).toBeInTheDocument()
    expect(box).toHaveAttribute('data-state', 'indeterminate')
  })

  it('checked renders the check indicator + aria-checked="true"', () => {
    render(<Checkbox checked />)
    const box = screen.getByRole('checkbox')
    expect(box).toHaveAttribute('aria-checked', 'true')
    expect(box.querySelector('svg')).toBeInTheDocument()
  })

  it('uncontrolled with defaultChecked', async () => {
    const user = userEvent.setup()
    render(<Checkbox defaultChecked />)
    const box = screen.getByRole('checkbox')
    expect(box).toHaveAttribute('aria-checked', 'true')
    await user.click(box)
    expect(box).toHaveAttribute('aria-checked', 'false')
  })

  it('sets aria-invalid + the danger border ONLY when invalid', () => {
    const { rerender } = render(<Checkbox />)
    const box = screen.getByRole('checkbox')
    expect(box).not.toHaveAttribute('aria-invalid', 'true')
    expect(box).not.toHaveClass('border-border-danger')

    rerender(<Checkbox invalid />)
    expect(box).toHaveAttribute('aria-invalid', 'true')
    expect(box).toHaveClass('border-border-danger')
  })

  it('blocks toggling when disabled', async () => {
    const onChange = vi.fn()
    const user = userEvent.setup()
    render(<Checkbox disabled onChange={onChange} />)
    const box = screen.getByRole('checkbox')
    expect(box).toBeDisabled()
    await user.click(box)
    expect(onChange).not.toHaveBeenCalled()
  })

  it('renders the optional inline label and toggles when the label is clicked', async () => {
    const onChange = vi.fn()
    const user = userEvent.setup()
    render(<Checkbox id="cb-terms" label="agree.terms" onChange={onChange} />)
    expect(screen.getByText('agree.terms')).toBeInTheDocument()
    await user.click(screen.getByText('agree.terms'))
    expect(onChange).toHaveBeenCalledWith(true)
  })

  it('carries the flat 1-bit + theme-aware focus-ring classes', () => {
    render(<Checkbox />)
    expect(screen.getByRole('checkbox')).toHaveClass(
      'rounded-none',
      'border',
      'border-border-strong',
      'focus-visible:outline-2',
      'focus-visible:outline-offset-2',
      'focus-visible:outline-accent',
    )
  })

  it('forwards its ref to the underlying control', () => {
    const ref = createRef<HTMLButtonElement>()
    render(<Checkbox ref={ref} />)
    expect(ref.current).toBeInstanceOf(HTMLButtonElement)
  })

  it('has no axe violations (labelled / checked / indeterminate / invalid / disabled)', async () => {
    const { container } = render(
      <div>
        <Checkbox id="a-inline" label="agree.terms" />
        <label htmlFor="a-checked">Checked</label>
        <Checkbox id="a-checked" checked />
        <label htmlFor="a-mixed">Mixed</label>
        <Checkbox id="a-mixed" checked="indeterminate" />
        <label htmlFor="a-invalid">Invalid</label>
        <Checkbox id="a-invalid" invalid />
        <label htmlFor="a-disabled">Disabled</label>
        <Checkbox id="a-disabled" disabled />
      </div>,
    )
    expect(await axe(container)).toHaveNoViolations()
  })
})
