import { useEffect, useMemo, useState } from 'react'
import { FullBleedStage, Stack, WorldGenGraph, WorldGenLoading } from '@mythrun/ui'
import { ENTITY_STAGES } from '@mythrun/contract/events'
import {
  remainingPrepWaitMs,
  remainingWaitMs,
  type StageTiming,
  type WorldGenStream,
} from '@mythrun/client-core'
import { MIN_EXPECTED_ENTITIES } from '@mythrun/client-core/worldgen'
import { useTranslation } from 'react-i18next'
import type { TFunction } from 'i18next'
import { usePrefersReducedMotion } from '../../platform/web/use-prefers-reduced-motion.ts'

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
//   - the WorldGenStatusCard (C4) is fed the stream's `stages[]` + a `[ph:]`
//     stage-label map (WATCHED entity stages only — the prep stretch belongs to
//     act one, and the silent tail runs behind the wiki reveal) + the ticking
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
// fetch; this view owns the act state (a local, deliberate transition — never
// automatic), the countdown's 1-second tick, and the `~M:SS` formatting.

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

/** Format the remaining wait into the ticking `~M:SS` countdown label, or
 *  `undefined` when there is no usable estimate (no history) — the surfaces show
 *  nothing rather than a fake number. 0 renders as `0:00` (the final-stage
 *  overrun holds there — "any moment now" — until the reveal fires). The digits
 *  are mechanical; the words around them are i18n. */
function countdownLabelFrom(remainingMs: number | null, t: TFunction): string | undefined {
  if (remainingMs === null) return undefined
  const totalSeconds = Math.max(0, Math.ceil(remainingMs / 1000))
  const minutes = Math.floor(totalSeconds / 60)
  const seconds = totalSeconds % 60
  return t('worldGen.countdown', {
    time: `${String(minutes)}:${String(seconds).padStart(2, '0')}`,
  })
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

  // Friendly per-stage labels for the status card (§3.3) — WATCHED entity stages
  // only: since the two-act cut the card renders no prep bar, and since the
  // reveal-timing cut (MYT-89) no tail bar either — the route swaps to the wiki
  // reveal at the entity_relationships boundary, so prep/tail labels would be
  // dead data. The DS owns no copy, so the route resolves each backend stage id →
  // an i18n'd label; an unmapped stage falls back to a `[ph:]` placeholder inside
  // the card.
  const stageLabels = useMemo<Record<string, string>>(
    () => ({
      world_and_factions: t('worldGen.stage.world_and_factions'),
      locations_and_npcs: t('worldGen.stage.locations_and_npcs'),
      entity_relationships: t('worldGen.stage.entity_relationships'),
    }),
    [t],
  )

  // The act-one flavor lines — `[ph:]` placeholders cycled by WorldGenLoading
  // every ~3s in RANDOM order (the copy is Miklos's; twenty slots so the loop
  // never feels short, shuffled so it never feels canned).
  const flavorLabels = useMemo<readonly string[]>(
    () => [
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
    ],
    [t],
  )

  // The per-second countdown (MYT-89 waiting-feedback, replacing the coarse
  // minute-granular ETA): the remaining visible wait — historical stage averages
  // ∩ live statuses, minus elapsed-in-the-running-stage — re-derived every tick
  // and formatted `~M:SS`. Ticks only when there IS a usable history;
  // `null`/cold-start → undefined → both surfaces show no estimate. It may HOLD
  // when a stage overruns (the clamp) and JUMP at the next stage event —
  // deliberate: an honest walk beats a smooth lie.
  const hasTimings = stageTimings !== null && stageTimings.length > 0
  const nowMs = useNowMs(hasTimings)
  // TWO targets (myth-tudy1): act one counts down to ARRIVING ON THE GRAPH (the
  // PREP slice — the watch-button beat); act two's status card keeps counting to
  // the wiki REVEAL (the WATCHED slice). Same tick, same `~M:SS` formatting.
  const prepCountdownLabel = useMemo(
    () => countdownLabelFrom(remainingPrepWaitMs(stageTimings, stages, nowMs), t),
    [stageTimings, stages, nowMs, t],
  )
  const revealCountdownLabel = useMemo(
    () => countdownLabelFrom(remainingWaitMs(stageTimings, stages, nowMs), t),
    [stageTimings, stages, nowMs, t],
  )

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
          // The countdown to ARRIVING ON THE GRAPH (the prep slice). Omit the key
          // when there's no estimate — exactOptionalPropertyTypes forbids an
          // explicit `undefined`.
          {...(prepCountdownLabel !== undefined ? { countdownLabel: prepCountdownLabel } : {})}
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
          // The status card keeps its countdown to the wiki REVEAL. Omit the key
          // entirely when there's no estimate (exactOptionalPropertyTypes forbids
          // an explicit `undefined` on an optional prop) → the card shows no
          // countdown.
          ...(revealCountdownLabel !== undefined ? { countdownLabel: revealCountdownLabel } : {}),
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
