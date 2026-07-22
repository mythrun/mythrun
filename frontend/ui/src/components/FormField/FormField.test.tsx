import { describe, it, expect, vi } from 'vitest'
import { createRef } from 'react'
import { render } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { axe } from 'jest-axe'
import { FormField } from './FormField.tsx'
import { Input } from '../Input/Input.tsx'
import { Select } from '../Select/Select.tsx'

const OPTIONS = [
  { value: 'human', label: 'race.human' },
  { value: 'elf', label: 'race.elf' },
] as const

describe('FormField (wrapping Input)', () => {
  it('gives the control its accessible name from the label', () => {
    const { getByLabelText } = render(
      <FormField requiredLabel="(required)" label="field.character_name">
        <Input />
      </FormField>,
    )
    // The control is reachable BY its label text → the label is associated.
    expect(getByLabelText('field.character_name').tagName).toBe('INPUT')
  })

  it('clicking the label focuses the control', async () => {
    const user = userEvent.setup()
    const { getByText, getByRole } = render(
      <FormField requiredLabel="(required)" label="field.character_name">
        <Input />
      </FormField>,
    )
    await user.click(getByText('field.character_name'))
    expect(getByRole('textbox')).toHaveFocus()
  })

  it('renders the description and wires it into aria-describedby', () => {
    const { getByRole, getByText } = render(
      <FormField requiredLabel="(required)" label="field.name" description="field.name.help">
        <Input />
      </FormField>,
    )
    const input = getByRole('textbox')
    const help = getByText('field.name.help')
    expect(help).toBeInTheDocument()
    const describedBy = input.getAttribute('aria-describedby') ?? ''
    expect(describedBy.split(' ')).toContain(help.id)
  })

  it('with NO description/error sets no aria-describedby', () => {
    const { getByRole } = render(
      <FormField requiredLabel="(required)" label="field.name">
        <Input />
      </FormField>,
    )
    expect(getByRole('textbox')).not.toHaveAttribute('aria-describedby')
  })

  it('error: marks the control invalid AND describes it AND announces it (role=alert)', () => {
    const { getByRole } = render(
      <FormField requiredLabel="(required)" label="field.name" error="field.name.error">
        <Input />
      </FormField>,
    )
    const input = getByRole('textbox')
    // (a) aria-invalid — error implies invalid (default).
    expect(input).toHaveAttribute('aria-invalid', 'true')
    // (b) the danger-token border (the visual half of invalid).
    expect(input).toHaveClass('border-border-danger')
    // (c) the error region is announced.
    const alert = getByRole('alert')
    expect(alert).toHaveTextContent('field.name.error')
    // (d) the error region id is in aria-describedby.
    const describedBy = input.getAttribute('aria-describedby') ?? ''
    expect(describedBy.split(' ')).toContain(alert.id)
  })

  it('description AND error: both ids land in aria-describedby', () => {
    const { getByRole, getByText } = render(
      <FormField requiredLabel="(required)" label="field.name" description="field.name.help" error="field.name.error">
        <Input />
      </FormField>,
    )
    const input = getByRole('textbox')
    const help = getByText('field.name.help')
    const alert = getByRole('alert')
    const ids = (input.getAttribute('aria-describedby') ?? '').split(' ')
    expect(ids).toContain(help.id)
    expect(ids).toContain(alert.id)
  })

  it('no error region in the DOM when error is absent', () => {
    const { queryByRole } = render(
      <FormField requiredLabel="(required)" label="field.name" description="field.name.help">
        <Input />
      </FormField>,
    )
    expect(queryByRole('alert')).toBeNull()
  })

  it('required: flows to the control AND the label marker (non-color)', () => {
    const { getByRole, getByText } = render(
      <FormField requiredLabel="(required)" label="field.name" required>
        <Input />
      </FormField>,
    )
    // Control is natively required (→ aria-required).
    expect(getByRole('textbox')).toBeRequired()
    // The label conveys required textually too (SR-only word + visual star).
    const label = getByText('field.name').closest('label') as HTMLElement
    expect(label.textContent).toMatch(/required/i)
  })

  it('explicit invalid (no error string) still invalidates the control', () => {
    const { getByRole } = render(
      <FormField requiredLabel="(required)" label="field.name" invalid>
        <Input />
      </FormField>,
    )
    expect(getByRole('textbox')).toHaveAttribute('aria-invalid', 'true')
  })

  it('throws clearly when children is not a single valid element', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    expect(() =>
      render(<FormField requiredLabel="(required)" label="field.name">{'just a string'}</FormField>),
    ).toThrow(/single (valid )?(react )?element/i)
    spy.mockRestore()
  })

  it('forwards its ref to the wrapping container', () => {
    const ref = createRef<HTMLDivElement>()
    render(
      <FormField requiredLabel="(required)" ref={ref} label="field.name">
        <Input />
      </FormField>,
    )
    expect(ref.current).toBeInstanceOf(HTMLDivElement)
  })

  it('has no axe violations (default / described / error / required)', async () => {
    const { container } = render(
      <div>
        <FormField requiredLabel="(required)" label="field.a">
          <Input />
        </FormField>
        <FormField requiredLabel="(required)" label="field.b" description="field.b.help">
          <Input />
        </FormField>
        <FormField requiredLabel="(required)" label="field.c" error="field.c.error">
          <Input />
        </FormField>
        <FormField requiredLabel="(required)" label="field.d" required>
          <Input />
        </FormField>
      </div>,
    )
    expect(await axe(container)).toHaveNoViolations()
  })
})

describe('FormField (wrapping Select — a different control shape)', () => {
  it('associates the label with the Select trigger', () => {
    const { getByText, getByRole } = render(
      <FormField requiredLabel="(required)" label="field.race">
        <Select options={OPTIONS} placeholder="field.race.placeholder" />
      </FormField>,
    )
    const trigger = getByRole('combobox')
    const label = getByText('field.race').closest('label') as HTMLElement
    // The label's htmlFor points at the trigger's id.
    expect(label.getAttribute('for')).toBe(trigger.id)
  })

  it('error: wires aria-describedby + aria-invalid + role=alert onto the trigger', () => {
    const { getByRole } = render(
      <FormField requiredLabel="(required)" label="field.race" error="field.race.error">
        <Select options={OPTIONS} />
      </FormField>,
    )
    const trigger = getByRole('combobox')
    expect(trigger).toHaveAttribute('aria-invalid', 'true')
    const alert = getByRole('alert')
    const ids = (trigger.getAttribute('aria-describedby') ?? '').split(' ')
    expect(ids).toContain(alert.id)
  })

  it('description: wires aria-describedby onto the trigger', () => {
    const { getByRole, getByText } = render(
      <FormField requiredLabel="(required)" label="field.race" description="field.race.help">
        <Select options={OPTIONS} />
      </FormField>,
    )
    const trigger = getByRole('combobox')
    const help = getByText('field.race.help')
    const ids = (trigger.getAttribute('aria-describedby') ?? '').split(' ')
    expect(ids).toContain(help.id)
  })
})
