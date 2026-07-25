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
  submitLabel: 'Continue',
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

  it('wears the serif user-prose face, not the mono DATA face (myth-xs9tc)', () => {
    const { getByRole } = render(<FreeformPrompt {...props()} />)
    const field = getByRole('textbox')
    // Same face as the world-concept field: serif font-body + the ember caret,
    // never the mono font-ui that read as a code stub.
    expect(field.className).toContain('font-body')
    expect(field.className).toContain('caret-accent-fg')
    expect(field.className).not.toContain('font-ui')
  })

  it('carries a data-testid on the root', () => {
    const { getByTestId } = render(<FreeformPrompt {...props()} />)
    expect(getByTestId('freeform-prompt')).toBeInTheDocument()
  })

  it('renders the resolved step signpost above the prompt when given (MYT-102)', () => {
    const { getByTestId } = render(<FreeformPrompt {...props({ stepIndicator: '1 of 2' })} />)
    const signpost = getByTestId('freeform-step-indicator')
    expect(signpost.textContent).toBe('1 of 2')
    // Above the prompt: the signpost precedes the field's label in the document.
    const label = getByTestId('freeform-prompt').querySelector('label')
    expect(label).not.toBeNull()
    expect(signpost.compareDocumentPosition(label as Element) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  })

  it('omits the step signpost when the prop is absent', () => {
    const { queryByTestId } = render(<FreeformPrompt {...props()} />)
    expect(queryByTestId('freeform-step-indicator')).toBeNull()
  })

  // ux-run2 myth-80an1: Back lives bottom-left in the action row when wired —
  // the flow's one Back position, never a teleporting top-of-page label.
  it('renders a quiet Back in the action row when onBack is wired, and fires it', async () => {
    const onBack = vi.fn()
    const user = userEvent.setup()
    const { getByTestId, queryByTestId, unmount } = render(
      <FreeformPrompt {...props({ onBack, backLabel: 'Back' })} />,
    )
    await user.click(getByTestId('freeform-prompt-back'))
    expect(onBack).toHaveBeenCalledOnce()
    unmount()
    render(<FreeformPrompt {...props()} />)
    expect(queryByTestId('freeform-prompt-back')).toBeNull()
  })

  // ux-run2 myth-4gnrp: the AI's bespoke prompt is the DM's voice, not form-hint
  // chrome — `dm` promotes it to roman body size with a quiet left rule.
  it('promotes the whisper to the DM voice register when whisperVoice="dm"', () => {
    const { getByText, unmount } = render(<FreeformPrompt {...props({ whisperVoice: 'dm' })} />)
    const dm = getByText('What brought them to the empty caravan at Greenward Toll?')
    expect(dm.getAttribute('data-voice')).toBe('dm')
    expect(dm.className).not.toContain('italic')
    expect(dm.className).toContain('border-l-2')
    unmount()
    const hint = render(<FreeformPrompt {...props()} />).getByText(
      'What brought them to the empty caravan at Greenward Toll?',
    )
    expect(hint.getAttribute('data-voice')).toBe('hint')
    expect(hint.className).toContain('italic')
  })

  // ux-run2 myth-z45sb: the notes field starts at a ~3-line detail floor. In
  // autoSize mode the floor is the row-bound minHeight style, not a rows attr.
  it('floors the field at 3 rows when compact', () => {
    const compact = render(<FreeformPrompt {...props({ compact: true })} />)
    expect(compact.getByRole('textbox').style.minHeight).toContain('3 * 1lh')
    compact.unmount()
    const essay = render(<FreeformPrompt {...props()} />)
    expect(essay.getByRole('textbox').style.minHeight).toContain('6 * 1lh')
  })

  it('has no a11y violations with the step indicator present', async () => {
    const { container } = render(<FreeformPrompt {...props({ stepIndicator: '1 of 2' })} />)
    expect(await axe(container)).toHaveNoViolations()
  })

  // ux-run3 myth-7ceqw (b): the commit control is honestly gated — muted while
  // the required field is empty, full accent once content exists.
  it('disables the submit control when submitDisabled (and not otherwise)', () => {
    const gated = render(<FreeformPrompt {...props({ submitDisabled: true })} />)
    expect(gated.getByRole('button', { name: 'Continue' })).toBeDisabled()
    gated.unmount()
    const open = render(<FreeformPrompt {...props()} />)
    expect(open.getByRole('button', { name: 'Continue' })).toBeEnabled()
  })

  // ux-run3 myth-g3mt6: the commit disclosure — a quiet mono line by the CTA.
  it('renders the submit hint when given, omits it otherwise', () => {
    const withHint = render(
      <FreeformPrompt {...props({ submitHint: 'Building your character takes about a minute.' })} />,
    )
    expect(
      withHint.getByText('Building your character takes about a minute.'),
    ).toBeInTheDocument()
    withHint.unmount()
    const bare = render(<FreeformPrompt {...props()} />)
    expect(bare.queryByTestId('freeform-submit-hint')).not.toBeInTheDocument()
  })

  // ux-run3 myth-21lpi: the disclosure rides the action row's commit cluster —
  // beside the control it discloses, costing the composition no vertical band
  // of its own (the grounding step has none to spare above the 720px fold).
  it('seats the submit hint inside the commit cluster, beside the control', () => {
    const { getByTestId, getByRole } = render(
      <FreeformPrompt {...props({ submitHint: 'Building your character takes about a minute.' })} />,
    )
    expect(getByTestId('freeform-submit-hint').parentElement).toBe(
      getByRole('button', { name: 'Continue' }).parentElement,
    )
  })

  // ux-run3 myth-en2jj: typing is the step's one next action.
  it('focuses the field on mount when focusOnMount is set', () => {
    const { getByRole } = render(<FreeformPrompt {...props({ focusOnMount: true })} />)
    expect(getByRole('textbox')).toHaveFocus()
  })

  // ux-run3 myth-en2jj / myth-7ceqw (a): the writing surface wears the freeform
  // overflow guard and the ~70ch writing measure.
  it('wears the scroll-fade guard and the writing measure on the field', () => {
    const { getByRole } = render(<FreeformPrompt {...props()} />)
    const el = getByRole('textbox')
    expect(el.className).toContain('pb-[1lh]')
    expect(el.className).toContain('70ch')
  })

  // myth-gdycq: the optional aside slot — a secondary ask that belongs to the
  // step. It is seated BETWEEN the field and the action row, never after the
  // commit control, where an optional question reads as an afterthought.
  it('renders the aside between the field and the action row', () => {
    const { getByTestId, getByRole } = render(
      <FreeformPrompt {...props()} aside={<span data-testid="aside-probe">ask</span>} />,
    )
    const aside = getByTestId('freeform-prompt-aside')
    expect(getByTestId('aside-probe')).toBeDefined()
    const field = getByRole('textbox')
    const button = getByRole('button', { name: 'Continue' })
    // DOCUMENT_POSITION_FOLLOWING (4): the aside comes after the field and
    // before the control.
    expect(field.compareDocumentPosition(aside) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    expect(aside.compareDocumentPosition(button) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  })

  it('renders no aside container when the slot is empty', () => {
    const { queryByTestId } = render(<FreeformPrompt {...props()} />)
    expect(queryByTestId('freeform-prompt-aside')).toBeNull()
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
