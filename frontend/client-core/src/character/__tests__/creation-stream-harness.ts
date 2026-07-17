import { vi } from 'vitest'
import { act, renderHook } from '@testing-library/react'
import { createElement, type ReactNode } from 'react'
import { createStore } from 'zustand/vanilla'
import type { PipelineEvent, StageProgress } from '@mythrun/contract/events'
import type { ApiContext } from '../../api/endpoint.ts'
import type { CharacterCreationProgress } from '../../api/characters.ts'
import type { ConnectionState } from '../../realtime/connection.ts'
import type { SseStatusClient } from '../../realtime/sse-status-client.ts'
import { ApiClientProvider } from '../../api/client-context.tsx'
import {
  useCharacterCreationStream,
  type CharacterCreationStreamDeps,
} from '../use-character-creation-stream.ts'

// The shared harness behind the useCharacterCreationStream suites (the base
// live-fold specs + the MYT-102 liveness specs in
// use-character-creation-stream.liveness.test.ts). Test infra, not a test file
// (no `.test.` suffix — vitest never collects it; the recording-ctx.ts
// precedent). Every spec injects a hand-driven `SseStatusClient` + a stub
// progress fetch through `deps` — no real transport, no MSW.

export const CID = 'campaign-123'
export const VIEWER = 'user-viewer'
export const OTHER = 'user-other'
export const testCtx: ApiContext = {
  baseUrl: 'http://api.test',
  getAuthHeaders: () => Promise.resolve({}),
}

/** The provider the hook's `useApiContext()` reads its ctx from. Built with
 *  `createElement` so the suites stay `.test.ts` (no JSX) files. */
export const wrapper = ({ children }: { children: ReactNode }) =>
  createElement(ApiClientProvider, { value: testCtx, children })

/** A hand-driven `SseStatusClient`: the test pushes events + snapshot frames and
 *  observes `open`/`close`. Listener unsubscribe is honoured by default so a
 *  post-unmount emit is a genuine no-op; `honorUnsub: false` models a "leaky"
 *  transport that keeps delivering after teardown — the case the hook's
 *  `mountedRef` guard absorbs. */
export function makeMockClient(opts: { honorUnsub?: boolean } = {}) {
  const honorUnsub = opts.honorUnsub ?? true
  const eventCbs = new Set<(e: PipelineEvent) => void>()
  const snapshotCbs = new Set<(raw: unknown) => void>()
  let openedPath: string | null = null
  let closed = false

  const client: SseStatusClient = {
    connectionState: createStore<ConnectionState>(() => ({ status: 'connecting', attempt: 0 })),
    open: (path) => {
      openedPath = path
    },
    onEvent: (cb) => {
      eventCbs.add(cb)
      return () => {
        if (honorUnsub) eventCbs.delete(cb)
      }
    },
    onSnapshot: (cb) => {
      snapshotCbs.add(cb)
      return () => {
        if (honorUnsub) snapshotCbs.delete(cb)
      }
    },
    close: () => {
      closed = true
    },
  }

  return {
    client,
    emit: (e: PipelineEvent) => {
      for (const cb of eventCbs) cb(e)
    },
    emitSnapshot: (raw: unknown) => {
      for (const cb of snapshotCbs) cb(raw)
    },
    isClosed: () => closed,
    openedPath: () => openedPath,
  }
}

export const started = (userId: string, stage: string): PipelineEvent => ({
  type: 'stage-started',
  stage,
  userId,
  startedAt: '2026-07-11T10:00:00.000Z',
})
export const completed = (userId: string, stage: string): PipelineEvent => ({
  type: 'stage-completed',
  stage,
  userId,
  durationMs: 1000,
  costUsd: 0.05,
})
export const failed = (userId: string, stage: string): PipelineEvent => ({
  type: 'stage-failed',
  stage,
  userId,
  errorCode: 'llm_error',
  willRetry: true,
})
export const complete = (userId: string): PipelineEvent => ({
  type: 'character_creation_complete',
  userId,
})

/** A snapshot `stages[]` row (the `StageProgress` wire shape — per-player rows
 *  carry the owning userId; world-scoped rows carry null). */
export const row = (
  userId: string | null,
  stage: string,
  status: StageProgress['status'],
  startedAt: string | null = null,
): StageProgress => ({ stage, status, userId, costUsd: 0, startedAt, completedAt: null })

/** The first-frame snapshot payload shape (a PhaseAndStages). */
export const snapshotWith = (stages: readonly StageProgress[]): unknown => ({
  phase: 'character_creation',
  stages,
})

/** A progress-GET response with the viewer's concept at `status` (`null` → the
 *  viewer has no concept row yet). */
export const progressOf = (status: string | null): CharacterCreationProgress => ({
  campaignId: CID,
  totalMembers: 2,
  concepts:
    status === null
      ? [
          {
            userId: OTHER,
            displayName: 'Other',
            status: 'completed',
            submittedAt: '2026-07-17T09:00:00.000Z',
          },
        ]
      : [{ userId: VIEWER, displayName: 'Viewer', status, submittedAt: '2026-07-17T09:00:00.000Z' }],
  missing: [],
})

/** Render the hook with the mock transport + a stubbed progress fetch (defaults
 *  to a calm `processing` — the pre-completion steady state). */
export function renderStream(
  mock: ReturnType<typeof makeMockClient>,
  overrides: Partial<CharacterCreationStreamDeps> = {},
) {
  const fetchProgress =
    overrides.fetchProgress ?? vi.fn().mockResolvedValue(progressOf('processing'))
  return renderHook(
    () =>
      useCharacterCreationStream(CID, VIEWER, {
        createClient: () => mock.client,
        fetchProgress,
        ...overrides,
      }),
    { wrapper },
  )
}

/** Flush the microtask queue (the mount-time progress probe resolves off it). */
export const flush = async (): Promise<void> => {
  await act(async () => {
    await Promise.resolve()
  })
}

export const stateOf = (beats: { id: string; state: string }[], id: string): string | undefined =>
  beats.find((b) => b.id === id)?.state
