import { describe, expect, it } from 'vitest'
import { render } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { axe } from 'jest-axe'
import { WikiGlossary } from './WikiGlossary.tsx'

// WikiGlossary is the collapsible vocabulary list: term summaries over
// disclosed-on-demand definitions, built on native <details>/<summary>.

const GLOSSARY = [
  { term: 'ashfen', definition: 'what the ashfen itself is' },
  { term: 'lampblack', definition: 'what lampblack means here' },
] as const

describe('WikiGlossary', () => {
  it('renders every term and its definition', () => {
    const { getByText } = render(<WikiGlossary glossary={GLOSSARY} />)
    for (const term of ['ashfen', 'lampblack']) {
      expect(getByText(term)).toBeInTheDocument()
    }
    expect(getByText('what lampblack means here')).toBeInTheDocument()
  })

  it('collapses every definition by default (details closed)', () => {
    const { container } = render(<WikiGlossary glossary={GLOSSARY} />)
    const rows = container.querySelectorAll('details')
    expect(rows).toHaveLength(2)
    for (const row of rows) expect(row.open).toBe(false)
  })

  it('discloses a definition on term activation, and folds it back', async () => {
    const user = userEvent.setup()
    const { getByText } = render(<WikiGlossary glossary={GLOSSARY} />)
    const term = getByText('ashfen')
    const details = term.closest('details')
    if (details === null) throw new Error('glossary term is not inside a <details>')
    // Collapsed at first paint; a click on the term (inside the summary) toggles.
    expect(details.open).toBe(false)
    await user.click(term)
    expect(details.open).toBe(true)
    await user.click(term)
    expect(details.open).toBe(false)
  })

  it('has no a11y violations', async () => {
    const { container } = render(<WikiGlossary glossary={GLOSSARY} />)
    expect(await axe(container)).toHaveNoViolations()
  })
})
