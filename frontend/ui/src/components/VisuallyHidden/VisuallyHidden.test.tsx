import { describe, it, expect } from 'vitest'
import { render } from '@testing-library/react'
import { axe } from 'jest-axe'
import { VisuallyHidden } from './VisuallyHidden.tsx'

describe('VisuallyHidden', () => {
  it('keeps its children in the accessibility tree (text present in the DOM)', () => {
    const { getByText } = render(<VisuallyHidden>screen-reader label</VisuallyHidden>)
    expect(getByText('screen-reader label')).toBeInTheDocument()
  })

  it('exposes its content as an accessible name when labelling a control', () => {
    const { getByRole } = render(
      <button type="button">
        <VisuallyHidden>Close dialog</VisuallyHidden>
      </button>,
    )
    expect(getByRole('button', { name: 'Close dialog' })).toBeInTheDocument()
  })

  it('has no axe violations', async () => {
    const { container } = render(
      <button type="button">
        <VisuallyHidden>Close</VisuallyHidden>
      </button>,
    )
    expect(await axe(container)).toHaveNoViolations()
  })
})
