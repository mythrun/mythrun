import type { Meta, StoryObj } from '@storybook/react-vite'
import { I18nextProvider } from 'react-i18next'
import type { PipelineEvent } from '@mythrun/contract/events'
import {
  ApiClientProvider,
  createSseStatusClient,
  type ApiContext,
  type SseStatusClient,
  type StageTiming,
} from '@mythrun/client-core'
import type { CharacterCreationStreamDeps } from '@mythrun/client-core/character'
import { i18n } from '../../i18n/config.ts'
import { CharacterLoadingSurface } from './character-loading.tsx'

// CharacterLoadingSurface — the processing-state screen (the DS CharacterLoadingBeat
// under its screen headline, driven by useCharacterCreationStream). The specimens
// feed the surface a hand-driven stream through the hook's `deps` seam: a fake SSE
// client that replays a fixed event set on open, so the fold settles to a fixed
// progress WITHOUT a live backend — plus a stubbed progress probe (calm
// `processing`) and, for the countdown specimen, an injected stage-timings
// history so the MYT-102 `~M:SS` line ticks live. Mid = concept done + sheet
// underway; Done = every stage complete + the completion event (the
// swap-to-reveal moment). The live folding itself is covered by
// use-character-creation-stream.test.ts; these exist for the E1 responsive/a11y
// sweep. (The countdown/stall copy keys are the controller's i18n pass — until
// then the countdown line renders its raw key, the deliberate [ph:]-era look.)

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
// the beats fold to their final state on mount. The progress probe resolves a
// calm `processing` (never `completed` — a story must not fire the reveal swap).
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
    fetchProgress: () =>
      Promise.resolve({
        campaignId: STORY_CID,
        totalMembers: 1,
        concepts: [
          {
            userId: VIEWER,
            displayName: 'Viewer',
            status: 'processing',
            submittedAt: new Date().toISOString(),
          },
        ],
        missing: [],
      }),
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

// The countdown specimen's stream: setup + concept done, the sheet freshly
// underway (a startedAt of "just now", so the live 1-second tick visibly walks
// the estimate down from ~2:30 in the running story).
const TICKING_EVENTS = (): readonly PipelineEvent[] => [
  completed('location_selection'),
  completed('character_concept'),
  { type: 'stage-started', stage: 'character_sheet', userId: VIEWER, startedAt: new Date().toISOString() },
]

// An injected stage-timings history (the un-filtered aggregate the real
// endpoint serves) — realistic per-stage averages for the creation slice.
const STORY_TIMINGS: readonly StageTiming[] = [
  { stage: 'location_selection', avgMs: 2_000 },
  { stage: 'character_concept', avgMs: 45_000 },
  { stage: 'character_sheet', avgMs: 150_000 },
]

function renderWith(
  events: readonly PipelineEvent[],
  fetchTimings?: () => Promise<readonly StageTiming[]>,
): React.JSX.Element {
  return (
    <I18nextProvider i18n={i18n}>
      <ApiClientProvider value={STORY_CTX}>
        <CharacterLoadingSurface
          campaignId={STORY_CID}
          userId={VIEWER}
          onDone={() => undefined}
          deps={replay(events)}
          {...(fetchTimings !== undefined ? { fetchTimings } : {})}
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

// With the countdown (MYT-102) — an injected timings history + a sheet stage
// started "just now", so the `~M:SS` line under the rows ticks down live. The
// default stories above stay countdown-less (the honest cold-start: no history,
// no number).
export const WithCountdown: Story = {
  name: 'With countdown (ticking, sheet underway)',
  render: () => renderWith(TICKING_EVENTS(), () => Promise.resolve(STORY_TIMINGS)),
}

// Complete — every stage done and the completion event delivered (the swap
// moment); the figure is fully materialised.
export const Complete: Story = {
  name: 'Complete (all done — swaps to the reveal)',
  render: () => renderWith(DONE_EVENTS),
}
