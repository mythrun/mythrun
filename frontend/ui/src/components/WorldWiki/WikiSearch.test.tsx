import { describe, expect, it, vi } from 'vitest'
import { render } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { axe } from 'jest-axe'
import { WikiSearch } from './WikiSearch.tsx'

// WikiSearch is the wiki's filter control — a body-scale borderless field. These
// tests pin the load-bearing contract: the label names the field (WCAG 3.3.2),
// the neutral onChange hands back a plain string, the placeholder is the hint
// (never the accessible name), and the specimen is axe-clean.

function renderSearch(overrides: Partial<React.ComponentProps<typeof WikiSearch>> = {}) {
  return render(
    <WikiSearch label="Explore your world" value="" onChange={vi.fn()} placeholder="Search" {...overrides} />,
  )
}

describe('WikiSearch', () => {
  it('names the field by its label (WCAG 3.3.2, label↔field association)', () => {
    const { getByRole } = renderSearch()
    expect(getByRole('textbox', { name: 'Explore your world' })).toBeInTheDocument()
  })

  it('shows the placeholder as a hint, not as the accessible name', () => {
    const { getByRole, queryByRole } = renderSearch()
    // The accessible name is the label, not the placeholder.
    expect(queryByRole('textbox', { name: 'Search' })).toBeNull()
    expect(getByRole('textbox', { name: 'Explore your world' })).toHaveAttribute('placeholder', 'Search')
  })

  it('reflects the controlled value', () => {
    const { getByRole } = renderSearch({ value: 'ward' })
    expect(getByRole('textbox', { name: 'Explore your world' })).toHaveValue('ward')
  })

  it('calls onChange with a plain string (never the DOM event)', async () => {
    const onChange = vi.fn()
    const user = userEvent.setup()
    const { getByRole } = renderSearch({ onChange })
    await user.type(getByRole('textbox', { name: 'Explore your world' }), 'a')
    expect(onChange).toHaveBeenCalledWith('a')
  })

  it('has no a11y violations', async () => {
    const { container } = renderSearch()
    expect(await axe(container)).toHaveNoViolations()
  })
})
