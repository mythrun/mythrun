import { useEffect, useState } from 'react'
import { CharacterLoadingBeat, CharacterSheetReveal } from '@mythrun/ui'
import type { CuratedSheet, FullSheet, LoadingBeat } from '@mythrun/client-core/contract'
import type { AuditSection } from '../types.ts'

// ── CharacterLoadingBeat: the 1-bit figure that FILLS IN (a Dither hatch rising from
//    the base) as beats resolve pending → active → done. We advance the beats on a
//    loop so the fill visibly rises and the rows surface. NOTE: the figure itself is
//    intentionally theme-INVARIANT (frozen paper/Dither tokens) — only the card frame
//    flips between the light/dark swatches, by design.
const BEAT_LABELS = [
  'Kessa Vurm — a name surfaces',
  'Human · Fighter — Champion',
  'rolling ability scores…',
  'gathering equipment…',
]
function beatsAt(done: number): LoadingBeat[] {
  return BEAT_LABELS.map((label, i) => ({
    id: `b${String(i)}`,
    label,
    state: i < done ? 'done' : i === done ? 'active' : 'pending',
  }))
}

function LoadingBeatLoop({ reducedMotion }: { reducedMotion: boolean }): React.JSX.Element {
  const [done, setDone] = useState(0)
  useEffect(() => {
    const id = window.setInterval(() => {
      setDone((d) => (d >= BEAT_LABELS.length ? 0 : d + 1))
    }, 1300)
    return () => {
      window.clearInterval(id)
    }
  }, [])
  return (
    <div className="bg-bg p-[var(--space-6)]">
      <CharacterLoadingBeat beats={beatsAt(done)} reducedMotion={reducedMotion} countdownLabel="[ph: ~2:10 left]" />
    </div>
  )
}

// ── CharacterSheetReveal: the "meet your character" field-guide entry. Its motion is
//    the controlled "See full sheet" inline expand; we toggle it on a loop. Verbatim
//    martial fixture (no spells) from the story.
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
    'Kessa spent eleven years stamping manifests at the Greenward Toll, and she never once miscounted a wagon. She keeps her old ledger-stylus sharpened to a point that could open a letter — or a throat. Broad through the shoulders, careful with her hands, slow to anger and unnerving once she gets there.',
    "When six wagons rolled through empty and the drivers couldn't say why, the numbers wouldn't leave her alone. She's the only one who noticed. That's usually how it starts.",
  ],
  features: [
    { name: 'Second Wind', gloss: 'Catch her breath: recover a burst of HP once per rest.' },
    { name: 'Action Surge', gloss: 'One extra action when it counts. Once per rest.' },
    { name: 'Improved Critical', gloss: 'Champion: her blade bites on a 19 or 20.' },
    { name: 'Fighting Style: Defense', gloss: "+1 AC while she's wearing armor." },
  ],
  equipment: [
    { name: 'Longsword', gloss: "Versatile · her father's, re-hilted." },
    { name: 'Chain mail & shield' },
    { name: 'Ledger-stylus', gloss: 'Sharpened. Sentimental. Occasionally lethal.' },
    { name: 'Belt pouch · 9 gp' },
  ],
}

const MARTIAL_FULL: FullSheet = {
  skills: [
    { name: 'Acrobatics', proficient: false, expertise: false },
    { name: 'Athletics', proficient: true, expertise: false },
    { name: 'Deception', proficient: false, expertise: false },
    { name: 'History', proficient: false, expertise: false },
    { name: 'Insight', proficient: true, expertise: false },
    { name: 'Intimidation', proficient: true, expertise: true },
    { name: 'Investigation', proficient: false, expertise: false },
    { name: 'Perception', proficient: true, expertise: false },
    { name: 'Persuasion', proficient: false, expertise: false },
    { name: 'Survival', proficient: false, expertise: false },
  ],
  savingThrows: ['Strength', 'Constitution'],
  equipment: [
    { name: 'Longsword', gloss: "Versatile · her father's, re-hilted." },
    { name: 'Chain mail' },
    { name: 'Shield' },
    { name: 'Ledger-stylus' },
    { name: "Explorer's pack" },
    { name: 'Belt pouch · 9 gp' },
  ],
  spells: [],
}

function SheetRevealLoop(): React.JSX.Element {
  const [expanded, setExpanded] = useState(false)
  useEffect(() => {
    const id = window.setInterval(() => {
      setExpanded((v) => !v)
    }, 3600)
    return () => {
      window.clearInterval(id)
    }
  }, [])
  return (
    <div className="bg-bg p-[var(--space-6)]">
      <CharacterSheetReveal
        curated={MARTIAL_CURATED}
        full={MARTIAL_FULL}
        expanded={expanded}
        onToggleExpand={() => {
          setExpanded((v) => !v)
        }}
        onConfirm={() => undefined}
        onStartOver={() => undefined}
      />
    </div>
  )
}

export const characterSections: AuditSection[] = [
  {
    id: 'character-loading',
    name: 'CharacterLoadingBeat — coming into being',
    path: 'frontend/ui/src/components/CharacterLoadingBeat',
    where: 'Character-creation loading screen while the sheet pipeline runs',
    note: 'Full-width quantized meter under the beat rows: position = beats done ÷ total, honest and monotonic; each completion lands over 4 decelerating quantized frames with a single settle frame at 100%. The fill now takes the theme-flipping token tone (frozen paper remains an opt-in relic). Reduced motion: position lands instantly.',
    height: 220,
    render: ({ reducedMotion, replayKey }) => (
      <div className="h-full w-full bg-bg" style={{ height: 220 }}>
        <LoadingBeatLoop key={replayKey} reducedMotion={reducedMotion} />
      </div>
    ),
  },
  {
    id: 'character-sheet-reveal',
    name: 'CharacterSheetReveal — meet your character',
    path: 'frontend/ui/src/components/CharacterSheetReveal',
    where: 'Character-creation payoff screen (after the loading beat)',
    note: 'The field-guide entry. Its motion is the controlled "See full sheet" inline expand of the full mechanical sheet — toggled here on a loop. (Reduced motion is not a separate prop here; the expand is a content reveal.)',
    height: 560,
    render: ({ replayKey }) => (
      <div className="h-full w-full overflow-y-auto" style={{ height: 560 }}>
        <SheetRevealLoop key={replayKey} />
      </div>
    ),
  },
]
