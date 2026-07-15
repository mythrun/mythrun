import { describe, it, expect, vi } from 'vitest'
import { createRef } from 'react'
import { render, screen, fireEvent } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { axe } from 'jest-axe'
import type {
  DmMessageProps,
  EntityCard,
  EntityIndex,
  ProseSegment,
  TranscriptItem,
} from '@mythrun/client-core/contract'
import { MessageStream } from './MessageStream.tsx'

// ── Fixtures — one of every TranscriptItem kind, frames matching the shipped
// ServerFrame shapes (frontend/contract/src/events/session-events.ts). ──────────

const DM_SETTLED: TranscriptItem = {
  kind: 'dm',
  key: 'dm-1',
  turnId: 'T1',
  text: 'The tavern door creaks open on a gust of cold rain.',
  streaming: false,
}

const DM_STREAMING: TranscriptItem = {
  kind: 'dm',
  key: 'dm-2',
  turnId: 'T2',
  text: 'A hooded figure at the back looks up',
  streaming: true,
}

const PLAYER_CONFIRMED: TranscriptItem = {
  kind: 'player',
  key: 'pl-1',
  turnId: null,
  seq: 5,
  userId: 'u1',
  displayName: 'Miklos',
  characterName: 'Kessa Vurm',
  text: 'I keep my hand near my blade and step inside.',
  pending: false,
}

const PLAYER_PENDING: TranscriptItem = {
  kind: 'player',
  key: 'pl-2',
  turnId: null,
  seq: null,
  userId: 'u1',
  displayName: 'Miklos',
  characterName: 'Kessa Vurm',
  text: 'Wait — did anyone else hear that?',
  pending: true,
}

const SKILL_CHECK: TranscriptItem = {
  kind: 'skill_check',
  key: 'sc-1',
  turnId: 'T1',
  frame: {
    type: 'skill_check',
    turnId: 'T1',
    characterName: 'Kessa Vurm',
    skill: 'perception',
    context: 'scanning the smoky common room',
    roll: 14,
    roll2: null,
    rollType: 'normal',
    modifier: 0,
    total: 14,
    dc: 12,
    outcomeTier: 'success',
    constraint: 'She notices the figure watching her.',
  },
}

const DICE_ROLL: TranscriptItem = {
  kind: 'dice_roll',
  key: 'dr-1',
  turnId: 'T1',
  frame: { type: 'dice_roll', turnId: 'T1', count: 2, sides: 20, results: [8, 9], total: 17 },
}

const LEDGER_UPDATE: TranscriptItem = {
  kind: 'ledger_update',
  key: 'lu-1',
  turnId: 'T1',
  frame: {
    type: 'ledger_update',
    turnId: 'T1',
    characterName: 'Kessa Vurm',
    kind: 'hp',
    summary: 'Kessa takes 5 damage (12 → 7)',
  },
}

const MODE_CHANGE: TranscriptItem = {
  kind: 'mode_change',
  key: 'mc-1',
  turnId: 'T1',
  frame: { type: 'mode_change', turnId: 'T1', from: 'exploration', to: 'combat', reason: 'ambush' },
}

const COMBAT_STARTED: TranscriptItem = {
  kind: 'combat_started',
  key: 'cs-1',
  turnId: 'T1',
  frame: {
    type: 'combat_started',
    turnId: 'T1',
    enemies: [
      { name: 'goblin', description: 'wiry, snarling', count: 2 },
      { name: 'bandit captain', description: 'scarred', count: 1 },
    ],
    initiative: [{ combatant: 'Kessa Vurm', roll: 18 }],
  },
}

const COMBAT_RESOLVED: TranscriptItem = {
  kind: 'combat_resolved',
  key: 'cr-1',
  turnId: 'T1',
  frame: {
    type: 'combat_resolved',
    turnId: 'T1',
    narration: 'The last goblin drops and the room goes quiet.',
    outcome: 'victory',
    casualties: [],
    hpChanges: [],
  },
}

const MECHANICAL: TranscriptItem[] = [
  SKILL_CHECK,
  DICE_ROLL,
  LEDGER_UPDATE,
  MODE_CHANGE,
  COMBAT_STARTED,
  COMBAT_RESOLVED,
]

const MIXED: TranscriptItem[] = [DM_SETTLED, PLAYER_CONFIRMED, SKILL_CHECK, DM_STREAMING, PLAYER_PENDING]

// jsdom has no layout, so `scrollTo` is undefined and scroll metrics are 0. The
// tests install a spy / define the geometry they assert against per-case.
function stubScroll(el: HTMLElement, geom: { scrollHeight?: number; clientHeight?: number }): ReturnType<typeof vi.fn> {
  const scrollTo = vi.fn()
  ;(el as unknown as { scrollTo: unknown }).scrollTo = scrollTo
  if (geom.scrollHeight !== undefined) {
    Object.defineProperty(el, 'scrollHeight', { configurable: true, value: geom.scrollHeight })
  }
  if (geom.clientHeight !== undefined) {
    Object.defineProperty(el, 'clientHeight', { configurable: true, value: geom.clientHeight })
  }
  return scrollTo
}

describe('MessageStream', () => {
  it('routes a dm item to DmMessage (serif prose) and a player item to PlayerMessage', () => {
    const { container } = render(
      <MessageStream items={[DM_SETTLED, PLAYER_CONFIRMED]} connectionLine={null} reducedMotion={false} />,
    )
    // DM prose renders inside the DmMessage wrapper (not a mechanical line).
    const dm = container.querySelector('[data-dm-message]')
    expect(dm).not.toBeNull()
    expect(dm).toHaveTextContent('The tavern door creaks open')
    // Player identity + text render.
    expect(screen.getByText('Kessa Vurm')).toBeInTheDocument()
    expect(screen.getByText('Miklos')).toBeInTheDocument()
    expect(screen.getByText(/keep my hand near my blade/)).toBeInTheDocument()
  })

  it('renders every mechanical kind as a terse mono (font-ui) system line', () => {
    const { container } = render(
      <MessageStream items={MECHANICAL} connectionLine={null} reducedMotion={false} />,
    )
    for (const kind of [
      'skill_check',
      'dice_roll',
      'ledger_update',
      'mode_change',
      'combat_started',
      'combat_resolved',
    ]) {
      const line = container.querySelector(`[data-mechanical="${kind}"]`)
      expect(line, kind).not.toBeNull()
      expect(line?.className).toContain('font-ui')
    }
  })

  it('formats each mechanical line from frame data', () => {
    const { container } = render(
      <MessageStream items={MECHANICAL} connectionLine={null} reducedMotion={false} />,
    )
    const text = (kind: string): string | null =>
      container.querySelector(`[data-mechanical="${kind}"]`)?.textContent ?? null
    expect(text('skill_check')).toBe('perception · 14 vs DC 12 · success')
    expect(text('dice_roll')).toBe('2d20 · 17')
    expect(text('ledger_update')).toBe('Kessa takes 5 damage (12 → 7)')
    expect(text('mode_change')).toBe('— combat —')
    expect(text('combat_started')).toBe('2× goblin · bandit captain')
    expect(text('combat_resolved')).toBe('— victory —')
  })

  it('pins the connectionLine as a status line when non-null, and omits it when null', () => {
    const { rerender } = render(
      <MessageStream items={[DM_SETTLED]} connectionLine={'[ph: reconnecting…]'} reducedMotion={false} />,
    )
    const line = screen.getByTestId('message-stream-connection')
    expect(line).toHaveTextContent('[ph: reconnecting…]')
    expect(line).toHaveAttribute('role', 'status')
    rerender(<MessageStream items={[DM_SETTLED]} connectionLine={null} reducedMotion={false} />)
    expect(screen.queryByTestId('message-stream-connection')).not.toBeInTheDocument()
  })

  it('auto-follows the tail on new items with a smooth scroll when motion is allowed', () => {
    const { rerender } = render(
      <MessageStream items={[DM_SETTLED]} connectionLine={null} reducedMotion={false} />,
    )
    const scroller = screen.getByTestId('message-stream-scroll')
    const scrollTo = stubScroll(scroller, { scrollHeight: 500 })
    rerender(<MessageStream items={[DM_SETTLED, PLAYER_CONFIRMED]} connectionLine={null} reducedMotion={false} />)
    expect(scrollTo).toHaveBeenCalledWith(expect.objectContaining({ top: 500, behavior: 'smooth' }))
  })

  it('follows streaming growth of the open DM turn even though item count is unchanged', () => {
    const { rerender } = render(
      <MessageStream items={[DM_STREAMING]} connectionLine={null} reducedMotion={false} />,
    )
    const scroller = screen.getByTestId('message-stream-scroll')
    const scrollTo = stubScroll(scroller, { scrollHeight: 800 })
    const grown: TranscriptItem = { ...DM_STREAMING, text: DM_STREAMING.text + ' and lowers their hood.' }
    rerender(<MessageStream items={[grown]} connectionLine={null} reducedMotion={false} />)
    expect(scrollTo).toHaveBeenCalledWith(expect.objectContaining({ behavior: 'smooth' }))
  })

  it('uses instant scrollTop under reducedMotion (never a smooth scroll)', () => {
    const { rerender } = render(
      <MessageStream items={[DM_SETTLED]} connectionLine={null} reducedMotion />,
    )
    const scroller = screen.getByTestId('message-stream-scroll')
    const scrollTo = vi.fn()
    ;(scroller as unknown as { scrollTo: unknown }).scrollTo = scrollTo
    Object.defineProperty(scroller, 'scrollHeight', { configurable: true, value: 500 })
    let scrolledTo = -1
    Object.defineProperty(scroller, 'scrollTop', {
      configurable: true,
      get: () => scrolledTo,
      set: (v: number) => {
        scrolledTo = v
      },
    })
    rerender(<MessageStream items={[DM_SETTLED, PLAYER_CONFIRMED]} connectionLine={null} reducedMotion />)
    expect(scrolledTo).toBe(500)
    expect(scrollTo).not.toHaveBeenCalled()
  })

  it('reveals a jump-to-latest control once the reader scrolls up, and hides it after jumping', async () => {
    const user = userEvent.setup()
    render(<MessageStream items={MIXED} connectionLine={null} reducedMotion={false} />)
    const scroller = screen.getByTestId('message-stream-scroll')
    // No jump while pinned to the bottom.
    expect(screen.queryByRole('button')).not.toBeInTheDocument()
    // Scroll up: 1000 content, 200 viewport, at top → not at bottom.
    const scrollTo = stubScroll(scroller, { scrollHeight: 1000, clientHeight: 200 })
    fireEvent.scroll(scroller)
    const jump = screen.getByRole('button')
    expect(jump).toBeInTheDocument()
    await user.click(jump)
    expect(scrollTo).toHaveBeenCalled()
    expect(screen.queryByRole('button')).not.toBeInTheDocument()
  })

  it('does NOT auto-follow when the reader has scrolled up', () => {
    const { rerender } = render(
      <MessageStream items={[DM_SETTLED]} connectionLine={null} reducedMotion={false} />,
    )
    const scroller = screen.getByTestId('message-stream-scroll')
    const scrollTo = stubScroll(scroller, { scrollHeight: 1000, clientHeight: 200 })
    fireEvent.scroll(scroller) // marks not-at-bottom
    scrollTo.mockClear()
    rerender(<MessageStream items={[DM_SETTLED, PLAYER_CONFIRMED]} connectionLine={null} reducedMotion={false} />)
    expect(scrollTo).not.toHaveBeenCalled()
  })

  it('draws a light scene divider when a new DM turn opens after a different turn', () => {
    render(<MessageStream items={[DM_SETTLED, DM_STREAMING]} connectionLine={null} reducedMotion={false} />)
    // DM_SETTLED is turn T1, DM_STREAMING is turn T2 → exactly one scene rule.
    expect(screen.getAllByRole('separator')).toHaveLength(1)
  })

  it('does not divide within a single turn (same turnId, or a non-DM row)', () => {
    const sameTurn: TranscriptItem = { ...DM_STREAMING, key: 'dm-3', turnId: 'T1' }
    render(<MessageStream items={[DM_SETTLED, SKILL_CHECK, sameTurn]} connectionLine={null} reducedMotion={false} />)
    // SKILL_CHECK is not a DM row; the second DM row is still turn T1 → no rule.
    expect(screen.queryByRole('separator')).not.toBeInTheDocument()
  })

  it('renders an empty transcript without crashing or dividing', () => {
    render(<MessageStream items={[]} connectionLine={null} reducedMotion={false} />)
    expect(screen.getByTestId('message-stream-scroll')).toBeEmptyDOMElement()
    expect(screen.queryByRole('separator')).not.toBeInTheDocument()
  })

  it('is square register — no circles anywhere in the surface', () => {
    const { container } = render(
      <MessageStream items={MIXED} connectionLine={'[ph: reconnecting…]'} reducedMotion={false} />,
    )
    expect(container.querySelector('.rounded-full')).toBeNull()
  })

  it('forwards the ref and carries a root data-testid', () => {
    const ref = createRef<HTMLDivElement>()
    render(<MessageStream ref={ref} items={[DM_SETTLED]} connectionLine={null} reducedMotion={false} />)
    expect(screen.getByTestId('message-stream')).toBeInTheDocument()
    expect(ref.current).toBeInstanceOf(HTMLDivElement)
  })

  it('has no a11y violations (mixed transcript, and with a connection line)', async () => {
    const plain = render(<MessageStream items={MIXED} connectionLine={null} reducedMotion={false} />)
    expect(await axe(plain.container)).toHaveNoViolations()
    const withLine = render(
      <MessageStream items={MECHANICAL} connectionLine={'[ph: reconnecting…]'} reducedMotion={false} />,
    )
    expect(await axe(withLine.container)).toHaveNoViolations()
  })
})

// ── MYT-94 (Task 11) — the settled-prose highlight seam threads straight through the
// `dm` arm. MessageStream stays presentation-only: DmMessage owns the settle-only gating
// + the once-per-row memoized segmentation. ────────────────────────────────────────────
describe('MessageStream — entity-highlight seam (MYT-94)', () => {
  const HL_CARDS: Record<string, EntityCard> = {
    e1: { entityId: 'e1', name: 'Highreach', glyph: 'location', leadLine: 'A cliff town.' },
  }
  const HL_SEGMENTS: ProseSegment[] = [
    { kind: 'text', text: 'A road climbs to ' },
    { kind: 'entity', text: 'Highreach', entityId: 'e1', glyph: 'location' },
    { kind: 'text', text: '.' },
  ]
  const HL_INDEX: EntityIndex = {
    segment: vi.fn(() => HL_SEGMENTS),
    card: vi.fn((id: string) => HL_CARDS[id] ?? null),
  }
  const HL_LABELS: NonNullable<DmMessageProps['highlightLabels']> = {
    mentionLabelFor: (name) => `entity: ${name}`,
    typeLabelFor: (glyph) => `type: ${glyph}`,
    openInWikiLabel: 'Open in wiki',
  }
  const DM_HL_SETTLED: TranscriptItem = {
    kind: 'dm',
    key: 'dm-hl',
    turnId: 'T9',
    text: 'A road climbs to Highreach.',
    streaming: false,
  }

  it('threads highlight through to a SETTLED dm row (mention renders) and fires onEntityOpen', async () => {
    const user = userEvent.setup()
    const onEntityOpen = vi.fn()
    render(
      <MessageStream
        items={[DM_HL_SETTLED]}
        connectionLine={null}
        reducedMotion={false}
        highlight={HL_INDEX}
        highlightLabels={HL_LABELS}
        onEntityOpen={onEntityOpen}
      />,
    )
    await user.click(screen.getByRole('button', { name: 'entity: Highreach' }))
    await user.click(screen.getByRole('button', { name: 'Open in wiki' }))
    expect(onEntityOpen).toHaveBeenCalledWith('e1')
  })

  it('does NOT highlight a STREAMING dm row even when highlight is present', () => {
    render(
      <MessageStream
        items={[{ ...DM_HL_SETTLED, key: 'dm-hl-s', streaming: true }]}
        connectionLine={null}
        reducedMotion={false}
        highlight={HL_INDEX}
        highlightLabels={HL_LABELS}
      />,
    )
    expect(screen.queryByRole('button', { name: 'entity: Highreach' })).toBeNull()
  })
})
