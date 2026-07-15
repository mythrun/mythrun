import type { Meta, StoryObj } from '@storybook/react-vite'
import type { ReactNode } from 'react'
import type { RollCardLabels, RollRevealView, TranscriptItem } from '@mythrun/client-core/contract'
import { MessageStream } from './MessageStream.tsx'
import { STORY_INDEX, STORY_LABELS } from '../DmMessage/highlight.fixture.ts'

// MessageStream — the live-play transcript. Pure/presentational: these specimens
// hand it fixed `items` snapshots + a plain-data reveal view; the real screen (the
// MYT-92/93 play route) wires the items from the client-core session view-model, the
// connection line from the transport state, and the reveal view/labels from the
// client-core roll-reveal selectors (`buildRevealView` + `useRollReveal`). Sample
// prose / names + label copy are realistic (stories are lint-exempt).
// The register to read for: DM in serif body, players + the non-card mechanical
// lines in mono `--font-ui`, square paper rows (no bubbles, no avatars, no circles),
// a light scene rule where a new DM turn opens — and, MYT-93, the skill_check /
// dice_roll rows as square RollCards (the dice moment), with a turn's outcome prose
// BUFFERED (rendered nothing) until its card is continued.

// The resolved [ph:] label bundle the play route threads to each RollCard. Sample
// copy here — stories are i18n-exempt; MYT-100 is the copy pass.
const ROLL_LABELS: RollCardLabels = {
  roll: 'Roll',
  continue: 'Continue',
  tier: { fail: 'Failure', success: 'Success', great_success: 'Great success' },
  dc: 'DC',
  advantage: 'advantage',
  disadvantage: 'disadvantage',
  dieResult: 'You rolled',
}

// A mixed multi-turn transcript: a DM beat + a player reply + a skill check, then
// a second DM turn that turns to combat (mode line, the enemy roster, a roll),
// resolves, and a fresh DM beat with an in-flight (pending) own message.
const TRANSCRIPT: TranscriptItem[] = [
  {
    kind: 'dm',
    key: 'dm-1',
    turnId: 'T1',
    text: 'The tavern door creaks open on a gust of cold rain. Lamplight gutters; a dozen faces turn, then look away. In the far corner, a hooded figure keeps their eyes on you.',
    streaming: false,
  },
  {
    kind: 'player',
    key: 'pl-1',
    turnId: null,
    seq: 5,
    userId: 'u1',
    displayName: 'Miklos',
    characterName: 'Kessa Vurm',
    text: 'I keep my hand near my blade and cross to the bar, watching the hooded one in the mirror.',
    pending: false,
  },
  {
    kind: 'skill_check',
    key: 'sc-1',
    turnId: 'T1',
    frame: {
      type: 'skill_check',
      turnId: 'T1',
      characterName: 'Kessa Vurm',
      skill: 'perception',
      context: 'reading the room in the bar mirror',
      roll: 14,
      roll2: null,
      rollType: 'normal',
      modifier: 0,
      total: 14,
      dc: 12,
      outcomeTier: 'success',
      constraint: 'She catches the figure loosening a dagger under the table.',
    },
  },
  {
    kind: 'dm',
    key: 'dm-2',
    turnId: 'T2',
    text: 'The figure moves first — a chair scrapes, steel glints, and two others rise from the shadows near the door.',
    streaming: false,
  },
  {
    kind: 'mode_change',
    key: 'mc-1',
    turnId: 'T2',
    frame: { type: 'mode_change', turnId: 'T2', from: 'exploration', to: 'combat', reason: 'ambush' },
  },
  {
    kind: 'combat_started',
    key: 'cs-1',
    turnId: 'T2',
    frame: {
      type: 'combat_started',
      turnId: 'T2',
      enemies: [
        { name: 'cutthroat', description: 'lean, quick', count: 2 },
        { name: 'hooded knifeman', description: 'the one who watched', count: 1 },
      ],
      initiative: [{ combatant: 'Kessa Vurm', roll: 18 }],
    },
  },
  {
    kind: 'dice_roll',
    key: 'dr-1',
    turnId: 'T2',
    frame: { type: 'dice_roll', turnId: 'T2', count: 1, sides: 20, results: [17], total: 17 },
  },
  {
    kind: 'combat_resolved',
    key: 'cr-1',
    turnId: 'T2',
    frame: {
      type: 'combat_resolved',
      turnId: 'T2',
      narration: 'The last cutthroat drops his knife and bolts into the rain.',
      outcome: 'victory',
      casualties: [],
      hpChanges: [{ combatant: 'Kessa Vurm', hpBefore: 12, hpAfter: 7, maxHp: 12 }],
    },
  },
  {
    kind: 'ledger_update',
    key: 'lu-1',
    turnId: 'T2',
    frame: {
      type: 'ledger_update',
      turnId: 'T2',
      characterName: 'Kessa Vurm',
      kind: 'hp',
      summary: 'Kessa takes 5 damage (12 → 7)',
    },
  },
  {
    kind: 'dm',
    key: 'dm-3',
    turnId: 'T3',
    text: 'Quiet returns. The barkeep sets down a chipped cup of something dark and slides it toward you without a word. On the underside of the hooded figure’s dropped dagger,',
    streaming: true,
  },
  {
    kind: 'player',
    key: 'pl-2',
    turnId: null,
    seq: null,
    userId: 'u1',
    displayName: 'Miklos',
    characterName: 'Kessa Vurm',
    text: 'I turn the dagger over to read the marking.',
    pending: true,
  },
]

// A card-first check turn — the dominant wire order (`ft-system.txt`: "call the
// tool first, write prose based on the result"): a scene beat, a player attempt,
// the live skill_check, then the DM's post-check prose (turn RT1, gated behind the
// card's Continue). The lead-in beat (turn RT0) is a different turn, so it is never
// gated — only the outcome prose is buffered.
const CHECK_TURN: TranscriptItem[] = [
  {
    kind: 'dm',
    key: 'r-dm-0',
    turnId: 'RT0',
    text: 'The strongbox sits alone on the table, its lock a blackened knot of brass. No one is watching — for now.',
    streaming: false,
  },
  {
    kind: 'player',
    key: 'r-pl-1',
    turnId: null,
    seq: 9,
    userId: 'u1',
    displayName: 'Miklos',
    characterName: 'Kessa Vurm',
    text: 'I crouch by the box and work the lock with my picks.',
    pending: false,
  },
  {
    kind: 'skill_check',
    key: 'r-sc-1',
    turnId: 'RT1',
    frame: {
      type: 'skill_check',
      turnId: 'RT1',
      characterName: 'Kessa Vurm',
      skill: 'thieves’ tools',
      context: 'picking the strongbox lock',
      roll: 16,
      roll2: null,
      rollType: 'normal',
      modifier: 4,
      total: 20,
      dc: 15,
      outcomeTier: 'great_success',
      constraint: 'The lock springs open, revealing a false bottom.',
    },
  },
  {
    kind: 'dm',
    key: 'r-dm-1',
    turnId: 'RT1',
    text: 'The tumblers give with a soft, final click. Under a folded map your fingers catch the seam of a false bottom — and the cold edge of something hidden beneath it.',
    streaming: false,
  },
]

// The reveal view MessageStream renders against — plain derived data (R1: computed
// route-side by the client-core selectors, passed as a prop; the story hand-builds
// the same shape). For the showcase transcript, the skill_check is already released
// (a replay / already-continued card), so nothing is gated and the full transcript
// reads naturally with the card's numbers stamped.
const SHOWCASE_REVEAL: RollRevealView = {
  phaseByKey: { 'sc-1': 'released' },
  gatedTurnIds: new Set<string>(),
}

// The dice-moment gate, mid-check: the skill_check is live/idle (Roll showing) and
// its outcome prose (turn RT1) is buffered — the DM's post-check narration is not in
// the DOM until Continue.
const GATED_REVEAL: RollRevealView = {
  phaseByKey: { 'r-sc-1': 'idle' },
  gatedTurnIds: new Set<string>(['RT1']),
}

// The same turn, continued: the card is released (numbers stamped, no buttons) and
// the outcome prose has been let through.
const RELEASED_REVEAL: RollRevealView = {
  phaseByKey: { 'r-sc-1': 'released' },
  gatedTurnIds: new Set<string>(),
}

// A bounded paper stage — the real full-bleed play frame gives MessageStream its
// height; the story fakes that with a fixed viewport so the internal scroll shows.
function Stage({ children }: { children: ReactNode }): ReactNode {
  return (
    <div className="bg-bg h-[560px] w-full max-w-[720px]">
      <div className="mx-auto flex h-full flex-col border border-border-strong">{children}</div>
    </div>
  )
}

const meta: Meta<typeof MessageStream> = {
  title: 'Session/MessageStream',
  component: MessageStream,
  tags: ['autodocs'],
  parameters: { layout: 'fullscreen' },
  // The reveal callbacks are wired to the client-core reducer on the real route; the
  // static specimens fix each card's phase directly, so here they are Storybook
  // actions (logged, inert) rather than live handlers.
  argTypes: {
    onRoll: { action: 'roll' },
    onContinue: { action: 'continue' },
  },
  decorators: [
    (Story) => (
      <div className="bg-bg p-[var(--space-6)]">
        <Stage>
          <Story />
        </Stage>
      </div>
    ),
  ],
}

// eslint-disable-next-line no-restricted-syntax -- Storybook CSF requires the meta object as the module's default export.
export default meta

type Story = StoryObj<typeof MessageStream>

// The default live transcript — DM prose, player replies, a skill-check RollCard
// (shown already revealed, its numbers stamped), a combat beat (mode line + roster +
// a dice RollCard + resolution + ledger), and a streaming DM turn with a pending own
// reply.
export const Default: Story = {
  args: {
    items: TRANSCRIPT,
    connectionLine: null,
    reducedMotion: false,
    rollReveal: SHOWCASE_REVEAL,
    rollLabels: ROLL_LABELS,
  },
}

// A quiet reconnect notice pinned below the stream (the transport is
// re-establishing the socket; the backlog replays on reconnect).
export const Reconnecting: Story = {
  args: {
    items: TRANSCRIPT,
    connectionLine: '[ph: reconnecting…]',
    reducedMotion: false,
    rollReveal: SHOWCASE_REVEAL,
    rollLabels: ROLL_LABELS,
  },
}

// Reduced motion — identical content; auto-follow lands instantly (no smooth
// scroll). Motion is never the only signal, so this reads the same at rest.
export const ReducedMotion: Story = {
  args: {
    items: TRANSCRIPT,
    connectionLine: null,
    reducedMotion: true,
    rollReveal: SHOWCASE_REVEAL,
    rollLabels: ROLL_LABELS,
  },
}

// The opening moment — an empty transcript before the first DM beat arrives.
export const Empty: Story = {
  args: {
    items: [],
    connectionLine: null,
    reducedMotion: false,
    rollReveal: { phaseByKey: {}, gatedTurnIds: new Set<string>() },
    rollLabels: ROLL_LABELS,
  },
}

// The dice moment, BEFORE Continue — the live skill_check renders as a RollCard at
// idle (the Roll affordance), and its turn's outcome prose is BUFFERED (not in the
// DOM). The lead-in scene beat (a different turn) still shows.
export const DiceMomentGated: Story = {
  args: {
    items: CHECK_TURN,
    connectionLine: null,
    reducedMotion: false,
    rollReveal: GATED_REVEAL,
    rollLabels: ROLL_LABELS,
  },
}

// The same turn AFTER Continue — the card is released (the die + mod/total/DC/tier
// readout stamped, no buttons), and the buffered post-check prose has been let
// through, growing the tail below the card.
export const DiceMomentReleased: Story = {
  args: {
    items: CHECK_TURN,
    connectionLine: null,
    reducedMotion: false,
    rollReveal: RELEASED_REVEAL,
    rollLabels: ROLL_LABELS,
  },
}

// MYT-94 — the highlight seam on. Recognized world-lore names in SETTLED DM prose carry the
// subtle mention underline (hover reveals a monochrome type glyph; click opens the terse
// popover); the streaming DM row at the tail stays plain (no mid-stream highlighting). The
// index + chrome come from the shared story fixture; in play they come from the knowledge
// cache + route i18n.
const HL_TRANSCRIPT: TranscriptItem[] = [
  {
    kind: 'dm',
    key: 'h-dm-1',
    turnId: 'H1',
    text: 'The road climbs to Highreach in roped switchbacks, and the wind carries woodsmoke and the smell of crushed herbs.',
    streaming: false,
  },
  {
    kind: 'player',
    key: 'h-pl-1',
    turnId: null,
    seq: 3,
    userId: 'u1',
    displayName: 'Miklos',
    characterName: 'Kessa Vurm',
    text: 'I look for the herb stall — Elenya said she would be here.',
    pending: false,
  },
  {
    kind: 'dm',
    key: 'h-dm-2',
    turnId: 'H2',
    text: 'Elenya is bent over a table of cuttings. Without looking up she says the Ashen Hand rode through at dawn, asking after you by name. Then she goes still, and',
    streaming: true,
  },
]

export const Highlighted: Story = {
  args: {
    items: HL_TRANSCRIPT,
    connectionLine: null,
    reducedMotion: false,
    highlight: STORY_INDEX,
    highlightLabels: STORY_LABELS,
  },
}
