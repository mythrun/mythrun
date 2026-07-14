import { describe, it, expect, vi } from 'vitest'
import { useState } from 'react'
import { render } from '@testing-library/react'
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

// A controlled harness — SessionInput is a controlled composer (value/onChange),
// so the test drives the value the way the route wire will.
function ControlledSessionInput(props: {
  onSend?: () => void
  onSummonDm?: () => void
  onChange?: (v: string) => void
  disabled?: boolean
  initial?: string
}) {
  const { onSend = vi.fn(), onSummonDm = vi.fn(), onChange, disabled = false, initial = '' } = props
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
      placeholder={LABELS.placeholder}
      summonLabel={LABELS.summonLabel}
      sendLabel={LABELS.sendLabel}
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
