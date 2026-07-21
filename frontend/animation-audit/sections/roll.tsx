import { useEffect, useRef, useState } from 'react'
import { DieSpin, RollCard } from '@mythrun/ui'
import type { CardItem, RollCardLabels, RollPhase } from '@mythrun/client-core/contract'
import type { AuditSection } from '../types.ts'

// ── DieSpin: the stepped d20 (8 × 45° steps ≈ 1s revolution), auto-rolling on a
//    loop. Mirrors the story's SpinDemo contract (roll → spin → land the numeral on
//    onSpinComplete). Reduced motion lands instantly.
function DieSpinLoop({ reducedMotion }: { reducedMotion: boolean }): React.JSX.Element {
  const [spinning, setSpinning] = useState(false)
  const [result, setResult] = useState<number | null>(null)
  useEffect(() => {
    const roll = (): void => {
      setResult(Math.floor(Math.random() * 20) + 1)
      setSpinning(true)
    }
    roll()
    const id = window.setInterval(roll, 2600)
    return () => {
      window.clearInterval(id)
    }
  }, [])
  return (
    <div className="flex h-full w-full items-center justify-center text-ink">
      <DieSpin
        spinning={spinning}
        result={result}
        reducedMotion={reducedMotion}
        onSpinComplete={() => {
          setSpinning(false)
        }}
        {...(result === null ? {} : { resultLabel: `[ph: you rolled a ${String(result)}]` })}
      />
    </div>
  )
}

// ── RollCard: the in-stream dice moment. Auto-cycles the real route phases
//    idle → revealed → released → idle so the DieSpin spin, the weight-tiered
//    readout, and the Continue affordance all play. Verbatim fixture from the story.
const STORY_LABELS: RollCardLabels = {
  roll: 'Roll',
  continue: 'Continue',
  tier: { fail: 'Failure', success: 'Success', great_success: 'Great success' },
  dc: 'DC',
  advantage: 'advantage',
  disadvantage: 'disadvantage',
  dieResult: 'You rolled',
}

const SKILL = {
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
} satisfies CardItem

function RollCardLoop({ reducedMotion }: { reducedMotion: boolean }): React.JSX.Element {
  const [phase, setPhase] = useState<RollPhase>('idle')
  const timers = useRef<number[]>([])
  useEffect(() => {
    const cycle = (): void => {
      timers.current.forEach((t) => {
        window.clearTimeout(t)
      })
      timers.current = []
      setPhase('idle')
      timers.current.push(window.setTimeout(() => setPhase('revealed'), 1400))
      timers.current.push(window.setTimeout(() => setPhase('released'), 4200))
      timers.current.push(window.setTimeout(cycle, 6800))
    }
    cycle()
    return () => {
      timers.current.forEach((t) => {
        window.clearTimeout(t)
      })
    }
  }, [])
  return (
    <div className="bg-bg p-[var(--space-6)]">
      <div className="mx-auto max-w-[36rem]">
        <RollCard
          item={SKILL}
          phase={phase}
          reducedMotion={reducedMotion}
          labels={STORY_LABELS}
          onRoll={() => {
            setPhase('revealed')
          }}
          onContinue={() => {
            setPhase('released')
          }}
        />
      </div>
    </div>
  )
}

export const rollSections: AuditSection[] = [
  {
    id: 'die-spin',
    name: 'DieSpin — d20 roll',
    path: 'frontend/ui/src/components/DieSpin',
    where: 'Inside RollCard, on the Roll press (live session skill/dice checks)',
    note: 'Stepped 45° rotation with a decelerating dwell ramp (~50→220ms into the landing), one discrete scale-pop recoil frame, then stillness; the numeral stamps into the facet-band die’s open equatorial field — no stroke ever crosses it. Auto-rolls every ~2.6s. Reduced motion: instant land, no spin.',
    height: 180,
    render: ({ reducedMotion, replayKey }) => (
      <div className="h-full w-full bg-bg" style={{ height: 180 }}>
        <DieSpinLoop key={replayKey} reducedMotion={reducedMotion} />
      </div>
    ),
  },
  {
    id: 'roll-card',
    name: 'RollCard — in-stream dice moment',
    path: 'frontend/ui/src/components/RollCard',
    where: 'In the live-play transcript for a skill_check / dice_roll item',
    note: 'Auto-cycles idle → revealed → released: Roll spins the DieSpin, the total/DC/tier readout stamps in (tier = typographic weight, never a colour chip), then Continue. Reduced motion: die lands instantly.',
    height: 360,
    render: ({ reducedMotion, replayKey }) => (
      <div className="h-full w-full overflow-y-auto" style={{ height: 360 }}>
        <RollCardLoop key={replayKey} reducedMotion={reducedMotion} />
      </div>
    ),
  },
]
