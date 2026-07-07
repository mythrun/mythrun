import type { Meta, StoryObj } from '@storybook/react-vite'
import { ENTITY_STAGES } from '@mythrun/contract/events'
import type { StageProgress } from '@mythrun/client-core/contract'
import { WorldGenStatusCard } from './WorldGenStatusCard.tsx'

// WorldGenStatusCard — the generation status/loading overlay pinned top-left of the
// graph pane during the ENTITY-GENERATION act. Since the two-act cut, the pre-entity
// prep stretch (concept_intake / world_color / vocabulary_intake) lives in the
// WorldGenLoading screen — this card renders ONLY the entity-generation stages: the
// current (running) stage's friendly label, a completed/8 percent, an optional
// data-driven "time left", and a PAPER-REGISTER segmented square bar of a FIXED 8
// cells (one per canonical ENTITY_STAGES stage, known from frame one — the stream only
// advances the fills) whose running cell pulses (opacity fade — the brand's only
// sanctioned motion; NO spinner, NO circle). At 100% the pulse stops and the bar rests
// full. Cost is NOT shown (the player never sees API spend). Every label is a `[ph:]`
// i18n key (the DS owns no copy). These specimens render it inside a mock graph pane
// so the `absolute` overlay pins correctly.

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

// The canonical 8-stage entity-generation act (the ENTITY_STAGES slice the card seeds
// its FIXED bars from), built at a chosen point of progress. Only the first `done`
// stages have appeared in the "stream" — the card fills the rest as pending from the
// taxonomy.
function stagesAt(done: number): StageProgress[] {
  return ENTITY_STAGES.slice(0, Math.min(done + 1, ENTITY_STAGES.length)).map((id, i) =>
    stage(id, i < done ? 'completed' : 'running'),
  )
}

// Friendly per-stage labels (i18n keys — the DS owns no copy). Entity stages only —
// the prep stages have no bar on this card anymore.
const STAGE_LABELS: Record<string, string> = {
  world_and_factions: '[ph: raising the powers]',
  locations_and_npcs: '[ph: settling people and places]',
  entity_relationships: '[ph: drawing connections]',
  entity_consolidation: '[ph: resolving the ties]',
  starting_situation: '[ph: finding your opening]',
  random_tables: '[ph: seeding the unexpected]',
  coherence_pass: '[ph: making it hold together]',
  embed_world: '[ph: committing it to memory]',
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
// player reveals the graph). 8 bars from frame one; a single pulsing ember cell.
export const Early: Story = {
  render: () => (
    <Pane>
      <WorldGenStatusCard stages={stagesAt(0)} stageLabels={STAGE_LABELS} etaLabel="[ph: ~4m left]" />
    </Pane>
  ),
}

// MID — several stages done, one running (the graph is filling behind the overlay).
export const Mid: Story = {
  render: () => (
    <Pane>
      <WorldGenStatusCard stages={stagesAt(4)} stageLabels={STAGE_LABELS} etaLabel="[ph: ~2m left]" />
    </Pane>
  ),
}

// NO ESTIMATE — cold-start (no history): the bars, but no "time left" line.
export const NoEstimate: Story = {
  render: () => (
    <Pane>
      <WorldGenStatusCard stages={stagesAt(2)} stageLabels={STAGE_LABELS} />
    </Pane>
  ),
}

// COMPLETE — every entity stage done: 100%, the done label, the pulse stopped, the
// bar full.
export const Complete: Story = {
  render: () => (
    <Pane>
      <WorldGenStatusCard
        stages={stagesAt(ENTITY_STAGES.length)}
        stageLabels={STAGE_LABELS}
        doneLabel="[ph: your world is ready]"
      />
    </Pane>
  ),
}
