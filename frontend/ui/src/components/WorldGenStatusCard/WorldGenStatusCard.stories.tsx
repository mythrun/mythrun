import type { Meta, StoryObj } from '@storybook/react-vite'
import { WATCHED_ENTITY_STAGES } from '@mythrun/contract/events'
import type { StageProgress } from '@mythrun/client-core/contract'
import { WorldGenStatusCard } from './WorldGenStatusCard.tsx'

// WorldGenStatusCard — the generation status/loading overlay pinned top-left of the
// graph pane during the VISIBLE WAIT of the graph act. Since the two-act cut, the
// pre-entity prep stretch (concept_intake / world_color / vocabulary_intake) lives in
// the WorldGenLoading screen; since the reveal-timing cut (MYT-89), the SILENT TAIL
// (entity_consolidation → embed_world) runs behind the wiki reveal — this card renders
// ONLY the watched entity stages (world_and_factions → entity_relationships): the
// current (running) stage's friendly label, a completed/3 percent, an optional
// data-driven "time left", and a PAPER-REGISTER segmented square bar of a FIXED 3
// cells (one per canonical WATCHED_ENTITY_STAGES stage, known from frame one — the
// stream only advances the fills) whose running cell pulses (opacity fade — the
// brand's only sanctioned motion; NO spinner, NO circle). The bars hit 100% exactly at
// the wiki-reveal moment: the pulse stops and the bar rests full. Cost is NOT shown
// (the player never sees API spend). Every label is a `[ph:]` i18n key (the DS owns no
// copy). These specimens render it inside a mock graph pane so the `absolute` overlay
// pins correctly.

const meta: Meta<typeof WorldGenStatusCard> = {
  title: 'Patterns/WorldGenStatusCard',
  component: WorldGenStatusCard,
  tags: ['autodocs'],
  parameters: { layout: 'fullscreen' },
}

// eslint-disable-next-line no-restricted-syntax -- Storybook CSF requires the meta object as the module's default export.
export default meta

type Story = StoryObj<typeof WorldGenStatusCard>

const stage = (id: string, status: StageProgress['status']): StageProgress => ({
  stage: id,
  status,
  userId: null,
  costUsd: 0,
  startedAt: null,
  completedAt: null,
})

// The canonical watched-entity act (the WATCHED_ENTITY_STAGES slice the card seeds
// its FIXED bars from), built at a chosen point of progress. Only the first `done`
// stages have appeared in the "stream" — the card fills the rest as pending from the
// taxonomy.
function stagesAt(done: number): StageProgress[] {
  return WATCHED_ENTITY_STAGES.slice(0, Math.min(done + 1, WATCHED_ENTITY_STAGES.length)).map(
    (id, i) => stage(id, i < done ? 'completed' : 'running'),
  )
}

// Friendly per-stage labels (i18n keys — the DS owns no copy). Watched entity stages
// only — the prep stages live on the loading screen and the silent tail has no bar.
const STAGE_LABELS: Record<string, string> = {
  world_and_factions: '[ph: raising the powers]',
  locations_and_npcs: '[ph: settling people and places]',
  entity_relationships: '[ph: drawing connections]',
}

// A mock graph pane (the `relative` host the overlay pins inside).
function Pane({ children }: { children: React.ReactNode }): React.JSX.Element {
  return (
    <div className="min-h-dvh bg-bg p-[var(--space-6)]">
      <div className="relative aspect-[4/3] w-full max-w-[720px] border border-border bg-surface">
        {children}
      </div>
    </div>
  )
}

// EARLY — the first entity stage running, nothing completed yet (the moment the
// player enters the graph). 3 bars from frame one; a single pulsing ember cell.
export const Early: Story = {
  render: () => (
    <Pane>
      <WorldGenStatusCard stages={stagesAt(0)} stageLabels={STAGE_LABELS} etaLabel="[ph: ~4m left]" />
    </Pane>
  ),
}

// MID — some stages done, the boundary stage running (the graph is filling behind
// the overlay).
export const Mid: Story = {
  render: () => (
    <Pane>
      <WorldGenStatusCard stages={stagesAt(2)} stageLabels={STAGE_LABELS} etaLabel="[ph: ~2m left]" />
    </Pane>
  ),
}

// NO ESTIMATE — cold-start (no history): the bars, but no "time left" line.
export const NoEstimate: Story = {
  render: () => (
    <Pane>
      <WorldGenStatusCard stages={stagesAt(1)} stageLabels={STAGE_LABELS} />
    </Pane>
  ),
}

// COMPLETE — every watched entity stage done: 100%, the done label, the pulse
// stopped, the bar full. This is the wiki-reveal moment — the silent tail keeps
// running behind the reveal, but the card's wait is over.
export const Complete: Story = {
  render: () => (
    <Pane>
      <WorldGenStatusCard
        stages={stagesAt(WATCHED_ENTITY_STAGES.length)}
        stageLabels={STAGE_LABELS}
        doneLabel="[ph: your world is ready]"
      />
    </Pane>
  ),
}
