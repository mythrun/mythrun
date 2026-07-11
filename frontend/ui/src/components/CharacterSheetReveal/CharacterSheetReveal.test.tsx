import { describe, it, expect, vi } from 'vitest'
import { createRef } from 'react'
import { render, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { axe } from 'jest-axe'
import type { CuratedSheet, FullSheet } from '@mythrun/client-core/contract'
import { CharacterSheetReveal } from './CharacterSheetReveal.tsx'

// A martial character (Kessa Vurm — the mockup specimen): NO spells. `full.spells`
// is the empty array a non-caster carries.
const MARTIAL_CURATED: CuratedSheet = {
  name: 'Kessa Vurm',
  identityLine: 'Level 3 · Human Fighter · Champion · Toll-clerk of Greenward',
  stats: [
    { label: 'Armor Class', value: '16' },
    { label: 'Hit Points', value: '28' },
    { label: 'Proficiency', value: '+2' },
    { label: 'Hit Die', value: 'd10' },
    { label: 'Speed', value: '30 ft' },
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
    'Kessa spent eleven years stamping manifests at the Greenward Toll, and she never once miscounted a wagon.',
    "When six wagons rolled through empty and the drivers couldn't say why, the numbers wouldn't leave her alone.",
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

const MARTIAL_FULL: FullSheet = {
  skills: [
    { name: 'Athletics', proficient: true, expertise: false },
    { name: 'Intimidation', proficient: true, expertise: true },
    { name: 'Arcana', proficient: false, expertise: false },
  ],
  savingThrows: ['Strength', 'Constitution'],
  equipment: [
    { name: 'Longsword' },
    { name: 'Chain mail & shield' },
    { name: 'Ledger-stylus', gloss: 'Sharpened. Sentimental. Occasionally lethal.' },
  ],
  spells: [],
}

// A caster (a Wizard): the curated + full spells panels are present.
const CASTER_CURATED: CuratedSheet = {
  ...MARTIAL_CURATED,
  name: 'Ilma the Unwritten',
  identityLine: 'Level 3 · Gnome Wizard · Evocation',
  spells: [
    { name: 'Fire Bolt', gloss: 'Cantrip · a mote of directed flame.' },
    { name: 'Shield', gloss: 'Reaction · a sudden wall of force.' },
    { name: 'Magic Missile' },
  ],
}

const CASTER_FULL: FullSheet = {
  ...MARTIAL_FULL,
  savingThrows: ['Intelligence', 'Wisdom'],
  spells: [
    { name: 'Fire Bolt' },
    { name: 'Shield' },
    { name: 'Magic Missile' },
    { name: 'Detect Magic' },
  ],
}

const noop = (): void => undefined

function baseProps(overrides: Partial<React.ComponentProps<typeof CharacterSheetReveal>> = {}) {
  return {
    curated: MARTIAL_CURATED,
    full: MARTIAL_FULL,
    expanded: false,
    onToggleExpand: noop,
    onConfirm: noop,
    onStartOver: noop,
    ...overrides,
  }
}

describe('CharacterSheetReveal', () => {
  it('renders the name and the identity eyebrow', () => {
    const { getByText } = render(<CharacterSheetReveal {...baseProps()} />)
    expect(getByText('Kessa Vurm')).toBeInTheDocument()
    expect(
      getByText('Level 3 · Human Fighter · Champion · Toll-clerk of Greenward'),
    ).toBeInTheDocument()
  })

  it('renders the stat stripe — every label over its value', () => {
    const { getByTestId } = render(<CharacterSheetReveal {...baseProps()} />)
    const stripe = within(getByTestId('character-sheet-reveal-stripe'))
    for (const stat of MARTIAL_CURATED.stats) {
      expect(stripe.getByText(stat.label)).toBeInTheDocument()
      expect(stripe.getByText(stat.value)).toBeInTheDocument()
    }
  })

  it('renders the six ability tiles with the score and the formatted modifier', () => {
    const { getAllByTestId } = render(<CharacterSheetReveal {...baseProps()} />)
    const tiles = getAllByTestId('character-sheet-reveal-ability')
    expect(tiles).toHaveLength(6)
    const byAbbrev = (abbrev: string): HTMLElement => {
      const tile = tiles.find((t) => t.getAttribute('data-abbrev') === abbrev)
      if (!tile) throw new Error(`no tile for ${abbrev}`)
      return tile
    }
    // Positive, zero, and negative modifiers all get an explicit sign.
    expect(byAbbrev('STR').textContent).toContain('16')
    expect(byAbbrev('STR').textContent).toContain('+3')
    expect(byAbbrev('WIS').textContent).toContain('+0')
    expect(byAbbrev('CHA').textContent).toContain('−1')
  })

  it('renders the connection prose paragraphs', () => {
    const { getByText } = render(<CharacterSheetReveal {...baseProps()} />)
    for (const para of MARTIAL_CURATED.prose) {
      expect(getByText(para)).toBeInTheDocument()
    }
  })

  it('renders the features and equipment panels (name + gloss)', () => {
    const { getByTestId } = render(<CharacterSheetReveal {...baseProps()} />)
    const features = within(getByTestId('character-sheet-reveal-features'))
    expect(features.getByText('Second Wind')).toBeInTheDocument()
    expect(features.getByText('One extra action when it counts. Once per rest.')).toBeInTheDocument()
    const equipment = within(getByTestId('character-sheet-reveal-equipment'))
    expect(equipment.getByText('Longsword')).toBeInTheDocument()
  })

  it('renders the spells panel ONLY for a caster (present with spells, absent for a martial)', () => {
    const martial = render(<CharacterSheetReveal {...baseProps()} />)
    expect(martial.queryByTestId('character-sheet-reveal-spells')).toBeNull()

    const caster = render(
      <CharacterSheetReveal {...baseProps({ curated: CASTER_CURATED, full: CASTER_FULL })} />,
    )
    const spells = within(caster.getByTestId('character-sheet-reveal-spells'))
    expect(spells.getByText('Fire Bolt')).toBeInTheDocument()
    expect(spells.getByText('Magic Missile')).toBeInTheDocument()
  })

  it('hides the full sheet when expanded=false', () => {
    const { queryByTestId } = render(<CharacterSheetReveal {...baseProps({ expanded: false })} />)
    expect(queryByTestId('character-sheet-reveal-full')).toBeNull()
  })

  it('shows the full skills + saving throws inline when expanded=true', () => {
    const { getByTestId } = render(<CharacterSheetReveal {...baseProps({ expanded: true })} />)
    const full = within(getByTestId('character-sheet-reveal-full'))
    // All skills, proficient AND non-proficient, with their state exposed.
    expect(full.getByText('Athletics')).toBeInTheDocument()
    expect(full.getByText('Arcana')).toBeInTheDocument()
    // Saving throws.
    const saves = full.getByTestId('character-sheet-reveal-saves')
    expect(saves.textContent).toContain('Strength')
    expect(saves.textContent).toContain('Constitution')
  })

  it('exposes each skill proficiency state (expertise / proficient / none) as data', () => {
    const { getAllByTestId } = render(<CharacterSheetReveal {...baseProps({ expanded: true })} />)
    const rows = getAllByTestId('character-sheet-reveal-skill')
    const stateFor = (name: string): string | null => {
      const row = rows.find((r) => r.textContent.startsWith(name))
      return row?.getAttribute('data-skill-state') ?? null
    }
    expect(stateFor('Athletics')).toBe('proficient')
    expect(stateFor('Intimidation')).toBe('expertise')
    expect(stateFor('Arcana')).toBe('none')
  })

  it('renders the full spells only for a caster (empty for a martial)', () => {
    const martial = render(<CharacterSheetReveal {...baseProps({ expanded: true })} />)
    expect(martial.queryByTestId('character-sheet-reveal-full-spells')).toBeNull()

    const caster = render(
      <CharacterSheetReveal
        {...baseProps({ curated: CASTER_CURATED, full: CASTER_FULL, expanded: true })}
      />,
    )
    const fullSpells = within(caster.getByTestId('character-sheet-reveal-full-spells'))
    expect(fullSpells.getByText('Detect Magic')).toBeInTheDocument()
  })

  it('the toggle label reflects the expanded state', () => {
    const collapsed = render(<CharacterSheetReveal {...baseProps({ expanded: false })} />)
    expect(collapsed.getByRole('button', { name: /see full sheet/i })).toBeInTheDocument()
    const opened = render(<CharacterSheetReveal {...baseProps({ expanded: true })} />)
    expect(opened.getByRole('button', { name: /hide full sheet/i })).toBeInTheDocument()
  })

  it('fires onToggleExpand — and nothing else — when the toggle is pressed (pure, no network)', async () => {
    const onToggleExpand = vi.fn()
    const onConfirm = vi.fn()
    const onStartOver = vi.fn()
    const user = userEvent.setup()
    const { getByRole } = render(
      <CharacterSheetReveal {...baseProps({ onToggleExpand, onConfirm, onStartOver })} />,
    )
    await user.click(getByRole('button', { name: /see full sheet/i }))
    expect(onToggleExpand).toHaveBeenCalledOnce()
    expect(onConfirm).not.toHaveBeenCalled()
    expect(onStartOver).not.toHaveBeenCalled()
  })

  it('fires onConfirm from "This is me"', async () => {
    const onConfirm = vi.fn()
    const user = userEvent.setup()
    const { getByRole } = render(<CharacterSheetReveal {...baseProps({ onConfirm })} />)
    await user.click(getByRole('button', { name: /this is me/i }))
    expect(onConfirm).toHaveBeenCalledOnce()
  })

  it('fires onStartOver from "Start over"', async () => {
    const onStartOver = vi.fn()
    const user = userEvent.setup()
    const { getByRole } = render(<CharacterSheetReveal {...baseProps({ onStartOver })} />)
    await user.click(getByRole('button', { name: /start over/i }))
    expect(onStartOver).toHaveBeenCalledOnce()
  })

  it('is flat 1-bit / square (the ability tiles carry rounded-none, no circles)', () => {
    const { getAllByTestId } = render(<CharacterSheetReveal {...baseProps()} />)
    const [firstTile] = getAllByTestId('character-sheet-reveal-ability')
    if (!firstTile) throw new Error('no ability tiles')
    expect(firstTile.className).toContain('rounded-none')
  })

  it('carries a data-testid on the root', () => {
    const { getByTestId } = render(<CharacterSheetReveal {...baseProps()} />)
    expect(getByTestId('character-sheet-reveal')).toBeInTheDocument()
  })

  it('forwards the ref to the root element', () => {
    const ref = createRef<HTMLDivElement>()
    render(<CharacterSheetReveal ref={ref} {...baseProps()} />)
    expect(ref.current).toBeInstanceOf(HTMLDivElement)
  })

  it('has no a11y violations (collapsed martial, expanded caster)', async () => {
    const collapsed = render(<CharacterSheetReveal {...baseProps()} />)
    expect(await axe(collapsed.container)).toHaveNoViolations()
    const expanded = render(
      <CharacterSheetReveal
        {...baseProps({ curated: CASTER_CURATED, full: CASTER_FULL, expanded: true })}
      />,
    )
    expect(await axe(expanded.container)).toHaveNoViolations()
  })
})
