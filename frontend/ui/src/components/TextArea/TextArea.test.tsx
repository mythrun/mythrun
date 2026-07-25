import { describe, it, expect, vi, afterEach } from 'vitest'
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

  it('sets aria-invalid + the 2px danger border (NO bg wash) ONLY when invalid', () => {
    const { getByRole, rerender } = render(<TextArea />)
    const el = getByRole('textbox')
    expect(el).not.toHaveAttribute('aria-invalid', 'true')
    expect(el).not.toHaveClass('border-border-danger')
    expect(el).not.toHaveClass('bg-surface-danger')

    rerender(<TextArea invalid />)
    expect(el).toHaveAttribute('aria-invalid', 'true')
    // A heavier 2px danger border — the standardized invalid treatment.
    expect(el).toHaveClass('border-2', 'border-border-danger')
    // The wash is GONE: the re-saturated danger red reads as error on its own.
    expect(el).not.toHaveClass('bg-surface-danger')
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
      'focus-visible:outline-accent-fg',
    )
  })

  it('uses flat 1-bit corners + the strong interactive border', () => {
    const { getByRole } = render(<TextArea />)
    expect(getByRole('textbox')).toHaveClass('rounded-none', 'border', 'border-border-strong')
  })

  it('defaults to the mono DATA face (font-ui), no prose caret', () => {
    const { getByRole } = render(<TextArea />)
    const el = getByRole('textbox')
    expect(el).toHaveClass('font-ui')
    expect(el).not.toHaveClass('font-body')
    expect(el).not.toHaveClass('caret-accent-fg')
  })

  it('face="prose" wears the serif user-prose face + the ember caret (the one player-writing face)', () => {
    const { getByRole } = render(<TextArea face="prose" />)
    const el = getByRole('textbox')
    expect(el).toHaveClass('font-body', 'caret-accent-fg')
    expect(el).not.toHaveClass('font-ui')
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

// AutoSize (the chat-composer auto-grow). Primary mechanism is the modern CSS
// `field-sizing: content` (Tailwind `field-sizing-content`); a JS scrollHeight
// fallback handles Firefox (no field-sizing yet). Feature-detected via
// `CSS.supports('field-sizing','content')`. jsdom has NO `CSS` global, so the
// default-render case takes the fallback path; the "supported" case stubs
// `globalThis.CSS`.
describe('TextArea — autoSize', () => {
  // Tests in this block may stub the global `CSS` (which jsdom lacks). Restore
  // the original after each so a stub never leaks across cases.
  const originalCss = (globalThis as { CSS?: unknown }).CSS
  afterEach(() => {
    if (originalCss === undefined) {
      delete (globalThis as { CSS?: unknown }).CSS
    } else {
      ;(globalThis as { CSS?: unknown }).CSS = originalCss
    }
  })

  const stubCssSupports = (result: boolean) => {
    ;(globalThis as { CSS?: { supports: (p: string, v: string) => boolean } }).CSS = {
      supports: vi.fn(() => result),
    }
  }

  it('non-autoSize is unchanged: resize-vertical, NO field-sizing/overflow utilities', () => {
    const { getByRole } = render(<TextArea rows={4} />)
    const el = getByRole('textbox')
    expect(el).toHaveClass('resize-vertical')
    expect(el).not.toHaveClass('field-sizing-content')
    expect(el).not.toHaveClass('resize-none')
    expect(el).not.toHaveClass('overflow-y-auto')
    expect(el).toHaveAttribute('rows', '4')
    expect(el).not.toHaveStyle({ minHeight: expect.anything() })
  })

  it('autoSize applies field-sizing-content + resize-none + overflow-y-auto (not resize-vertical)', () => {
    const { getByRole } = render(<TextArea autoSize />)
    const el = getByRole('textbox')
    expect(el).toHaveClass('field-sizing-content', 'resize-none', 'overflow-y-auto')
    expect(el).not.toHaveClass('resize-vertical')
  })

  it('autoSize ignores `rows` (field-sizing ignores the rows attribute)', () => {
    const { getByRole } = render(<TextArea autoSize rows={9} />)
    expect(getByRole('textbox')).not.toHaveAttribute('rows')
  })

  it('autoSize sets the inline min/max-height bound from minRows/maxRows (md vertical padding)', () => {
    const { getByRole } = render(<TextArea autoSize minRows={2} maxRows={6} />)
    const el = getByRole('textbox') as HTMLTextAreaElement
    // md size → py is --space-2 each side → 2 * var(--space-2) total padding.
    expect(el.style.minHeight).toBe('calc(2 * 1lh + 2 * var(--space-2))')
    expect(el.style.maxHeight).toBe('calc(6 * 1lh + 2 * var(--space-2))')
  })

  it('autoSize uses the SIZE-correct vertical padding token in the bound (lg → --space-3)', () => {
    const { getByRole } = render(<TextArea autoSize size="lg" minRows={1} maxRows={3} />)
    const el = getByRole('textbox') as HTMLTextAreaElement
    expect(el.style.minHeight).toBe('calc(1 * 1lh + 2 * var(--space-3))')
    expect(el.style.maxHeight).toBe('calc(3 * 1lh + 2 * var(--space-3))')
  })

  it('defaults minRows=1 / maxRows=8 when unspecified', () => {
    const { getByRole } = render(<TextArea autoSize />)
    const el = getByRole('textbox') as HTMLTextAreaElement
    expect(el.style.minHeight).toBe('calc(1 * 1lh + 2 * var(--space-2))')
    expect(el.style.maxHeight).toBe('calc(8 * 1lh + 2 * var(--space-2))')
  })

  it('field-sizing UNSUPPORTED (jsdom default): runs the JS resize on mount + on input', async () => {
    // jsdom has no `CSS` global → unsupported → the fallback wires up. jsdom also
    // reports scrollHeight 0 (no layout), so we stub a growing content height on
    // the prototype BEFORE render — the mount effect reads it during render — then
    // bump it for the input case. The getter lets the value change between reads.
    let scrollHeightPx = 30
    const scrollHeightSpy = vi
      .spyOn(HTMLTextAreaElement.prototype, 'scrollHeight', 'get')
      .mockImplementation(() => scrollHeightPx)

    const user = userEvent.setup()
    const { getByRole } = render(<TextArea autoSize minRows={1} maxRows={3} />)
    const el = getByRole('textbox') as HTMLTextAreaElement

    // Mount effect ran the resize once: height was set to 'auto' then to a px value
    // clamped to the cap (jsdom can't resolve the calc() maxHeight → cap is +∞).
    expect(el.style.height).toBe('30px')

    // Typing fires `input` → the handler recomputes from the new content height.
    scrollHeightPx = 72
    await user.type(el, 'a')
    expect(el.style.height).toBe('72px')

    scrollHeightSpy.mockRestore()
  })

  it('field-sizing SUPPORTED: NO JS input listener is attached (the CSS does the work)', () => {
    stubCssSupports(true)
    const { getByRole } = render(<TextArea autoSize />)
    const el = getByRole('textbox') as HTMLTextAreaElement
    const addSpy = vi.spyOn(el, 'addEventListener')
    // A fresh input event must not trigger any height write (no listener wired).
    Object.defineProperty(el, 'scrollHeight', { configurable: true, value: 99 })
    el.dispatchEvent(new Event('input', { bubbles: true }))
    expect(el.style.height).toBe('')
    expect(addSpy).not.toHaveBeenCalledWith('input', expect.anything())
  })

  it('does NOT attach the JS fallback when autoSize is false (even with CSS unsupported)', async () => {
    const user = userEvent.setup()
    const { getByRole } = render(<TextArea rows={3} />)
    const el = getByRole('textbox') as HTMLTextAreaElement
    Object.defineProperty(el, 'scrollHeight', { configurable: true, value: 50 })
    await user.type(el, 'x')
    expect(el.style.height).toBe('')
  })

  it('still forwards the ref to the textarea in autoSize mode (merged with the internal ref)', () => {
    const ref = createRef<HTMLTextAreaElement>()
    render(<TextArea autoSize ref={ref} />)
    expect(ref.current).toBeInstanceOf(HTMLTextAreaElement)
  })

  it('does NOT add aria-multiline (native textarea already has multiline semantics)', () => {
    const { getByRole } = render(<TextArea autoSize />)
    expect(getByRole('textbox')).not.toHaveAttribute('aria-multiline')
  })

  it('autoSize chat composer is axe-clean with a bound <label>', async () => {
    const { container } = render(
      <div>
        <label htmlFor="composer">Message</label>
        <TextArea id="composer" autoSize minRows={1} maxRows={6} placeholder="composer.message" />
      </div>,
    )
    expect(await axe(container)).toHaveNoViolations()
  })
})

describe('TextArea — subdued (the gated-composer visual mute)', () => {
  it('quiets the chrome while staying fully interactive (no disabled semantics)', async () => {
    const onChange = vi.fn()
    const user = userEvent.setup()
    const { getByRole } = render(<TextArea subdued value="" onChange={onChange} />)
    const el = getByRole('textbox')
    expect(el.className).toContain('border-border')
    expect(el.className).toContain('text-ink-secondary')
    expect(el).not.toBeDisabled()
    await user.type(el, 'x')
    expect(onChange).toHaveBeenCalledWith('x')
  })

  it('keeps the default full-voice chrome without the prop', () => {
    const { getByRole } = render(<TextArea />)
    expect(getByRole('textbox').className).not.toContain('text-ink-secondary')
  })
})
