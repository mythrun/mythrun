import { describe, it, expect } from 'vitest'
import { render, screen } from '@testing-library/react'
import { axe } from 'jest-axe'
import { DmCorrection } from './DmCorrection.tsx'

// DmCorrection (myth-d6knq) — the DM errata slip. Load-bearing invariants pinned
// here: it is SET APART from narration (the machine face + a ruled ink left margin,
// never the serif DM lift); it renders the amendment text + a terse eyebrow; it is
// square 1-bit register (rounded-none, no circles / badges); it is a `note`
// annotation to AT; it stays quiet (muted-but-AA ink); and it wraps a long
// amendment inside a narrow column (min-w-0 / break-words) so ~375px never spills.

const LABEL = 'Correction'
const TEXT = 'Earlier I said the gate was oak — it is iron, banded and cold.'

function renderCorrection(overrides: { text?: string; label?: string } = {}) {
  const { text = TEXT, label = LABEL } = overrides
  return render(<DmCorrection text={text} label={label} />)
}

describe('DmCorrection', () => {
  it('renders the amendment text and the terse errata eyebrow', () => {
    renderCorrection()
    expect(screen.getByText(TEXT)).toBeInTheDocument()
    expect(screen.getByText(LABEL)).toBeInTheDocument()
  })

  it('is a `note` annotation to assistive tech — an amendment to the record, not narration', () => {
    renderCorrection()
    const note = screen.getByRole('note')
    expect(note).toHaveAttribute('data-dm-correction')
    // The whole amendment is inside the note, so AT reads it as one annotated unit.
    expect(note).toHaveTextContent(TEXT)
    expect(note).toHaveTextContent(LABEL)
  })

  it('carries the MACHINE face on both the eyebrow and the body — set apart from serif narration', () => {
    renderCorrection()
    expect(screen.getByText(LABEL)).toHaveClass('font-ui')
    expect(screen.getByText(TEXT)).toHaveClass('font-ui')
    // Neither line is the serif prose register the DM narrates in.
    expect(screen.getByText(TEXT)).not.toHaveClass('font-body')
  })

  it('is set apart by a ruled INK left margin (the ledger-margin note), unfilled — off the DM lift', () => {
    const { container } = renderCorrection()
    const note = container.querySelector('[data-dm-correction]')
    expect(note?.className).toMatch(/border-l-2/)
    expect(note?.className).toMatch(/border-l-ink/)
    // Not the DM narrative register's warm paper lift.
    expect(note?.className).not.toMatch(/bg-surface/)
  })

  it('reads quietly — muted-but-AA ink, never a loud/coloured alarm', () => {
    renderCorrection()
    expect(screen.getByText(TEXT)).toHaveClass('text-ink-secondary')
    expect(screen.getByText(LABEL)).toHaveClass('text-ink-secondary')
  })

  it('is square register — rounded-none, no circles', () => {
    const { container } = renderCorrection()
    expect(container.querySelector('.rounded-full')).toBeNull()
    expect(container.querySelector('[data-dm-correction]')).toHaveClass('rounded-none')
  })

  it('wraps a long amendment inside a narrow column (min-w-0 / break-words) — no ~375px spill', () => {
    const { container } = renderCorrection({
      text: 'Correction: the caravan-master is Halden-of-Westreach-by-the-Kingsroad, not Holden.',
    })
    const note = container.querySelector('[data-dm-correction]')
    expect(note?.className).toMatch(/min-w-0/)
    expect(screen.getByText(/Halden-of-Westreach/)).toHaveClass('break-words')
  })

  it('has no axe violations', async () => {
    const { container } = renderCorrection()
    expect(await axe(container)).toHaveNoViolations()
  })
})
