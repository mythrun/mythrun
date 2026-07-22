import { describe, it, expect, vi } from 'vitest'
import { createRef } from 'react'
import { render, screen, fireEvent } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { axe } from 'jest-axe'
import type {
  DmMessageProps,
  EntityCard,
  EntityIndex,
  MessageStreamProps,
  ProseSegment,
  RollCardLabels,
  RollPhase,
  RollRevealView,
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

// The full mechanical set (MYT-93 moved skill_check / dice_roll to RollCard).
const MECHANICAL: TranscriptItem[] = [
  SKILL_CHECK,
  DICE_ROLL,
  LEDGER_UPDATE,
  MODE_CHANGE,
  COMBAT_STARTED,
  COMBAT_RESOLVED,
]

// The four post-92 mechanical kinds that still render as a terse mono system line
// (skill_check / dice_roll are now RollCards — spec §5).
const NON_CARD_MECHANICAL: TranscriptItem[] = [LEDGER_UPDATE, MODE_CHANGE, COMBAT_STARTED, COMBAT_RESOLVED]

// A DM correction (myth-d6knq) — the errata row. Both a live-appended and a
// replayed row reduce to this same item kind, so one fixture covers both paths.
const DM_CORRECTION: TranscriptItem = {
  kind: 'dm_correction',
  key: 'corr-1',
  turnId: 'T3',
  text: 'The gate is iron, not oak — banded and cold.',
}

const MIXED: TranscriptItem[] = [DM_SETTLED, PLAYER_CONFIRMED, SKILL_CHECK, DM_STREAMING, PLAYER_PENDING]

// ── Reveal scaffolding (MYT-93). MessageStream is presentational: the play route
// computes the reveal view + label bundle (client-core selectors) and threads them
// in. Tests supply a stub label bundle + a reveal view (default: nothing revealed,
// nothing gated). Stub labels are i18n-exempt — the real i18n bundle resolves
// route-side (MYT-100 is the copy pass). ─────────────────────────────────────────
const STUB_LABELS: RollCardLabels = {
  roll: 'Roll',
  continue: 'Continue',
  tier: { fail: 'Miss', success: 'Success', great_success: 'Critical' },
  dc: 'DC',
  advantage: 'advantage',
  disadvantage: 'disadvantage',
  dieResult: 'You rolled',
}

const NO_REVEAL: RollRevealView = { phaseByKey: {}, gatedTurnIds: new Set<string>() }

// A reveal view from a phase map + an optional gated-turn list.
function reveal(phaseByKey: Record<string, RollPhase>, gated: string[] = []): RollRevealView {
  return { phaseByKey, gatedTurnIds: new Set(gated) }
}

// Build a full MessageStreamProps with the four MYT-93 props defaulted, so each
// case overrides only what it exercises (items / reveal / callbacks / motion).
function streamProps(overrides: Partial<MessageStreamProps> = {}): MessageStreamProps {
  return {
    items: [],
    connectionLine: null,
    reducedMotion: false,
    rollReveal: NO_REVEAL,
    rollLabels: STUB_LABELS,
    onRoll: vi.fn(),
    onContinue: vi.fn(),
    ...overrides,
  }
}

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
    const { container } = render(<MessageStream {...streamProps({ items: [DM_SETTLED, PLAYER_CONFIRMED] })} />)
    // DM prose renders inside the DmMessage wrapper (not a mechanical line).
    const dm = container.querySelector('[data-dm-message]')
    expect(dm).not.toBeNull()
    expect(dm).toHaveTextContent('The tavern door creaks open')
    // Player identity + text render.
    expect(screen.getByText('Kessa Vurm')).toBeInTheDocument()
    expect(screen.getByText('Miklos')).toBeInTheDocument()
    expect(screen.getByText(/keep my hand near my blade/)).toBeInTheDocument()
  })

  it('routes a dm_correction item to the set-apart errata slip, never to a dm prose row or a mechanical line', () => {
    const { container } = render(
      <MessageStream {...streamProps({ items: [DM_SETTLED, DM_CORRECTION], correctionLabel: 'Correction' })} />,
    )
    // The errata slip renders with its own eyebrow + amendment text.
    const slip = container.querySelector('[data-dm-correction]')
    expect(slip).not.toBeNull()
    expect(slip).toHaveAttribute('role', 'note')
    expect(slip).toHaveTextContent('The gate is iron, not oak')
    expect(slip).toHaveTextContent('Correction')
    // It is NOT the DM narrative register, and NOT a mechanical system line.
    expect(slip?.closest('[data-dm-message]')).toBeNull()
    expect(container.querySelector('[data-mechanical="dm_correction"]')).toBeNull()
    // The narration above it still rendered as its own DM prose row.
    expect(container.querySelector('[data-dm-message]')).toHaveTextContent('The tavern door creaks open')
  })

  it('a replayed dm_correction row renders identically to a live one (same item kind → same slip)', () => {
    // The reducer maps both the live frame and the persisted replay row to the SAME
    // dm_correction item, so rendering is path-independent by construction.
    const { container } = render(
      <MessageStream {...streamProps({ items: [DM_CORRECTION], correctionLabel: 'Correction' })} />,
    )
    expect(container.querySelector('[data-dm-correction]')).toHaveTextContent('The gate is iron, not oak')
  })

  it('renders each non-card mechanical kind as a terse mono (font-ui) system line', () => {
    const { container } = render(<MessageStream {...streamProps({ items: NON_CARD_MECHANICAL })} />)
    for (const kind of ['ledger_update', 'mode_change', 'combat_started', 'combat_resolved']) {
      const line = container.querySelector(`[data-mechanical="${kind}"]`)
      expect(line, kind).not.toBeNull()
      expect(line?.className).toContain('font-ui')
    }
  })

  it('formats each non-card mechanical line from frame data', () => {
    const { container } = render(<MessageStream {...streamProps({ items: NON_CARD_MECHANICAL })} />)
    const text = (kind: string): string | null =>
      container.querySelector(`[data-mechanical="${kind}"]`)?.textContent ?? null
    expect(text('ledger_update')).toBe('Kessa takes 5 damage (12 → 7)')
    expect(text('mode_change')).toBe('— combat —')
    expect(text('combat_started')).toBe('2× goblin · bandit captain')
    expect(text('combat_resolved')).toBe('— victory —')
  })

  it('routes skill_check / dice_roll to a RollCard, not a terse mono line', () => {
    const { container } = render(<MessageStream {...streamProps({ items: [SKILL_CHECK, DICE_ROLL] })} />)
    // Both card kinds render as RollCards…
    expect(container.querySelector('[data-roll-card="skill_check"]')).not.toBeNull()
    expect(container.querySelector('[data-roll-card="dice_roll"]')).not.toBeNull()
    // …and no longer as terse mono system lines.
    expect(container.querySelector('[data-mechanical="skill_check"]')).toBeNull()
    expect(container.querySelector('[data-mechanical="dice_roll"]')).toBeNull()
    // At the default idle phase each card exposes the Roll affordance.
    expect(screen.getAllByRole('button', { name: 'Roll' })).toHaveLength(2)
  })

  it('drives each card phase from rollReveal.phaseByKey (revealed shows the readout + Continue)', () => {
    render(<MessageStream {...streamProps({ items: [SKILL_CHECK], rollReveal: reveal({ 'sc-1': 'revealed' }) })} />)
    // A revealed skill_check stamps its readout (DC prefix from labels) + Continue,
    // and no longer the idle Roll button.
    expect(screen.getByText('DC 12')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Continue' })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Roll' })).toBeNull()
  })

  it('gates a dm item whose turnId ∈ gatedTurnIds, then renders it once released', () => {
    // SKILL_CHECK and DM_SETTLED share turn T1: the post-check prose is buffered
    // until the card is continued.
    const { rerender } = render(
      <MessageStream {...streamProps({ items: [SKILL_CHECK, DM_SETTLED], rollReveal: reveal({ 'sc-1': 'idle' }, ['T1']) })} />,
    )
    expect(screen.queryByText(/tavern door creaks open/)).not.toBeInTheDocument()
    // Continue released → the turn drops out of gatedTurnIds → the prose renders.
    rerender(
      <MessageStream {...streamProps({ items: [SKILL_CHECK, DM_SETTLED], rollReveal: reveal({ 'sc-1': 'released' }) })} />,
    )
    expect(screen.getByText(/tavern door creaks open/)).toBeInTheDocument()
  })

  it('binds onRoll to the card item key (fires when the spin completes)', async () => {
    const onRoll = vi.fn()
    const user = userEvent.setup()
    // Reduced motion → the die lands instantly, so no fake timers are needed.
    render(<MessageStream {...streamProps({ items: [SKILL_CHECK], reducedMotion: true, onRoll })} />)
    await user.click(screen.getByRole('button', { name: 'Roll' }))
    expect(onRoll).toHaveBeenCalledWith('sc-1')
  })

  it('binds onContinue to the card item key', async () => {
    const onContinue = vi.fn()
    const user = userEvent.setup()
    render(<MessageStream {...streamProps({ items: [SKILL_CHECK], rollReveal: reveal({ 'sc-1': 'revealed' }), onContinue })} />)
    await user.click(screen.getByRole('button', { name: 'Continue' }))
    expect(onContinue).toHaveBeenCalledWith('sc-1')
  })

  it('pins the connectionLine as a status line when non-null, and omits it when null', () => {
    const { rerender } = render(
      <MessageStream {...streamProps({ items: [DM_SETTLED], connectionLine: 'finding your way back…' })} />,
    )
    const line = screen.getByTestId('message-stream-connection')
    expect(line).toHaveTextContent('finding your way back…')
    expect(line).toHaveAttribute('role', 'status')
    rerender(<MessageStream {...streamProps({ items: [DM_SETTLED] })} />)
    expect(screen.queryByTestId('message-stream-connection')).not.toBeInTheDocument()
  })

  it('auto-follows the tail on new items with a smooth scroll when motion is allowed', () => {
    const { rerender } = render(<MessageStream {...streamProps({ items: [DM_SETTLED] })} />)
    const scroller = screen.getByTestId('message-stream-scroll')
    const scrollTo = stubScroll(scroller, { scrollHeight: 500 })
    rerender(<MessageStream {...streamProps({ items: [DM_SETTLED, PLAYER_CONFIRMED] })} />)
    expect(scrollTo).toHaveBeenCalledWith(expect.objectContaining({ top: 500, behavior: 'smooth' }))
  })

  it('follows streaming growth of the open DM turn even though item count is unchanged', () => {
    const { rerender } = render(<MessageStream {...streamProps({ items: [DM_STREAMING] })} />)
    const scroller = screen.getByTestId('message-stream-scroll')
    const scrollTo = stubScroll(scroller, { scrollHeight: 800 })
    const grown: TranscriptItem = { ...DM_STREAMING, text: DM_STREAMING.text + ' and lowers their hood.' }
    rerender(<MessageStream {...streamProps({ items: [grown] })} />)
    expect(scrollTo).toHaveBeenCalledWith(expect.objectContaining({ behavior: 'smooth' }))
  })

  it('uses instant scrollTop under reducedMotion (never a smooth scroll)', () => {
    const { rerender } = render(<MessageStream {...streamProps({ items: [DM_SETTLED], reducedMotion: true })} />)
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
    rerender(<MessageStream {...streamProps({ items: [DM_SETTLED, PLAYER_CONFIRMED], reducedMotion: true })} />)
    expect(scrolledTo).toBe(500)
    expect(scrollTo).not.toHaveBeenCalled()
  })

  it('reveals a jump-to-latest control once the reader scrolls up, and hides it after jumping', async () => {
    const user = userEvent.setup()
    render(<MessageStream {...streamProps({ items: MIXED })} />)
    const scroller = screen.getByTestId('message-stream-scroll')
    // No jump while pinned to the bottom.
    expect(screen.queryByRole('button', { name: 'Jump to latest' })).not.toBeInTheDocument()
    // Scroll up: 1000 content, 200 viewport, at top → not at bottom.
    const scrollTo = stubScroll(scroller, { scrollHeight: 1000, clientHeight: 200 })
    fireEvent.scroll(scroller)
    const jump = screen.getByRole('button', { name: 'Jump to latest' })
    expect(jump).toBeInTheDocument()
    await user.click(jump)
    expect(scrollTo).toHaveBeenCalled()
    expect(screen.queryByRole('button', { name: 'Jump to latest' })).not.toBeInTheDocument()
  })

  it('does NOT auto-follow when the reader has scrolled up', () => {
    const { rerender } = render(<MessageStream {...streamProps({ items: [DM_SETTLED] })} />)
    const scroller = screen.getByTestId('message-stream-scroll')
    const scrollTo = stubScroll(scroller, { scrollHeight: 1000, clientHeight: 200 })
    fireEvent.scroll(scroller) // marks not-at-bottom
    scrollTo.mockClear()
    rerender(<MessageStream {...streamProps({ items: [DM_SETTLED, PLAYER_CONFIRMED] })} />)
    expect(scrollTo).not.toHaveBeenCalled()
  })

  it('draws a light scene divider when a new DM turn opens after a different turn', () => {
    render(<MessageStream {...streamProps({ items: [DM_SETTLED, DM_STREAMING] })} />)
    // DM_SETTLED is turn T1, DM_STREAMING is turn T2 → exactly one scene rule.
    expect(screen.getAllByRole('separator')).toHaveLength(1)
  })

  it('does not divide within a single turn (same turnId, or a non-DM row)', () => {
    const sameTurn: TranscriptItem = { ...DM_STREAMING, key: 'dm-3', turnId: 'T1' }
    render(<MessageStream {...streamProps({ items: [DM_SETTLED, SKILL_CHECK, sameTurn] })} />)
    // SKILL_CHECK is not a DM row; the second DM row is still turn T1 → no rule.
    expect(screen.queryByRole('separator')).not.toBeInTheDocument()
  })

  it('renders an empty transcript without crashing or dividing', () => {
    render(<MessageStream {...streamProps({ items: [] })} />)
    expect(screen.getByTestId('message-stream-scroll')).toBeEmptyDOMElement()
    expect(screen.queryByRole('separator')).not.toBeInTheDocument()
  })

  it('is square register — no circles anywhere in the surface', () => {
    const { container } = render(
      <MessageStream {...streamProps({ items: MIXED, connectionLine: 'finding your way back…' })} />,
    )
    expect(container.querySelector('.rounded-full')).toBeNull()
  })

  it('forwards the ref and carries a root data-testid', () => {
    const ref = createRef<HTMLDivElement>()
    render(<MessageStream ref={ref} {...streamProps({ items: [DM_SETTLED] })} />)
    expect(screen.getByTestId('message-stream')).toBeInTheDocument()
    expect(ref.current).toBeInstanceOf(HTMLDivElement)
  })

  it('has no a11y violations (mixed transcript, and with a connection line)', async () => {
    const plain = render(<MessageStream {...streamProps({ items: MIXED })} />)
    expect(await axe(plain.container)).toHaveNoViolations()
    const withLine = render(
      <MessageStream {...streamProps({ items: MECHANICAL, connectionLine: 'finding your way back…' })} />,
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
        rollReveal={NO_REVEAL}
        rollLabels={STUB_LABELS}
        onRoll={() => undefined}
        onContinue={() => undefined}
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
        rollReveal={NO_REVEAL}
        rollLabels={STUB_LABELS}
        onRoll={() => undefined}
        onContinue={() => undefined}
        highlight={HL_INDEX}
        highlightLabels={HL_LABELS}
      />,
    )
    expect(screen.queryByRole('button', { name: 'entity: Highreach' })).toBeNull()
  })
})
