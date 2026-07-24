import { describe, it, expect, afterEach, vi } from 'vitest'
import { useState } from 'react'
import { render, screen, act, fireEvent } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { axe } from 'jest-axe'
import type { CardItem, RollCardLabels, RollPhase } from '@mythrun/client-core/contract'
import { RollCard } from './RollCard.tsx'

// Behavior-tested with RTL + jest-axe. RollCard is PURE THEATER over an
// already-server-resolved number: `phase` is a controlled prop (the route's
// client-core `cardPhase`), and the only in-component step is the local DieSpin
// transition. Load-bearing invariants pinned here: the `constraint` prose seed is
// NEVER rendered; Roll spins then commits via `onRoll` (never `onContinue`); the
// settled readout carries the outcome tier as typographic WEIGHT (a `data-tier`
// attr + a weight class), never a colour chip; a `released` card shows no buttons;
// dice_roll is the flavor variant (no DC/tier/Continue); reduced motion lands
// instantly; and all numerics ride `--font-ui`.

// Test-double labels (stories/tests are i18n-exempt — the real i18n bundle is
// resolved route-side; MYT-100 is the copy pass). Distinct tier words so the
// weight assertion targets a specific node.
const LABELS: RollCardLabels = {
  roll: 'Roll',
  continue: 'Continue',
  tier: { fail: 'Miss', success: 'Success', great_success: 'Critical' },
  dc: 'DC',
  beats: 'beats',
  misses: 'misses',
  advantage: 'advantage',
  disadvantage: 'disadvantage',
  dieResult: 'You rolled',
}

// A normal skill check: die = total − modifier = 14 (the used d20); readout +2 = 16.
const SKILL_ITEM: CardItem = {
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
    modifier: 2,
    total: 16,
    dc: 12,
    outcomeTier: 'success',
    constraint: 'She notices the figure watching her.',
  },
}

// Advantage: both raw dice present (14 / 9); die still stamps the used 14.
const ADV_ITEM: CardItem = {
  ...SKILL_ITEM,
  key: 'sc-adv',
  frame: { ...SKILL_ITEM.frame, roll: 14, roll2: 9, rollType: 'advantage' },
}

const DICE_ITEM: CardItem = {
  kind: 'dice_roll',
  key: 'dr-1',
  turnId: 'T1',
  frame: { type: 'dice_roll', turnId: 'T1', count: 2, sides: 20, results: [8, 9], total: 17 },
}

function renderCard(
  overrides: {
    item?: CardItem
    phase?: RollPhase
    reducedMotion?: boolean
    onRoll?: () => void
    onContinue?: () => void
  } = {},
) {
  const { item = SKILL_ITEM, phase = 'idle', reducedMotion = false, onRoll = vi.fn(), onContinue = vi.fn() } = overrides
  return render(
    <RollCard
      item={item}
      phase={phase}
      reducedMotion={reducedMotion}
      labels={LABELS}
      onRoll={onRoll}
      onContinue={onContinue}
    />,
  )
}

// A stateful harness mirroring the route: onRoll → revealed, onContinue → released.
// Lets the interaction tests drive the full idle → revealed → released flow the
// isolated component can't (phase is controlled route-side).
function Harness({
  item = SKILL_ITEM,
  reducedMotion = false,
  onRollSpy,
  onContinueSpy,
}: {
  item?: CardItem
  reducedMotion?: boolean
  onRollSpy?: () => void
  onContinueSpy?: () => void
}): React.JSX.Element {
  const [phase, setPhase] = useState<RollPhase>('idle')
  return (
    <RollCard
      item={item}
      phase={phase}
      reducedMotion={reducedMotion}
      labels={LABELS}
      onRoll={() => {
        onRollSpy?.()
        setPhase('revealed')
      }}
      onContinue={() => {
        onContinueSpy?.()
        setPhase('released')
      }}
    />
  )
}

afterEach(() => {
  if (vi.isFakeTimers()) vi.useRealTimers()
})

describe('RollCard', () => {
  it('idle skill_check renders skill + the player modifier + context + Roll, never the constraint', () => {
    renderCard({ phase: 'idle' })
    expect(screen.getByText('perception')).toBeInTheDocument()
    // myth-89hfu: the player's OWN modifier is revealed PRE-roll (their competence).
    expect(screen.getByTestId('roll-modifier')).toHaveTextContent('+2')
    expect(screen.getByText('scanning the smoky common room')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Roll' })).toBeInTheDocument()
    // The constraint is the DM's gated-prose seed — it must never reach the card.
    expect(screen.queryByText('She notices the figure watching her.')).toBeNull()
    // No readout / Continue / DC while idle (the DC stays hidden until the roll).
    expect(screen.queryByRole('button', { name: 'Continue' })).toBeNull()
    expect(screen.queryByTestId('roll-equation')).toBeNull()
    expect(screen.queryByTestId('roll-comparison')).toBeNull()
  })

  it('pressing Roll spins then commits via onRoll exactly once (never onContinue)', () => {
    // Fake timers + synchronous fireEvent (userEvent's async delay deadlocks under
    // fake timers): press Roll, then drive the stepped spin to completion.
    vi.useFakeTimers()
    const onRoll = vi.fn()
    const onContinue = vi.fn()
    renderCard({ phase: 'idle', onRoll, onContinue })
    act(() => {
      fireEvent.click(screen.getByRole('button', { name: 'Roll' }))
    })
    // Generous — decoupled from DieSpin's exact step budget; it clears its interval
    // and calls back exactly once at the end of one revolution.
    act(() => {
      vi.advanceTimersByTime(2000)
    })
    expect(onRoll).toHaveBeenCalledTimes(1)
    expect(onContinue).not.toHaveBeenCalled()
  })

  it('revealed renders the full equation + explicit comparison + promoted outcome + Continue', async () => {
    const onContinue = vi.fn()
    const { container } = renderCard({ phase: 'revealed', onContinue })
    // myth-89hfu: the whole die-anchored equation (natural roll 14 + mod 2 = 16),
    // not the orphaned "+2 = 16".
    expect(screen.getByTestId('roll-equation')).toHaveTextContent('14 + 2 = 16')
    expect(screen.getByTestId('roll-equation')).toHaveClass('font-ui')
    // The explicit pass comparison so no arithmetic is required (the DC lives here).
    expect(screen.getByTestId('roll-comparison')).toHaveTextContent('16 beats DC 12')
    // The outcome is a WEIGHT at the typographic peak (data-tier + weight + size),
    // never a colour chip.
    const tier = container.querySelector('[data-tier="success"]')
    expect(tier).not.toBeNull()
    expect(tier).toHaveTextContent('Success')
    expect(tier).toHaveClass('font-ui', 'font-semibold', 'text-2xl')
    // Continue releases the buffered prose.
    const user = userEvent.setup()
    await user.click(screen.getByRole('button', { name: 'Continue' }))
    expect(onContinue).toHaveBeenCalledTimes(1)
  })

  it('great_success renders the heaviest tier weight; fail the plainest', () => {
    const great = renderCard({
      phase: 'released',
      item: { ...SKILL_ITEM, key: 'g', frame: { ...SKILL_ITEM.frame, outcomeTier: 'great_success' } },
    })
    expect(great.container.querySelector('[data-tier="great_success"]')).toHaveClass('font-bold')
    const fail = renderCard({
      phase: 'released',
      item: { ...SKILL_ITEM, key: 'f', frame: { ...SKILL_ITEM.frame, outcomeTier: 'fail' } },
    })
    // A failed check reads the miss comparison, not the pass one (scoped to this
    // render — the great_success card above also mounted a comparison node).
    expect(fail.container.querySelector('[data-testid="roll-comparison"]')).toHaveTextContent(
      '16 misses DC 12',
    )
    expect(fail.container.querySelector('[data-tier="fail"]')).toHaveClass('font-medium')
  })

  it('released renders the settled readout with NO buttons', () => {
    const { container } = renderCard({ phase: 'released' })
    expect(container).toHaveTextContent('DC 12')
    expect(container).toHaveTextContent('Success')
    expect(screen.queryByRole('button')).toBeNull()
  })

  it('a replayed card (phase=released) shows the result immediately — no Roll theater', () => {
    renderCard({ phase: 'released' })
    expect(screen.queryByRole('button', { name: 'Roll' })).toBeNull()
    // Die stamps the used natural roll (14); the equation repeats it → 14 + 2 = 16.
    expect(screen.getByTestId('roll-equation')).toHaveTextContent('14 + 2 = 16')
  })

  it('advantage carries both raw dice beside the readout', () => {
    renderCard({ phase: 'released', item: ADV_ITEM })
    expect(screen.getByText('advantage')).toBeInTheDocument()
    expect(screen.getByText('14 / 9')).toBeInTheDocument()
  })

  it('disadvantage shows its posture tag; a negative modifier reads signed', () => {
    renderCard({
      phase: 'released',
      item: {
        ...SKILL_ITEM,
        key: 'sc-dis',
        frame: { ...SKILL_ITEM.frame, roll: 8, roll2: 5, rollType: 'disadvantage', modifier: -1, total: 7 },
      },
    })
    expect(screen.getByText('disadvantage')).toBeInTheDocument()
    // Negative modifier: natural roll 8, then − 1 = 7 (the equation carries the sign).
    expect(screen.getByTestId('roll-equation')).toHaveTextContent('8 - 1 = 7')
  })

  it('dice_roll variant renders NdM + total, with NO DC/tier/Continue', () => {
    const { container } = renderCard({ phase: 'released', item: DICE_ITEM })
    expect(container).toHaveTextContent('2d20')
    // The summed total stamps in the die centre.
    expect(container).toHaveTextContent('17')
    expect(screen.queryByText('DC 12')).toBeNull()
    expect(screen.queryByText('Success')).toBeNull()
    expect(screen.queryByRole('button')).toBeNull()
  })

  it('reduced motion: Roll lands instantly (no interval) and shows the readout', async () => {
    const onRollSpy = vi.fn()
    render(<Harness reducedMotion onRollSpy={onRollSpy} />)
    const user = userEvent.setup()
    await user.click(screen.getByRole('button', { name: 'Roll' }))
    // No fake timers advanced — the readout appears at once (instant land).
    expect(await screen.findByTestId('roll-comparison')).toHaveTextContent('16 beats DC 12')
    expect(screen.queryByRole('button', { name: 'Roll' })).toBeNull()
    expect(screen.getByRole('button', { name: 'Continue' })).toBeInTheDocument()
    expect(onRollSpy).toHaveBeenCalledTimes(1)
  })

  it('is square register — no circles anywhere', () => {
    const { container } = renderCard({ phase: 'released' })
    expect(container.querySelector('.rounded-full')).toBeNull()
    expect(container.querySelector('[data-roll-card]')).toHaveClass('rounded-none')
  })

  it('has no axe violations across idle / revealed / released', async () => {
    const idle = renderCard({ phase: 'idle' })
    expect(await axe(idle.container)).toHaveNoViolations()
    const revealed = renderCard({ phase: 'revealed' })
    expect(await axe(revealed.container)).toHaveNoViolations()
    const released = renderCard({ phase: 'released' })
    expect(await axe(released.container)).toHaveNoViolations()
  })
})
