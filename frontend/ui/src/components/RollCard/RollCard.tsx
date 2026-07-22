import { forwardRef, useState } from 'react'
import type { ReactNode } from 'react'
import type { CardItem, RollCardLabels, RollCardProps } from '@mythrun/client-core/contract'
import { cn } from '../../lib/cn.ts'
import { Button } from '../Button/Button.tsx'
import { Stack } from '../Stack/Stack.tsx'
import { Text } from '../Text/Text.tsx'
import { DieSpin } from '../DieSpin/DieSpin.tsx'

// RollCard (MYT-93, spec §5) — the in-stream dice moment. A skill_check / dice_roll
// transcript item rendered as a square/paper card: skill + context + posture → a Roll
// button → a stepped DieSpin → the mod/total/DC/tier readout → Continue. It is PURE
// THEATER over an already-server-resolved number: the roll arrived whole in ONE frame,
// so pressing Roll sends NOTHING to the server — it only reveals a number we already
// hold. `phase` is DERIVED route-side (client-core `cardPhase`) and passed in, so
// @mythrun/ui holds no reveal runtime (R1); the LOCAL `spinning` state is the only
// in-component reveal step (the DieSpin transition between idle and revealed).
//
// The `constraint` field is NEVER rendered (it is the seed the DM's gated post-check
// prose is written from — showing it would pre-empt the buffered narrative). Two faces
// only: every mechanical readout (die numeral, modifier/total/DC/tier, dice notation)
// is `--font-ui`; the outcome tier is carried by typographic WEIGHT, never a colour
// chip (the no-status-chips register). Square/flat-1-bit, no circles.

type SkillItem = Extract<CardItem, { kind: 'skill_check' }>
type DiceItem = Extract<CardItem, { kind: 'dice_roll' }>

// outcomeTier → its font WEIGHT (spec §5: the tier signal is TYPOGRAPHIC WEIGHT, never
// a colour chip). fail reads plain, success a touch heavier, great_success heaviest;
// twMerge lets it override the base `font-ui` weight.
const TIER_WEIGHT: Record<SkillItem['frame']['outcomeTier'], string> = {
  fail: 'font-normal',
  success: 'font-medium',
  great_success: 'font-semibold',
}

// The paper card frame: flat 1-bit, SQUARE (rounded-none), a hairline strong edge over
// the surface fill — a mechanical interjection distinct from the DM's serif prose row.
// Its content is centred (the dice-moment composition).
const CARD_CLASS = cn(
  'rounded-none border border-border-strong bg-surface',
  'px-[var(--space-5)] py-[var(--space-4)]',
)

// The die stamps the USED d20: skill_check shows the effective natural roll
// (total − modifier — matches adv/dis without exposing both dice on the face);
// dice_roll shows the summed total.
function dieNumber(item: CardItem): number {
  return item.kind === 'dice_roll' ? item.frame.total : item.frame.total - item.frame.modifier
}

// A signed modifier readout (+0 / +2 / -1) in the mono register.
function signed(n: number): string {
  return n >= 0 ? `+${String(n)}` : String(n)
}

// The skill-check header: skill (mono eyebrow) + character & posture + the context
// sub-line. `context` is quiet DATA (the attempt, not a key). `constraint` is absent
// by construction — it is never threaded here.
function SkillHeader({ frame, labels }: { frame: SkillItem['frame']; labels: RollCardLabels }): ReactNode {
  const posture =
    frame.rollType === 'advantage'
      ? labels.advantage
      : frame.rollType === 'disadvantage'
        ? labels.disadvantage
        : null
  return (
    <Stack gap={1} align="center">
      <Text role="ui-label">{frame.skill}</Text>
      <Stack direction="row" gap={2} align="center" justify="center" wrap>
        <Text role="meta">{frame.characterName}</Text>
        {posture !== null && <Text role="meta">{posture}</Text>}
      </Stack>
      <Text role="meta">{frame.context}</Text>
    </Stack>
  )
}

// The settled skill-check readout under the die: the modifier→total tail, the DC, and
// the outcome tier as WEIGHT. On adv/dis a small mono note carries BOTH raw dice.
function SkillReadout({ frame, labels }: { frame: SkillItem['frame']; labels: RollCardLabels }): ReactNode {
  return (
    <Stack gap={1} align="center">
      <span className="font-ui text-sm">
        {/* eslint-disable-next-line mythrun-ui/no-untranslated-jsx-text -- dice arithmetic notation, not translatable copy */}
        {signed(frame.modifier)} = {frame.total}
      </span>
      <Stack direction="row" gap={2} align="center" justify="center" wrap>
        <span className="font-ui text-sm">
          {labels.dc} {frame.dc}
        </span>
        <span data-tier={frame.outcomeTier} className={cn('font-ui text-sm', TIER_WEIGHT[frame.outcomeTier])}>
          {labels.tier[frame.outcomeTier]}
        </span>
      </Stack>
      {frame.roll2 !== null && (
        <Text role="meta">
          {/* eslint-disable-next-line mythrun-ui/no-untranslated-jsx-text -- dice-pair separator notation, not translatable copy */}
          {frame.roll} / {frame.roll2}
        </Text>
      )}
    </Stack>
  )
}

// The dice-roll header: the terse `NdM` notation (no skill/DC/context — the flavor
// variant). The rolled total stamps in the die centre once revealed.
function DiceHeader({ frame }: { frame: DiceItem['frame'] }): ReactNode {
  return (
    <span className="font-ui text-sm font-medium">
      {/* eslint-disable-next-line mythrun-ui/no-untranslated-jsx-text -- NdM dice notation, not translatable copy */}
      {frame.count}d{frame.sides}
    </span>
  )
}

export const RollCard = forwardRef<HTMLDivElement, RollCardProps>(function RollCard(
  { item, phase, reducedMotion, labels, onRoll, onContinue },
  ref,
) {
  // The ONLY in-component reveal state: the local DieSpin transition. Roll flips it
  // true; DieSpin lands and calls back; we clear it and commit the roll route-side.
  const [spinning, setSpinning] = useState(false)
  const revealed = phase === 'revealed' || phase === 'released'

  function handleSpinComplete(): void {
    setSpinning(false)
    onRoll()
  }

  return (
    <div ref={ref} data-roll-card={item.kind} className={CARD_CLASS}>
      <Stack gap={3} align="center">
        {item.kind === 'skill_check' ? (
          <SkillHeader frame={item.frame} labels={labels} />
        ) : (
          <DiceHeader frame={item.frame} />
        )}
        <DieSpin
          spinning={spinning}
          result={revealed ? dieNumber(item) : null}
          reducedMotion={reducedMotion}
          onSpinComplete={handleSpinComplete}
          resultLabel={labels.dieResult}
        />
        {phase === 'idle' && !spinning && (
          <Button
            onPress={() => {
              setSpinning(true)
            }}
          >
            {labels.roll}
          </Button>
        )}
        {revealed && item.kind === 'skill_check' && <SkillReadout frame={item.frame} labels={labels} />}
        {phase === 'revealed' && item.kind === 'skill_check' && <Button onPress={onContinue}>{labels.continue}</Button>}
      </Stack>
    </div>
  )
})
