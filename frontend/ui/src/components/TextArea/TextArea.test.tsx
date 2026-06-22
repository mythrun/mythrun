import { describe, it, expect, vi } from 'vitest'
import { createRef, useState } from 'react'
import { render } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { axe } from 'jest-axe'
import { TextArea } from './TextArea.tsx'

// Mirrors Input — DOM-free contract, neutral `onChange(value)` (§9). Tests query
// the single rendered textarea by role; the axe-clean case binds a `<label>`.
describe('TextArea', () => {
  it('renders a native <textarea> (role textbox)', () => {
    const { getByRole } = render(<TextArea />)
    const el = getByRole('textbox')
    expect(el.tagName).toBe('TEXTAREA')
  })

  it('is uncontrolled with defaultValue — typing updates the value', async () => {
    const user = userEvent.setup()
    const { getByRole } = render(<TextArea defaultValue="ab" />)
    const el = getByRole('textbox') as HTMLTextAreaElement
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
        <TextArea
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
    expect(onChange).toHaveBeenNthCalledWith(1, 'h')
    expect(onChange).toHaveBeenNthCalledWith(2, 'hi')
    expect(onChange.mock.calls.every(([arg]) => typeof arg === 'string')).toBe(true)
  })

  it('passes rows through to the native textarea', () => {
    const { getByRole } = render(<TextArea rows={6} />)
    expect(getByRole('textbox')).toHaveAttribute('rows', '6')
  })

  it('sets aria-invalid + the danger border ONLY when invalid', () => {
    const { getByRole, rerender } = render(<TextArea />)
    const el = getByRole('textbox')
    expect(el).not.toHaveAttribute('aria-invalid', 'true')
    expect(el).not.toHaveClass('border-border-danger')

    rerender(<TextArea invalid />)
    expect(el).toHaveAttribute('aria-invalid', 'true')
    expect(el).toHaveClass('border-border-danger')
  })

  it('blocks input when disabled', async () => {
    const onChange = vi.fn()
    const user = userEvent.setup()
    const { getByRole } = render(<TextArea disabled onChange={onChange} />)
    const el = getByRole('textbox')
    expect(el).toBeDisabled()
    await user.type(el, 'x')
    expect(onChange).not.toHaveBeenCalled()
  })

  it('blocks input when readOnly (value stays, no change fires)', async () => {
    const onChange = vi.fn()
    const user = userEvent.setup()
    const { getByRole } = render(<TextArea readOnly defaultValue="locked" onChange={onChange} />)
    const el = getByRole('textbox') as HTMLTextAreaElement
    expect(el).toHaveAttribute('readonly')
    await user.type(el, 'x')
    expect(el.value).toBe('locked')
    expect(onChange).not.toHaveBeenCalled()
  })

  it('passes through placeholder', () => {
    const { getByPlaceholderText } = render(<TextArea placeholder="tell.us" />)
    expect(getByPlaceholderText('tell.us')).toBeInTheDocument()
  })

  it('marks required (native + aria)', () => {
    const { getByRole } = render(<TextArea required />)
    expect(getByRole('textbox')).toBeRequired()
  })

  it('carries the theme-aware focus-ring outline classes', () => {
    const { getByRole } = render(<TextArea />)
    expect(getByRole('textbox')).toHaveClass(
      'focus-visible:outline-2',
      'focus-visible:outline-offset-2',
      'focus-visible:outline-accent',
    )
  })

  it('uses flat 1-bit corners + the strong interactive border', () => {
    const { getByRole } = render(<TextArea />)
    expect(getByRole('textbox')).toHaveClass('rounded-none', 'border', 'border-border-strong')
  })

  it('forwards its ref to the underlying textarea', () => {
    const ref = createRef<HTMLTextAreaElement>()
    render(<TextArea ref={ref} />)
    expect(ref.current).toBeInstanceOf(HTMLTextAreaElement)
  })

  it('maps describedBy → aria-describedby (the portable a11y relationship)', () => {
    const { getByRole, rerender } = render(<TextArea />)
    expect(getByRole('textbox')).not.toHaveAttribute('aria-describedby')
    rerender(<TextArea describedBy="help-1 err-1" />)
    expect(getByRole('textbox')).toHaveAttribute('aria-describedby', 'help-1 err-1')
  })

  it('has no axe violations (labelled / invalid / disabled / read-only)', async () => {
    const { container } = render(
      <div>
        <label htmlFor="t-default">Default</label>
        <TextArea id="t-default" />
        <label htmlFor="t-invalid">Invalid</label>
        <TextArea id="t-invalid" invalid />
        <label htmlFor="t-disabled">Disabled</label>
        <TextArea id="t-disabled" disabled />
        <label htmlFor="t-readonly">Read-only</label>
        <TextArea id="t-readonly" readOnly defaultValue="x" />
      </div>,
    )
    expect(await axe(container)).toHaveNoViolations()
  })
})
