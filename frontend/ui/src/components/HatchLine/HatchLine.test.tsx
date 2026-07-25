import { describe, it, expect, vi } from 'vitest'
import { render } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { axe } from 'jest-axe'
import { HatchLine } from './HatchLine.tsx'

// HatchLine — the flow escape-hatch line (ux-run2 myth-vjl7d): a quiet framing
// prompt + an ACTIONABLE phrase with a real link affordance (persistent
// underline + accent) that is a native button firing the neutral onPress.
describe('HatchLine', () => {
  it('renders the prompt as quiet chrome and the action as a pressable button', () => {
    const { getByRole, getByText } = render(
      <HatchLine prompt="Feeling constrained?" action="Describe your world yourself." onPress={vi.fn()} />,
    )
    expect(getByText(/Feeling constrained\?/)).toBeInTheDocument()
    const action = getByRole('button', { name: 'Describe your world yourself.' })
    expect(action.tagName).toBe('BUTTON')
  })

  it('the action carries a persistent underline + accent (link affordance at rest)', () => {
    const { getByRole } = render(<HatchLine action="Write your own." onPress={vi.fn()} />)
    const action = getByRole('button')
    // The underline IS the affordance — always on, not hover-only (the run-2
    // player never read the bare-text hatch as pressable).
    expect(action).toHaveClass('underline', 'text-accent-fg')
    // Shared DS focus ring.
    expect(action).toHaveClass(
      'focus-visible:outline-2',
      'focus-visible:outline-offset-2',
      'focus-visible:outline-accent-fg',
    )
  })

  it('fires onPress on activation', async () => {
    const onPress = vi.fn()
    const user = userEvent.setup()
    const { getByRole } = render(
      <HatchLine prompt="Feeling constrained?" action="Describe it yourself." onPress={onPress} />,
    )
    await user.click(getByRole('button'))
    expect(onPress).toHaveBeenCalledTimes(1)
  })

  it('omits the prompt cleanly when not given (all-action hatch)', () => {
    const { container, getByRole } = render(<HatchLine action="Start somewhere else." onPress={vi.fn()} />)
    expect(getByRole('button', { name: 'Start somewhere else.' })).toBeInTheDocument()
    expect(container.textContent).toBe('Start somewhere else.')
  })

  it('spreads data-testid on the line for presence queries', () => {
    const { getByTestId } = render(
      <HatchLine data-testid="guided-switch" action="Describe it yourself." onPress={vi.fn()} />,
    )
    expect(getByTestId('guided-switch').tagName).toBe('P')
  })

  it('has no axe violations', async () => {
    const { container } = render(
      <HatchLine prompt="Feeling constrained?" action="Describe your world yourself." onPress={vi.fn()} />,
    )
    expect(await axe(container)).toHaveNoViolations()
  })
})
