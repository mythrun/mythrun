import { describe, it, expect, vi } from 'vitest'
import { createRef, useState } from 'react'
import { render } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { axe } from 'jest-axe'
import { FreeformPrompt } from './FreeformPrompt.tsx'
import type { FreeformPromptProps } from '@mythrun/client-core/contract'

// The freeform character-creation prompt: a calm question + whisper + one
// generous textarea + a submit control. Pure/presentational — renders the prop
// strings and fires the neutral onChange(value) / onSubmit callbacks.
const props = (overrides: Partial<FreeformPromptProps> = {}): FreeformPromptProps => ({
  prompt: 'Who are you?',
  whisper: 'What brought them to the empty caravan at Greenward Toll?',
  value: '',
  onChange: vi.fn(),
  onSubmit: vi.fn(),
  placeholder: 'A retired toll-clerk who never stopped counting…',
  ...overrides,
})

// A stateful harness so a controlled round-trip (type → value shows) can be
// exercised the way the real view-model wires value/onChange.
function Harness({ onSubmit = vi.fn() }: { onSubmit?: () => void }): React.JSX.Element {
  const [value, setValue] = useState('')
  return <FreeformPrompt {...props({ value, onChange: setValue, onSubmit })} />
}

describe('FreeformPrompt', () => {
  it('renders the prompt as the textarea\'s accessible label (the question names the field)', () => {
    const { getByRole } = render(<FreeformPrompt {...props()} />)
    // The field's accessible name is the question, wired via <label htmlFor>.
    expect(getByRole('textbox', { name: /Who are you\?/ })).toBeInTheDocument()
  })

  it('renders the whisper sub-line', () => {
    const { getByText } = render(<FreeformPrompt {...props()} />)
    expect(getByText('What brought them to the empty caravan at Greenward Toll?')).toBeInTheDocument()
  })

  it('reflects the controlled value and the placeholder on the textarea', () => {
    const { getByRole } = render(
      <FreeformPrompt {...props({ value: 'A ledger-keeper who counts.' })} />,
    )
    const field = getByRole('textbox')
    expect(field).toHaveValue('A ledger-keeper who counts.')
    expect(field).toHaveAttribute('placeholder', 'A retired toll-clerk who never stopped counting…')
  })

  it('fires onChange with the new value (neutral value, not a DOM event)', async () => {
    const onChange = vi.fn()
    const user = userEvent.setup()
    const { getByRole } = render(<FreeformPrompt {...props({ value: '', onChange })} />)
    await user.type(getByRole('textbox'), 'A')
    expect(onChange).toHaveBeenCalledWith('A')
  })

  it('is controlled: typing round-trips through value/onChange into the field', async () => {
    const user = userEvent.setup()
    const { getByRole } = render(<Harness />)
    const field = getByRole('textbox')
    await user.type(field, 'A retired toll-clerk')
    expect(field).toHaveValue('A retired toll-clerk')
  })

  it('describes the field with the whisper (aria-describedby → guidance text)', () => {
    const { getByRole } = render(<FreeformPrompt {...props()} />)
    expect(getByRole('textbox')).toHaveAccessibleDescription(
      'What brought them to the empty caravan at Greenward Toll?',
    )
  })

  it('fires onSubmit when the submit control is clicked', async () => {
    const onSubmit = vi.fn()
    const user = userEvent.setup()
    const { getByRole } = render(<FreeformPrompt {...props({ onSubmit })} />)
    await user.click(getByRole('button'))
    expect(onSubmit).toHaveBeenCalledOnce()
  })

  it('fires onSubmit on native keyboard activation of the submit control (Enter)', async () => {
    const onSubmit = vi.fn()
    const user = userEvent.setup()
    const { getByRole } = render(<FreeformPrompt {...props({ onSubmit })} />)
    getByRole('button').focus()
    await user.keyboard('{Enter}')
    expect(onSubmit).toHaveBeenCalledOnce()
  })

  it('is flat 1-bit / square: the textarea carries rounded-none', () => {
    const { getByRole } = render(<FreeformPrompt {...props()} />)
    expect(getByRole('textbox').className).toContain('rounded-none')
  })

  it('carries a data-testid on the root', () => {
    const { getByTestId } = render(<FreeformPrompt {...props()} />)
    expect(getByTestId('freeform-prompt')).toBeInTheDocument()
  })

  it('forwards the ref to the container element', () => {
    const ref = createRef<HTMLDivElement>()
    render(<FreeformPrompt ref={ref} {...props()} />)
    expect(ref.current).toBeInstanceOf(HTMLDivElement)
  })

  it('has no a11y violations (empty and filled)', async () => {
    const empty = render(<FreeformPrompt {...props()} />)
    expect(await axe(empty.container)).toHaveNoViolations()
    empty.unmount()
    const filled = render(<FreeformPrompt {...props({ value: 'A retired toll-clerk who never stopped counting.' })} />)
    expect(await axe(filled.container)).toHaveNoViolations()
  })
})
