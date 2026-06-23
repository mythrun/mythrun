import { describe, it, expect, vi } from 'vitest'
import { createRef, useState } from 'react'
import { render } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { axe } from 'jest-axe'
import { Input } from './Input.tsx'

// The bare Input takes no `aria-label` (DOM-free contract — labelling is
// FormField's job, §9). Tests query the single rendered input by role; the
// axe-clean case binds a real `<label htmlFor>`.
describe('Input', () => {
  it('renders a native <input> (role textbox)', () => {
    const { getByRole } = render(<Input />)
    const el = getByRole('textbox')
    expect(el.tagName).toBe('INPUT')
  })

  it('defaults to type="text"', () => {
    const { getByRole } = render(<Input />)
    expect(getByRole('textbox')).toHaveAttribute('type', 'text')
  })

  it('honours an explicit type (email)', () => {
    const { getByRole } = render(<Input type="email" />)
    expect(getByRole('textbox')).toHaveAttribute('type', 'email')
  })

  it('is uncontrolled with defaultValue — typing updates the value', async () => {
    const user = userEvent.setup()
    const { getByRole } = render(<Input defaultValue="ab" />)
    const el = getByRole('textbox') as HTMLInputElement
    expect(el.value).toBe('ab')
    await user.type(el, 'cd')
    expect(el.value).toBe('abcd')
  })

  it('controlled: onChange receives the STRING (not the DOM event)', async () => {
    const onChange = vi.fn()
    const user = userEvent.setup()

    function Controlled() {
      const [v, setV] = useState('')
      return (
        <Input
          value={v}
          onChange={(next) => {
            onChange(next)
            setV(next)
          }}
        />
      )
    }

    const { getByRole } = render(<Controlled />)
    await user.type(getByRole('textbox'), 'hi')
    // Each keystroke delivers a plain string, never an event object.
    expect(onChange).toHaveBeenNthCalledWith(1, 'h')
    expect(onChange).toHaveBeenNthCalledWith(2, 'hi')
    expect(onChange.mock.calls.every(([arg]) => typeof arg === 'string')).toBe(true)
  })

  it('sets aria-invalid + the 2px danger border (NO bg wash) ONLY when invalid', () => {
    const { getByRole, rerender } = render(<Input />)
    const el = getByRole('textbox')
    expect(el).not.toHaveAttribute('aria-invalid', 'true')
    expect(el).not.toHaveClass('border-border-danger')
    expect(el).not.toHaveClass('bg-surface-danger')

    rerender(<Input invalid />)
    expect(el).toHaveAttribute('aria-invalid', 'true')
    // A heavier 2px danger border — the standardized invalid treatment.
    expect(el).toHaveClass('border-2', 'border-border-danger')
    // The wash is GONE: the re-saturated danger red reads as error on its own.
    expect(el).not.toHaveClass('bg-surface-danger')
  })

  it('blocks input when disabled', async () => {
    const onChange = vi.fn()
    const user = userEvent.setup()
    const { getByRole } = render(<Input disabled onChange={onChange} />)
    const el = getByRole('textbox')
    expect(el).toBeDisabled()
    await user.type(el, 'x')
    expect(onChange).not.toHaveBeenCalled()
  })

  it('blocks input when readOnly (value stays, no change fires)', async () => {
    const onChange = vi.fn()
    const user = userEvent.setup()
    const { getByRole } = render(<Input readOnly defaultValue="locked" onChange={onChange} />)
    const el = getByRole('textbox') as HTMLInputElement
    expect(el).toHaveAttribute('readonly')
    await user.type(el, 'x')
    expect(el.value).toBe('locked')
    expect(onChange).not.toHaveBeenCalled()
  })

  it('passes through placeholder', () => {
    const { getByPlaceholderText } = render(<Input placeholder="your.name" />)
    expect(getByPlaceholderText('your.name')).toBeInTheDocument()
  })

  it('marks required (native + aria)', () => {
    const { getByRole } = render(<Input required />)
    expect(getByRole('textbox')).toBeRequired()
  })

  it('carries the theme-aware focus-ring outline classes', () => {
    const { getByRole } = render(<Input />)
    expect(getByRole('textbox')).toHaveClass(
      'focus-visible:outline-2',
      'focus-visible:outline-offset-2',
      'focus-visible:outline-accent',
    )
  })

  it('uses flat 1-bit corners + the strong interactive border', () => {
    const { getByRole } = render(<Input />)
    expect(getByRole('textbox')).toHaveClass('rounded-none', 'border', 'border-border-strong')
  })

  it('forwards its ref to the underlying input', () => {
    const ref = createRef<HTMLInputElement>()
    render(<Input ref={ref} />)
    expect(ref.current).toBeInstanceOf(HTMLInputElement)
  })

  it('maps describedBy → aria-describedby (the portable a11y relationship)', () => {
    const { getByRole, rerender } = render(<Input />)
    expect(getByRole('textbox')).not.toHaveAttribute('aria-describedby')
    rerender(<Input describedBy="help-1 err-1" />)
    expect(getByRole('textbox')).toHaveAttribute('aria-describedby', 'help-1 err-1')
  })

  it('has no axe violations (labelled / invalid / disabled / read-only)', async () => {
    // FormField provides the <label> in real use; the test harness binds one so
    // axe sees an associated label.
    const { container } = render(
      <div>
        <label htmlFor="i-default">Default</label>
        <Input id="i-default" />
        <label htmlFor="i-invalid">Invalid</label>
        <Input id="i-invalid" invalid />
        <label htmlFor="i-disabled">Disabled</label>
        <Input id="i-disabled" disabled />
        <label htmlFor="i-readonly">Read-only</label>
        <Input id="i-readonly" readOnly defaultValue="x" />
      </div>,
    )
    expect(await axe(container)).toHaveNoViolations()
  })
})
