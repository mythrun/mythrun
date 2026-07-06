import type { Meta, StoryObj } from '@storybook/react-vite'
import type { StageProgress } from '@mythrun/client-core/contract'
import { WorldGenStatusCard } from './WorldGenStatusCard.tsx'

// WorldGenStatusCard — the generation status/loading overlay pinned top-left of the
// graph pane. It turns the long pre-entity stretch (the first ~2 minutes, before any
// named entity arrives) into legible PROGRESS: the current (running) stage's friendly
// label, a completed/total percent, and a PAPER-REGISTER segmented square bar whose
// running cell pulses (opacity fade — the brand's only sanctioned motion; NO spinner,
// NO circle). At 100% the pulse stops and the bar rests full. Every label is a `[ph:]`
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

// The seven-stage world-gen pipeline, built at a chosen point of progress.
const STAGE_IDS = [
  'concept_intake',
  'world_color',
  'vocabulary_intake',
  'entity_relationships',
  'entity_details',
  'fact_generation',
  'coherence_pass',
] as const

/** Build the stage set with the first `done` completed, the next one running (unless
 *  all are done), the rest pending. */
function stagesAt(done: number): StageProgress[] {
  return STAGE_IDS.map((id, i) =>
    stage(id, i < done ? 'completed' : i === done ? 'running' : 'pending'),
  )
}

// Friendly per-stage labels (i18n keys — the DS owns no copy).
const STAGE_LABELS: Record<string, string> = {
  concept_intake: '[ph: shaping the concept]',
  world_color: '[ph: colouring the world]',
  vocabulary_intake: '[ph: naming things]',
  entity_relationships: '[ph: drawing connections]',
  entity_details: '[ph: filling in detail]',
  fact_generation: '[ph: gathering lore]',
  coherence_pass: '[ph: making it hold together]',
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

// EARLY — the first stage running, nothing completed yet (the "is this hung?" window
// the card exists to answer). The bar shows a single pulsing ember cell.
export const Early: Story = {
  render: () => (
    <Pane>
      <WorldGenStatusCard stages={stagesAt(0)} stageLabels={STAGE_LABELS} costUsd={0.02} />
    </Pane>
  ),
}

// MID — several stages done, one running (the graph is filling behind the overlay).
export const Mid: Story = {
  render: () => (
    <Pane>
      <WorldGenStatusCard stages={stagesAt(4)} stageLabels={STAGE_LABELS} costUsd={0.41} />
    </Pane>
  ),
}

// COMPLETE — every stage done: 100%, the done label, the pulse stopped, the bar full.
export const Complete: Story = {
  render: () => (
    <Pane>
      <WorldGenStatusCard
        stages={stagesAt(STAGE_IDS.length)}
        stageLabels={STAGE_LABELS}
        doneLabel="[ph: your world is ready]"
        costUsd={0.63}
      />
    </Pane>
  ),
}
