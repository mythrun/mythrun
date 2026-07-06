import { useMemo } from 'react'
import { Stack, WorldGenGraph } from '@mythrun/ui'
import { remainingStageMs, type StageTiming, type WorldGenStream } from '@mythrun/client-core'
import { useTranslation } from 'react-i18next'
import type { TFunction } from 'i18next'
import { usePrefersReducedMotion } from '../../platform/web/use-prefers-reduced-motion.ts'

// The GENERATING VIEW (MYT-89 Phase C, C7 + audit ③/⑥) — the live world-gen
// experience the `/campaigns/:id` route lands on after Begin, and the returnable
// background state a player can leave and re-enter. C7 removes C5's `interactive`
// bridge and wires the true fog-forward, GATED generation experience (§3.3/§3.4):
//
//   - the graph is INERT (`interactive={false}`): no entity list, no selection —
//     the fog + graph own the whole space (§3.4; the accessible representation is
//     E1's aria-live surface, not a visual list);
//   - the WorldGenStatusCard (C4) is fed the stream's `stages[]` + a `[ph:]`
//     stage-label map + a data-driven ETA label (from the route's stage-timings
//     fetch), so the ~2-minute pre-entity stretch reads as work with a "time left".
//     Cost is NOT passed (audit ⑥ — the player never sees API spend);
//   - the FOG FADE is keyed off STAGE progress (completed/total), NOT entity count:
//     the total-entity count is unknown mid-gen (entities stream in), but `stages[]`
//     is known and its completed/total is the SAME signal the status card's percent
//     uses — so the two progress surfaces agree, and the fog reaches 0 (fully gone)
//     exactly when every reported stage is complete (the reveal moment, §3.8).
//
// Flat 1-bit paper register — no chrome. The route owns the stream + the timings
// fetch; this view is a presentational surface that formats the ETA for display.

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

export function GeneratingView({
  nodes,
  edges,
  stages,
  stageTimings = null,
}: GeneratingViewProps): React.JSX.Element {
  const { t } = useTranslation()
  // The graph's Canvas rAF loop + fog sim run for the whole ~10-min generation; the
  // global CSS reduce-block can't stop a JS rAF loop, so we read the OS/browser
  // preference here (web layer — DOM `matchMedia`) and hand the graph the boolean.
  const prefersReducedMotion = usePrefersReducedMotion()

  // Friendly per-stage labels for the status card (§3.3). The DS owns no copy, so
  // the route resolves each backend stage id → an i18n'd label; an unmapped stage
  // falls back to a `[ph:]` placeholder inside the card.
  const stageLabels = useMemo<Record<string, string>>(
    () => ({
      concept_intake: t('worldGen.stage.concept_intake'),
      world_color: t('worldGen.stage.world_color'),
      vocabulary_intake: t('worldGen.stage.vocabulary_intake'),
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

  // The data-driven ETA (audit ③): a rough "time left" from the historical stage
  // timings intersected with the live stage statuses. `null`/cold-start → undefined
  // → the card shows no estimate. Recomputed as stages advance (fewer remain).
  const etaLabel = useMemo(
    () => etaLabelFrom(remainingStageMs(stageTimings, stages), t),
    [stageTimings, stages, t],
  )

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
        // Fog fade keyed off STAGE progress: `completed / stages.length` — the same
        // ratio the status card's percent uses (so fog + card agree), reaching 1
        // (fog fully gone) when every reported stage is complete. `stages.length`
        // is 0 before the first snapshot → the fade is disabled → base-density fog.
        shownEntities={completedStages(stages)}
        totalEntities={stages.length}
      />
    </Stack>
  )
}
