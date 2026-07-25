import { describe, it, expect } from 'vitest'
import { render, screen } from '@testing-library/react'
import { axe } from 'jest-axe'
import { TableTalk } from './TableTalk.tsx'
import { PlayerMessage } from '../PlayerMessage/PlayerMessage.tsx'
import { DmMessage } from '../DmMessage/DmMessage.tsx'

// TableTalk (myth-1msig) — the marked OOC exchange frame in the live transcript.
// Load-bearing invariants pinned here: the frame marks the START of the aside (a
// terse mono eyebrow + a ruled edge), so the boundary never rides on the answer's
// closing pleasantry alone; the rows INSIDE keep their own registers (the
// question in the players' mono, the answer in the DM's serif — the boundary
// lives on the frame, not the faces); it is a `note` annotation to AT; and it is
// square 1-bit register (rounded-none, no circles).

const LABEL = 'Table talk'
const QUESTION = '@dm what does the brass key open?'
const ANSWER = 'Not common knowledge at your tier. Back to you.'

function renderExchange() {
  return render(
    <TableTalk label={LABEL}>
      <PlayerMessage displayName="Dev User 1" characterName="Corin Vale" text={QUESTION} pending={false} />
      <DmMessage text={ANSWER} streaming={false} />
    </TableTalk>,
  )
}

describe('TableTalk', () => {
  it('renders the eyebrow and the framed exchange rows', () => {
    renderExchange()
    expect(screen.getByText(LABEL)).toBeInTheDocument()
    expect(screen.getByText(QUESTION)).toBeInTheDocument()
    expect(screen.getByText(ANSWER)).toBeInTheDocument()
  })

  it('is a `note` annotation to assistive tech — table talk, not narration', () => {
    renderExchange()
    const note = screen.getByRole('note')
    expect(note).toHaveAttribute('data-table-talk')
  })

  it('marks the START of the aside: the eyebrow precedes the framed rows', () => {
    const { container } = renderExchange()
    const frame = container.querySelector('[data-table-talk]')
    expect(frame?.firstElementChild).toHaveTextContent(LABEL)
  })

  it('keeps the square 1-bit register with a ruled left edge (no circles)', () => {
    const { container } = renderExchange()
    const frame = container.querySelector('[data-table-talk]')
    expect(frame).toHaveClass('rounded-none', 'border-l-2')
    expect(container.querySelector('.rounded-full')).toBeNull()
  })

  it('has no axe violations', async () => {
    const { container } = renderExchange()
    expect(await axe(container)).toHaveNoViolations()
  })
})
