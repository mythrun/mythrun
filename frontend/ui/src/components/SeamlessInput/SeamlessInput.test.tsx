import { describe, it, expect, vi } from 'vitest'
import { createRef, useState } from 'react'
import { render } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { axe } from 'jest-axe'
import { SeamlessInput } from './SeamlessInput.tsx'

// SeamlessInput — the creation-flow's PROSE field. The `label` (the question) is
// the visible, persistent, ASSOCIATED label and the field's accessible name (the
// key a11y check). The field is a REAL native control (input by default, textarea
// when multiline) styled as a DEFINED paper field — surface ground + square
// interactive-grade border (the DS Input/TextArea affordance, so it can't be
// mistaken for prose) — with serif display type and the shared accent focus ring
// (WCAG 2.4.13).
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
    // Auto-grow: the field sizes to its content rather than a fixed rows count —
    // capped at ~14 visible lines clamped to 55dvh (ux-run3 myth-en2jj), past
    // which the field scrolls internally.
    expect(el).toHaveClass('field-sizing-content', 'resize-none', 'overflow-y-auto')
    expect(el).toHaveClass('max-h-[min(calc(14*1lh+var(--space-3)+1lh),55dvh)]')
  })

  it('multiline guards the scroll edge: 1lh bottom pad + alpha fade, border on the shell', () => {
    // ux-run3 myth-en2jj: the field must never guillotine the player's last
    // line under its bottom rule — a full line of bottom padding plus a bottom
    // fade; the border moves to a shell wrapper (a mask clips everything the
    // element paints, border included).
    const { getByRole, getByTestId } = render(<SeamlessInput multiline label="Q" />)
    const el = getByRole('textbox')
    expect(el).toHaveClass('pb-[1lh]', 'border-0', 'bg-transparent')
    expect(el.className).toContain('mask-image:linear-gradient')
    const shell = getByTestId('seamless-fade-shell')
    expect(shell.className).toContain('border-border-strong')
    expect(shell.className).toContain('bg-surface')
    // The one-contiguous-accent-stroke focus rides the shell via :has().
    expect(shell.className).toContain('has-[textarea:focus-visible]:outline-2')
    expect(shell.className).toContain('has-[textarea:focus-visible]:border-accent-fg')
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

  it('focus is ONE contiguous accent stroke — no offset gap, no double rule', () => {
    const { getByRole } = render(<SeamlessInput label="Q" />)
    const el = getByRole('textbox')
    // ux-run2 myth-1pzjw: the offset ring over the field's own border read as a
    // pressed-button/error double-stroke. Focus hugs the border (offset 0) and
    // the border flips to the same accent, so the two read as one single
    // distinctive sienna stroke (WCAG 2.4.13 still: 2px accent, theme-aware).
    expect(el).toHaveClass(
      'focus-visible:outline-2',
      'focus-visible:outline-offset-0',
      'focus-visible:outline-accent-fg',
      'focus-visible:border-accent-fg',
    )
  })

  it('uses the branded ember caret', () => {
    const { getByRole } = render(<SeamlessInput label="Q" />)
    expect(getByRole('textbox')).toHaveClass('caret-accent-fg')
  })

  it('renders a defined paper field: surface ground + a square interactive-grade border', () => {
    const { getByRole } = render(<SeamlessInput label="Q" />)
    const el = getByRole('textbox')
    // The DS input affordance — the field must READ as a place to write, not
    // prose: a square (flat 1-bit) box in the 3:1 interactive-grade border token
    // over the surface ground. (A bare underline was missed by real users.)
    expect(el).toHaveClass('border', 'border-border-strong', 'bg-surface', 'rounded-none')
  })

  it('renders reading-scale prose type (serif body face, ~22px)', () => {
    const { getByRole } = render(<SeamlessInput label="Q" />)
    // The literary register survives at a READING size (ux-run2 myth-x9ugl: the
    // 28px field text pushed Q2 + the CTA under the fold; serif stays).
    expect(getByRole('textbox')).toHaveClass('font-body', 'text-xl')
  })

  it('single-line: compact height + ellipsis on overflow (no mid-word clip at the edge)', () => {
    const { getByRole } = render(<SeamlessInput label="Q" />)
    const el = getByRole('textbox')
    // ux-run2 myth-1pzjw: a ~70px single-line field implied a paragraph; the
    // title arm is a true one-line input (~48px) whose overflow resolves to an
    // ellipsis when unfocused instead of clipping flush against the border.
    expect(el).toHaveClass('py-[var(--space-2)]', 'text-ellipsis')
    expect(el).not.toHaveClass('py-[var(--space-3)]')
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
