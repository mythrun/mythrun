import { useEffect, useMemo, useRef, useState } from 'react'
import { FullBleedStage, Stack, WorldGenGraph, WorldGenLoading } from '@mythrun/ui'
import {
  ENTITY_STAGES,
  WATCHED_ENTITY_STAGES,
  WORLD_GEN_STAGES,
  type WorldGenStage,
} from '@mythrun/contract/events'
import {
  clampEtaMonotonic,
  remainingWaitMs,
  waitDisplay,
  worldGenAccretion,
  type StageTiming,
  type WorldGenStream,
} from '@mythrun/client-core'
import { MIN_EXPECTED_ENTITIES } from '@mythrun/client-core/worldgen'
import { useTranslation } from 'react-i18next'
import type { TFunction } from 'i18next'
import { usePrefersReducedMotion } from '../../platform/web/use-prefers-reduced-motion.ts'
import { coarseWaitTime } from '../wait-format.ts'

// The GENERATING VIEW (MYT-89 Phase C, C7 + audit ③/⑥ + the TWO-ACT flow) — the
// live world-gen experience the `/campaigns/:id` route lands on after Begin, and
// the returnable background state a player can leave and re-enter. Generation is
// two acts:
//
//   ACT ONE (prep): while only the pre-entity prep stages (concept_intake /
//   world_color / vocabulary_intake — `PREP_STAGES`) have run, there is nothing
//   to draw — so the view shows the GENERIC loading screen (`WorldGenLoading`):
//   the DS Spinner + a flavor line cycling twenty short playful loading messages
//   in RANDOM order + the per-second countdown to the reveal. No graph, no fog,
//   no status card.
//
//   THE BEAT: the moment entities START (the stream reports an ENTITY_STAGES
//   stage underway, OR the first node arrives — whichever signal lands first),
//   the loading screen grows the "watch your world be born" button. Generation
//   keeps running in the background regardless — the button only REVEALS the
//   graph; the player chooses the moment.
//
//   ACT TWO (graph): the fog-forward, GATED generation experience (§3.3/§3.4):
//   - the graph is INERT (`interactive={false}`): no entity list, no selection —
//     the fog + graph own the whole space (§3.4);
//   - the WorldGenStatusCard (C4) is fed the stream's `stages[]` + a full
//     stage-label map (every canonical stage carries a friendly label, though the
//     card only bars the WATCHED entity stages — the prep stretch belongs to act
//     one, and the silent tail runs behind the wiki reveal) + the ticking
//     per-second countdown (from the route's stage-timings fetch — MYT-89
//     waiting-feedback; the player holds an expectation of the wait AT ALL
//     TIMES, on both acts). Cost is NOT passed (audit ⑥ — the player never sees
//     API spend);
//   - the FOG DRAIN is keyed off the ENTITY COUNT (MYT-89 spawn-drain, replacing
//     the old stage-progress fade): `nodes.length / MIN_EXPECTED_ENTITIES` scales
//     the fog's respawn flux down as entities arrive, so the wind carries the fog
//     off the pane — fully gone by the DB-derived minimum entity count a real
//     generation produces (before the pipeline's tail stages even finish).
//
// THIS VIEW ENDS AT THE WIKI-REVEAL MOMENT (MYT-89 reveal timing): the route
// swaps it for the WorldReveal the instant connection-weaving
// (entity_relationships) completes — the card's bars hit 100% exactly then; the
// tail stages never render here.
//
// Flat 1-bit paper register — no chrome. The route owns the stream + the timings
// fetch; this view owns the act state (a deliberate transition, two-way since
// myth-t11az — the status card's quiet link returns to the calm wait), the
// countdown's 1-second tick, the ONE aggregate monotonic wait budget both acts
// read (ux-run2 myth-uz1bn), and the coarse label formatting.

/** The generation graph model + the status/fade inputs (folded by the route's
 *  `useWorldGenStream`) plus the route's historical stage timings (the input to
 *  the per-second countdown). */
interface GeneratingViewProps
  extends Pick<WorldGenStream, 'nodes' | 'edges' | 'stages' | 'resumedMidGen'> {
  /** Historical per-stage average durations (the route's `getStageTimings` fetch),
   *  or `null` before it resolves / on cold-start → the card shows no estimate. */
  readonly stageTimings?: readonly StageTiming[] | null
}

/** The 1-second tick behind the countdown (MYT-89 waiting-feedback): the current
 *  epoch ms, refreshed by a REAL 1s interval (not per-rAF) while `active`. Each
 *  tick re-derives the remaining wait from scratch, so a stage event landing
 *  between ticks recalibrates on the next render, and the tick itself stops
 *  costing anything when there is no countdown to show (cold-start). NOT gated
 *  on reduced motion — the ticking number is CONTENT (the remaining wait), not
 *  decoration; freezing it would show a wrong number. */
function useNowMs(active: boolean): number {
  const [nowMs, setNowMs] = useState(() => Date.now())
  useEffect(() => {
    if (!active) return
    setNowMs(Date.now())
    // Bare timer globals (not window.*) — universal across web + native (R1).
    const id = setInterval(() => {
      setNowMs(Date.now())
    }, 1000)
    return () => {
      clearInterval(id)
    }
  }, [active])
  return nowMs
}

/** The wait line both acts render (ux-run2 myth-uz1bn): the COARSE overall
 *  countdown ("Ready in about 4 min") while the estimate holds, the STALLED
 *  reassurance the instant it exhausts (a frozen number degrades in language,
 *  never sits), and neither on cold-start (no history — no fake numbers; the
 *  flavor cycle / the bars carry the wait). At most one of the two is set.
 *  The label is minute-granular, never a ticking `0:24` — false precision +
 *  per-second churn were the anti-patterns. */
interface WaitLines {
  readonly countdownLabel?: string
  readonly stalledLabel?: string
}

function waitLinesFrom(remainingMs: number | null, t: TFunction): WaitLines {
  const display = waitDisplay({
    remainingMs,
    elapsedMs: 0,
    noHistoryStallMs: Number.POSITIVE_INFINITY,
  })
  if (display.kind === 'estimate') {
    return { countdownLabel: t('worldGen.countdown', { time: coarseWaitTime(display.bucket, t) }) }
  }
  if (display.kind === 'stalled') return { stalledLabel: t('shared.wait.stalled') }
  return {}
}

/** The MONOTONIC fold over the raw aggregate estimate (ux-run2 myth-uz1bn): the
 *  shown remaining wait may hold, never climb — `min(new, lastShown)` per tick,
 *  with the last-shown value held in a ref for the LIFE of this view. The view
 *  stays mounted across the act-one → act-two swap, so the countdown survives
 *  the calm-wait → live-map transition instead of resetting per view. The
 *  render-time ref write is an idempotent min-fold (safe under StrictMode
 *  double-invocation). */
function useMonotonicEtaMs(rawMs: number | null): number | null {
  const lastShownRef = useRef<number | null>(null)
  const shown = clampEtaMonotonic(rawMs, lastShownRef.current)
  lastShownRef.current = shown ?? lastShownRef.current
  return shown
}

/** The graph contract requires `onSelect`, but generation is GATED (§3.4) so it
 *  never fires. A stable module-level no-op keeps the reference identity steady
 *  across renders (no needless re-sync churn). */
const noSelect = (): void => {
  /* gated: generation never fires selection */
}

/** The canonical entity-generation stage ids (the act-two act detector reads set
 *  membership per stream entry). NOTE: this is the GRAPH-ENTRY beat's detector —
 *  deliberately the full ENTITY_STAGES slice, not the watched subset (any entity
 *  stage underway means there is something to watch). Distinct from the
 *  wiki-reveal boundary the route owns (`connectionsDone`). */
const ENTITY_STAGE_SET: ReadonlySet<string> = new Set(ENTITY_STAGES)

/** Every canonical world-gen stage → its friendly i18n label key. Keyed by
 *  `WorldGenStage`, so a stage added to the taxonomy fails the compile HERE (a
 *  missing Record entry) rather than silently falling back to a placeholder — the
 *  status card + the SR announcer then always have a real label for any stage the
 *  stream reports. The values are literal typed keys so `t()` accepts them. */
const STAGE_LABEL_KEY = {
  concept_intake: 'worldGen.stage.concept_intake',
  world_color: 'worldGen.stage.world_color',
  vocabulary_intake: 'worldGen.stage.vocabulary_intake',
  world_and_factions: 'worldGen.stage.world_and_factions',
  locations_and_npcs: 'worldGen.stage.locations_and_npcs',
  entity_relationships: 'worldGen.stage.entity_relationships',
  world_introduction: 'worldGen.stage.world_introduction',
  entity_consolidation: 'worldGen.stage.entity_consolidation',
  starting_situation: 'worldGen.stage.starting_situation',
  random_tables: 'worldGen.stage.random_tables',
  coherence_pass: 'worldGen.stage.coherence_pass',
  embed_world: 'worldGen.stage.embed_world',
} as const satisfies Record<WorldGenStage, string>

/** Friendly per-stage labels for the status card (§3.3) + the SR announcer,
 *  covering ALL canonical stages. Built by iterating WORLD_GEN_STAGES (not a
 *  hand-listed subset), so the map can never silently omit a stage: any stage
 *  the stream surfaces resolves to a real label, and a taxonomy addition fails
 *  loud at the STAGE_LABEL_KEY compile check above. The DS owns no copy, so the
 *  route resolves each backend stage id → its i18n'd label here; the card's
 *  own fallback is now defensive only. The WATCHED-ENTITY stages — the card's
 *  bars — get their scope composed in ("Stage 2 of 4 · …", ux-run2 myth-uz1bn):
 *  run 2 read a bare stage label + "0%" as overall progress; the explicit
 *  position makes stage scope and overall time impossible to conflate. */
function stageLabelsFrom(t: TFunction): Record<string, string> {
  const position = new Map(WATCHED_ENTITY_STAGES.map((stage, i) => [stage, i + 1]))
  return Object.fromEntries(
    WORLD_GEN_STAGES.map((stage) => {
      const plain = t(STAGE_LABEL_KEY[stage])
      const current = position.get(stage)
      return [
        stage,
        current === undefined
          ? plain
          : t('worldGen.stagePosition', {
              current,
              total: WATCHED_ENTITY_STAGES.length,
              stage: plain,
            }),
      ]
    }),
  )
}

/** The act-one flavor lines — cycled by WorldGenLoading every ~10s in RANDOM
 *  order (twenty slots so the loop never feels short, shuffled so it never
 *  feels canned), past lines settling into the whisper ledger. Literal keys —
 *  the typed catalog rejects dynamic ones. */
function flavorLabelsFrom(t: TFunction): readonly string[] {
  return [
    t('worldGen.flavor1'),
    t('worldGen.flavor2'),
    t('worldGen.flavor3'),
    t('worldGen.flavor4'),
    t('worldGen.flavor5'),
    t('worldGen.flavor6'),
    t('worldGen.flavor7'),
    t('worldGen.flavor8'),
    t('worldGen.flavor9'),
    t('worldGen.flavor10'),
    t('worldGen.flavor11'),
    t('worldGen.flavor12'),
    t('worldGen.flavor13'),
    t('worldGen.flavor14'),
    t('worldGen.flavor15'),
    t('worldGen.flavor16'),
    t('worldGen.flavor17'),
    t('worldGen.flavor18'),
    t('worldGen.flavor19'),
    t('worldGen.flavor20'),
  ]
}

/** Whether entities have started appearing — the act-one → watch-beat trigger.
 *  TRUE when the stream reports an ENTITY_STAGES stage underway
 *  (running/completed/failed — anything past pending), OR when the first node has
 *  already arrived (the entity-added event can land before the stage snapshot
 *  catches up; either signal suffices, so the button never lags the visible
 *  truth). */
function entitiesStarted(
  stages: GeneratingViewProps['stages'],
  nodes: GeneratingViewProps['nodes'],
): boolean {
  if (nodes.length > 0) return true
  return stages.some((s) => ENTITY_STAGE_SET.has(s.stage) && s.status !== 'pending')
}

export function GeneratingView({
  nodes,
  edges,
  stages,
  stageTimings = null,
  resumedMidGen,
}: GeneratingViewProps): React.JSX.Element {
  const { t } = useTranslation()
  // The act state: 'loading' (act one — the generic loading screen) until the
  // player presses the watch button, then 'graph' (act two) until the wiki
  // reveal. A DELIBERATE transition on a FIRST visit — never automatic. But a
  // mid-gen REJOIN/REFRESH of an already-populated world (`resumedMidGen`) lands
  // straight on the graph: the "watch your world be born" beat already happened,
  // so forcing the loading screen would be a step backward (myth-gcsp1).
  const [act, setAct] = useState<'loading' | 'graph'>('loading')
  useEffect(() => {
    if (resumedMidGen) setAct('graph')
  }, [resumedMidGen])
  // The graph's Canvas rAF loop + fog sim run for the whole ~10-min generation; the
  // global CSS reduce-block can't stop a JS rAF loop, so we read the OS/browser
  // preference here (web layer — DOM `matchMedia`) and hand the graph the boolean.
  const prefersReducedMotion = usePrefersReducedMotion()

  // The resolved label maps (module-level builders — the DS owns no copy).
  const stageLabels = useMemo<Record<string, string>>(() => stageLabelsFrom(t), [t])
  const flavorLabels = useMemo<readonly string[]>(() => flavorLabelsFrom(t), [t])

  // The COARSE remaining-wait line (MYT-102 timer revamp + ux-run2 myth-uz1bn):
  // ONE AGGREGATE budget for the WHOLE visible wait — `remainingWaitMs` sums the
  // full WATCHED slice (prep through the wiki reveal), so act one and act two
  // read the SAME number and the calm-wait → live-map transition cannot reset
  // the countdown upward. (This retires the myth-tudy1 two-target design: run 2
  // proved a per-view target reads as a lie the moment the view changes —
  // "Under a minute" → "8 min remaining".) The raw estimate is re-derived every
  // tick from historical stage averages ∩ live statuses, then folded through the
  // MONOTONIC clamp: shown = min(new, lastShown) — it may hold at a floor when a
  // stage overruns, never climb. The instant it EXHAUSTS, the line degrades in
  // language (the shared stalled reassurance) rather than sitting at a dead
  // floor; `null`/cold-start → no line at all (no fake numbers).
  const hasTimings = stageTimings !== null && stageTimings.length > 0
  const nowMs = useNowMs(hasTimings)
  const rawRemainingMs = useMemo(
    () => remainingWaitMs(stageTimings, stages, nowMs),
    [stageTimings, stages, nowMs],
  )
  const remainingMs = useMonotonicEtaMs(rawRemainingMs)
  const { countdownLabel, stalledLabel } = useMemo(() => waitLinesFrom(remainingMs, t), [remainingMs, t])

  // E1 (MYT-89 Phase E) — the SR announcer's PHASE signal: the running watched-entity
  // stage's friendly label (a change flushes the live region at once); before or between
  // those stages it falls back to the generic status title. A structural pick over the
  // same stream data the card reads — the graph owns the announce pacing.
  const generationPhaseLabel = useMemo(() => {
    const running = stages.find((s) => s.status === 'running' && stageLabels[s.stage] !== undefined)
    return running !== undefined ? (stageLabels[running.stage] ?? t('worldGen.statusTitle')) : t('worldGen.statusTitle')
  }, [stages, stageLabels, t])

  // ACT ONE — the generic loading screen, with the watch button once entities
  // start. The gen keeps streaming underneath (the route's hook stays mounted);
  // watching only swaps what this view renders.
  if (act === 'loading') {
    return (
      <Stack gap={4} data-testid="worldgen-generating">
        <WorldGenLoading
          data-testid="worldgen-loading"
          flavorLabels={flavorLabels}
          spinnerLabel={t('worldGen.loadingLabel')}
          // The mark accretes on REAL pipeline events (completed stages +
          // arrived entities — myth-i2pdo): stillness means stillness, motion
          // means work.
          accretion={worldGenAccretion(stages, nodes.length)}
          // Permission to leave — re-entry lands back here with progress intact
          // (the stream re-snapshots; a populated world resumes on the graph).
          leaveLabel={t('worldGen.safeToLeave')}
          // The SAME aggregate countdown act two shows (one budget, monotonic).
          // Omit absent keys — exactOptionalPropertyTypes forbids an explicit
          // `undefined`.
          {...(countdownLabel !== undefined ? { countdownLabel } : {})}
          {...(stalledLabel !== undefined ? { stalledLabel } : {})}
          watchReady={entitiesStarted(stages, nodes)}
          watchLabel={t('worldGen.watch')}
          onWatch={() => {
            setAct('graph')
          }}
        />
      </Stack>
    )
  }

  // ACT TWO — the fog-forward gated graph. The stage (MYT-89 audit v2) makes the
  // graph OWN a phone screen: on narrow viewports it cancels the AppFrame's
  // content inset and fills the viewport below the header — nav + full-bleed
  // pane + the graph's status footer = exactly one screen. `inset={6}` MUST
  // match the AppFrame content Box's `padding={6}` (app-frame.test.tsx pins the
  // pair). On wide viewports the stage is a plain block — desktop unchanged.
  return (
    <FullBleedStage inset={6} data-testid="worldgen-generating">
      <WorldGenGraph
        interactive={false}
        nodes={nodes}
        edges={edges}
        onSelect={noSelect}
        reducedMotion={prefersReducedMotion}
        status={{
          stages,
          stageLabels,
          titleLabel: t('worldGen.statusTitle'),
          doneLabel: t('worldGen.statusDone'),
          progressLabel: t('worldGen.statusProgress'),
          // The SAME aggregate wait line act one showed (one monotonic budget —
          // the transition into this view can never move the number up). Omit
          // absent keys (exactOptionalPropertyTypes forbids an explicit
          // `undefined` on an optional prop).
          ...(countdownLabel !== undefined ? { countdownLabel } : {}),
          ...(stalledLabel !== undefined ? { stalledLabel } : {}),
          // The way back to the calm wait (ux-run2 myth-t11az) — watching is a
          // choice, not a one-way door.
          returnLabel: t('worldGen.waitQuietly'),
          onReturn: () => {
            setAct('loading')
          },
        }}
        // Fog DRAIN keyed off the ENTITY COUNT (MYT-89 spawn-drain): every arrived
        // node ramps the fog's respawn flux down by 1/MIN_EXPECTED_ENTITIES — the
        // wind carries the fog off the pane and ever fewer particles replace it,
        // fully gone by the DB-derived minimum a real generation produces (never a
        // paint fade; the sim spawns less, the draw stays at base density). At 0
        // nodes (just revealed) the scale is 1 — full fog at the birth of the world.
        shownEntities={nodes.length}
        totalEntities={MIN_EXPECTED_ENTITIES}
        // E1 (Phase E): the SR model for the aria-hidden generation canvas — a
        // polite live region (phase flushes at once; the entity tally is coalesced)
        // + a hidden entities-so-far list. All strings resolved here (DS owns no copy).
        generationA11y={{
          entityListLabel: t('worldGen.a11y.entityList'),
          phaseLabel: generationPhaseLabel,
          entitiesLabel: t('worldGen.a11y.entities', { count: nodes.length }),
        }}
      />
    </FullBleedStage>
  )
}
