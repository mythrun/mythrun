import { describe, it, expect, vi } from 'vitest'
import { createRef } from 'react'
import { render } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { axe } from 'jest-axe'
import { LevelCard } from './LevelCard.tsx'

describe('LevelCard', () => {
  it('renders the level number and the grant gloss', () => {
    const { getByText } = render(
      <LevelCard eyebrow="Level" level={3} grantGloss="Your subclass. 2nd-level spells." selected={false} onSelect={vi.fn()} />,
    )
    expect(getByText('3')).toBeInTheDocument()
    expect(getByText('Your subclass. 2nd-level spells.')).toBeInTheDocument()
  })

  it('exposes "Level N" as the accessible name (mono eyebrow + number)', () => {
    const { getByRole } = render(
      <LevelCard eyebrow="Level" level={3} grantGloss="Your subclass. 2nd-level spells." selected={false} onSelect={vi.fn()} />,
    )
    // The eyebrow word + the number read together as the button's name.
    expect(getByRole('button', { name: /Level\s*3/ })).toBeInTheDocument()
  })

  it('is a real <button> so keyboard activation works natively', () => {
    const { getByRole } = render(
      <LevelCard eyebrow="Level" level={1} grantGloss="Core class features." selected={false} onSelect={vi.fn()} />,
    )
    expect(getByRole('button').tagName).toBe('BUTTON')
  })

  it('fires onSelect on click', async () => {
    const onSelect = vi.fn()
    const user = userEvent.setup()
    const { getByRole } = render(
      <LevelCard eyebrow="Level" level={2} grantGloss="A second class feature." selected={false} onSelect={onSelect} />,
    )
    await user.click(getByRole('button'))
    expect(onSelect).toHaveBeenCalledOnce()
  })

  it('fires onSelect on keyboard activation (Enter)', async () => {
    const onSelect = vi.fn()
    const user = userEvent.setup()
    const { getByRole } = render(
      <LevelCard eyebrow="Level" level={2} grantGloss="A second class feature." selected={false} onSelect={onSelect} />,
    )
    getByRole('button').focus()
    await user.keyboard('{Enter}')
    expect(onSelect).toHaveBeenCalledOnce()
  })

  it('fires onSelect on keyboard activation (Space)', async () => {
    const onSelect = vi.fn()
    const user = userEvent.setup()
    const { getByRole } = render(
      <LevelCard eyebrow="Level" level={2} grantGloss="A second class feature." selected={false} onSelect={onSelect} />,
    )
    getByRole('button').focus()
    await user.keyboard(' ')
    expect(onSelect).toHaveBeenCalledOnce()
  })

  it('marks the SELECTED card via data-state + aria-pressed + the ember selection class', () => {
    const { getByRole } = render(
      <LevelCard eyebrow="Level" level={3} grantGloss="Your subclass." selected onSelect={vi.fn()} />,
    )
    const btn = getByRole('button')
    expect(btn).toHaveAttribute('data-state', 'selected')
    expect(btn).toHaveAttribute('aria-pressed', 'true')
    // Ember edge recolor (the shipped selection idiom) — asserting the class, not pixels.
    expect(btn.className).toContain('data-[state=selected]:border-accent')
  })

  it('marks the UNSELECTED card via data-state + aria-pressed', () => {
    const { getByRole } = render(
      <LevelCard eyebrow="Level" level={3} grantGloss="Your subclass." selected={false} onSelect={vi.fn()} />,
    )
    const btn = getByRole('button')
    expect(btn).toHaveAttribute('data-state', 'default')
    expect(btn).toHaveAttribute('aria-pressed', 'false')
  })

  // ux-run2 myth-nyjtl: accent means "chosen" and "act" only — the eyebrow rests
  // in muted ink and takes ember exclusively through the selected group state.
  it('mutes the eyebrow at rest and reserves ember for the selected card', () => {
    const { getByText } = render(
      <LevelCard eyebrow="Level" level={3} grantGloss="Your subclass." selected={false} onSelect={vi.fn()} />,
    )
    const eyebrow = getByText('Level')
    expect(eyebrow.className).toContain('text-ink-tertiary')
    expect(eyebrow.className).toContain('group-data-[state=selected]:text-accent-fg')
  })

  it('is flat 1-bit / square (0px radius, no circles)', () => {
    const { getByRole } = render(
      <LevelCard eyebrow="Level" level={4} grantGloss="First ASI or feat." selected={false} onSelect={vi.fn()} />,
    )
    expect(getByRole('button').className).toContain('rounded-none')
  })

  it('carries a data-testid + data-level on the root', () => {
    const { getByTestId } = render(
      <LevelCard eyebrow="Level" level={5} grantGloss="Extra Attack / 3rd-level spells." selected={false} onSelect={vi.fn()} />,
    )
    const root = getByTestId('level-card')
    expect(root).toHaveAttribute('data-level', '5')
  })

  it('forwards the ref to the button element', () => {
    const ref = createRef<HTMLButtonElement>()
    render(<LevelCard ref={ref} eyebrow="Level" level={1} grantGloss="Core class features." selected={false} onSelect={vi.fn()} />)
    expect(ref.current).toBeInstanceOf(HTMLButtonElement)
  })

  it('has no a11y violations (selected and unselected)', async () => {
    const unsel = render(
      <LevelCard eyebrow="Level" level={2} grantGloss="A second class feature." selected={false} onSelect={vi.fn()} />,
    )
    expect(await axe(unsel.container)).toHaveNoViolations()
    const sel = render(<LevelCard eyebrow="Level" level={3} grantGloss="Your subclass." selected onSelect={vi.fn()} />)
    expect(await axe(sel.container)).toHaveNoViolations()
  })
})
