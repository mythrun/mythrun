import { describe, it, expect } from 'vitest'
import { createRef } from 'react'
import { render } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { axe } from 'jest-axe'
import { SituationRecap } from './SituationRecap.tsx'
import type { SituationRecapProps } from '@mythrun/client-core/contract'

// The opening-situation recap card (MYT-102): a mono eyebrow over the serif
// title + location, then the scene prose. Long prose gains a narrow-viewport
// clamp + a quiet internal disclosure toggle; short prose renders whole with no
// toggle. Eyebrow is resolved chrome; title/locationName/prose are LLM DATA.

const SHORT_PROSE = 'A skiff has come in wrong, riding low.'
// Comfortably past the collapse threshold (240 chars).
const LONG_PROSE =
  'A skiff has come in wrong, riding low with no one at the tiller. The harbourmaster has cleared the quay and stands alone at the bollard, rope in hand, watching the boat drift closer. ' +
  'Gulls have gone quiet. Someone will have to board her, and the tide gives you an hour at most before she is carried back out past the bar.'

const props = (overrides: Partial<SituationRecapProps> = {}): SituationRecapProps => ({
  eyebrow: 'Your opening scene',
  title: 'The harbour at low tide',
  locationName: 'Ashfen Reach',
  prose: SHORT_PROSE,
  ...overrides,
})

describe('SituationRecap', () => {
  it('renders the eyebrow, title, location name, and prose', () => {
    const { getByText, getByTestId } = render(<SituationRecap {...props()} />)
    expect(getByText('Your opening scene')).toBeInTheDocument()
    expect(getByText('The harbour at low tide')).toBeInTheDocument()
    expect(getByText(/Ashfen Reach/)).toBeInTheDocument()
    expect(getByTestId('situation-recap-prose').textContent).toBe(SHORT_PROSE)
  })

  it('shows NO disclosure toggle (and no clamp) for short prose', () => {
    const { queryByTestId, getByTestId } = render(<SituationRecap {...props()} />)
    expect(queryByTestId('situation-recap-toggle')).toBeNull()
    expect(getByTestId('situation-recap-prose').className).not.toContain('line-clamp')
  })

  it('clamps long prose on narrow (max-sm) and offers the disclosure toggle, collapsed', () => {
    const { getByTestId } = render(<SituationRecap {...props({ prose: LONG_PROSE })} />)
    expect(getByTestId('situation-recap-prose').className).toContain('max-sm:line-clamp-3')
    const toggle = getByTestId('situation-recap-toggle')
    expect(toggle).toHaveAttribute('aria-expanded', 'false')
    // WAI-ARIA disclosure: the toggle controls the (always-rendered) prose region.
    expect(toggle.getAttribute('aria-controls')).toBe(getByTestId('situation-recap-prose').id)
  })

  it('expands on toggle press (clamp lifted, aria-expanded true) and collapses again', async () => {
    const user = userEvent.setup()
    const { getByTestId } = render(<SituationRecap {...props({ prose: LONG_PROSE })} />)
    const toggle = getByTestId('situation-recap-toggle')

    await user.click(toggle)
    expect(toggle).toHaveAttribute('aria-expanded', 'true')
    expect(getByTestId('situation-recap-prose').className).not.toContain('line-clamp')

    await user.click(toggle)
    expect(toggle).toHaveAttribute('aria-expanded', 'false')
    expect(getByTestId('situation-recap-prose').className).toContain('max-sm:line-clamp-3')
  })

  it('keeps the full prose in the DOM while clamped (the clamp is visual only)', () => {
    const { getByTestId } = render(<SituationRecap {...props({ prose: LONG_PROSE })} />)
    expect(getByTestId('situation-recap-prose').textContent).toBe(LONG_PROSE)
  })

  it('is flat 1-bit / square: the card carries rounded-none', () => {
    const { getByTestId } = render(<SituationRecap {...props()} />)
    expect(getByTestId('situation-recap').className).toContain('rounded-none')
  })

  it('forwards the ref to the card element', () => {
    const ref = createRef<HTMLDivElement>()
    render(<SituationRecap ref={ref} {...props()} />)
    expect(ref.current).toBeInstanceOf(HTMLDivElement)
  })

  it('has no a11y violations (short, long collapsed, long expanded)', async () => {
    const user = userEvent.setup()
    const short = render(<SituationRecap {...props()} />)
    expect(await axe(short.container)).toHaveNoViolations()
    short.unmount()

    const long = render(<SituationRecap {...props({ prose: LONG_PROSE })} />)
    expect(await axe(long.container)).toHaveNoViolations()
    await user.click(long.getByTestId('situation-recap-toggle'))
    expect(await axe(long.container)).toHaveNoViolations()
  })
})
