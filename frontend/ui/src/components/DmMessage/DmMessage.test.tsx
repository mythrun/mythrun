import { describe, it, expect, vi } from 'vitest'
import { createRef } from 'react'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { axe } from 'jest-axe'
import type { DmMessageProps, EntityCard, EntityIndex, ProseSegment } from '@mythrun/client-core/contract'
import { DmMessage } from './DmMessage.tsx'
import { TYPE_ROLE_CLASS } from '../../lib/typography.ts'

// Behavior-tested with RTL + jest-dom (jsdom does not compute Tailwind styles,
// so the applied token classes are the observable contract). DmMessage is a THIN
// wrapper: it fixes the DM register (Source Serif 4 prose on a quiet paper tint)
// over the shipped StreamingProse and does NOT re-implement the caret. The
// load-bearing invariants: the prose renders in the `prose-body` serif role
// (byte-identical to a settled `<Text role="prose-body">` — the zero-reflow
// handoff StreamingProse guarantees), the DM row carries its distinct paper
// tint, and `streaming` drives StreamingProse's writing caret + SR annotation.

describe('DmMessage', () => {
  it('renders the DM prose in a serif prose-body <p>', () => {
    const { container } = render(<DmMessage text="A quiet valley." streaming={false} />)
    const p = container.querySelector('p')
    expect(p).not.toBeNull()
    expect(p).toHaveTextContent('A quiet valley.')
    // Serif narrative register — the same prose-body role classes StreamingProse
    // applies, so the streaming→settled handoff never reflows.
    expect(p).toHaveClass(...TYPE_ROLE_CLASS['prose-body'].split(' '))
  })

  it('sits on the DM paper tint (the distinct narrative surface)', () => {
    const { container } = render(<DmMessage text="A quiet valley." streaming={false} />)
    const row = container.querySelector('[data-dm-message]')
    expect(row).not.toBeNull()
    // The narrative register: a quiet warm paper lift (bg-surface), distinct from
    // the player row's tint. A utility (not a frozen var), so it flips under .dark.
    expect(row).toHaveClass('bg-surface')
  })

  it('shows the writing caret while streaming', () => {
    const { container } = render(<DmMessage text="A quiet" streaming />)
    const caret = container.querySelector('[data-streaming-caret]')
    expect(caret).not.toBeNull()
    expect(caret).toHaveAttribute('aria-hidden', 'true')
    // The passage announces in-progress to AT.
    expect(container.querySelector('p')).toHaveAttribute('aria-busy', 'true')
  })

  it('drops the caret and busy state when the turn settles', () => {
    const { container } = render(<DmMessage text="A quiet valley." streaming={false} />)
    expect(container.querySelector('[data-streaming-caret]')).toBeNull()
    expect(container.querySelector('p')).not.toHaveAttribute('aria-busy')
  })

  it('announces the writingLabel to AT only while streaming', () => {
    const { queryByText, rerender } = render(
      <DmMessage text="A qui" streaming writingLabel="DM is writing" />,
    )
    expect(queryByText('DM is writing')).not.toBeNull()
    rerender(<DmMessage text="A quiet valley." streaming={false} writingLabel="DM is writing" />)
    expect(queryByText('DM is writing')).toBeNull()
  })

  it('forwards its ref to the DM row element', () => {
    const ref = createRef<HTMLDivElement>()
    render(<DmMessage ref={ref} text="x" streaming={false} />)
    expect(ref.current).toBeInstanceOf(HTMLDivElement)
    expect(ref.current).toHaveAttribute('data-dm-message')
  })

  it('has no axe violations, streaming and settled', async () => {
    const streaming = render(<DmMessage text="A qui" streaming writingLabel="DM is writing" />)
    expect(await axe(streaming.container)).toHaveNoViolations()
    const settled = render(<DmMessage text="A quiet valley." streaming={false} />)
    expect(await axe(settled.container)).toHaveNoViolations()
  })
})

// ── MYT-94 (Task 11) — settled-prose entity highlighting ─────────────────────────
// The highlight seam is append-only + settle-only: when `highlight` + `highlightLabels`
// are present AND the turn has settled, recognized entity names become mentions →
// popovers. While streaming (or with no highlight) the row is byte-identical to MYT-92.

const CARDS: Record<string, EntityCard> = {
  e1: { entityId: 'e1', name: 'Elenya', glyph: 'npc', leadLine: 'A quiet herbalist.' },
  e2: { entityId: 'e2', name: 'Highreach', glyph: 'location', leadLine: 'A cliff town.' },
}

// "Elenya walked to Highreach." pre-segmented (the matcher is Task 3's concern; here we
// pin RENDERING of a fixed segment run).
const SEGMENTS: ProseSegment[] = [
  { kind: 'entity', text: 'Elenya', entityId: 'e1', glyph: 'npc' },
  { kind: 'text', text: ' walked to ' },
  { kind: 'entity', text: 'Highreach', entityId: 'e2', glyph: 'location' },
  { kind: 'text', text: '.' },
]

const HL_TEXT = 'Elenya walked to Highreach.'

/** A mock EntityIndex returning fixed segments/cards. The `segment` spy is returned as a
 *  standalone reference (not `index.segment`) so call-count assertions do not trip the
 *  unbound-method rule — tests can pin the once-per-settled-row memoization directly. */
function mockIndex(segments: ProseSegment[] = SEGMENTS) {
  const segment = vi.fn(() => segments)
  const index: EntityIndex = { segment, card: (id: string) => CARDS[id] ?? null }
  return { index, segment }
}

const LABELS: NonNullable<DmMessageProps['highlightLabels']> = {
  mentionLabelFor: (name) => `entity: ${name}`,
  typeLabelFor: (glyph) => `type: ${glyph}`,
  openInWikiLabel: 'Open in wiki',
}

describe('DmMessage — settled entity highlighting (MYT-94)', () => {
  it('does NOT highlight while streaming, even when highlight is present (no mid-stream reflow)', () => {
    const { index, segment } = mockIndex()
    render(<DmMessage text={HL_TEXT} streaming highlight={index} highlightLabels={LABELS} />)
    // Streaming path = StreamingProse (caret present), never a mention button.
    expect(screen.queryByRole('button', { name: 'entity: Elenya' })).toBeNull()
    expect(segment).not.toHaveBeenCalled()
  })

  it('renders a streaming row byte-identical with and without highlight (streaming path unchanged)', () => {
    const withoutHl = render(<DmMessage text={HL_TEXT} streaming writingLabel="writing" />)
    const withHl = render(
      <DmMessage text={HL_TEXT} streaming writingLabel="writing" highlight={mockIndex().index} highlightLabels={LABELS} />,
    )
    expect(withHl.container.innerHTML).toBe(withoutHl.container.innerHTML)
  })

  it('highlights recognized entity names in settled prose, plain text between them', () => {
    const { container } = render(
      <DmMessage text={HL_TEXT} streaming={false} highlight={mockIndex().index} highlightLabels={LABELS} />,
    )
    // Both entity segments become mention buttons; the join text is present verbatim.
    expect(screen.getByRole('button', { name: 'entity: Elenya' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'entity: Highreach' })).toBeInTheDocument()
    const p = container.querySelector('p')
    expect(p).toHaveTextContent('Elenya walked to Highreach.')
    // Zero-reflow pin: the highlighted paragraph carries the SAME prose-body role classes
    // as StreamingProse's settled output, so the stream→settle handoff never reflows.
    expect(p).toHaveClass(...TYPE_ROLE_CLASS['prose-body'].split(' '))
  })

  it('renders plain settled prose when no highlight is supplied (MYT-92 back-compat)', () => {
    const { container } = render(<DmMessage text={HL_TEXT} streaming={false} />)
    expect(screen.queryByRole('button')).toBeNull()
    expect(container.querySelector('p')).toHaveTextContent(HL_TEXT)
  })

  it('falls back to plain prose when highlight is present but labels are missing (graceful)', () => {
    render(<DmMessage text={HL_TEXT} streaming={false} highlight={mockIndex().index} />)
    expect(screen.queryByRole('button', { name: 'entity: Elenya' })).toBeNull()
  })

  it('segments ONCE per settled row — a re-render with identical text does not re-segment', () => {
    const { index, segment } = mockIndex()
    const { rerender } = render(
      <DmMessage text={HL_TEXT} streaming={false} highlight={index} highlightLabels={LABELS} />,
    )
    expect(segment).toHaveBeenCalledTimes(1)
    rerender(<DmMessage text={HL_TEXT} streaming={false} highlight={index} highlightLabels={LABELS} />)
    // useMemo keyed on the stable settled text → no recompute.
    expect(segment).toHaveBeenCalledTimes(1)
  })

  it('opens a mention popover and fires onEntityOpen from its open-in-wiki action', async () => {
    const user = userEvent.setup()
    const onEntityOpen = vi.fn()
    render(
      <DmMessage
        text={HL_TEXT}
        streaming={false}
        highlight={mockIndex().index}
        highlightLabels={LABELS}
        onEntityOpen={onEntityOpen}
      />,
    )
    await user.click(screen.getByRole('button', { name: 'entity: Elenya' }))
    await user.click(screen.getByRole('button', { name: 'Open in wiki' }))
    expect(onEntityOpen).toHaveBeenCalledWith('e1')
  })

  it('closes a mention popover on Escape (controlled onOpenChange(false))', async () => {
    const user = userEvent.setup()
    render(<DmMessage text={HL_TEXT} streaming={false} highlight={mockIndex().index} highlightLabels={LABELS} />)
    await user.click(screen.getByRole('button', { name: 'entity: Elenya' }))
    expect(screen.getByRole('button', { name: 'Open in wiki' })).toBeInTheDocument()
    await user.keyboard('{Escape}')
    expect(screen.queryByRole('button', { name: 'Open in wiki' })).toBeNull()
  })

  it('open-in-wiki closes the popover even with no onEntityOpen handler (optional callback)', async () => {
    const user = userEvent.setup()
    render(<DmMessage text={HL_TEXT} streaming={false} highlight={mockIndex().index} highlightLabels={LABELS} />)
    await user.click(screen.getByRole('button', { name: 'entity: Elenya' }))
    await user.click(screen.getByRole('button', { name: 'Open in wiki' }))
    // No onEntityOpen supplied → the optional call is a no-op; the popover still closes.
    expect(screen.queryByRole('button', { name: 'Open in wiki' })).toBeNull()
  })

  it('degrades an entity segment with no resolvable card to plain text (never a broken popover)', () => {
    // The index recognizes a name but `card` returns null for it — HighlightedProse must
    // render the text run, not a mention button.
    const segment = vi.fn<() => readonly ProseSegment[]>(() => [
      { kind: 'entity', text: 'Ghost', entityId: 'missing', glyph: 'npc' },
    ])
    const index: EntityIndex = { segment, card: () => null }
    const { container } = render(
      <DmMessage text="Ghost" streaming={false} highlight={index} highlightLabels={LABELS} />,
    )
    expect(screen.queryByRole('button', { name: 'entity: Ghost' })).toBeNull()
    expect(container.querySelector('p')).toHaveTextContent('Ghost')
  })

  it('has no axe violations in the settled highlighted state', async () => {
    const { container } = render(
      <DmMessage text={HL_TEXT} streaming={false} highlight={mockIndex().index} highlightLabels={LABELS} />,
    )
    expect(await axe(container)).toHaveNoViolations()
  })
})
