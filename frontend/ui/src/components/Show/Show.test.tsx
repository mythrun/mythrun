import { describe, it, expect } from 'vitest'
import { createRef } from 'react'
import { render } from '@testing-library/react'
import { axe } from 'jest-axe'
import { Show } from './Show.tsx'

// Show — the responsive show/hide primitive (MYT-87 T15). A breakpoint SWITCH:
// `above` shows its children only at/above a breakpoint (hidden below); `below`
// shows them only below it (hidden at/above). jsdom has no layout, so these
// assert the responsive Tailwind classes — the contract that decides which slot
// is visible. (The hub composes two: a desktop grid `above` ⊕ a mobile index
// `below`.)

describe('Show', () => {
  it('renders children hidden below the breakpoint, shown at/above (above="sm")', () => {
    const { getByTestId } = render(
      <Show above="sm" data-testid="show">
        body
      </Show>,
    )
    const el = getByTestId('show')
    expect(el.tagName).toBe('DIV')
    expect(el.classList.contains('hidden')).toBe(true)
    expect(el.classList.contains('sm:block')).toBe(true)
    expect(el.textContent).toBe('body')
  })

  it('renders children shown below the breakpoint, hidden at/above (below="sm")', () => {
    const { getByTestId } = render(
      <Show below="sm" data-testid="show">
        body
      </Show>,
    )
    const el = getByTestId('show')
    expect(el.classList.contains('block')).toBe(true)
    expect(el.classList.contains('sm:hidden')).toBe(true)
  })

  it.each(['sm', 'md', 'lg', 'xl', '2xl'] as const)(
    'emits a full literal class pair for the %s breakpoint (above + below)',
    (bp) => {
      const above = render(
        <Show above={bp} data-testid="a">
          x
        </Show>,
      )
      expect(above.getByTestId('a').className).toBe(`hidden ${bp}:block`)
      above.unmount()
      const below = render(
        <Show below={bp} data-testid="b">
          x
        </Show>,
      )
      expect(below.getByTestId('b').className).toBe(`block ${bp}:hidden`)
    },
  )

  it('forwards its ref to the underlying div', () => {
    const ref = createRef<HTMLDivElement>()
    render(
      <Show above="md" ref={ref}>
        x
      </Show>,
    )
    expect(ref.current).toBeInstanceOf(HTMLDivElement)
  })

  it('has no axe violations', async () => {
    const { container } = render(
      <Show below="lg">
        <span>visible</span>
      </Show>,
    )
    expect(await axe(container)).toHaveNoViolations()
  })
})
