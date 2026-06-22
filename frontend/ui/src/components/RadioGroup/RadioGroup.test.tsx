import { describe, it, expect, vi } from 'vitest'
import { createRef, useState } from 'react'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { axe } from 'jest-axe'
import { RadioGroup, Radio } from './RadioGroup.tsx'

describe('RadioGroup / Radio', () => {
  it('renders a radiogroup with its radio options', () => {
    render(
      <RadioGroup>
        <Radio value="good" label="align.good" />
        <Radio value="neutral" label="align.neutral" />
        <Radio value="evil" label="align.evil" />
      </RadioGroup>,
    )
    expect(screen.getByRole('radiogroup')).toBeInTheDocument()
    expect(screen.getAllByRole('radio')).toHaveLength(3)
  })

  // KEYBOARD: arrow keys roam the group (moving focus from option to option),
  // Space commits the focused option — onChange gets the VALUE STRING (not a DOM
  // event). (Radix's roving-focus model moves focus on arrow and commits on
  // Space when the group starts pristine; the arrow-then-Space sequence is the
  // real keyboard path and exercises both the navigation and the neutral
  // callback.)
  it('keyboard: arrow keys move focus through the group, Space commits — onChange gets the value string', async () => {
    const onChange = vi.fn()
    const user = userEvent.setup()
    render(
      <RadioGroup onChange={onChange}>
        <Radio value="good" label="align.good" />
        <Radio value="neutral" label="align.neutral" />
        <Radio value="evil" label="align.evil" />
      </RadioGroup>,
    )
    const good = screen.getByRole('radio', { name: 'align.good' })
    const neutral = screen.getByRole('radio', { name: 'align.neutral' })
    good.focus()
    // ArrowDown roves focus from `good` to `neutral` within the group.
    await user.keyboard('{ArrowDown}')
    expect(neutral).toHaveFocus()
    // Space commits the focused option.
    await user.keyboard(' ')
    expect(onChange).toHaveBeenCalledWith('neutral')
    expect(typeof onChange.mock.calls[0]?.[0]).toBe('string')

    // One more arrow + Space moves to and commits `evil`.
    await user.keyboard('{ArrowDown} ')
    expect(onChange).toHaveBeenLastCalledWith('evil')
  })

  it('controlled: a state-bound onChange updates the checked option', async () => {
    const user = userEvent.setup()
    function Controlled() {
      const [v, setV] = useState('good')
      return (
        <RadioGroup value={v} onChange={setV}>
          <Radio value="good" label="align.good" />
          <Radio value="evil" label="align.evil" />
        </RadioGroup>
      )
    }
    render(<Controlled />)
    const good = screen.getByRole('radio', { name: 'align.good' })
    const evil = screen.getByRole('radio', { name: 'align.evil' })
    expect(good).toHaveAttribute('aria-checked', 'true')
    await user.click(evil)
    expect(evil).toHaveAttribute('aria-checked', 'true')
    expect(good).toHaveAttribute('aria-checked', 'false')
  })

  it('uncontrolled with defaultValue', () => {
    render(
      <RadioGroup defaultValue="neutral">
        <Radio value="good" label="align.good" />
        <Radio value="neutral" label="align.neutral" />
      </RadioGroup>,
    )
    expect(screen.getByRole('radio', { name: 'align.neutral' })).toHaveAttribute('aria-checked', 'true')
  })

  it('a disabled group blocks all selection', async () => {
    const onChange = vi.fn()
    const user = userEvent.setup()
    render(
      <RadioGroup disabled onChange={onChange}>
        <Radio value="good" label="align.good" />
        <Radio value="evil" label="align.evil" />
      </RadioGroup>,
    )
    const good = screen.getByRole('radio', { name: 'align.good' })
    expect(good).toBeDisabled()
    await user.click(good)
    expect(onChange).not.toHaveBeenCalled()
  })

  it('a single disabled option is skipped, others still work', async () => {
    const onChange = vi.fn()
    const user = userEvent.setup()
    render(
      <RadioGroup onChange={onChange}>
        <Radio value="good" label="align.good" disabled />
        <Radio value="evil" label="align.evil" />
      </RadioGroup>,
    )
    const good = screen.getByRole('radio', { name: 'align.good' })
    const evil = screen.getByRole('radio', { name: 'align.evil' })
    expect(good).toBeDisabled()
    await user.click(evil)
    expect(onChange).toHaveBeenCalledWith('evil')
  })

  it('the inline label selects the option when clicked', async () => {
    const onChange = vi.fn()
    const user = userEvent.setup()
    render(
      <RadioGroup onChange={onChange}>
        <Radio value="good" label="align.good" id="r-good" />
      </RadioGroup>,
    )
    await user.click(screen.getByText('align.good'))
    expect(onChange).toHaveBeenCalledWith('good')
  })

  it('each radio carries the theme-aware focus-ring classes', () => {
    render(
      <RadioGroup>
        <Radio value="good" label="align.good" />
      </RadioGroup>,
    )
    expect(screen.getByRole('radio')).toHaveClass(
      'focus-visible:outline-2',
      'focus-visible:outline-offset-2',
      'focus-visible:outline-accent',
    )
  })

  it('maps the group describedBy → aria-describedby on the radiogroup', () => {
    const { rerender } = render(
      <RadioGroup>
        <Radio value="good" label="align.good" />
      </RadioGroup>,
    )
    expect(screen.getByRole('radiogroup')).not.toHaveAttribute('aria-describedby')
    rerender(
      <RadioGroup describedBy="help-1 err-1">
        <Radio value="good" label="align.good" />
      </RadioGroup>,
    )
    expect(screen.getByRole('radiogroup')).toHaveAttribute('aria-describedby', 'help-1 err-1')
  })

  it('forwards refs to the group container and an item', () => {
    const groupRef = createRef<HTMLDivElement>()
    const itemRef = createRef<HTMLButtonElement>()
    render(
      <RadioGroup ref={groupRef}>
        <Radio ref={itemRef} value="good" label="align.good" />
      </RadioGroup>,
    )
    expect(groupRef.current).toBeInstanceOf(HTMLDivElement)
    expect(itemRef.current).toBeInstanceOf(HTMLButtonElement)
  })

  it('has no axe violations (labelled options / a disabled option)', async () => {
    const { container } = render(
      <fieldset>
        <legend>Alignment</legend>
        <RadioGroup defaultValue="good">
          <Radio value="good" label="align.good" id="ax-good" />
          <Radio value="neutral" label="align.neutral" id="ax-neutral" />
          <Radio value="evil" label="align.evil" id="ax-evil" disabled />
        </RadioGroup>
      </fieldset>,
    )
    expect(await axe(container)).toHaveNoViolations()
  })
})
