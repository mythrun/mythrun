import type { Meta, StoryObj } from '@storybook/react-vite'
import { I18nextProvider } from 'react-i18next'
import type { PipelineEvent } from '@mythrun/contract/events'
import {
  ApiClientProvider,
  createSseStatusClient,
  type ApiContext,
  type SseStatusClient,
} from '@mythrun/client-core'
import type { CharacterCreationStreamDeps } from '@mythrun/client-core/character'
import { i18n } from '../../i18n/config.ts'
import { CharacterLoadingSurface } from './character-loading.tsx'

// CharacterLoadingSurface — the processing-state screen (the DS CharacterLoadingBeat
// under its screen headline, driven by useCharacterCreationStream). The specimens
// feed the surface a hand-driven stream through the hook's `deps` seam: a fake SSE
// client that replays a fixed event set on open, so the fold settles to a fixed
// progress WITHOUT a live backend. Mid = concept done + sheet underway; Done =
// every stage complete + the completion event (the swap-to-reveal moment). The
// live folding itself is covered by use-character-creation-stream.test.ts; these
// exist for the E1 responsive/a11y sweep.

const VIEWER = 'viewer'
const STORY_CID = 'story-campaign'
const STORY_CTX: ApiContext = {
  baseUrl: 'http://storybook.invalid',
  getAuthHeaders: () => Promise.resolve({}),
}

const started = (stage: string): PipelineEvent => ({
  type: 'stage-started',
  stage,
  userId: VIEWER,
  startedAt: '2026-07-11T10:00:00.000Z',
})
const completed = (stage: string): PipelineEvent => ({
  type: 'stage-completed',
  stage,
  userId: VIEWER,
  durationMs: 1000,
  costUsd: 0,
})
const complete = (): PipelineEvent => ({ type: 'character_creation_complete', userId: VIEWER })

// A deps seam whose client replays `events` on open. The hook subscribes via
// onEvent BEFORE calling open, so the synchronous replay reaches its listener and
// the beats fold to their final state on mount.
function replay(events: readonly PipelineEvent[]): CharacterCreationStreamDeps {
  return {
    createClient: (ctx): SseStatusClient => {
      const listeners = new Set<(e: PipelineEvent) => void>()
      // Borrow a genuine (never-opened) connection store to satisfy the transport
      // type — the surface never reads it, and we replay events through our own
      // open(). No real connection is ever established (open() below is ours).
      const { connectionState } = createSseStatusClient(ctx)
      return {
        connectionState,
        open: () => {
          for (const e of events) for (const cb of listeners) cb(e)
        },
        onEvent: (cb) => {
          listeners.add(cb)
          return () => listeners.delete(cb)
        },
        onSnapshot: () => () => undefined,
        close: () => undefined,
      }
    },
  }
}

const MID_EVENTS: readonly PipelineEvent[] = [
  completed('character_concept'),
  started('character_sheet'),
]
const DONE_EVENTS: readonly PipelineEvent[] = [
  completed('character_concept'),
  completed('character_sheet'),
  complete(),
]

function renderWith(events: readonly PipelineEvent[]): React.JSX.Element {
  return (
    <I18nextProvider i18n={i18n}>
      <ApiClientProvider value={STORY_CTX}>
        <CharacterLoadingSurface
          campaignId={STORY_CID}
          userId={VIEWER}
          onDone={() => undefined}
          deps={replay(events)}
        />
      </ApiClientProvider>
    </I18nextProvider>
  )
}

const meta: Meta<typeof CharacterLoadingSurface> = {
  title: 'Screens/CharacterLoading',
  component: CharacterLoadingSurface,
}
// eslint-disable-next-line no-restricted-syntax -- Storybook CSF requires the meta object as the module's default export.
export default meta

type Story = StoryObj<typeof CharacterLoadingSurface>

// Mid-progress — the concept resolved (name + class done), the sheet underway
// (scores + kit surfacing); the figure is part-filled.
export const MidProgress: Story = {
  name: 'Mid-progress (concept done, sheet underway)',
  render: () => renderWith(MID_EVENTS),
}

// Complete — every stage done and the completion event delivered (the swap
// moment); the figure is fully materialised.
export const Complete: Story = {
  name: 'Complete (all done — swaps to the reveal)',
  render: () => renderWith(DONE_EVENTS),
}
