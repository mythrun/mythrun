import { useMemo, useState } from 'react'
import { Stack, WorldGenGraph, WorldGenLoading } from '@mythrun/ui'
import { ENTITY_STAGES } from '@mythrun/contract/events'
import { remainingStageMs, type StageTiming, type WorldGenStream } from '@mythrun/client-core'
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
//   the DS Spinner + a flavor line cycling short playful loading messages. No
//   graph, no fog, no status card.
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
//     stage-label map (ENTITY stages only — the prep stretch belongs to act one)
//     + a data-driven ETA label (from the route's stage-timings fetch). Cost is
//     NOT passed (audit ⑥ — the player never sees API spend);
//   - the FOG FADE is keyed off STAGE progress (completed/total over ALL
//     reported stages), NOT entity count: `stages[]` is known and reaches
//     all-completed at the end, so the fog is fully gone exactly at the reveal
//     moment (§3.8).
//
// Flat 1-bit paper register — no chrome. The route owns the stream + the timings
// fetch; this view owns the act state (a local, deliberate transition — never
// automatic) and formats the ETA for display.

/** The generation graph model + the status/fade inputs (folded by the route's
 *  `useWorldGenStream`) plus the route's historical stage timings (for the ETA). */
interface GeneratingViewProps extends Pick<WorldGenStream, 'nodes' | 'edges' | 'stages'> {
  /** Historical per-stage average durations (the route's `getStageTimings` fetch),
   *  or `null` before it resolves / on cold-start → the card shows no estimate. */
  readonly stageTimings?: readonly StageTiming[] | null
}

/** Format the rough remaining-ms into a resolved `[ph:]` ETA label, or `undefined`
 *  when there is no usable estimate (no history, or nothing left). Minutes when a
 *  minute-plus remains, seconds in the final stretch — the words + units are i18n. */
function etaLabelFrom(remainingMs: number | null, t: TFunction): string | undefined {
  if (remainingMs === null) return undefined
  const totalSeconds = Math.round(remainingMs / 1000)
  if (totalSeconds <= 0) return undefined
  if (totalSeconds < 60) return t('worldGen.statusEtaShort', { seconds: totalSeconds })
  return t('worldGen.statusEta', { minutes: Math.max(1, Math.round(totalSeconds / 60)) })
}

/** The graph contract requires `onSelect`, but generation is GATED (§3.4) so it
 *  never fires. A stable module-level no-op keeps the reference identity steady
 *  across renders (no needless re-sync churn). */
const noSelect = (): void => {
  /* gated: generation never fires selection */
}

/** Count completed stages — the fog-fade numerator. Keyed off STAGE progress (not
 *  entity count): `stages[]` is known + reaches all-completed at the end, so the
 *  fog is guaranteed GONE by completion (the invariant, §3.2f / §3.8). */
function completedStages(stages: GeneratingViewProps['stages']): number {
  return stages.filter((s) => s.status === 'completed').length
}

/** The canonical entity-generation stage ids (the act-two act detector reads set
 *  membership per stream entry). */
const ENTITY_STAGE_SET: ReadonlySet<string> = new Set(ENTITY_STAGES)

/** Whether entities have started appearing — the act-one → beat trigger. TRUE when
 *  the stream reports an ENTITY_STAGES stage underway (running/completed/failed —
 *  anything past pending), OR when the first node has already arrived (the
 *  entity-added event can land before the stage snapshot catches up; either signal
 *  suffices, so the button never lags the visible truth). */
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
}: GeneratingViewProps): React.JSX.Element {
  const { t } = useTranslation()
  // The act state: 'loading' (act one — the generic loading screen) until the
  // player presses the reveal button, then 'graph' (act two) for the rest of the
  // generation. A DELIBERATE transition — never automatic; re-entering mid-gen
  // restarts at the loading screen with the button already offered.
  const [act, setAct] = useState<'loading' | 'graph'>('loading')
  // The graph's Canvas rAF loop + fog sim run for the whole ~10-min generation; the
  // global CSS reduce-block can't stop a JS rAF loop, so we read the OS/browser
  // preference here (web layer — DOM `matchMedia`) and hand the graph the boolean.
  const prefersReducedMotion = usePrefersReducedMotion()

  // Friendly per-stage labels for the status card (§3.3) — ENTITY stages only:
  // since the two-act cut the card renders no prep bar, so prep labels would be
  // dead data. The DS owns no copy, so the route resolves each backend stage id →
  // an i18n'd label; an unmapped stage falls back to a `[ph:]` placeholder inside
  // the card.
  const stageLabels = useMemo<Record<string, string>>(
    () => ({
      world_and_factions: t('worldGen.stage.world_and_factions'),
      locations_and_npcs: t('worldGen.stage.locations_and_npcs'),
      entity_relationships: t('worldGen.stage.entity_relationships'),
      entity_consolidation: t('worldGen.stage.entity_consolidation'),
      starting_situation: t('worldGen.stage.starting_situation'),
      random_tables: t('worldGen.stage.random_tables'),
      coherence_pass: t('worldGen.stage.coherence_pass'),
      embed_world: t('worldGen.stage.embed_world'),
    }),
    [t],
  )

  // The act-one flavor lines — `[ph:]` placeholders cycled by WorldGenLoading
  // every ~3s (the copy is Miklos's; six slots so the loop doesn't feel short).
  const flavorLabels = useMemo<readonly string[]>(
    () => [
      t('worldGen.flavor1'),
      t('worldGen.flavor2'),
      t('worldGen.flavor3'),
      t('worldGen.flavor4'),
      t('worldGen.flavor5'),
      t('worldGen.flavor6'),
    ],
    [t],
  )

  // The data-driven ETA (audit ③): a rough "time left" from the historical stage
  // timings intersected with the live stage statuses. `null`/cold-start → undefined
  // → the card shows no estimate. Recomputed as stages advance (fewer remain).
  const etaLabel = useMemo(
    () => etaLabelFrom(remainingStageMs(stageTimings, stages), t),
    [stageTimings, stages, t],
  )

  // The ENTITY-act slice of the reported stages — the fog-fade inputs. Since the
  // two-act cut, act two BEGINS at the first entity stage, so the fog fades over
  // the entity stages only (full fog at the reveal moment, agreeing with the
  // status card's entity-only percent) and still reaches fully-gone exactly when
  // the last stage (embed_world) completes (§3.8 — the invariant holds: the
  // entity slice ends where the pipeline ends).
  const entityStages = useMemo(
    () => stages.filter((s) => ENTITY_STAGE_SET.has(s.stage)),
    [stages],
  )

  // ACT ONE — the generic loading screen, with the reveal button once entities
  // start. The gen keeps streaming underneath (the route's hook stays mounted);
  // revealing only swaps what this view renders.
  if (act === 'loading') {
    return (
      <Stack gap={4} data-testid="worldgen-generating">
        <WorldGenLoading
          data-testid="worldgen-loading"
          flavorLabels={flavorLabels}
          spinnerLabel={t('worldGen.loadingLabel')}
          revealReady={entitiesStarted(stages, nodes)}
          revealLabel={t('worldGen.reveal')}
          onReveal={() => {
            setAct('graph')
          }}
        />
      </Stack>
    )
  }

  // ACT TWO — the fog-forward gated graph.
  return (
    <Stack gap={4} data-testid="worldgen-generating">
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
          // Omit the key entirely when there's no estimate (exactOptionalPropertyTypes
          // forbids an explicit `undefined` on an optional prop) → the card shows no ETA.
          ...(etaLabel !== undefined ? { etaLabel } : {}),
        }}
        // Fog fade keyed off ENTITY-STAGE progress: `completed / reported` over the
        // entity slice — the same signal the status card's percent uses (so fog +
        // card agree), reaching 1 (fog fully gone) when every entity stage is
        // complete (= pipeline done; embed_world is last). A length of 0 (just
        // revealed, no entity stage reported yet) disables the fade → base-density
        // fog — full fog at the birth of the world.
        shownEntities={completedStages(entityStages)}
        totalEntities={entityStages.length}
      />
    </Stack>
  )
}
