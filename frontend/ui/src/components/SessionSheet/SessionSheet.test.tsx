import { describe, it, expect } from 'vitest'
import { createRef } from 'react'
import { render, within } from '@testing-library/react'
import { axe } from 'jest-axe'
import type { CuratedSheet, CharacterOverlay } from '@mythrun/client-core/contract'
import { SessionSheet } from './SessionSheet.tsx'

// The in-session curated sheet fixture, mirroring exactly what the shipped sheet
// view-model (`buildStats` in client-core `sheet-view-model.ts`) emits: a
// structural `key` per cell plus the `${hp} / ${maxHp}` HP value. SessionSheet
// consumes that projection and keys its live-HP override on `key: 'hp'`
// (myth-qeyqq) — the labels are display copy and nothing branches on them.
const MARTIAL: CuratedSheet = {
  name: 'Kessa Vurm',
  identityLine: 'Level 3 · Human Fighter · Champion · Toll-clerk of Greenward',
  stats: [
    { key: 'ac', label: 'AC', value: '16' },
    { key: 'hp', label: 'HP', value: '28 / 28' },
    { key: 'proficiency', label: 'Proficiency', value: '+2' },
    { key: 'hitDie', label: 'Hit Die', value: 'd10' },
    { key: 'speed', label: 'Speed', value: '30 ft' },
  ],
  abilities: [
    { abbrev: 'STR', score: 16, modifier: 3 },
    { abbrev: 'DEX', score: 13, modifier: 1 },
    { abbrev: 'CON', score: 15, modifier: 2 },
    { abbrev: 'INT', score: 12, modifier: 1 },
    { abbrev: 'WIS', score: 11, modifier: 0 },
    { abbrev: 'CHA', score: 9, modifier: -1 },
  ],
  prose: [
    'Kessa spent eleven years stamping manifests at the Greenward Toll.',
    "When six wagons rolled through empty, the numbers wouldn't leave her alone.",
  ],
  features: [
    { name: 'Second Wind', gloss: 'Catch her breath: recover a burst of HP once per rest.' },
    { name: 'Action Surge', gloss: 'One extra action when it counts. Once per rest.' },
  ],
  equipment: [
    { name: 'Longsword', gloss: "Versatile · her father's, re-hilted." },
    { name: 'Chain mail & shield' },
  ],
}

const CASTER: CuratedSheet = {
  ...MARTIAL,
  name: 'Ilma the Unwritten',
  identityLine: 'Level 3 · Gnome Wizard · Evocation',
  spells: [
    { name: 'Fire Bolt', gloss: 'Cantrip · a mote of directed flame.' },
    { name: 'Magic Missile' },
  ],
}

// `activeConditions: null` = no ledger frame has spoken yet (distinct from `[]`,
// which means "currently none"). The sheet renders `conditionLog` only — the
// active set is folded but its presentation is still an open design call.
const EMPTY_OVERLAY: CharacterOverlay = {
  hp: null, maxHp: null, gold: null, conditionLog: [], activeConditions: null,
}
const LIVE_OVERLAY: CharacterOverlay = {
  hp: 12,
  maxHp: 28,
  gold: null,
  conditionLog: ['A hobgoblin blade opens a gash along her ribs.', 'The venom starts to bite.'],
  activeConditions: [{ condition: 'poisoned', level: null }],
}

function baseProps(overrides: Partial<React.ComponentProps<typeof SessionSheet>> = {}) {
  return {
    sheet: MARTIAL,
    overlay: EMPTY_OVERLAY,
    hpLabel: 'Current HP',
    conditionsLabel: 'Recent changes',
    emptyLabel: 'Nothing has changed yet',
    ...overrides,
  }
}

describe('SessionSheet', () => {
  it('renders the name and the identity eyebrow', () => {
    const { getByText } = render(<SessionSheet {...baseProps()} />)
    expect(getByText('Kessa Vurm')).toBeInTheDocument()
    expect(
      getByText('Level 3 · Human Fighter · Champion · Toll-clerk of Greenward'),
    ).toBeInTheDocument()
  })

  it('renders the stat stripe — every label over its value', () => {
    const { getByTestId } = render(<SessionSheet {...baseProps()} />)
    const stripe = within(getByTestId('session-sheet-stripe'))
    for (const stat of MARTIAL.stats) {
      expect(stripe.getByText(stat.label)).toBeInTheDocument()
      expect(stripe.getByText(stat.value)).toBeInTheDocument()
    }
  })

  it('renders the six ability tiles with the score and the signed modifier', () => {
    const { getAllByTestId } = render(<SessionSheet {...baseProps()} />)
    const tiles = getAllByTestId('session-sheet-ability')
    expect(tiles).toHaveLength(6)
    const byAbbrev = (abbrev: string): HTMLElement => {
      const tile = tiles.find((t) => t.getAttribute('data-abbrev') === abbrev)
      if (!tile) throw new Error(`no tile for ${abbrev}`)
      return tile
    }
    expect(byAbbrev('STR').textContent).toContain('16')
    expect(byAbbrev('STR').textContent).toContain('+3')
    expect(byAbbrev('WIS').textContent).toContain('+0')
    expect(byAbbrev('CHA').textContent).toContain('−1')
  })

  it('renders the connection prose paragraphs', () => {
    const { getByText } = render(<SessionSheet {...baseProps()} />)
    for (const para of MARTIAL.prose) {
      expect(getByText(para)).toBeInTheDocument()
    }
  })

  it('renders the features and equipment panels (name + optional gloss)', () => {
    const { getByTestId } = render(<SessionSheet {...baseProps()} />)
    const features = within(getByTestId('session-sheet-features'))
    expect(features.getByText('Second Wind')).toBeInTheDocument()
    expect(features.getByText('One extra action when it counts. Once per rest.')).toBeInTheDocument()
    const equipment = within(getByTestId('session-sheet-equipment'))
    expect(equipment.getByText('Longsword')).toBeInTheDocument()
    // A gloss-less entry still renders its name (the gloss line is simply omitted).
    expect(equipment.getByText('Chain mail & shield')).toBeInTheDocument()
  })

  it('renders the spells panel ONLY for a caster (absent for a martial)', () => {
    const martial = render(<SessionSheet {...baseProps()} />)
    expect(martial.queryByTestId('session-sheet-spells')).toBeNull()

    const caster = render(<SessionSheet {...baseProps({ sheet: CASTER })} />)
    const spells = within(caster.getByTestId('session-sheet-spells'))
    expect(spells.getByText('Fire Bolt')).toBeInTheDocument()
    expect(spells.getByText('Magic Missile')).toBeInTheDocument()
  })

  it('carries NO creation-flow chrome — no confirm / start-over / full-sheet controls', () => {
    const { queryAllByRole } = render(<SessionSheet {...baseProps()} />)
    // The in-session sheet is read-only: it strips the reveal's action row entirely.
    expect(queryAllByRole('button')).toHaveLength(0)
  })

  it('shows the base static HP when there is no live overlay', () => {
    const { getByTestId } = render(<SessionSheet {...baseProps()} />)
    const hp = getByTestId('session-sheet-hp')
    expect(hp).toHaveAttribute('data-live', 'false')
    expect(within(hp).getByText('HP')).toBeInTheDocument()
    expect(within(hp).getByText('28 / 28')).toBeInTheDocument()
  })

  it('overlays the live HP over the base sheet HP when overlay.hp is set', () => {
    const { getByTestId, queryByText } = render(
      <SessionSheet {...baseProps({ overlay: LIVE_OVERLAY })} />,
    )
    const hp = getByTestId('session-sheet-hp')
    expect(hp).toHaveAttribute('data-live', 'true')
    // The live label + live value replace the base sheet's static HP cell.
    expect(within(hp).getByText('Current HP')).toBeInTheDocument()
    expect(within(hp).getByText('12 / 28')).toBeInTheDocument()
    // The base static HP value is gone — the live value stands in its place.
    expect(queryByText('28 / 28')).toBeNull()
  })

  // myth-qeyqq — the override follows the cell's STRUCTURAL key, not its
  // display label. Renaming the HP label used to silently switch the live
  // overlay off, so a player mid-combat would read stale hit points off the
  // sheet with nothing to indicate it.
  it('overlays live HP by the cell key, not the label copy', () => {
    const renamed: CuratedSheet = {
      ...MARTIAL,
      stats: MARTIAL.stats.map((stat) => (stat.key === 'hp' ? { ...stat, label: 'Hit points' } : stat)),
    }
    const { getByTestId } = render(
      <SessionSheet {...baseProps({ sheet: renamed, overlay: LIVE_OVERLAY })} />,
    )
    const hp = getByTestId('session-sheet-hp')
    expect(hp).toHaveAttribute('data-live', 'true')
    expect(within(hp).getByText('12 / 28')).toBeInTheDocument()
  })

  it('renders the live current HP alone when the overlay carries no maxHp', () => {
    const overlay: CharacterOverlay = {
      hp: 9, maxHp: null, gold: null, conditionLog: [], activeConditions: null,
    }
    const { getByTestId } = render(<SessionSheet {...baseProps({ overlay })} />)
    const hp = getByTestId('session-sheet-hp')
    expect(within(hp).getByText('9')).toBeInTheDocument()
  })

  it('renders the condition log chronologically (prose lines, not chips) when non-empty', () => {
    const { getByTestId, queryByText } = render(
      <SessionSheet {...baseProps({ overlay: LIVE_OVERLAY })} />,
    )
    const region = within(getByTestId('session-sheet-conditions'))
    expect(region.getByText('Recent changes')).toBeInTheDocument()
    for (const line of LIVE_OVERLAY.conditionLog) {
      expect(region.getByText(line)).toBeInTheDocument()
    }
    // A LOG, not status badges — the calm empty line is absent while there are changes.
    expect(queryByText('Nothing has changed yet')).toBeNull()
  })

  it('shows the calm empty line (no conditions header) when the overlay log is empty', () => {
    const { getByText, queryByTestId } = render(<SessionSheet {...baseProps()} />)
    expect(getByText('Nothing has changed yet')).toBeInTheDocument()
    expect(queryByTestId('session-sheet-conditions')).toBeNull()
  })

  it('is flat 1-bit / square (the ability tiles carry rounded-none, no circles)', () => {
    const { getAllByTestId } = render(<SessionSheet {...baseProps()} />)
    const [firstTile] = getAllByTestId('session-sheet-ability')
    if (!firstTile) throw new Error('no ability tiles')
    expect(firstTile.className).toContain('rounded-none')
  })

  it('carries a data-testid on the root', () => {
    const { getByTestId } = render(<SessionSheet {...baseProps()} />)
    expect(getByTestId('session-sheet')).toBeInTheDocument()
  })

  it('forwards the ref to the root element', () => {
    const ref = createRef<HTMLDivElement>()
    render(<SessionSheet ref={ref} {...baseProps()} />)
    expect(ref.current).toBeInstanceOf(HTMLDivElement)
  })

  it('has no a11y violations (martial resting, caster mid-combat with conditions)', async () => {
    const resting = render(<SessionSheet {...baseProps()} />)
    expect(await axe(resting.container)).toHaveNoViolations()
    const combat = render(<SessionSheet {...baseProps({ sheet: CASTER, overlay: LIVE_OVERLAY })} />)
    expect(await axe(combat.container)).toHaveNoViolations()
  })
})
