import { describe, it, expect, vi } from 'vitest'
import { createRef, useState } from 'react'
import { render } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { axe } from 'jest-axe'
import { SeamlessInput } from './SeamlessInput.tsx'

// SeamlessInput — the borderless "ghost" creation-flow field. The `label` (the
// question) is the visible, persistent, ASSOCIATED label and the field's
// accessible name (the key a11y check). The field is a REAL native control
// (input by default, textarea when multiline), strips the box (no
// border/background on the resting field), and carries a NON-BOX focus
// affordance — the accent baseline rule, not an outline box (WCAG 2.4.13).
describe('SeamlessInput', () => {
  it('renders a real native <input> by default (role textbox)', () => {
    const { getByRole } = render(<SeamlessInput label="What is your world called?" />)
    const el = getByRole('textbox')
    expect(el.tagName).toBe('INPUT')
  })

  it('multiline renders a real native <textarea> (auto-grows via field-sizing-content)', () => {
    const { getByRole } = render(<SeamlessInput multiline label="Describe the feel of your world" />)
    const el = getByRole('textbox')
    expect(el.tagName).toBe('TEXTAREA')
    // Auto-grow: the field sizes to its content rather than a fixed rows count.
    expect(el).toHaveClass('field-sizing-content', 'resize-none', 'overflow-hidden')
  })

  it('the label (the question) is the field accessible name (programmatic association)', () => {
    const { getByRole } = render(<SeamlessInput label="What is your world called?" />)
    // getByRole resolves the accessible name from the associated <label htmlFor>.
    expect(getByRole('textbox', { name: 'What is your world called?' })).toBeInTheDocument()
  })

  it('auto-generates an id to wire label↔field when none is supplied', () => {
    const { getByRole, getByText } = render(<SeamlessInput label="Your world's name" />)
    const field = getByRole('textbox')
    const label = getByText("Your world's name")
    expect(field.id).toBeTruthy()
    expect(label).toHaveAttribute('for', field.id)
  })

  it('honours an explicit id for the label↔field association', () => {
    const { getByRole, getByText } = render(<SeamlessInput id="world-name" label="Name it" />)
    expect(getByRole('textbox')).toHaveAttribute('id', 'world-name')
    expect(getByText('Name it')).toHaveAttribute('for', 'world-name')
  })

  it('is uncontrolled with defaultValue — typing updates the value', async () => {
    const user = userEvent.setup()
    const { getByRole } = render(<SeamlessInput label="Q" defaultValue="ab" />)
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
        <SeamlessInput
          label="Q"
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

  it('multiline controlled: onChange also hands back a plain string', async () => {
    const onChange = vi.fn()
    const user = userEvent.setup()

    function Controlled() {
      const [v, setV] = useState('')
      return (
        <SeamlessInput
          multiline
          label="Q"
          value={v}
          onChange={(next) => {
            onChange(next)
            setV(next)
          }}
        />
      )
    }

    const { getByRole } = render(<Controlled />)
    await user.type(getByRole('textbox'), 'x')
    expect(onChange).toHaveBeenCalledWith('x')
    expect(onChange.mock.calls.every(([arg]) => typeof arg === 'string')).toBe(true)
  })

  it('carries the non-box focus affordance: accent baseline rule, NOT a box outline', () => {
    const { getByRole } = render(<SeamlessInput label="Q" />)
    const el = getByRole('textbox')
    // Resting baseline rule (thin, low-emphasis) ...
    expect(el).toHaveClass('border-b', 'border-border')
    // ... thickens to 2px + colors to accent on focus (the WCAG 2.4.13 indicator).
    expect(el).toHaveClass('focus-visible:border-b-2', 'focus-visible:border-accent')
    // The default box outline is removed — the baseline IS the indicator.
    expect(el).toHaveClass('focus-visible:outline-none')
  })

  it('uses the branded ember caret', () => {
    const { getByRole } = render(<SeamlessInput label="Q" />)
    expect(getByRole('textbox')).toHaveClass('caret-accent')
  })

  it('strips the box: no border-box / background utility on the resting field', () => {
    const { getByRole } = render(<SeamlessInput label="Q" />)
    const el = getByRole('textbox')
    // A full border or a surface fill would draw a box — the ghost field has neither.
    expect(el).not.toHaveClass('border')
    expect(el).not.toHaveClass('bg-surface')
    expect(el).toHaveClass('bg-transparent')
  })

  it('renders display-size prose type (large serif body face)', () => {
    const { getByRole } = render(<SeamlessInput label="Q" />)
    // The magical register: the serif body face at headline scale.
    expect(getByRole('textbox')).toHaveClass('font-body', 'text-2xl')
  })

  it('passes through placeholder as a faint hint (muted token, never the label)', () => {
    const { getByPlaceholderText } = render(<SeamlessInput label="Q" placeholder="field.hint" />)
    const el = getByPlaceholderText('field.hint')
    expect(el).toBeInTheDocument()
    expect(el).toHaveClass('placeholder:text-ink-tertiary')
  })

  it('blocks input when disabled', async () => {
    const onChange = vi.fn()
    const user = userEvent.setup()
    const { getByRole } = render(<SeamlessInput label="Q" disabled onChange={onChange} />)
    const el = getByRole('textbox')
    expect(el).toBeDisabled()
    await user.type(el, 'x')
    expect(onChange).not.toHaveBeenCalled()
  })

  it('marks required (native + aria)', () => {
    const { getByRole } = render(<SeamlessInput label="Q" required />)
    expect(getByRole('textbox')).toBeRequired()
  })

  it('maps describedBy → aria-describedby (the portable a11y relationship)', () => {
    const { getByRole, rerender } = render(<SeamlessInput label="Q" />)
    expect(getByRole('textbox')).not.toHaveAttribute('aria-describedby')
    rerender(<SeamlessInput label="Q" describedBy="help-1 err-1" />)
    expect(getByRole('textbox')).toHaveAttribute('aria-describedby', 'help-1 err-1')
  })

  it('passes the form name through to the field', () => {
    const { getByRole } = render(<SeamlessInput label="Q" name="world_name" />)
    expect(getByRole('textbox')).toHaveAttribute('name', 'world_name')
  })

  it('spreads ...rest so the flow can pass DOM props (onKeyDown, data-*) through', async () => {
    const onKeyDown = vi.fn()
    const user = userEvent.setup()
    // The flow drives behaviour via native DOM props (e.g. autoFocus, onKeyDown)
    // — the component must not block them. We assert the passthrough with an
    // event handler + an arbitrary data-* attribute (autoFocus itself is
    // exercised by the consumer; asserting it here would trip jsx-a11y).
    const { getByRole } = render(
      <SeamlessInput label="Q" onKeyDown={onKeyDown} data-step="1" />,
    )
    const el = getByRole('textbox')
    expect(el).toHaveAttribute('data-step', '1')
    el.focus()
    await user.keyboard('{Enter}')
    expect(onKeyDown).toHaveBeenCalled()
  })

  it('forwards its ref to the single-line input', () => {
    const ref = createRef<HTMLInputElement>()
    render(<SeamlessInput label="Q" ref={ref} />)
    expect(ref.current).toBeInstanceOf(HTMLInputElement)
  })

  it('forwards its ref to the multiline textarea', () => {
    const ref = createRef<HTMLTextAreaElement>()
    render(<SeamlessInput label="Q" multiline ref={ref} />)
    expect(ref.current).toBeInstanceOf(HTMLTextAreaElement)
  })

  it('multiline auto-grow FALLBACK (no CSS field-sizing): height tracks scrollHeight, unbounded', async () => {
    // jsdom has no `CSS` global, so supportsFieldSizing() is false → the JS
    // fallback is active (this is the Firefox path Miklos hit). jsdom has no
    // layout, so stub scrollHeight and assert the height grows to it on input —
    // no cap, no scrollbar (overflow stays hidden via the class).
    const user = userEvent.setup()
    const { getByRole } = render(<SeamlessInput multiline label="Q" />)
    const el = getByRole('textbox') as HTMLTextAreaElement
    Object.defineProperty(el, 'scrollHeight', { configurable: true, value: 200 })
    await user.type(el, 'a long line of world-creation prose that would wrap')
    expect(el.style.height).toBe('200px')
  })

  it('multiline with CSS field-sizing supported: NO inline height is set (CSS drives growth)', async () => {
    const original = (globalThis as { CSS?: unknown }).CSS
    ;(globalThis as { CSS?: { supports: (p: string, v: string) => boolean } }).CSS = {
      supports: () => true,
    }
    try {
      const user = userEvent.setup()
      const { getByRole } = render(<SeamlessInput multiline label="Q" />)
      const el = getByRole('textbox') as HTMLTextAreaElement
      Object.defineProperty(el, 'scrollHeight', { configurable: true, value: 200 })
      await user.type(el, 'prose')
      // field-sizing handles the height; the JS fallback never runs.
      expect(el.style.height).toBe('')
    } finally {
      if (original === undefined) delete (globalThis as { CSS?: unknown }).CSS
      else (globalThis as { CSS?: unknown }).CSS = original
    }
  })

  it('has no axe violations (label association is the key a11y check)', async () => {
    const { container } = render(
      <div>
        <SeamlessInput label="What is your world called?" />
        <SeamlessInput label="Describe the feel of your world" multiline />
        <SeamlessInput label="Disabled question" disabled />
      </div>,
    )
    expect(await axe(container)).toHaveNoViolations()
  })
})
