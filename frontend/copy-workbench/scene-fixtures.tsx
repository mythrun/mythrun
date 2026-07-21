// scene-fixtures.tsx — compile-ready prop fixtures for the copy workbench.
//
// The copy workbench mounts the REAL @mythrun/ui components so a designer can see
// live examples while the copy team fills in the text. This module supplies, per
// component, a MINIMAL VALID set of NON-TEXT props (the structural data + neutral
// handlers the component needs to render) plus a `<name>TextProps` manifest listing
// every prop path that carries USER-FACING TEXT — the strings the tool overrides at
// runtime (i18n chrome) or that carry content DATA (LLM prose / world content).
//
// Convention:
//   • i18n CHROME strings (labels, placeholders, eyebrows, aria-labels, section
//     headings) are set to the placeholder 'TEXT' — the tool supplies them at runtime.
//   • content DATA strings (LLM prose, character names, world names, fact bodies) get
//     realistic sample values (reused verbatim from the known-good Storybook /
//     animation-audit fixtures) so the component renders with something to show; they
//     are still listed in `<name>TextProps` (annotated "(DATA)") so the tool knows the
//     full user-facing surface.
//   • every other required prop (booleans, enums, numbers, structured data, callbacks)
//     gets a valid minimal value; handlers are `noop`.
//
// This is a pure data/fixtures module — no component definitions (only the CoverDither
// leaf used as a ReactNode slot value, and two tiny data helpers for graph nodes/edges).

import { CoverDither } from '@mythrun/ui'
import { snapshotToGraph, toWikiViewModel } from '@mythrun/client-core/worldgen'
import { WIKI_FIXTURE_MODEL } from '../ui/src/components/WorldWiki/wiki-fixture.ts'
import type {
  AlaCarteView,
  BannerProps,
  CardBodyProps,
  CardFooterProps,
  CardHeaderProps,
  CardItem,
  CardProps,
  CharacterLevel,
  CharacterLoadingBeatProps,
  CharacterOverlay,
  CharacterSheetRevealProps,
  CoverCardProps,
  CreditBalanceProps,
  CuratedSheet,
  DmCorrectionProps,
  DmMessageProps,
  FreeformPromptProps,
  FullSheet,
  GhostChoiceItem,
  GhostChoiceListProps,
  GhostHookItem,
  GhostHookListProps,
  GraphEdge,
  GraphNode,
  GuidedBuilderProps,
  GuidedOption,
  GuidedRailProps,
  HorizontalLockupProps,
  InvitePanelProps,
  JoinPreviewProps,
  KnowledgeCache,
  KnowledgeSidebarProps,
  LevelCardProps,
  LoadingBeat,
  LockupProps,
  LogomarkProps,
  MessageStreamProps,
  PackListProps,
  PartyRosterProps,
  PlayerMessageProps,
  PurchaseHistoryProps,
  PurchaseHistoryRow,
  PurchasePromptProps,
  RailStep,
  RollCardLabels,
  RollCardProps,
  RosterMember,
  SeamlessInputProps,
  SessionInputProps,
  SessionPreparingProps,
  SessionSheetPanelProps,
  SessionSheetState,
  SessionStartBeatProps,
  SituationRecapProps,
  StageProgress,
  StreamingProseProps,
  SubscriptionTierView,
  ThinkingIndicatorProps,
  TranscriptItem,
  WordmarkProps,
  WorldGenGraphProps,
  WorldGenLoadingProps,
  WorldGenStatusCardProps,
  WorldWikiProps,
} from '@mythrun/client-core/contract'

/** A user-facing text prop / label-bundle field the tool fills at runtime. */
export interface TextProp {
  /** Dotted path to the string (or `items[].field` for a repeated field). */
  readonly prop: string
  /** What the string is + whether it is i18n chrome or content DATA. */
  readonly note: string
}

/** One neutral no-op handler, assignable to every DOM-free callback signature. */
const noop = (): void => undefined

// ─────────────────────────────────────────────────────────────────────────────
// Shared DATA fixtures (reused verbatim from the known-good Storybook / audit
// fixtures — these are content, not copy).
// ─────────────────────────────────────────────────────────────────────────────

/** A skill-check card item — verbatim from animation-audit/sections/roll.tsx. The
 *  frame carries LLM-authored DATA (characterName / skill / context / constraint). */
const SKILL_CARD_ITEM = {
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

/** The curated field-guide sheet — verbatim from animation-audit/sections/character.tsx
 *  (the martial specimen, no spells). All DATA. */
const CURATED_SHEET: CuratedSheet = {
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

/** The expanded mechanical sheet — verbatim from character.tsx. All DATA. */
const FULL_SHEET: FullSheet = {
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

/** Tiny data helpers for graph fixtures — mirror the node()/edge() shape used in
 *  animation-audit/sections/worldgen.tsx (pure data, not components). */
const gNode = (synthKey: string, kind: string, name: string): GraphNode => ({
  synthKey,
  kind,
  name,
  displayId: synthKey,
  state: 'live',
  lastEventIndex: 0,
})
const gEdge = (synthKey: string, from: string, to: string, relationship: string): GraphEdge => ({
  synthKey,
  from,
  to,
  relationship,
  arrivalIndex: 0,
  sourceStage: 'weave',
})

// ═════════════════════════════════════════════════════════════════════════════
// 1. RollCard
// ═════════════════════════════════════════════════════════════════════════════

/** The resolved [ph:] label bundle — every field is i18n chrome (tool-filled). */
const ROLL_LABELS: RollCardLabels = {
  roll: 'TEXT',
  continue: 'TEXT',
  tier: { fail: 'TEXT', success: 'TEXT', great_success: 'TEXT' },
  dc: 'TEXT',
  advantage: 'TEXT',
  disadvantage: 'TEXT',
  dieResult: 'TEXT',
}

export const rollCardFixture = {
  item: SKILL_CARD_ITEM,
  phase: 'revealed',
  reducedMotion: false,
  labels: ROLL_LABELS,
  onRoll: noop,
  onContinue: noop,
} satisfies RollCardProps

export const rollCardTextProps: TextProp[] = [
  { prop: 'labels.roll', note: 'i18n — the Roll button (idle phase)' },
  { prop: 'labels.continue', note: 'i18n — the Continue button (releases buffered prose)' },
  { prop: 'labels.tier.fail', note: 'i18n — outcome-tier word for a failure' },
  { prop: 'labels.tier.success', note: 'i18n — outcome-tier word for a success' },
  { prop: 'labels.tier.great_success', note: 'i18n — outcome-tier word for a great success' },
  { prop: 'labels.dc', note: 'i18n — the "DC" readout prefix' },
  { prop: 'labels.advantage', note: 'i18n — advantage posture tag' },
  { prop: 'labels.disadvantage', note: 'i18n — disadvantage posture tag' },
  { prop: 'labels.dieResult', note: 'i18n — SR label naming the stamped die result' },
  { prop: 'item.frame.characterName', note: 'DATA — the roller (LLM/session data)' },
  { prop: 'item.frame.skill', note: 'DATA — the skill being checked' },
  { prop: 'item.frame.context', note: 'DATA — the situational context line' },
  { prop: 'item.frame.constraint', note: 'DATA — the matched outcome constraint prose' },
]

// ═════════════════════════════════════════════════════════════════════════════
// 2. ThinkingIndicator
// ═════════════════════════════════════════════════════════════════════════════

export const thinkingIndicatorFixture = {
  thinking: true,
  typingNames: ['Kessa', 'Bram'],
  thinkingLabel: 'TEXT',
  typingLabel: 'TEXT',
} satisfies ThinkingIndicatorProps

export const thinkingIndicatorTextProps: TextProp[] = [
  { prop: 'thinkingLabel', note: 'i18n — the "DM is thinking…" label' },
  { prop: 'typingLabel', note: 'i18n — the "… is typing" label template' },
  { prop: 'typingNames[]', note: 'DATA — display names of players currently typing' },
]

// ═════════════════════════════════════════════════════════════════════════════
// 3. DmCorrection
// ═════════════════════════════════════════════════════════════════════════════

export const dmCorrectionFixture = {
  text: 'Earlier I said the gate was oak — it is iron, banded and cold. The rest of the room stands as described.',
  label: 'TEXT',
} satisfies DmCorrectionProps

export const dmCorrectionTextProps: TextProp[] = [
  { prop: 'text', note: 'DATA — the correction prose (DM output)' },
  { prop: 'label', note: 'i18n — the errata eyebrow (e.g. "correction")' },
]

// ═════════════════════════════════════════════════════════════════════════════
// 4. DmMessage / PlayerMessage / MessageStream / StreamingProse
// ═════════════════════════════════════════════════════════════════════════════

export const dmMessageFixture = {
  text: 'The tavern door groans against the wind, and for a moment the whole room turns to look at you — the card players, the old woman by the hearth, the barkeep with his rag gone still in his hand. Then the noise folds back over the silence, and you are just another traveller shaking the rain from your coat.',
  streaming: false,
  writingLabel: 'TEXT',
} satisfies DmMessageProps

export const dmMessageTextProps: TextProp[] = [
  { prop: 'text', note: 'DATA — the DM prose (LLM output, never an i18n key)' },
  { prop: 'writingLabel', note: 'i18n — SR annotation announced while writing' },
]

export const playerMessageFixture = {
  displayName: 'Miklos',
  characterName: 'Kessa Vurm',
  text: 'I keep my hand near my blade and cross to the bar, watching the hooded one in the mirror.',
  pending: false,
} satisfies PlayerMessageProps

export const playerMessageTextProps: TextProp[] = [
  { prop: 'displayName', note: 'DATA — the human player handle' },
  { prop: 'characterName', note: 'DATA — the persona in the fiction (may be empty pre-finalize)' },
  { prop: 'text', note: 'DATA — the player message (player input)' },
]

/** A mixed transcript snapshot (DM prose → player reply → skill card → dice card →
 *  a DM correction) — item shapes verbatim from MessageStream.stories.tsx. */
const MESSAGE_STREAM_ITEMS: TranscriptItem[] = [
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
  SKILL_CARD_ITEM,
  {
    kind: 'dice_roll',
    key: 'dr-1',
    turnId: 'T2',
    frame: { type: 'dice_roll', turnId: 'T2', count: 1, sides: 20, results: [17], total: 17 },
  },
  {
    kind: 'dm_correction',
    key: 'dc-1',
    turnId: 'T3',
    text: 'The innkeeper is named Perrin, not Perry.',
  },
]

export const messageStreamFixture = {
  items: MESSAGE_STREAM_ITEMS,
  connectionLine: null,
  reducedMotion: false,
  rollReveal: { phaseByKey: {}, gatedTurnIds: new Set<string>() },
  rollLabels: ROLL_LABELS,
  onRoll: noop,
  onContinue: noop,
  correctionLabel: 'TEXT',
} satisfies MessageStreamProps

export const messageStreamTextProps: TextProp[] = [
  { prop: 'correctionLabel', note: 'i18n — errata eyebrow forwarded to a dm_correction row' },
  { prop: 'rollLabels.*', note: 'i18n — the RollCard label bundle (see rollCardTextProps)' },
  { prop: 'items[]', note: 'DATA — transcript rows carry DM/player prose + frame content' },
  { prop: 'connectionLine', note: 'i18n/DATA — quiet reconnect / system line (null here)' },
]

export const streamingProseFixture = {
  text: 'A rain-soaked archipelago where the lighthouses are sentient and remember every shipwreck they have witnessed.',
  writing: true,
  writingLabel: 'TEXT',
} satisfies StreamingProseProps

export const streamingProseTextProps: TextProp[] = [
  { prop: 'text', note: 'DATA — the prose accumulated so far (LLM output)' },
  { prop: 'writingLabel', note: 'i18n — SR annotation for the in-progress state' },
]

// ═════════════════════════════════════════════════════════════════════════════
// 5. SessionInput
// ═════════════════════════════════════════════════════════════════════════════

export const sessionInputFixture = {
  value: '',
  onChange: noop,
  onSend: noop,
  onSummonDm: noop,
  disabled: false,
  placeholder: 'TEXT',
  summonLabel: 'TEXT',
  sendLabel: 'TEXT',
  maxLength: 2000,
} satisfies SessionInputProps

export const sessionInputTextProps: TextProp[] = [
  { prop: 'placeholder', note: 'i18n — composer placeholder copy' },
  { prop: 'summonLabel', note: 'i18n — the @DM summon affordance label' },
  { prop: 'sendLabel', note: 'i18n — the Send affordance label' },
  { prop: 'value', note: 'DATA — controlled composer value (player input; empty here)' },
]

// ═════════════════════════════════════════════════════════════════════════════
// 6. SessionPreparing / SessionStartBeat
// ═════════════════════════════════════════════════════════════════════════════

export const sessionPreparingFixture = {
  label: 'TEXT',
  detail: 'TEXT',
  reducedMotion: false,
} satisfies SessionPreparingProps

export const sessionPreparingTextProps: TextProp[] = [
  { prop: 'label', note: 'i18n — the atmospheric preparing line (also the AT source)' },
  { prop: 'detail', note: 'i18n — optional quiet sub-line' },
]

export const sessionStartBeatFixture = {
  phase: 'prep',
  reducedMotion: false,
  prepLabel: 'TEXT',
  connectingLabel: 'TEXT',
} satisfies SessionStartBeatProps

export const sessionStartBeatTextProps: TextProp[] = [
  { prop: 'prepLabel', note: 'i18n — label for the prep (session-preparing) phase' },
  { prop: 'connectingLabel', note: 'i18n — label for the connecting (socket-connect) phase' },
]

// ═════════════════════════════════════════════════════════════════════════════
// 7. WorldGenLoading / WorldGenStatusCard
// ═════════════════════════════════════════════════════════════════════════════

export const worldGenLoadingFixture = {
  flavorLabels: ['TEXT', 'TEXT', 'TEXT'],
  spinnerLabel: 'TEXT',
  countdownLabel: 'TEXT',
  watchReady: true,
  watchLabel: 'TEXT',
  onWatch: noop,
} satisfies WorldGenLoadingProps

export const worldGenLoadingTextProps: TextProp[] = [
  { prop: 'flavorLabels[]', note: 'i18n — the cycling playful loading lines' },
  { prop: 'spinnerLabel', note: 'i18n — the spinner SR busy label' },
  { prop: 'countdownLabel', note: 'i18n/DATA — the resolved "~M:SS left" countdown (consumer-ticked)' },
  { prop: 'watchLabel', note: 'i18n — the "watch your world be born" button label' },
]

const WORLDGEN_STAGE_IDS = [
  'world_and_factions',
  'locations_and_npcs',
  'entity_relationships',
  'entity_consolidation',
  'starting_situation',
  'random_tables',
  'coherence_pass',
  'embed_world',
] as const

const WORLDGEN_STAGES: StageProgress[] = WORLDGEN_STAGE_IDS.map((id, i) => ({
  stage: id,
  status: i < 3 ? 'completed' : i === 3 ? 'running' : 'pending',
  userId: null,
  costUsd: 0,
  startedAt: null,
  completedAt: null,
}))

/** Full stage-label bundle (raw stage id → friendly i18n label). */
const WORLDGEN_STAGE_LABELS: Record<string, string> = Object.fromEntries(
  WORLDGEN_STAGE_IDS.map((id) => [id, 'TEXT']),
)

export const worldGenStatusCardFixture = {
  stages: WORLDGEN_STAGES,
  stageLabels: WORLDGEN_STAGE_LABELS,
  countdownLabel: 'TEXT',
  titleLabel: 'TEXT',
  doneLabel: 'TEXT',
  progressLabel: 'TEXT',
} satisfies WorldGenStatusCardProps

export const worldGenStatusCardTextProps: TextProp[] = [
  { prop: 'stageLabels.world_and_factions', note: 'i18n — friendly label for the world_and_factions stage' },
  { prop: 'stageLabels.locations_and_npcs', note: 'i18n — friendly label for the locations_and_npcs stage' },
  { prop: 'stageLabels.entity_relationships', note: 'i18n — friendly label for the entity_relationships stage' },
  { prop: 'stageLabels.entity_consolidation', note: 'i18n — friendly label for the entity_consolidation stage' },
  { prop: 'stageLabels.starting_situation', note: 'i18n — friendly label for the starting_situation stage' },
  { prop: 'stageLabels.random_tables', note: 'i18n — friendly label for the random_tables stage' },
  { prop: 'stageLabels.coherence_pass', note: 'i18n — friendly label for the coherence_pass stage' },
  { prop: 'stageLabels.embed_world', note: 'i18n — friendly label for the embed_world stage' },
  { prop: 'titleLabel', note: 'i18n — the card framing caption' },
  { prop: 'doneLabel', note: 'i18n — the 100% "done" line' },
  { prop: 'progressLabel', note: 'i18n — accessible name for the progressbar' },
  { prop: 'countdownLabel', note: 'i18n/DATA — the resolved "~M:SS left" countdown' },
]

// ═════════════════════════════════════════════════════════════════════════════
// 8. WorldGenGraph
// ═════════════════════════════════════════════════════════════════════════════

const GRAPH_NODES: GraphNode[] = [
  gNode('g/world', 'world', 'Ashfen Reach'),
  gNode('g/ward', 'location', 'The Drowned Ward'),
  gNode('g/guild', 'faction', 'The Tallow Guild'),
  gNode('g/vale', 'npc', 'Maeris Vale'),
  gNode('g/ledger', 'item', 'The Salt Ledger'),
]
const GRAPH_EDGES: GraphEdge[] = [
  gEdge('ge1', 'g/ward', 'g/world', 'within'),
  gEdge('ge2', 'g/guild', 'g/ward', 'controls'),
  gEdge('ge3', 'g/vale', 'g/guild', 'leads'),
  gEdge('ge4', 'g/ledger', 'g/guild', 'kept by'),
]

export const worldGenGraphFixture = {
  nodes: GRAPH_NODES,
  edges: GRAPH_EDGES,
  onSelect: noop,
  reducedMotion: false,
  interactive: true,
  fillHost: true,
  nodeListLabel: 'TEXT',
} satisfies WorldGenGraphProps

export const worldGenGraphTextProps: TextProp[] = [
  { prop: 'nodeListLabel', note: 'i18n — SR label for the reveal graph roving node list' },
  { prop: 'nodes[].name', note: 'DATA — entity names drawn beside each glyph' },
  {
    prop: 'generationA11y.*',
    note: 'i18n — SR generation announcer bundle (entityListLabel / phaseLabel / entitiesLabel); omitted here (reveal graph)',
  },
]

// ═════════════════════════════════════════════════════════════════════════════
// 9. CharacterLoadingBeat / CharacterSheetReveal
// ═════════════════════════════════════════════════════════════════════════════

const LOADING_BEATS: LoadingBeat[] = [
  { id: 'b0', label: 'Kessa Vurm — a name surfaces', state: 'done' },
  { id: 'b1', label: 'Human · Fighter — Champion', state: 'done' },
  { id: 'b2', label: 'rolling ability scores…', state: 'active' },
  { id: 'b3', label: 'gathering equipment…', state: 'pending' },
]

export const characterLoadingBeatFixture = {
  beats: LOADING_BEATS,
  reducedMotion: false,
  countdownLabel: 'TEXT',
} satisfies CharacterLoadingBeatProps

export const characterLoadingBeatTextProps: TextProp[] = [
  { prop: 'beats[].label', note: 'DATA/chrome — each "coming into being" beat line' },
  { prop: 'countdownLabel', note: 'i18n/DATA — the resolved "~M:SS left" estimate' },
]

export const characterSheetRevealFixture = {
  curated: CURATED_SHEET,
  full: FULL_SHEET,
  expanded: false,
  onToggleExpand: noop,
  onConfirm: noop,
  onStartOver: noop,
} satisfies CharacterSheetRevealProps

export const characterSheetRevealTextProps: TextProp[] = [
  { prop: 'curated.name', note: 'DATA — character name' },
  { prop: 'curated.identityLine', note: 'DATA — the level/species/class/role identity line' },
  { prop: 'curated.prose[]', note: 'DATA — the connection prose paragraphs (LLM)' },
  { prop: 'curated.stats[].label / .value', note: 'DATA — AC/HP/Proficiency/Hit Die/Speed stripe' },
  { prop: 'curated.features[].name / .gloss', note: 'DATA — class/feature rows' },
  { prop: 'curated.equipment[].name / .gloss', note: 'DATA — equipment rows' },
  { prop: 'full.skills[].name / savingThrows[] / equipment[] / spells[]', note: 'DATA — expanded mechanical sheet' },
]

// ═════════════════════════════════════════════════════════════════════════════
// 10. LevelCard (5 level choices)
// ═════════════════════════════════════════════════════════════════════════════

const LEVELS: readonly CharacterLevel[] = [1, 2, 3, 4, 5]

export const levelCardFixture: LevelCardProps[] = LEVELS.map((level) => ({
  level,
  grantGloss: 'TEXT',
  selected: level === 3,
  onSelect: noop,
}))

export const levelCardTextProps: TextProp[] = [
  { prop: 'grantGloss', note: 'i18n — one-line "what this level grants" gloss (per card)' },
]

// ═════════════════════════════════════════════════════════════════════════════
// 11. GhostChoiceList / GhostHookList
// ═════════════════════════════════════════════════════════════════════════════

const GHOST_CHOICES: GhostChoiceItem[] = [
  { id: 'c1', title: 'TEXT', subtitle: 'TEXT', onSelect: noop },
  { id: 'c2', title: 'TEXT', subtitle: 'TEXT', onSelect: noop },
  { id: 'c3', title: 'TEXT', onSelect: noop },
]

export const ghostChoiceListFixture = {
  items: GHOST_CHOICES,
} satisfies GhostChoiceListProps

export const ghostChoiceListTextProps: TextProp[] = [
  { prop: 'items[].title', note: 'i18n — the choice serif headline (resolved display string)' },
  { prop: 'items[].subtitle', note: 'i18n — optional quiet sub-line' },
]

const GHOST_HOOKS: GhostHookItem[] = [
  {
    id: 'h1',
    title: 'TEXT',
    place: 'TEXT',
    prose: 'A ledger goes missing from the Tallow Guild the same night three wagons roll through empty. Someone is counting on no one else noticing.',
    onSelect: noop,
  },
  {
    id: 'h2',
    title: 'TEXT',
    place: 'TEXT',
    prose: 'The bell-loft has gone silent for the first time in living memory, and the keeper who tended it will not answer her door.',
    onSelect: noop,
  },
]

export const ghostHookListFixture = {
  items: GHOST_HOOKS,
} satisfies GhostHookListProps

export const ghostHookListTextProps: TextProp[] = [
  { prop: 'items[].title', note: 'i18n — the hook serif headline (resolved display string)' },
  { prop: 'items[].place', note: 'i18n — optional quiet place / where sub-line' },
  { prop: 'items[].prose', note: 'DATA — the hook prose paragraph (LLM-authored content)' },
]

// ═════════════════════════════════════════════════════════════════════════════
// 12. GuidedBuilder / GuidedRail
// ═════════════════════════════════════════════════════════════════════════════

const GUIDED_RAIL: RailStep[] = [
  { step: 'class', label: 'TEXT', chosen: 'Fighter', state: 'done' },
  { step: 'subclass', label: 'TEXT', chosen: 'Champion', state: 'done' },
  { step: 'species', label: 'TEXT', state: 'now' },
  { step: 'background', label: 'TEXT', state: 'todo' },
  { step: 'notes', label: 'TEXT', state: 'todo' },
  { step: 'grounding', label: 'TEXT', state: 'todo' },
]

const GUIDED_OPTIONS: GuidedOption[] = [
  { id: 'human', name: 'Human', description: 'TEXT' },
  { id: 'elf', name: 'Elf', description: 'TEXT' },
  { id: 'dwarf', name: 'Dwarf', description: 'TEXT' },
]

export const guidedBuilderFixture = {
  rail: GUIDED_RAIL,
  question: 'TEXT',
  options: GUIDED_OPTIONS,
  selectedId: 'human',
  onSelect: noop,
  onNext: noop,
  onBack: noop,
  onSkipToFreeform: noop,
} satisfies GuidedBuilderProps

export const guidedBuilderTextProps: TextProp[] = [
  { prop: 'question', note: 'i18n — the current step question' },
  { prop: 'rail[].label', note: 'i18n — the rung label per step' },
  { prop: 'rail[].chosen', note: 'DATA — the chosen value once picked (e.g. "Fighter")' },
  { prop: 'options[].description', note: 'i18n — the option card description (resolved [ph:] copy)' },
  { prop: 'options[].name', note: 'DATA — the option name (e.g. "Human")' },
]

export const guidedRailFixture = {
  rail: GUIDED_RAIL,
} satisfies GuidedRailProps

export const guidedRailTextProps: TextProp[] = [
  { prop: 'rail[].label', note: 'i18n — the rung label per step' },
  { prop: 'rail[].chosen', note: 'DATA — the chosen value once picked' },
]

// ═════════════════════════════════════════════════════════════════════════════
// 13. FreeformPrompt / SeamlessInput
// ═════════════════════════════════════════════════════════════════════════════

export const freeformPromptFixture = {
  stepIndicator: 'TEXT',
  prompt: 'TEXT',
  whisper: 'TEXT',
  value: '',
  onChange: noop,
  onSubmit: noop,
  placeholder: 'TEXT',
} satisfies FreeformPromptProps

export const freeformPromptTextProps: TextProp[] = [
  { prop: 'stepIndicator', note: 'i18n — optional step signpost (e.g. "1 of 2")' },
  { prop: 'prompt', note: 'i18n — the seamless field question/label' },
  { prop: 'whisper', note: 'i18n — the quiet sub-line of guidance' },
  { prop: 'placeholder', note: 'i18n — optional empty-field placeholder' },
  { prop: 'value', note: 'DATA — controlled field value (player input; empty here)' },
]

export const seamlessInputFixture = {
  label: 'TEXT',
  placeholder: 'TEXT',
  value: '',
  onChange: noop,
} satisfies SeamlessInputProps

export const seamlessInputTextProps: TextProp[] = [
  { prop: 'label', note: 'i18n — the visible, associated question label (required)' },
  { prop: 'placeholder', note: 'i18n — faint hint (never the label)' },
  { prop: 'value', note: 'DATA — controlled value (empty here)' },
]

// ═════════════════════════════════════════════════════════════════════════════
// 14. PackList / PurchasePrompt / CreditBalance / PurchaseHistory
// ═════════════════════════════════════════════════════════════════════════════

const PACK_TIERS: SubscriptionTierView[] = [
  { lookupKey: 'wayfarer', displayName: 'Wayfarer', priceLabel: '$8 / mo', cta: 'subscribe', isCurrent: false },
  { lookupKey: 'sojourner', displayName: 'Sojourner', priceLabel: '$12 / mo', cta: 'manage', isCurrent: true },
  { lookupKey: 'mythwright', displayName: 'Mythwright', priceLabel: '$16 / mo', cta: 'upgrade', isCurrent: false },
]

const PACK_ALACARTE: AlaCarteView[] = [
  { lookupKey: 'session_pack', displayName: 'Session', unitPriceLabel: '$5 each' },
  { lookupKey: 'world_pack', displayName: 'World', unitPriceLabel: '$9 each' },
]

export const packListFixture = {
  tiers: PACK_TIERS,
  alaCarte: PACK_ALACARTE,
  quantityPresets: [1, 4, 8, 16],
  onTierCta: noop,
  onBuyAlaCarte: noop,
  labels: { subscribe: 'TEXT', upgrade: 'TEXT', manage: 'TEXT', current: 'TEXT', buy: 'TEXT' },
} satisfies PackListProps

export const packListTextProps: TextProp[] = [
  { prop: 'labels.subscribe', note: 'i18n — subscribe CTA verb' },
  { prop: 'labels.upgrade', note: 'i18n — upgrade CTA verb' },
  { prop: 'labels.manage', note: 'i18n — manage CTA verb' },
  { prop: 'labels.current', note: 'i18n — the quiet "current" marker' },
  { prop: 'labels.buy', note: 'i18n — à-la-carte buy verb' },
  { prop: 'tiers[].displayName', note: 'DATA — tier name (server data)' },
  { prop: 'tiers[].priceLabel', note: 'DATA — shell-formatted recurring price' },
  { prop: 'alaCarte[].displayName', note: 'DATA — pack name (server data)' },
  { prop: 'alaCarte[].unitPriceLabel', note: 'DATA — shell-formatted unit price' },
]

export const purchasePromptFixture = {
  variant: 'owner',
  heading: 'TEXT',
  body: 'TEXT',
  buyLabel: 'TEXT',
  quantityPresets: [1, 4, 8],
  onBuy: noop,
  onDismiss: noop,
  dismissLabel: 'TEXT',
} satisfies PurchasePromptProps

export const purchasePromptTextProps: TextProp[] = [
  { prop: 'heading', note: 'i18n — the prompt heading' },
  { prop: 'body', note: 'i18n — the prompt body prose' },
  { prop: 'buyLabel', note: 'i18n — the buy verb (owner only)' },
  { prop: 'dismissLabel', note: 'i18n — accessible name for the dismiss control' },
]

export const creditBalanceFixture = {
  session: 12,
  sessionLabel: 'TEXT',
  worldGen: 3,
  worldGenLabel: 'TEXT',
} satisfies CreditBalanceProps

export const creditBalanceTextProps: TextProp[] = [
  { prop: 'sessionLabel', note: 'i18n — label for the session-credit bucket' },
  { prop: 'worldGenLabel', note: 'i18n — label for the world-gen bucket' },
]

const PURCHASE_ROWS: PurchaseHistoryRow[] = [
  { id: 'e1', label: 'Mythwright — $16.00', refunded: false },
  { id: 'e2', label: 'Purchase — $12.00', refunded: false },
  { id: 'e3', label: 'Purchase — $5.00', refunded: true },
]

export const purchaseHistoryFixture = {
  rows: PURCHASE_ROWS,
  emptyLabel: 'TEXT',
} satisfies PurchaseHistoryProps

export const purchaseHistoryTextProps: TextProp[] = [
  { prop: 'rows[].label', note: 'DATA — shell-composed terse ledger prose per row' },
  { prop: 'emptyLabel', note: 'i18n — empty-state line when there are no rows' },
]

// ═════════════════════════════════════════════════════════════════════════════
// 15. PartyRoster
// ═════════════════════════════════════════════════════════════════════════════

const ROSTER_MEMBERS: RosterMember[] = [
  { userId: 'u1', displayName: 'Miklos', characterName: 'Kessa Vurm', status: 'ready', isViewer: true },
  { userId: 'u2', displayName: 'Bram', characterName: 'Ordric Vane', status: 'ready', isViewer: false },
  { userId: 'u3', displayName: 'Sil', status: 'creating', isViewer: false },
  { userId: 'u4', displayName: 'Onwe', status: 'gathering', isViewer: false },
]

export const partyRosterFixture = {
  members: ROSTER_MEMBERS,
  viewerIsOwner: true,
  canBegin: false,
  onBegin: noop,
  onInvite: noop,
} satisfies PartyRosterProps

export const partyRosterTextProps: TextProp[] = [
  { prop: 'members[].displayName', note: 'DATA — the human player handle' },
  { prop: 'members[].characterName', note: 'DATA — the character name (present once ready)' },
  { prop: '—', note: 'No i18n text props: begin/invite copy is not a prop on this contract' },
]

// ═════════════════════════════════════════════════════════════════════════════
// 16. JoinPreview / InvitePanel
// ═════════════════════════════════════════════════════════════════════════════

export const joinPreviewFixture = {
  campaignName: 'The Ashfen Reaches',
  ownerName: 'Miklos',
  valid: true,
  signedIn: true,
  accepting: false,
  arm: null,
  onAccept: noop,
  onSignIn: noop,
} satisfies JoinPreviewProps

export const joinPreviewTextProps: TextProp[] = [
  { prop: 'campaignName', note: 'DATA — the campaign name (server data)' },
  { prop: 'ownerName', note: 'DATA — the inviting owner display name (server data)' },
  { prop: '—', note: 'No i18n text props on this contract (chrome is internal)' },
]

export const invitePanelFixture = {
  inviteUrl: 'https://mythrun.com/join/ASHFEN-REACH',
  loading: false,
  canShare: true,
  copied: false,
  notice: null,
  onCopy: noop,
  onShare: noop,
  onRevoke: noop,
  onCreate: noop,
} satisfies InvitePanelProps

export const invitePanelTextProps: TextProp[] = [
  { prop: 'inviteUrl', note: 'DATA — the share link (null while loading / post-revoke)' },
  { prop: '—', note: 'No i18n text props on this contract (chrome is internal)' },
]

// ═════════════════════════════════════════════════════════════════════════════
// 17. WorldWiki / SessionSheet / KnowledgeSidebar
// ═════════════════════════════════════════════════════════════════════════════

/** The full WorldWiki group-label bundle (per world-lore kind). */
const WIKI_GROUP_LABELS = { faction: 'TEXT', location: 'TEXT', npc: 'TEXT', item: 'TEXT' }

/** The full WorldWiki chrome-label bundle (also reused as KnowledgeSidebar.wikiLabels). */
const WIKI_LABELS = {
  searchLabel: 'TEXT',
  searchPlaceholder: 'TEXT',
  groupLabels: WIKI_GROUP_LABELS,
  emptyLabel: 'TEXT',
  backLabel: 'TEXT',
  relatedLabel: 'TEXT',
  emptyBodyLabel: 'TEXT',
  referencesLabel: 'TEXT',
  indexLabel: 'TEXT',
}

export const worldWikiFixture = {
  model: WIKI_FIXTURE_MODEL,
  query: '',
  onSelect: noop,
  onQuery: noop,
  ...WIKI_LABELS,
} satisfies WorldWikiProps

export const worldWikiTextProps: TextProp[] = [
  { prop: 'searchLabel', note: 'i18n — accessible label for the search field' },
  { prop: 'searchPlaceholder', note: 'i18n — faint search placeholder hint' },
  { prop: 'groupLabels.faction', note: 'i18n — "factions" group heading' },
  { prop: 'groupLabels.location', note: 'i18n — "places" group heading' },
  { prop: 'groupLabels.npc', note: 'i18n — "people" group heading' },
  { prop: 'groupLabels.item', note: 'i18n — "things" group heading' },
  { prop: 'emptyLabel', note: 'i18n — empty-groups note' },
  { prop: 'backLabel', note: 'i18n — the page back-affordance label' },
  { prop: 'relatedLabel', note: 'i18n — the RELATED section label' },
  { prop: 'emptyBodyLabel', note: 'i18n — empty known-tier body note' },
  { prop: 'referencesLabel', note: 'i18n — intro dig-deeper references label' },
  { prop: 'indexLabel', note: 'i18n — the search+browse index label' },
  { prop: 'model.*', note: 'DATA — entity names, facts, intro/kernel prose (world content)' },
]

const SESSION_OVERLAY: CharacterOverlay = {
  hp: 9,
  maxHp: 28,
  gold: null,
  conditionLog: ['A hobgoblin blade opens a gash along her ribs.'],
}

export const sessionSheetFixture = {
  sheet: CURATED_SHEET,
  overlay: SESSION_OVERLAY,
  hpLabel: 'TEXT',
  conditionsLabel: 'TEXT',
  emptyLabel: 'TEXT',
} satisfies SessionSheetPanelProps

export const sessionSheetTextProps: TextProp[] = [
  { prop: 'hpLabel', note: 'i18n — label for the live HP stat' },
  { prop: 'conditionsLabel', note: 'i18n — label over the recent-conditions line' },
  { prop: 'emptyLabel', note: 'i18n — calm empty-state line (no live changes)' },
  { prop: 'sheet.*', note: 'DATA — the curated character sheet content' },
  { prop: 'overlay.conditionLog[]', note: 'DATA — recent live condition-change prose' },
]

/** One coherent world snapshot — both wiki + graph projections derive from it, so
 *  the graph↔wiki bridge lines up on shared entity ids (mirrors the sidebar story). */
const SIDEBAR_SNAPSHOT: Parameters<typeof toWikiViewModel>[0] = {
  introduction: {
    title: 'The Ashfen Reaches',
    prose:
      '[placeholder for the first introduction paragraph — how the reach functions at rest]\n\n[placeholder for the second introduction paragraph — the tensions a newcomer would feel first]',
    references: [
      { entityId: 'f-guild', name: 'The Tallow Guild' },
      { entityId: 'n-vale', name: 'Maeris Vale' },
    ],
  },
  entities: [
    { id: 'f-guild', entityType: 'faction', name: 'The Tallow Guild' },
    { id: 'l-reach', entityType: 'location', name: 'Ashfen Reach' },
    { id: 'l-ward', entityType: 'location', name: 'The Drowned Ward' },
    { id: 'n-vale', entityType: 'npc', name: 'Maeris Vale' },
    { id: 'n-corr', entityType: 'npc', name: 'Corrin Salt' },
  ],
  facts: [
    { id: 'fact-1', entityId: 'f-guild', topic: 'Purpose', content: '[placeholder for the guild purpose]' },
    { id: 'fact-2', entityId: 'l-reach', topic: 'Terrain', content: '[placeholder for the terrain of the reach]' },
    { id: 'fact-3', entityId: 'n-vale', topic: 'Role', content: '[placeholder for what Maeris Vale does]' },
  ],
  entityHierarchy: [{ parentEntityId: 'l-reach', childEntityId: 'l-ward' }],
  relationships: [
    { sourceEntityId: 'f-guild', targetEntityId: 'l-ward', relationshipType: 'seated_at' },
    { sourceEntityId: 'n-vale', targetEntityId: 'f-guild', relationshipType: 'sworn_to' },
    { sourceEntityId: 'n-corr', targetEntityId: 'n-vale', relationshipType: 'serves' },
  ],
}

const SIDEBAR_CACHE: KnowledgeCache = {
  wiki: toWikiViewModel(SIDEBAR_SNAPSHOT),
  graph: snapshotToGraph({ entities: SIDEBAR_SNAPSHOT.entities, relationships: SIDEBAR_SNAPSHOT.relationships ?? [] }),
  index: null,
  loading: false,
  failed: false,
}

const SIDEBAR_SHEET_STATE: SessionSheetState = {
  sheet: CURATED_SHEET,
  overlay: SESSION_OVERLAY,
  loading: false,
  failed: false,
}

export const knowledgeSidebarFixture = {
  cache: SIDEBAR_CACHE,
  sheet: SIDEBAR_SHEET_STATE,
  onSelectEntity: noop,
  activeTab: 'wiki',
  onTabChange: noop,
  wikiQuery: '',
  onWikiQuery: noop,
  reducedMotion: false,
  tabsLabel: 'TEXT',
  wikiTabLabel: 'TEXT',
  graphTabLabel: 'TEXT',
  sheetTabLabel: 'TEXT',
  wikiLabels: WIKI_LABELS,
  graphNodeListLabel: 'TEXT',
  sheetLabels: { hpLabel: 'TEXT', conditionsLabel: 'TEXT', emptyLabel: 'TEXT' },
  wikiUnavailableLabel: 'TEXT',
  graphUnavailableLabel: 'TEXT',
  sheetUnavailableLabel: 'TEXT',
} satisfies KnowledgeSidebarProps

export const knowledgeSidebarTextProps: TextProp[] = [
  { prop: 'tabsLabel', note: 'i18n — the Tabs list accessible label' },
  { prop: 'wikiTabLabel', note: 'i18n — World Wiki tab label' },
  { prop: 'graphTabLabel', note: 'i18n — Relationship Graph tab label' },
  { prop: 'sheetTabLabel', note: 'i18n — Character Sheet tab label' },
  { prop: 'wikiLabels.searchLabel', note: 'i18n — forwarded WorldWiki search label' },
  { prop: 'wikiLabels.searchPlaceholder', note: 'i18n — forwarded WorldWiki search placeholder' },
  { prop: 'wikiLabels.groupLabels.faction', note: 'i18n — forwarded "factions" heading' },
  { prop: 'wikiLabels.groupLabels.location', note: 'i18n — forwarded "places" heading' },
  { prop: 'wikiLabels.groupLabels.npc', note: 'i18n — forwarded "people" heading' },
  { prop: 'wikiLabels.groupLabels.item', note: 'i18n — forwarded "things" heading' },
  { prop: 'wikiLabels.emptyLabel', note: 'i18n — forwarded empty-groups note' },
  { prop: 'wikiLabels.backLabel', note: 'i18n — forwarded page back label' },
  { prop: 'wikiLabels.relatedLabel', note: 'i18n — forwarded RELATED section label' },
  { prop: 'wikiLabels.emptyBodyLabel', note: 'i18n — forwarded empty-body note' },
  { prop: 'wikiLabels.referencesLabel', note: 'i18n — forwarded references label' },
  { prop: 'wikiLabels.indexLabel', note: 'i18n — forwarded index label' },
  { prop: 'graphNodeListLabel', note: 'i18n — forwarded graph roving node-list label' },
  { prop: 'sheetLabels.hpLabel', note: 'i18n — forwarded live-HP label' },
  { prop: 'sheetLabels.conditionsLabel', note: 'i18n — forwarded recent-conditions label' },
  { prop: 'sheetLabels.emptyLabel', note: 'i18n — forwarded sheet empty-state line' },
  { prop: 'wikiUnavailableLabel', note: 'i18n — calm line when the wiki projection is null' },
  { prop: 'graphUnavailableLabel', note: 'i18n — calm line when the graph projection is null' },
  { prop: 'sheetUnavailableLabel', note: 'i18n — calm line when the sheet is null' },
  { prop: 'cache.* / sheet.*', note: 'DATA — world snapshot + character sheet content' },
]

// ═════════════════════════════════════════════════════════════════════════════
// 18. CoverCard
// ═════════════════════════════════════════════════════════════════════════════

export const coverCardFixture = {
  // The cover is a decorative ReactNode slot — a ghost CoverDither (no world-colour
  // pick yet). `children` (body) and `foot` are ReactNode content slots the tool fills.
  cover: <CoverDither size="band" />,
  width: 320,
} satisfies CoverCardProps

export const coverCardTextProps: TextProp[] = [
  { prop: 'children', note: 'DATA/i18n — the body content slot (title/subtitle ReactNode)' },
  { prop: 'foot', note: 'DATA/i18n — the foot imprint slot (ReactNode, optional)' },
  { prop: 'cover', note: 'non-text — decorative cover-art slot (a CoverDither)' },
]

// ═════════════════════════════════════════════════════════════════════════════
// 19. SituationRecap
// ═════════════════════════════════════════════════════════════════════════════

export const situationRecapFixture = {
  eyebrow: 'TEXT',
  title: 'The Salt Ledger Goes Missing',
  locationName: 'The Tallow Guild, Drowned Ward',
  prose:
    'The guild ledger — the one book that reconciles every tallow-run in the reach — was gone from its locked case by morning, and the clerk who kept it will not meet anyone in the eye.',
} satisfies SituationRecapProps

export const situationRecapTextProps: TextProp[] = [
  { prop: 'eyebrow', note: 'i18n — the mono eyebrow label (shell-owned chrome)' },
  { prop: 'title', note: 'DATA — the situation title (LLM-authored, verbatim)' },
  { prop: 'locationName', note: 'DATA — the situation location (LLM-authored, verbatim)' },
  { prop: 'prose', note: 'DATA — the scene prose (LLM-authored, verbatim)' },
]

// ═════════════════════════════════════════════════════════════════════════════
// 20. Banner / Card (+ CardHeader / CardBody / CardFooter)
// ═════════════════════════════════════════════════════════════════════════════

export const bannerFixture = {
  severity: 'info',
  dismissible: true,
  dismissLabel: 'TEXT',
  onDismiss: noop,
} satisfies BannerProps

export const bannerTextProps: TextProp[] = [
  { prop: 'title', note: 'i18n — optional bold lead line (children carries the body)' },
  { prop: 'children', note: 'i18n — the banner body content' },
  { prop: 'dismissLabel', note: 'i18n — accessible name for the dismiss control' },
]

export const cardFixture = { surface: 'base', frame: 'solid' } satisfies CardProps
export const cardHeaderFixture = {} satisfies CardHeaderProps
export const cardBodyFixture = {} satisfies CardBodyProps
export const cardFooterFixture = {} satisfies CardFooterProps

export const cardTextProps: TextProp[] = [
  { prop: 'children', note: 'i18n/DATA — all Card / CardHeader / CardBody / CardFooter text lives in their children slots; the container itself carries no string props' },
]

// ═════════════════════════════════════════════════════════════════════════════
// 21. Wordmark / Lockup / HorizontalLockup / Logomark
//     aria-label is the ONLY text prop on each brand mark.
// ═════════════════════════════════════════════════════════════════════════════

export const wordmarkFixture = { 'aria-label': 'TEXT', size: 48 } satisfies WordmarkProps
export const lockupFixture = { 'aria-label': 'TEXT', size: 128 } satisfies LockupProps
export const horizontalLockupFixture = { 'aria-label': 'TEXT', size: 56 } satisfies HorizontalLockupProps
export const logomarkFixture = { 'aria-label': 'TEXT', size: 64, tone: 'ink' } satisfies LogomarkProps

export const wordmarkTextProps: TextProp[] = [{ prop: 'aria-label', note: 'i18n — accessible name for the wordmark' }]
export const lockupTextProps: TextProp[] = [{ prop: 'aria-label', note: 'i18n — accessible name for the lockup' }]
export const horizontalLockupTextProps: TextProp[] = [
  { prop: 'aria-label', note: 'i18n — accessible name for the horizontal lockup' },
]
export const logomarkTextProps: TextProp[] = [{ prop: 'aria-label', note: 'i18n — accessible name for the mark' }]
