import { describe, expect, it, vi } from 'vitest'
import { render } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { axe } from 'jest-axe'
import { WikiViewSwitch } from './WikiViewSwitch.tsx'

// WikiViewSwitch is the wiki's Index ⇄ Glossary segmented switch — two toggle
// buttons, each self-naming (no group label), the active one aria-pressed.

function renderSwitch(overrides: Partial<React.ComponentProps<typeof WikiViewSwitch>> = {}) {
  return render(
    <WikiViewSwitch value="index" onChange={vi.fn()} indexLabel="Index" glossaryLabel="Glossary" {...overrides} />,
  )
}

describe('WikiViewSwitch', () => {
  it('marks the active segment with aria-pressed (and the other idle)', () => {
    const { getByRole } = renderSwitch({ value: 'index' })
    expect(getByRole('button', { name: 'Index' })).toHaveAttribute('aria-pressed', 'true')
    expect(getByRole('button', { name: 'Glossary' })).toHaveAttribute('aria-pressed', 'false')
  })

  it('reports the glossary view when its segment is clicked', async () => {
    const onChange = vi.fn()
    const user = userEvent.setup()
    const { getByRole } = renderSwitch({ value: 'index', onChange })
    await user.click(getByRole('button', { name: 'Glossary' }))
    expect(onChange).toHaveBeenCalledExactlyOnceWith('glossary')
  })

  it('reports the index view from the glossary segment (activation is keyboard-operable)', async () => {
    const onChange = vi.fn()
    const user = userEvent.setup()
    const { getByRole } = renderSwitch({ value: 'glossary', onChange })
    getByRole('button', { name: 'Index' }).focus()
    await user.keyboard('{Enter}')
    expect(onChange).toHaveBeenCalledExactlyOnceWith('index')
  })

  it('has no a11y violations', async () => {
    const { container } = renderSwitch()
    expect(await axe(container)).toHaveNoViolations()
  })
})
