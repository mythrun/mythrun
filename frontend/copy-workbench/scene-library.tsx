import type { ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import {
  Heading,
  Text,
  Button,
  Stack,
  Divider,
  Lockup,
  Wordmark,
  CoverCard,
  GhostChoiceList,
  GhostHookList,
  LevelCard,
  GuidedBuilder,
  FreeformPrompt,
  SeamlessInput,
  SituationRecap,
  PartyRoster,
  PackList,
  CreditBalance,
  PurchaseHistory,
  WorldGenLoading,
  WorldGenStatusCard,
  WorldWiki,
  KnowledgeSidebar,
  RollCard,
  ThinkingIndicator,
  DmCorrection,
  SessionInput,
  SessionPreparing,
  SessionStartBeat,
  PurchasePrompt,
} from '@mythrun/ui'
import { data } from './store.ts'
import { useCopy, T } from './highlight.tsx'
import type { Scene } from './types.ts'
import * as fx from './scene-fixtures.tsx'

// ── Scene factory ────────────────────────────────────────────────────────────
// Each scene renders a STABLE inner component (defined once) so it never remounts
// between store repaints. The inner reads i18n via useCopy(), so overriding a key
// repaints the exhibit live.
function scene(
  meta: { id: string; title: string; note: string; kind: 'real' | 'composed'; keys: string[]; minHeight?: number },
  Inner: () => ReactNode,
): Scene {
  const Wrapped = (): ReactNode => Inner()
  return { ...meta, render: () => <Wrapped /> }
}

/** Ground padding wrapper for composed scenes. */
function Ground({ children, style }: { children: ReactNode; style?: React.CSSProperties }): React.JSX.Element {
  return <div style={{ maxWidth: 640, margin: '0 auto', ...style }}>{children}</div>
}

// ── Derived key lists ────────────────────────────────────────────────────────
const flavorKeys = data.order
  .filter((k) => /^worldGen\.flavor\d+$/.test(k))
  .sort((a, b) => Number(a.replace(/\D/g, '')) - Number(b.replace(/\D/g, '')))

const stageKeys = data.order.filter((k) => k.startsWith('worldGen.stage.'))

function optionKeys(group: string): string[] {
  const prefix = `characterCreate.guided.${group}.options.`
  return data.order.filter((k) => k.startsWith(prefix) && k.endsWith('.name'))
}
function optionId(key: string): string {
  const m = key.match(/\.options\.(.+)\.name$/)
  return m?.[1] ?? key
}

// ═════════════════════════════════════════════════════════════════════════════
// LANDING
// ═════════════════════════════════════════════════════════════════════════════
const landingScenes: Scene[] = [
  scene(
    {
      id: 'landing-hero',
      title: 'Landing hero',
      note: 'The public front door: the brand lockup, the h1, the tagline, and the primary CTA — composed from real DS pieces.',
      kind: 'composed',
      keys: ['landing.title', 'landing.tagline', 'landing.cta', 'landing.pricing', 'landing.legal'],
      minHeight: 360,
    },
    () => (
      <Ground style={{ maxWidth: 520, textAlign: 'center', paddingTop: 8 }}>
        <Stack gap={4} align="center">
          <Lockup aria-label="Mythrun" size={120} />
          <Heading level={1} role="display">
            <T k="landing.title" />
          </Heading>
          <Text role="subtitle">
            <T k="landing.tagline" />
          </Text>
          <div>
            <Button variant="primary" onPress={() => undefined}>
              <T k="landing.cta" />
            </Button>
          </div>
          <Text role="ui-caption">
            <T k="landing.pricing" />
          </Text>
          <Text role="meta">
            <T k="landing.legal" />
          </Text>
        </Stack>
      </Ground>
    ),
  ),
]

// ═════════════════════════════════════════════════════════════════════════════
// APP FRAME (chrome & brand)
// ═════════════════════════════════════════════════════════════════════════════
const frameScenes: Scene[] = [
  scene(
    {
      id: 'frame-header',
      title: 'App frame header (chrome & brand)',
      note: 'The persistent top bar. frame.wordmark is an aria-label on the WORDMARK, not visible text. The display name is DATA (rendered from /me, MYT-99), not copy, so it is not authored here. Composed from real DS pieces.',
      kind: 'composed',
      keys: ['frame.wordmark', 'frame.credits', 'frame.creditsLoading', 'frame.buyCredits', 'frame.settings'],
      minHeight: 120,
    },
    () => {
      const tk = useCopy()
      return (
        <div style={{ maxWidth: 620, margin: '0 auto' }}>
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 14,
              padding: '10px 14px',
              border: '1px solid var(--border-strong)',
            }}
          >
            <Wordmark aria-label={tk('frame.wordmark')} size={26} />
            <span data-key="frame.wordmark" style={{ fontSize: 11, opacity: 0.55 }}>
              (aria-label)
            </span>
            <div style={{ flex: 1 }} />
            <Text role="data">
              <T k="frame.credits" /> 1,250
            </Text>
            <Button variant="secondary" onPress={() => undefined}>
              <T k="frame.buyCredits" />
            </Button>
            <Text role="ui-caption">
              <T k="frame.settings" />
            </Text>
          </div>
          <div style={{ marginTop: 8 }}>
            <Text role="meta">
              loading state: <T k="frame.creditsLoading" />
            </Text>
          </div>
        </div>
      )
    },
  ),
]

// ═════════════════════════════════════════════════════════════════════════════
// HOME
// ═════════════════════════════════════════════════════════════════════════════
const homeScenes: Scene[] = [
  scene(
    {
      id: 'home-hub',
      title: 'Home hub + a campaign card',
      note: 'The shelf title, the create action, and one real CoverCard with a phase line + record foot. Other card phases are context cards below.',
      kind: 'composed',
      keys: ['home.title', 'home.createCampaign', 'home.card.generating', 'home.card.record'],
      minHeight: 320,
    },
    () => (
      <Ground>
        <Stack gap={4}>
          <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: 12 }}>
            <Heading level={1} role="heading">
              <T k="home.title" />
            </Heading>
            <Button variant="primary" onPress={() => undefined}>
              <T k="home.createCampaign" />
            </Button>
          </div>
          <CoverCard
            {...fx.coverCardFixture}
            foot={
              <Text role="meta">
                <T k="home.card.record" />
              </Text>
            }
          >
            <Stack gap={2}>
              <Heading level={2} role="title">
                The Ashfen Reaches
              </Heading>
              <Text role="ui-caption">
                <T k="home.card.generating" />
              </Text>
            </Stack>
          </CoverCard>
        </Stack>
      </Ground>
    ),
  ),
]

// ═════════════════════════════════════════════════════════════════════════════
// CAMPAIGN NEW
// ═════════════════════════════════════════════════════════════════════════════
const campaignNewScenes: Scene[] = [
  scene(
    {
      id: 'cn-fork',
      title: 'Create fork — idea vs. what you love',
      note: 'The world-creation fork: eyebrow, lede, question over a real GhostChoiceList (the two paths).',
      kind: 'real',
      keys: [
        'campaignNew.fork.eyebrow',
        'campaignNew.fork.lede',
        'campaignNew.fork.question',
        'campaignNew.fork.idea.title',
        'campaignNew.fork.idea.subtitle',
        'campaignNew.fork.love.title',
        'campaignNew.fork.love.subtitle',
      ],
      minHeight: 340,
    },
    () => {
      const tk = useCopy()
      return (
        <Ground>
          <Stack gap={3}>
            <Text role="ui-caption">
              <T k="campaignNew.fork.eyebrow" />
            </Text>
            <Text role="subtitle">
              <T k="campaignNew.fork.lede" />
            </Text>
            <Heading level={2} role="title">
              <T k="campaignNew.fork.question" />
            </Heading>
            <GhostChoiceList
              items={[
                { id: 'idea', title: tk('campaignNew.fork.idea.title'), subtitle: tk('campaignNew.fork.idea.subtitle'), onSelect: () => undefined },
                { id: 'love', title: tk('campaignNew.fork.love.title'), subtitle: tk('campaignNew.fork.love.subtitle'), onSelect: () => undefined },
              ]}
            />
          </Stack>
        </Ground>
      )
    },
  ),
  scene(
    {
      id: 'cn-freeform',
      title: 'Freeform — describe your world',
      note: 'The single seamless prompt for a freeform world idea (real FreeformPrompt) + the begin action.',
      kind: 'real',
      keys: ['campaignNew.freeform.eyebrow', 'campaignNew.freeform.question', 'campaignNew.freeform.hint', 'campaignNew.freeform.begin'],
      minHeight: 240,
    },
    () => {
      const tk = useCopy()
      return (
        <Ground>
          <Stack gap={3}>
            <Text role="ui-caption">
              <T k="campaignNew.freeform.eyebrow" />
            </Text>
            <FreeformPrompt
              {...fx.freeformPromptFixture}
              prompt={tk('campaignNew.freeform.question')}
              whisper={tk('campaignNew.freeform.hint')}
              stepIndicator=""
            />
            <div>
              <Button variant="primary" onPress={() => undefined}>
                <T k="campaignNew.freeform.begin" />
              </Button>
            </div>
          </Stack>
        </Ground>
      )
    },
  ),
  scene(
    {
      id: 'cn-guided',
      title: 'Guided — name something you love',
      note: 'The guided world-seed flow: eyebrow, step, the two seamless questions, and the advance actions.',
      kind: 'composed',
      keys: [
        'campaignNew.guided.eyebrow',
        'campaignNew.guided.step.one',
        'campaignNew.guided.nameQuestion',
        'campaignNew.guided.whyQuestion',
        'campaignNew.guided.next',
        'campaignNew.guided.find',
      ],
      minHeight: 260,
    },
    () => {
      const tk = useCopy()
      return (
        <Ground>
          <Stack gap={3}>
            <div style={{ display: 'flex', justifyContent: 'space-between' }}>
              <Text role="ui-caption">
                <T k="campaignNew.guided.eyebrow" />
              </Text>
              <Text role="meta">
                <T k="campaignNew.guided.step.one" />
              </Text>
            </div>
            <SeamlessInput {...fx.seamlessInputFixture} label={tk('campaignNew.guided.nameQuestion')} />
            <SeamlessInput {...fx.seamlessInputFixture} label={tk('campaignNew.guided.whyQuestion')} />
            <div style={{ display: 'flex', gap: 8 }}>
              <Button variant="secondary" onPress={() => undefined}>
                <T k="campaignNew.guided.next" />
              </Button>
              <Button variant="primary" onPress={() => undefined}>
                <T k="campaignNew.guided.find" />
              </Button>
            </div>
          </Stack>
        </Ground>
      )
    },
  ),
]

// ═════════════════════════════════════════════════════════════════════════════
// WORLD GENERATION
// ═════════════════════════════════════════════════════════════════════════════
const worldGenScenes: Scene[] = [
  scene(
    {
      id: 'wg-loading',
      title: 'World-gen loading (act one)',
      note: 'The real WorldGenLoading: the spinner busy-label, the cycling flavor lines (all 20 edited as one catalog below), the countdown, and the "watch" button.',
      kind: 'real',
      keys: ['worldGen.flavor1..flavor20', 'worldGen.loadingLabel', 'worldGen.countdown', 'worldGen.watch'],
      minHeight: 300,
    },
    () => {
      const tk = useCopy()
      return (
        <div style={{ minHeight: 280 }}>
          <WorldGenLoading
            flavorLabels={flavorKeys.map((k) => tk(k))}
            spinnerLabel={tk('worldGen.loadingLabel')}
            countdownLabel={tk('worldGen.countdown')}
            watchReady
            watchLabel={tk('worldGen.watch')}
            onWatch={() => undefined}
          />
        </div>
      )
    },
  ),
  scene(
    {
      id: 'wg-status',
      title: 'World-gen status card (stage labels)',
      note: 'The real WorldGenStatusCard. Only three stage labels are wired into the shipped screen (world_and_factions, locations_and_npcs, entity_relationships) — the other 9 are flagged dead below. Title, done line, and progress a11y name are live.',
      kind: 'real',
      keys: [
        'worldGen.stage.world_and_factions',
        'worldGen.stage.locations_and_npcs',
        'worldGen.stage.entity_relationships',
        'worldGen.statusTitle',
        'worldGen.statusDone',
        'worldGen.statusProgress',
      ],
      minHeight: 200,
    },
    () => {
      const tk = useCopy()
      return (
        <div style={{ maxWidth: 420, margin: '0 auto' }}>
          <WorldGenStatusCard
            stages={fx.worldGenStatusCardFixture.stages}
            stageLabels={Object.fromEntries(stageKeys.map((k) => [k.split('.').pop(), tk(k)]))}
            countdownLabel={tk('worldGen.countdown')}
            titleLabel={tk('worldGen.statusTitle')}
            doneLabel={tk('worldGen.statusDone')}
            progressLabel={tk('worldGen.statusProgress')}
          />
        </div>
      )
    },
  ),
]

// ═════════════════════════════════════════════════════════════════════════════
// WORLD REVEAL
// ═════════════════════════════════════════════════════════════════════════════
const worldRevealScenes: Scene[] = [
  scene(
    {
      id: 'wr-wiki',
      title: 'World wiki (meet your world)',
      note: 'The real WorldWiki: the search field labels, the group headings (people/places/factions/things), and the browse/related/dig-deeper chrome.',
      kind: 'real',
      keys: [
        'worldReveal.wikiSearchLabel',
        'worldReveal.wikiSearchPlaceholder',
        'worldReveal.group.faction',
        'worldReveal.group.location',
        'worldReveal.group.npc',
        'worldReveal.group.item',
        'worldReveal.wikiEmpty',
        'worldReveal.wikiBack',
        'worldReveal.wikiRelated',
        'worldReveal.wikiEmptyBody',
        'worldReveal.wikiDigDeeper',
        'worldReveal.wikiIndex',
      ],
      minHeight: 460,
    },
    () => {
      const tk = useCopy()
      return (
        <div style={{ maxWidth: 460, margin: '0 auto', height: 440 }}>
          <WorldWiki
            glossaryLabel="Glossary"
            model={fx.worldWikiFixture.model}
            query=""
            onSelect={() => undefined}
            onQuery={() => undefined}
            searchLabel={tk('worldReveal.wikiSearchLabel')}
            searchPlaceholder={tk('worldReveal.wikiSearchPlaceholder')}
            groupLabels={{
              faction: tk('worldReveal.group.faction'),
              location: tk('worldReveal.group.location'),
              npc: tk('worldReveal.group.npc'),
              item: tk('worldReveal.group.item'),
            }}
            emptyLabel={tk('worldReveal.wikiEmpty')}
            backLabel={tk('worldReveal.wikiBack')}
            relatedLabel={tk('worldReveal.wikiRelated')}
            emptyBodyLabel={tk('worldReveal.wikiEmptyBody')}
            referencesLabel={tk('worldReveal.wikiDigDeeper')}
            indexLabel={tk('worldReveal.wikiIndex')}
          />
        </div>
      )
    },
  ),
]

// ═════════════════════════════════════════════════════════════════════════════
// STARTING LEVEL
// ═════════════════════════════════════════════════════════════════════════════
const startingLevelScenes: Scene[] = [
  scene(
    {
      id: 'sl-pick',
      title: 'Starting level pick',
      note: 'Eyebrow + prompt + lede over the five real LevelCards (each grant gloss is live) and the begin CTA.',
      kind: 'real',
      keys: [
        'startingLevel.eyebrow',
        'startingLevel.prompt',
        'startingLevel.lede',
        'startingLevel.grant1',
        'startingLevel.grant2',
        'startingLevel.grant3',
        'startingLevel.grant4',
        'startingLevel.grant5',
        'startingLevel.cta',
      ],
      minHeight: 380,
    },
    () => {
      const tk = useCopy()
      return (
        <Ground>
          <Stack gap={3}>
            <Text role="ui-caption">
              <T k="startingLevel.eyebrow" />
            </Text>
            <Heading level={2} role="title">
              <T k="startingLevel.prompt" />
            </Heading>
            <Text role="subtitle">
              <T k="startingLevel.lede" />
            </Text>
            <Stack gap={2}>
              {[1, 2, 3, 4, 5].map((lvl) => (
                <LevelCard
                  key={lvl}
                  eyebrow="Level"
                  level={lvl as 1 | 2 | 3 | 4 | 5}
                  grantGloss={tk(`startingLevel.grant${String(lvl)}`)}
                  selected={lvl === 3}
                  onSelect={() => undefined}
                />
              ))}
            </Stack>
            <div>
              <Button variant="primary" onPress={() => undefined}>
                <T k="startingLevel.cta" />
              </Button>
            </div>
          </Stack>
        </Ground>
      )
    },
  ),
]

// ═════════════════════════════════════════════════════════════════════════════
// STARTING SITUATION
// ═════════════════════════════════════════════════════════════════════════════
const startingSituationScenes: Scene[] = [
  scene(
    {
      id: 'ss-pick',
      title: 'Starting situation pick',
      note: 'Eyebrow + prompt over a real GhostHookList (the opening hooks; hook prose is sample content).',
      kind: 'real',
      keys: ['startingSituation.eyebrow', 'startingSituation.prompt'],
      minHeight: 320,
    },
    () => (
      <Ground>
        <Stack gap={3}>
          <Text role="ui-caption">
            <T k="startingSituation.eyebrow" />
          </Text>
          <Heading level={2} role="title">
            <T k="startingSituation.prompt" />
          </Heading>
          <GhostHookList {...fx.ghostHookListFixture} />
        </Stack>
      </Ground>
    ),
  ),
]

// ═════════════════════════════════════════════════════════════════════════════
// CHARACTER CREATION
// ═════════════════════════════════════════════════════════════════════════════
function guidedScene(group: string, title: string): Scene {
  const keys = optionKeys(group)
  const questionKey = `characterCreate.guided.${group}.question`
  return scene(
    {
      id: `cc-guided-${group}`,
      title,
      note: `The real GuidedBuilder on the ${group} step — the question and every option name are live.`,
      kind: 'real',
      keys: [questionKey, ...keys],
      minHeight: 360,
    },
    () => {
      const tk = useCopy()
      const options = keys.map((k) => ({ id: optionId(k), name: tk(k), description: '' }))
      return (
        <div style={{ maxWidth: 560, margin: '0 auto' }}>
          <GuidedBuilder
            {...fx.guidedBuilderFixture}
            question={tk(questionKey)}
            options={options}
            selectedId={options[0]?.id ?? ''}
          />
        </div>
      )
    },
  )
}

const characterScenes: Scene[] = [
  scene(
    {
      id: 'cc-chooser',
      title: 'How do you want to make your character?',
      note: 'The path chooser: the prompt over a real GhostChoiceList (guided vs. freeform).',
      kind: 'real',
      keys: [
        'characterCreate.chooser.prompt',
        'characterCreate.chooser.guided.cta',
        'characterCreate.chooser.guided.body',
        'characterCreate.chooser.freeform.cta',
        'characterCreate.chooser.freeform.body',
      ],
      minHeight: 260,
    },
    () => {
      const tk = useCopy()
      return (
        <Ground>
          <Stack gap={3}>
            <Heading level={2} role="title">
              <T k="characterCreate.chooser.prompt" />
            </Heading>
            <GhostChoiceList
              items={[
                { id: 'guided', title: tk('characterCreate.chooser.guided.cta'), subtitle: tk('characterCreate.chooser.guided.body'), onSelect: () => undefined },
                { id: 'freeform', title: tk('characterCreate.chooser.freeform.cta'), subtitle: tk('characterCreate.chooser.freeform.body'), onSelect: () => undefined },
              ]}
            />
          </Stack>
        </Ground>
      )
    },
  ),
  guidedScene('species', 'Guided — species step'),
  guidedScene('class', 'Guided — class step'),
  guidedScene('subclass', 'Guided — subclass step'),
  guidedScene('background', 'Guided — background step'),
  scene(
    {
      id: 'cc-freeform',
      title: 'Freeform — who are you?',
      note: 'The real FreeformPrompt for the concept step (prompt + whisper + step signpost).',
      kind: 'real',
      keys: ['characterCreate.freeform.conceptPrompt', 'characterCreate.freeform.conceptWhisper', 'characterCreate.freeform.stepIndicator'],
      minHeight: 220,
    },
    () => {
      const tk = useCopy()
      return (
        <Ground>
          <FreeformPrompt
            {...fx.freeformPromptFixture}
            prompt={tk('characterCreate.freeform.conceptPrompt')}
            whisper={tk('characterCreate.freeform.conceptWhisper')}
            stepIndicator={tk('characterCreate.freeform.stepIndicator')}
          />
        </Ground>
      )
    },
  ),
  scene(
    {
      id: 'cc-staging',
      title: 'Ready to begin? (party staging)',
      note: 'The staging title + lede over the real PartyRoster (the begin/invite affordances are internal, not copy keys).',
      kind: 'real',
      keys: ['characterCreate.staging.title', 'characterCreate.staging.lede'],
      minHeight: 320,
    },
    () => (
      <Ground>
        <Stack gap={3}>
          <Heading level={2} role="title">
            <T k="characterCreate.staging.title" />
          </Heading>
          <Text role="subtitle">
            <T k="characterCreate.staging.lede" />
          </Text>
          <PartyRoster {...fx.partyRosterFixture} />
        </Stack>
      </Ground>
    ),
  ),
  scene(
    {
      id: 'cc-recap',
      title: 'Your opening scene (recap)',
      note: 'The real SituationRecap — the eyebrow is the copy key; title/place/prose are sample content.',
      kind: 'real',
      keys: ['characterCreate.recap.eyebrow'],
      minHeight: 240,
    },
    () => {
      const tk = useCopy()
      return (
        <Ground>
          <SituationRecap {...fx.situationRecapFixture} eyebrow={tk('characterCreate.recap.eyebrow')} />
        </Ground>
      )
    },
  ),
]

// ═════════════════════════════════════════════════════════════════════════════
// PLAY
// ═════════════════════════════════════════════════════════════════════════════
const playScenes: Scene[] = [
  scene(
    {
      id: 'play-roll',
      title: 'Dice moment (RollCard)',
      note: 'The real RollCard, revealed: the DC readout, posture tags, outcome-tier words, and the roll/continue actions.',
      kind: 'real',
      keys: [
        'play.roll.roll',
        'play.roll.continue',
        'play.roll.tier.fail',
        'play.roll.tier.success',
        'play.roll.tier.greatSuccess',
        'play.roll.dc',
        'play.roll.beats',
        'play.roll.misses',
        'play.roll.advantage',
        'play.roll.disadvantage',
        'play.roll.dieResult',
        'play.roll.explainer',
        'play.roll.dcExplainer',
      ],
      minHeight: 320,
    },
    () => {
      const tk = useCopy()
      const { t } = useTranslation()
      return (
        <div style={{ maxWidth: 480, margin: '0 auto' }}>
          <RollCard
            item={fx.rollCardFixture.item}
            phase="revealed"
            reducedMotion={false}
            labels={{
              roll: tk('play.roll.roll'),
              continue: tk('play.roll.continue'),
              tier: {
                fail: tk('play.roll.tier.fail'),
                success: tk('play.roll.tier.success'),
                great_success: tk('play.roll.tier.greatSuccess'),
              },
              dc: tk('play.roll.dc'),
              beats: tk('play.roll.beats'),
              misses: tk('play.roll.misses'),
              advantage: tk('play.roll.advantage'),
              disadvantage: tk('play.roll.disadvantage'),
              dieResult: tk('play.roll.dieResult'),
              // The DS stays interpolation-free, so the SHELL resolves the skill +
              // modifier — and RollCard hands them to this resolver. Use them
              // rather than `tk`: `useCopy` interpolates SAMPLE_VARS, which has no
              // skill/modifier, so `tk` here would leak raw {{tokens}} into the
              // exhibit. This mirrors the real call in routes/play/session-shell.
              explainerFor: (skill, modifier) => t('play.roll.explainer', { skill, modifier }),
              dcExplainer: tk('play.roll.dcExplainer'),
            }}
            onRoll={() => undefined}
            onContinue={() => undefined}
          />
        </div>
      )
    },
  ),
  scene(
    {
      id: 'play-input',
      title: 'Session composer (SessionInput)',
      note: 'The real composer: the placeholder, the @DM summon affordance, and the send affordance.',
      kind: 'real',
      keys: ['play.input.placeholder', 'play.input.send', 'play.input.summon'],
      minHeight: 140,
    },
    () => {
      const tk = useCopy()
      return (
        <div style={{ maxWidth: 560, margin: '0 auto' }}>
          <SessionInput
            {...fx.sessionInputFixture}
            placeholder={tk('play.input.placeholder')}
            sendLabel={tk('play.input.send')}
            summonLabel={tk('play.input.summon')}
          />
        </div>
      )
    },
  ),
  scene(
    {
      id: 'play-thinking',
      title: 'Thinking / typing indicator',
      note: 'The real ThinkingIndicator: the DM-thinking label and the "…is typing" template.',
      kind: 'real',
      keys: ['play.thinking.dm', 'play.thinking.typing'],
      minHeight: 120,
    },
    () => {
      const tk = useCopy()
      return (
        <div style={{ maxWidth: 520, margin: '0 auto' }}>
          <ThinkingIndicator
            thinking
            typingNames={['Bram']}
            thinkingLabel={tk('play.thinking.dm')}
            typingLabel={tk('play.thinking.typing')}
          />
        </div>
      )
    },
  ),
  scene(
    {
      id: 'play-correction',
      title: 'DM correction (errata)',
      note: 'The real DmCorrection: the eyebrow label is the copy key; the correction body is sample DM prose.',
      kind: 'real',
      keys: ['play.correction.label'],
      minHeight: 140,
    },
    () => {
      const tk = useCopy()
      return (
        <div style={{ maxWidth: 520, margin: '0 auto' }}>
          <DmCorrection text={fx.dmCorrectionFixture.text} label={tk('play.correction.label')} />
        </div>
      )
    },
  ),
  scene(
    {
      id: 'play-preparing',
      title: 'Preparing hold + start beat',
      note: 'The real SessionPreparing (between-sessions hold) and SessionStartBeat (start → first token) with their live labels.',
      kind: 'real',
      keys: ['play.preparing.label', 'play.preparing.detail', 'play.start.prep', 'play.start.connecting'],
      minHeight: 260,
    },
    () => {
      const tk = useCopy()
      return (
        <Stack gap={4}>
          <SessionPreparing label={tk('play.preparing.label')} detail={tk('play.preparing.detail')} reducedMotion={false} />
          <Divider />
          <SessionStartBeat phase="prep" heading="The table gathers…" reducedMotion={false} prepLabel={tk('play.start.prep')} connectingLabel={tk('play.start.connecting')} />
        </Stack>
      )
    },
  ),
  scene(
    {
      id: 'play-purchase',
      title: 'Out of credits (owner prompt)',
      note: 'The real PurchasePrompt (owner variant): heading, body, and buy action.',
      kind: 'real',
      keys: ['play.purchase.owner.title', 'play.purchase.owner.body', 'play.purchase.owner.buy'],
      minHeight: 200,
    },
    () => {
      const tk = useCopy()
      return (
        <div style={{ maxWidth: 480, margin: '0 auto' }}>
          <PurchasePrompt
            {...fx.purchasePromptFixture}
            heading={tk('play.purchase.owner.title')}
            body={tk('play.purchase.owner.body')}
            buyLabel={tk('play.purchase.owner.buy')}
            dismissLabel="dismiss"
          />
        </div>
      )
    },
  ),
  scene(
    {
      id: 'play-knowledge',
      title: 'Table knowledge sidebar',
      note: 'The real KnowledgeSidebar: the three tab labels, the world-wiki chrome, the character-sheet labels, and the unavailable lines.',
      kind: 'real',
      keys: [
        'play.knowledge.tabs',
        'play.knowledge.wikiTab',
        'play.knowledge.graphTab',
        'play.knowledge.sheetTab',
        'play.knowledge.graphNodes',
        'play.knowledge.wiki.search',
        'play.knowledge.wiki.searchPlaceholder',
        'play.knowledge.wiki.group.faction',
        'play.knowledge.wiki.group.location',
        'play.knowledge.wiki.group.npc',
        'play.knowledge.wiki.group.item',
        'play.knowledge.wiki.empty',
        'play.knowledge.wiki.back',
        'play.knowledge.wiki.related',
        'play.knowledge.wiki.emptyBody',
        'play.knowledge.wiki.references',
        'play.knowledge.wiki.index',
        'play.knowledge.sheet.hp',
        'play.knowledge.sheet.conditions',
        'play.knowledge.sheet.empty',
        'play.knowledge.wikiUnavailable',
        'play.knowledge.graphUnavailable',
        'play.knowledge.sheetUnavailable',
      ],
      minHeight: 500,
    },
    () => {
      const tk = useCopy()
      return (
        <div style={{ maxWidth: 460, margin: '0 auto', height: 480 }}>
          <KnowledgeSidebar
            {...fx.knowledgeSidebarFixture}
            tabsLabel={tk('play.knowledge.tabs')}
            wikiTabLabel={tk('play.knowledge.wikiTab')}
            graphTabLabel={tk('play.knowledge.graphTab')}
            sheetTabLabel={tk('play.knowledge.sheetTab')}
            graphNodeListLabel={tk('play.knowledge.graphNodes')}
            wikiLabels={{
              glossaryLabel: 'Glossary',
              searchLabel: tk('play.knowledge.wiki.search'),
              searchPlaceholder: tk('play.knowledge.wiki.searchPlaceholder'),
              groupLabels: {
                faction: tk('play.knowledge.wiki.group.faction'),
                location: tk('play.knowledge.wiki.group.location'),
                npc: tk('play.knowledge.wiki.group.npc'),
                item: tk('play.knowledge.wiki.group.item'),
              },
              emptyLabel: tk('play.knowledge.wiki.empty'),
              backLabel: tk('play.knowledge.wiki.back'),
              relatedLabel: tk('play.knowledge.wiki.related'),
              emptyBodyLabel: tk('play.knowledge.wiki.emptyBody'),
              referencesLabel: tk('play.knowledge.wiki.references'),
              indexLabel: tk('play.knowledge.wiki.index'),
            }}
            sheetLabels={{
              hpLabel: tk('play.knowledge.sheet.hp'),
              conditionsLabel: tk('play.knowledge.sheet.conditions'),
              emptyLabel: tk('play.knowledge.sheet.empty'),
            }}
            wikiUnavailableLabel={tk('play.knowledge.wikiUnavailable')}
            graphUnavailableLabel={tk('play.knowledge.graphUnavailable')}
            sheetUnavailableLabel={tk('play.knowledge.sheetUnavailable')}
          />
        </div>
      )
    },
  ),
]

// ═════════════════════════════════════════════════════════════════════════════
// BILLING
// ═════════════════════════════════════════════════════════════════════════════
const billingScenes: Scene[] = [
  scene(
    {
      id: 'bl-packs',
      title: 'Packs & plans (PackList)',
      note: 'The real PackList: the two section headings + their help lines, and the subscribe/upgrade/manage/current/buy verbs (tiers, prices and the grant ledger are sample data).',
      kind: 'real',
      keys: [
        'billing.plansTitle',
        'billing.plansHelp',
        'billing.alaCarteTitle',
        'billing.alaCarteHelp',
        'billing.subscribe',
        'billing.upgrade',
        'billing.manage',
        'billing.current',
        'billing.buy',
      ],
      minHeight: 320,
    },
    () => {
      const tk = useCopy()
      return (
        <div style={{ maxWidth: 560, margin: '0 auto' }}>
          <PackList
            {...fx.packListFixture}
            labels={{
              plansTitle: tk('billing.plansTitle'),
              plansHelp: tk('billing.plansHelp'),
              alaCarteTitle: tk('billing.alaCarteTitle'),
              alaCarteHelp: tk('billing.alaCarteHelp'),
              subscribe: tk('billing.subscribe'),
              upgrade: tk('billing.upgrade'),
              manage: tk('billing.manage'),
              current: tk('billing.current'),
              buy: tk('billing.buy'),
            }}
          />
        </div>
      )
    },
  ),
  scene(
    {
      id: 'bl-balance',
      title: 'Credit balance + history',
      note: 'The real CreditBalance (bucket labels + the explainer that sits beside each number) and PurchaseHistory (empty-state label; rows are sample data). The zero-state explainers are authorable here even though both buckets are stocked in this exhibit.',
      kind: 'real',
      keys: [
        'billing.sessionLabel',
        'billing.sessionHelp',
        'billing.sessionZeroHelp',
        'billing.worldGenLabel',
        'billing.worldGenHelp',
        'billing.worldGenZeroHelp',
        'billing.history.empty',
      ],
      minHeight: 220,
    },
    () => {
      const tk = useCopy()
      return (
        <Ground>
          <Stack gap={4}>
            <CreditBalance
              {...fx.creditBalanceFixture}
              sessionLabel={tk('billing.sessionLabel')}
              sessionHelp={tk('billing.sessionHelp')}
              sessionZeroHelp={tk('billing.sessionZeroHelp')}
              worldGenLabel={tk('billing.worldGenLabel')}
              worldGenHelp={tk('billing.worldGenHelp')}
              worldGenZeroHelp={tk('billing.worldGenZeroHelp')}
            />
            <Divider />
            <PurchaseHistory {...fx.purchaseHistoryFixture} emptyLabel={tk('billing.history.empty')} />
          </Stack>
        </Ground>
      )
    },
  ),
]

// ═════════════════════════════════════════════════════════════════════════════
export const sceneLibrary: Record<string, Scene[]> = {
  landing: landingScenes,
  frame: frameScenes,
  home: homeScenes,
  campaignNew: campaignNewScenes,
  worldGen: worldGenScenes,
  worldReveal: worldRevealScenes,
  startingLevel: startingLevelScenes,
  startingSituation: startingSituationScenes,
  characterCreate: characterScenes,
  play: playScenes,
  billing: billingScenes,
}
