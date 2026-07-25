import { forwardRef, useState } from 'react'
import type { ReactNode } from 'react'
import type { CardItem, RollCardLabels, RollCardProps } from '@mythrun/client-core/contract'
import { cn } from '../../lib/cn.ts'
import { TYPE_ROLE_CLASS } from '../../lib/typography.ts'
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
// twMerge lets it override the base `font-ui` weight. myth-89hfu: the outcome is the
// card's whole point, so it's PROMOTED to the typographic peak (TIER_SIZE) below the
// die — the reader sees the win without hunting a footnote-sized word.
const TIER_WEIGHT: Record<SkillItem['frame']['outcomeTier'], string> = {
  fail: 'font-medium',
  success: 'font-semibold',
  great_success: 'font-bold',
}
// The promoted outcome sits at roughly the die's scale — the largest weighted token on
// the card. `leading-tight` keeps a wrapped "Critical success" compact.
const TIER_SIZE = 'text-2xl leading-tight'

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

// The skill-check header: the skill + the player's OWN modifier (mono eyebrow) +
// character & posture + the context sub-line. myth-89hfu: the modifier is revealed
// PRE-roll ("investigation +6") — it's the player's competence, theirs to weigh
// before the die drops ("I need a 7+, here goes"); only the DC stays hidden for
// mystery. `context` is quiet DATA (the attempt, not a key); `constraint` is absent
// by construction — it is never threaded here. myth-3dufc: while the roll is still
// PENDING, one quiet newcomer framing line ("Roll a d20 · Investigation +0 is your
// bonus") turns the stat fragment into a sentence — dropped once the equation
// carries the mental model post-roll. The context line is CENTERED with the rest
// of the card (the ceremonial composition; mixed alignment read as unfinished).
function SkillHeader({
  frame,
  labels,
  pending,
}: {
  frame: SkillItem['frame']
  labels: RollCardLabels
  pending: boolean
}): ReactNode {
  const posture =
    frame.rollType === 'advantage'
      ? labels.advantage
      : frame.rollType === 'disadvantage'
        ? labels.disadvantage
        : null
  return (
    <Stack gap={1} align="center">
      <Stack direction="row" gap={2} align="center" justify="center" wrap>
        <Text role="ui-label">{frame.skill}</Text>
        {/* The player's own modifier, revealed before the roll (mechanical
            notation — a signed number, not translatable copy). */}
        <span data-testid="roll-modifier" className="font-ui text-sm">
          {signed(frame.modifier)}
        </span>
      </Stack>
      <Stack direction="row" gap={2} align="center" justify="center" wrap>
        <Text role="meta">{frame.characterName}</Text>
        {posture !== null && <Text role="meta">{posture}</Text>}
      </Stack>
      <p className={cn(TYPE_ROLE_CLASS.meta, 'text-center')}>{frame.context}</p>
      {pending && (
        <p data-testid="roll-explainer" className={cn(TYPE_ROLE_CLASS.meta, 'text-center')}>
          {labels.explainerFor(frame.skill, signed(frame.modifier))}
        </p>
      )}
    </Stack>
  )
}

// The full natural-roll + modifier equation ("10 + 6 = 16"), repeating the die's
// numeral as the left operand so the arithmetic is whole on the card — a new player
// never has to reach back up into the die to reconstruct it (myth-89hfu). The die
// stamps the same natural roll (dieNumber), so the two agree.
function equationText(frame: SkillItem['frame']): string {
  const natRoll = frame.total - frame.modifier
  const op = frame.modifier < 0 ? '-' : '+'
  return `${String(natRoll)} ${op} ${String(Math.abs(frame.modifier))} = ${String(frame.total)}`
}

// The settled skill-check readout under the die (myth-89hfu): the WHOLE equation
// (die-anchored "10 + 6 = 16"), then the explicit pass/fail comparison ("16 beats
// DC 13" — the DC is revealed here, post-roll), then the PROMOTED outcome word at
// the typographic peak (weight carries the tier, never a colour chip). The die →
// math → comparison → outcome read as ONE causal beat. On adv/dis a small mono note
// carries BOTH raw dice.
function SkillReadout({ frame, labels }: { frame: SkillItem['frame']; labels: RollCardLabels }): ReactNode {
  const passed = frame.outcomeTier !== 'fail'
  const verb = passed ? labels.beats : labels.misses
  // myth-4sxhd: a NATURAL 20 (the used d20 face, not the modified total) is the
  // table's slot-machine moment — the outcome word earns the system's native
  // "loud": the inverted plate (ink field, paper letters) at display size. Both
  // tokens are theme-aware; no colour, no curve, one move.
  const nat20 = frame.total - frame.modifier === 20
  return (
    <Stack gap={2} align="center">
      <span data-testid="roll-equation" className="font-ui text-base">
        {equationText(frame)}
      </span>
      {/* The explicit comparison, composed inline from DATA + connective words so
          no arithmetic is required (same inline-compose pattern as the DC readout). */}
      <span data-testid="roll-comparison" className="font-ui text-sm">
        {frame.total} {verb} {labels.dc} {frame.dc}
      </span>
      {/* myth-3dufc: the quiet post-roll DC explainer — the target was hidden
          until commitment, so its one-line meaning lands here, with it. */}
      <p data-testid="roll-dc-explainer" className={cn(TYPE_ROLE_CLASS.meta, 'text-center')}>
        {labels.dcExplainer}
      </p>
      {/* The outcome — the card's whole point — at the typographic peak. */}
      <span
        data-tier={frame.outcomeTier}
        data-testid="roll-outcome"
        className={cn(
          'font-ui',
          TIER_SIZE,
          TIER_WEIGHT[frame.outcomeTier],
          nat20 && 'bg-ink px-[var(--space-3)] py-[var(--space-1)] text-surface',
        )}
      >
        {labels.tier[frame.outcomeTier]}
      </span>
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
          <SkillHeader frame={item.frame} labels={labels} pending={!revealed} />
        ) : (
          <DiceHeader frame={item.frame} />
        )}
        <DieSpin
          spinning={spinning}
          result={revealed ? dieNumber(item) : null}
          reducedMotion={reducedMotion}
          onSpinComplete={handleSpinComplete}
          resultLabel={labels.dieResult}
          // myth-0qvay: a skill check is always a d20; a dice_roll shows its own
          // die shape (NdM → the M-sided silhouette).
          sides={item.kind === 'dice_roll' ? item.frame.sides : 20}
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
