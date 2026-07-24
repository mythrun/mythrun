import { describe, expect, it, vi } from 'vitest'
import { render } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { axe } from 'jest-axe'
import { ResizeHandle } from './ResizeHandle.tsx'

// ResizeHandle is the window-splitter divider: a focusable role="separator" with
// aria-valuenow/min/max, arrow-key nudging, and Home/End to the clamps.

function renderHandle(overrides: Partial<React.ComponentProps<typeof ResizeHandle>> = {}) {
  return render(
    <ResizeHandle value={340} min={240} max={520} onChange={vi.fn()} edge="leading" label="Resize the wiki" {...overrides} />,
  )
}

describe('ResizeHandle', () => {
  it('exposes the splitter role + value range to assistive tech', () => {
    const { getByRole } = renderHandle()
    const sep = getByRole('separator', { name: 'Resize the wiki' })
    expect(sep).toHaveAttribute('aria-orientation', 'vertical')
    expect(sep).toHaveAttribute('aria-valuenow', '340')
    expect(sep).toHaveAttribute('aria-valuemin', '240')
    expect(sep).toHaveAttribute('aria-valuemax', '520')
    expect(sep).toHaveAttribute('tabindex', '0')
  })

  it('widens a leading handle on ArrowLeft and narrows on ArrowRight', async () => {
    const onChange = vi.fn()
    const user = userEvent.setup()
    const { getByRole } = renderHandle({ onChange, step: 20 })
    getByRole('separator').focus()
    await user.keyboard('{ArrowLeft}')
    expect(onChange).toHaveBeenLastCalledWith(360) // 340 + 20 (leading widens leftward)
    await user.keyboard('{ArrowRight}')
    expect(onChange).toHaveBeenLastCalledWith(320) // 340 − 20
  })

  it('clamps to the floor and ceiling (and Home/End jump to them)', async () => {
    const onChange = vi.fn()
    const user = userEvent.setup()
    const { getByRole } = renderHandle({ onChange, value: 250, step: 100 })
    getByRole('separator').focus()
    await user.keyboard('{ArrowRight}') // 250 − 100 = 150 → clamped to min 240
    expect(onChange).toHaveBeenLastCalledWith(240)
    await user.keyboard('{Home}')
    expect(onChange).toHaveBeenLastCalledWith(240)
    await user.keyboard('{End}')
    expect(onChange).toHaveBeenLastCalledWith(520)
  })

  it('has no a11y violations', async () => {
    const { container } = renderHandle()
    expect(await axe(container)).toHaveNoViolations()
  })
})
