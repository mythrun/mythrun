import { describe, it, expect } from 'vitest'
import { createRef } from 'react'
import { render } from '@testing-library/react'
import { axe } from 'jest-axe'
import { Label } from './Label.tsx'

describe('Label', () => {
  it('renders a native <label> with its text', () => {
    const { getByText } = render(<Label>field.name</Label>)
    const el = getByText('field.name')
    expect(el.tagName).toBe('LABEL')
  })

  it('binds to a control via htmlFor', () => {
    const { getByText } = render(<Label htmlFor="ctl-1">field.name</Label>)
    expect(getByText('field.name')).toHaveAttribute('for', 'ctl-1')
  })

  it('carries the ui-label type role classes (mono / uppercase / tracked)', () => {
    const { getByText } = render(<Label htmlFor="x">field.name</Label>)
    expect(getByText('field.name')).toHaveClass('font-ui', 'uppercase', 'tracking-wide')
  })

  it('renders NO required marker by default', () => {
    const { queryByText } = render(<Label htmlFor="x">field.name</Label>)
    expect(queryByText('*')).toBeNull()
  })

  it('renders a required marker that carries meaning to AT (not color alone)', () => {
    const { getByText } = render(
      <Label htmlFor="x" required>
        field.name
      </Label>,
    )
    // A visible marker ("*") is present...
    const marker = getByText('*')
    expect(marker).toBeInTheDocument()
    // ...and the relationship is conveyed non-visually: the label exposes the
    // accessible word "required" (an aria-hidden visual star + an SR-only word).
    const label = getByText('field.name').closest('label') as HTMLElement
    expect(label.textContent).toMatch(/required/i)
    expect(marker).toHaveAttribute('aria-hidden', 'true')
  })

  it('forwards its ref to the underlying <label>', () => {
    const ref = createRef<HTMLLabelElement>()
    render(<Label ref={ref}>field.name</Label>)
    expect(ref.current).toBeInstanceOf(HTMLLabelElement)
  })

  it('has no axe violations (bound to a real control)', async () => {
    const { container } = render(
      <div>
        <Label htmlFor="axe-input" required>
          field.name
        </Label>
        <input id="axe-input" />
      </div>,
    )
    expect(await axe(container)).toHaveNoViolations()
  })
})
