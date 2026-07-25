import { describe, it, expect, vi } from 'vitest'
import { useState } from 'react'
import { render, fireEvent } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { axe } from 'jest-axe'
import { SessionInput } from './SessionInput.tsx'

// SessionInput — the live-play composer: a controlled text field, a Send
// affordance, and a prominent @DM summon. The component exposes exactly TWO
// intents (onSend / onSummonDm) plus the neutral controlled value; the visible
// `@dm` token composition + broadcast-as-player_message live at the route wire
// (Task 16), not here. Enter sends; Shift+Enter inserts a newline. `disabled`
// gates BOTH intents (session ended / not-ready).

const LABELS = {
  placeholder: 'Say or do something…',
  summonLabel: 'Ask the DM',
  sendLabel: 'Send',
}
const SUMMON_HINT = 'Ask a question, out of character'

// A controlled harness — SessionInput is a controlled composer (value/onChange),
// so the test drives the value the way the route wire will.
function ControlledSessionInput(props: {
  onSend?: () => void
  onSummonDm?: () => void
  onChange?: (v: string) => void
  disabled?: boolean
  busy?: boolean
  busyLabel?: string
  initial?: string
  maxLength?: number
  summonHint?: string
}) {
  const {
    onSend = vi.fn(),
    onSummonDm = vi.fn(),
    onChange,
    disabled = false,
    busy = false,
    busyLabel,
    initial = '',
    maxLength,
    summonHint,
  } = props
  const [v, setV] = useState(initial)
  return (
    <SessionInput
      value={v}
      onChange={(next) => {
        onChange?.(next)
        setV(next)
      }}
      onSend={onSend}
      onSummonDm={onSummonDm}
      disabled={disabled}
      busy={busy}
      {...(busyLabel !== undefined ? { busyLabel } : {})}
      placeholder={LABELS.placeholder}
      summonLabel={LABELS.summonLabel}
      sendLabel={LABELS.sendLabel}
      {...(maxLength !== undefined ? { maxLength } : {})}
      {...(summonHint !== undefined ? { summonHint } : {})}
    />
  )
}

describe('SessionInput', () => {
  it('renders a real native <textarea> composer with the resolved placeholder', () => {
    const { getByRole, getByPlaceholderText } = render(<ControlledSessionInput />)
    const el = getByRole('textbox')
    expect(el.tagName).toBe('TEXTAREA')
    expect(getByPlaceholderText(LABELS.placeholder)).toBe(el)
  })

  it('the field has an accessible NAME (a placeholder is not a name — SR label wired)', () => {
    // axe flags a textarea whose only "label" is a placeholder; the composer
    // wires a visually-hidden <label> so the field has a real accessible name.
    const { getByRole } = render(<ControlledSessionInput />)
    expect(getByRole('textbox', { name: LABELS.placeholder })).toBeInTheDocument()
  })

  it('exposes the Send + @DM summon affordances with their resolved labels', () => {
    const { getByRole } = render(<ControlledSessionInput />)
    expect(getByRole('button', { name: LABELS.sendLabel })).toBeInTheDocument()
    expect(getByRole('button', { name: LABELS.summonLabel })).toBeInTheDocument()
  })

  it('typing fires the neutral onChange with the STRING (controlled)', async () => {
    const onChange = vi.fn()
    const user = userEvent.setup()
    const { getByRole } = render(<ControlledSessionInput onChange={onChange} />)
    await user.type(getByRole('textbox'), 'hi')
    expect(onChange).toHaveBeenNthCalledWith(1, 'h')
    expect(onChange).toHaveBeenNthCalledWith(2, 'hi')
    expect(onChange.mock.calls.every(([arg]) => typeof arg === 'string')).toBe(true)
  })

  it('Enter (no modifier) fires onSend and does NOT insert a newline', async () => {
    const onSend = vi.fn()
    const onChange = vi.fn()
    const user = userEvent.setup()
    const { getByRole } = render(<ControlledSessionInput onSend={onSend} onChange={onChange} initial="ready" />)
    const el = getByRole('textbox') as HTMLTextAreaElement
    await user.click(el)
    await user.keyboard('{Enter}')
    expect(onSend).toHaveBeenCalledTimes(1)
    // preventDefault kept the newline out of the value (no onChange for '\n').
    expect(el.value).toBe('ready')
    expect(onChange).not.toHaveBeenCalled()
  })

  it('Shift+Enter inserts a newline and does NOT send', async () => {
    const onSend = vi.fn()
    const onChange = vi.fn()
    const user = userEvent.setup()
    const { getByRole } = render(<ControlledSessionInput onSend={onSend} onChange={onChange} initial="line" />)
    const el = getByRole('textbox') as HTMLTextAreaElement
    await user.click(el)
    await user.keyboard('{Shift>}{Enter}{/Shift}')
    expect(onSend).not.toHaveBeenCalled()
    expect(el.value).toBe('line\n')
    expect(onChange).toHaveBeenCalledWith('line\n')
  })

  it('clicking Send fires onSend', async () => {
    const onSend = vi.fn()
    const user = userEvent.setup()
    const { getByRole } = render(<ControlledSessionInput onSend={onSend} initial="go" />)
    await user.click(getByRole('button', { name: LABELS.sendLabel }))
    expect(onSend).toHaveBeenCalledTimes(1)
  })

  it('clicking the @DM summon fires onSummonDm (never onSend)', async () => {
    const onSend = vi.fn()
    const onSummonDm = vi.fn()
    const user = userEvent.setup()
    const { getByRole } = render(<ControlledSessionInput onSend={onSend} onSummonDm={onSummonDm} />)
    await user.click(getByRole('button', { name: LABELS.summonLabel }))
    expect(onSummonDm).toHaveBeenCalledTimes(1)
    expect(onSend).not.toHaveBeenCalled()
  })

  it('disabled gates BOTH intents: field + both affordances are inert', async () => {
    const onSend = vi.fn()
    const onSummonDm = vi.fn()
    const onChange = vi.fn()
    const user = userEvent.setup()
    const { getByRole } = render(
      <ControlledSessionInput onSend={onSend} onSummonDm={onSummonDm} onChange={onChange} disabled initial="x" />,
    )
    const el = getByRole('textbox')
    const send = getByRole('button', { name: LABELS.sendLabel })
    const summon = getByRole('button', { name: LABELS.summonLabel })
    expect(el).toBeDisabled()
    expect(send).toBeDisabled()
    expect(summon).toBeDisabled()
    await user.click(send)
    await user.click(summon)
    expect(onSend).not.toHaveBeenCalled()
    expect(onSummonDm).not.toHaveBeenCalled()
    expect(onChange).not.toHaveBeenCalled()
  })

  it('has no axe violations (empty, typed, disabled)', async () => {
    const { container } = render(
      <div>
        <ControlledSessionInput />
        <ControlledSessionInput initial="A torch flickers in the far corridor." />
        <ControlledSessionInput disabled initial="Locked while the session is ended." />
      </div>,
    )
    expect(await axe(container)).toHaveNoViolations()
  })
})


describe('SessionInput — busy gating (myth-dd63v: no silent send-swallow)', () => {
  const BUSY = 'The DM is writing…'

  it('busy gates Send + @DM but the FIELD stays typeable (draft-ahead is honest)', async () => {
    const onSend = vi.fn()
    const onSummonDm = vi.fn()
    const onChange = vi.fn()
    const user = userEvent.setup()
    const { getByRole } = render(
      <ControlledSessionInput onSend={onSend} onSummonDm={onSummonDm} onChange={onChange} busy busyLabel={BUSY} />,
    )
    const field = getByRole('textbox')
    const send = getByRole('button', { name: LABELS.sendLabel })
    const summon = getByRole('button', { name: LABELS.summonLabel })
    expect(field).not.toBeDisabled() // the field stays LIVE while the DM writes
    expect(send).toBeDisabled()
    expect(summon).toBeDisabled()
    await user.type(field, 'draft')
    expect(onChange).toHaveBeenCalled() // typing works
    await user.click(send)
    await user.click(summon)
    expect(onSend).not.toHaveBeenCalled()
    expect(onSummonDm).not.toHaveBeenCalled()
  })

  it('busy blocks Enter-to-send (a keyboard send cannot slip past the gate)', () => {
    const onSend = vi.fn()
    const { getByRole } = render(<ControlledSessionInput onSend={onSend} busy busyLabel={BUSY} initial="ready" />)
    const ta = getByRole('textbox')
    ta.focus()
    fireEvent.keyDown(ta, { key: 'Enter' })
    expect(onSend).not.toHaveBeenCalled()
  })

  it('shows the busy caption while busy, and nothing when idle', () => {
    const { getByTestId, rerender } = render(<ControlledSessionInput busy busyLabel={BUSY} />)
    expect(getByTestId('session-input-busy')).toHaveTextContent(BUSY)
    rerender(<ControlledSessionInput busy={false} busyLabel={BUSY} />)
    expect(getByTestId('session-input-busy')).toHaveTextContent('')
  })

  it('terminal disabled supersedes busy: field inert, no busy caption', () => {
    const { getByRole, getByTestId } = render(
      <ControlledSessionInput disabled busy busyLabel={BUSY} initial="x" />,
    )
    expect(getByRole('textbox')).toBeDisabled()
    expect(getByTestId('session-input-busy')).toHaveTextContent('')
  })
})

describe('SessionInput — the gated visual state (myth-lkm09)', () => {
  const BUSY = 'The DM is writing…'

  it('busy drops the FIELD to the subdued mute (quiet edge on the page ground), and back', () => {
    const { getByRole, rerender } = render(<ControlledSessionInput busy busyLabel={BUSY} />)
    expect(getByRole('textbox').className).toContain('bg-bg')
    rerender(<ControlledSessionInput busy={false} busyLabel={BUSY} />)
    expect(getByRole('textbox').className).not.toContain('bg-bg')
  })

  it('busy blanks the VISIBLE placeholder (the field must not ask "what next" while gated) but keeps the SR name', () => {
    const { getByRole } = render(<ControlledSessionInput busy busyLabel={BUSY} />)
    const field = getByRole('textbox')
    expect(field).not.toHaveAttribute('placeholder')
    // The accessible name survives the blank — it rides the SR-only label.
    expect(getByRole('textbox', { name: LABELS.placeholder })).toBe(field)
  })

  it('terminal disabled blanks the visible placeholder too (a farewell must not solicit moves)', () => {
    const { getByRole } = render(<ControlledSessionInput disabled />)
    expect(getByRole('textbox')).not.toHaveAttribute('placeholder')
  })

  it('while gated Send stands down to the quiet borderless treatment; idle keeps the solid primary', () => {
    const { getByRole, rerender } = render(<ControlledSessionInput busy busyLabel={BUSY} />)
    expect(getByRole('button', { name: LABELS.sendLabel }).className).toContain('bg-transparent')
    rerender(<ControlledSessionInput busy={false} busyLabel={BUSY} />)
    expect(getByRole('button', { name: LABELS.sendLabel }).className).toContain('bg-accent')
  })

  it('the summon hint never resurfaces the placeholder while gated', () => {
    const { getByRole } = render(<ControlledSessionInput busy busyLabel={BUSY} summonHint={SUMMON_HINT} />)
    fireEvent.mouseEnter(getByRole('button', { name: LABELS.summonLabel }))
    expect(getByRole('textbox')).not.toHaveAttribute('placeholder')
  })
})

describe('SessionInput — the @DM modality hint (myth-cimi3)', () => {
  it('hovering the @DM summon shifts the placeholder to the out-of-character hint, and back on leave', () => {
    const { getByRole } = render(<ControlledSessionInput summonHint={SUMMON_HINT} />)
    const field = getByRole('textbox')
    const summon = getByRole('button', { name: LABELS.summonLabel })
    expect(field).toHaveAttribute('placeholder', LABELS.placeholder)
    fireEvent.mouseEnter(summon)
    expect(field).toHaveAttribute('placeholder', SUMMON_HINT)
    fireEvent.mouseLeave(summon)
    expect(field).toHaveAttribute('placeholder', LABELS.placeholder)
  })

  it('keyboard focus on the summon shifts the placeholder too (not a hover-only disclosure)', () => {
    const { getByRole } = render(<ControlledSessionInput summonHint={SUMMON_HINT} />)
    const field = getByRole('textbox')
    const summon = getByRole('button', { name: LABELS.summonLabel })
    fireEvent.focus(summon)
    expect(field).toHaveAttribute('placeholder', SUMMON_HINT)
    fireEvent.blur(summon)
    expect(field).toHaveAttribute('placeholder', LABELS.placeholder)
  })

  it('without a summonHint the placeholder never shifts (back-compat)', () => {
    const { getByRole } = render(<ControlledSessionInput />)
    fireEvent.mouseEnter(getByRole('button', { name: LABELS.summonLabel }))
    expect(getByRole('textbox')).toHaveAttribute('placeholder', LABELS.placeholder)
  })
})

describe('SessionInput — message length cap (MYT-102 QA F1)', () => {
  it('caps the native textarea at maxLength (blocks over-long typing/paste)', () => {
    const { getByRole } = render(<ControlledSessionInput maxLength={4000} />)
    const ta = getByRole('textbox') as HTMLTextAreaElement
    expect(ta.maxLength).toBe(4000)
  })

  it('disables Send and Enter-to-send when the value exceeds the cap', () => {
    const onSend = vi.fn()
    const { getByRole } = render(
      <ControlledSessionInput maxLength={10} initial={'x'.repeat(11)} onSend={onSend} />,
    )
    const send = getByRole('button', { name: LABELS.sendLabel })
    expect((send as HTMLButtonElement).disabled).toBe(true)
    const ta = getByRole('textbox')
    ta.focus()
    fireEvent.keyDown(ta, { key: 'Enter' })
    expect(onSend).not.toHaveBeenCalled()
  })
})
