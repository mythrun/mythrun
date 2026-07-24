import { useState } from 'react'
import type { Meta, StoryObj } from '@storybook/react-vite'
import type { CardItem, RollCardLabels, RollPhase } from '@mythrun/client-core/contract'
import { RollCard } from './RollCard.tsx'

// RollCard — the in-stream dice moment (MYT-93). A skill_check / dice_roll transcript
// item rendered as a square/paper card: skill + context + posture → a Roll button → a
// stepped DieSpin → the mod/total/DC/tier readout → Continue. It is PURE THEATER over
// an already-server-resolved number — pressing Roll sends NOTHING to the server, it
// only reveals a number the frame already carried; Continue releases the buffered
// post-check prose. The outcome tier is carried by typographic WEIGHT (fail plain,
// success medium, great_success semibold), never a colour chip. The `constraint` seed
// is never shown.
//
// Do: keep the die + numerals in `--font-ui`; let `phase` (route-derived) drive which
//   affordance shows; honour reduced motion (the die lands with no spin).
// Don't: render `constraint`; add status dots/chips; colour the tier.
// Content/i18n: `skill` / `context` / roll numbers are DATA; the button + tier + DC
//   words are resolved i18n labels (sample copy here — stories are i18n-exempt).

const STORY_LABELS: RollCardLabels = {
  roll: 'Roll',
  continue: 'Continue',
  tier: { fail: 'Failure', success: 'Success', great_success: 'Critical success' },
  dc: 'DC',
  advantage: 'Advantage',
  disadvantage: 'Disadvantage',
  dieResult: 'You rolled',
}

// `satisfies` (not `: CardItem`) so SKILL keeps its concrete skill_check type —
// the `withTier` / SKILL_ADV spreads below need `SKILL.frame` narrowed to the
// skill frame (a union-typed frame can't take `outcomeTier` / `rollType`).
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

const SKILL_ADV: CardItem = {
  ...SKILL,
  key: 'sc-adv',
  frame: { ...SKILL.frame, roll: 14, roll2: 9, rollType: 'advantage' },
}

const DICE: CardItem = {
  kind: 'dice_roll',
  key: 'dr-1',
  turnId: 'T1',
  frame: { type: 'dice_roll', turnId: 'T1', count: 2, sides: 20, results: [8, 9], total: 17 },
}

function withTier(outcomeTier: 'fail' | 'success' | 'great_success', key: string): CardItem {
  return { ...SKILL, key, frame: { ...SKILL.frame, outcomeTier } }
}

// Static specimens don't advance phase (the Interactive story shows the real
// Roll → reveal → Continue flow); their callbacks are inert.
const noop = (): void => undefined

// A self-driving harness mirroring the route: Roll → revealed, Continue → released.
function InteractiveDemo({ item, reducedMotion = false }: { item: CardItem; reducedMotion?: boolean }): React.JSX.Element {
  const [phase, setPhase] = useState<RollPhase>('idle')
  return (
    <RollCard
      item={item}
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
  )
}

const meta: Meta<typeof RollCard> = {
  title: 'Session/RollCard',
  component: RollCard,
  tags: ['autodocs'],
  args: {
    labels: STORY_LABELS,
    reducedMotion: false,
    onRoll: noop,
    onContinue: noop,
  },
  // A paper page ground + the stream's column width so the card reads as it does live.
  decorators: [
    (Story) => (
      <div className="bg-bg p-[var(--space-6)]">
        <div className="max-w-[36rem]">
          <Story />
        </div>
      </div>
    ),
  ],
}

// eslint-disable-next-line no-restricted-syntax -- Storybook CSF requires the meta object as the module's default export.
export default meta

type Story = StoryObj<typeof RollCard>

// Idle — the header + the Roll invitation; the die sits un-stamped.
export const SkillIdle: Story = {
  name: 'Skill — idle (Roll)',
  args: { item: SKILL, phase: 'idle' },
}

// Revealed at each tier — the readout stamps in; the tier is a WEIGHT, not a colour.
export const SkillRevealedFail: Story = {
  name: 'Skill — revealed (fail / plain)',
  args: { item: withTier('fail', 'sc-fail'), phase: 'revealed' },
}

export const SkillRevealedSuccess: Story = {
  name: 'Skill — revealed (success / medium)',
  args: { item: withTier('success', 'sc-succ'), phase: 'revealed' },
}

export const SkillRevealedGreat: Story = {
  name: 'Skill — revealed (great success / semibold)',
  args: { item: withTier('great_success', 'sc-great'), phase: 'revealed' },
}

// Advantage — both raw dice ride a mono note beside the readout.
export const SkillAdvantage: Story = {
  name: 'Skill — advantage (both dice)',
  args: { item: SKILL_ADV, phase: 'revealed' },
}

// Released — the settled record: readout, no Continue (the prose has been released).
export const SkillReleased: Story = {
  name: 'Skill — released (settled)',
  args: { item: SKILL, phase: 'released' },
}

// Dice roll — the flavor variant: NdM + the stamped total, no DC/tier/Continue.
export const DiceRoll: Story = {
  name: 'Dice roll (2d20)',
  args: { item: DICE, phase: 'released' },
}

// Interactive — press Roll, watch the die spin and settle, then Continue.
export const Interactive: Story = {
  name: 'Interactive (Roll → reveal → Continue)',
  render: () => <InteractiveDemo item={SKILL} />,
}

// Reduced motion — the die lands instantly on Roll, no spin (Continue still explicit).
export const ReducedMotion: Story = {
  name: 'Reduced motion (instant land)',
  render: () => <InteractiveDemo item={SKILL} reducedMotion />,
}

// Mobile — the card at ~375px; header, die, and readout hold together.
export const Mobile: Story = {
  name: 'Mobile (~375px)',
  render: () => (
    <div className="max-w-[375px]">
      <InteractiveDemo item={SKILL} />
    </div>
  ),
}
