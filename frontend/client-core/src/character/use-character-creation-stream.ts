import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { PipelineEvent, StageProgress } from '@mythrun/contract/events'
import type { LoadingBeat } from '../contract/index.ts'
import type { ApiContext } from '../api/endpoint.ts'
import { useApiContext } from '../api/client-context.tsx'
import {
  getCharacterCreationProgress,
  type CharacterCreationProgress,
} from '../api/characters.ts'
import { createSseStatusClient, type SseStatusClient } from '../realtime/sse-status-client.ts'
import type { CharacterCreationStage } from './creation-eta.ts'

// useCharacterCreationStream (MYT-90 B5 + the MYT-102 liveness upgrade): the
// DOM-free per-user data layer behind the character-creation loading beat (the
// B4 `CharacterLoadingBeat` renders the derived `beats`/`done`/countdown — this
// hook does the folding). It mirrors use-worldgen-stream's connection + reducer
// shape:
//
//   1. Opens the campaign-wide status SSE (`createSseStatusClient`),
//      accumulates the `PipelineEvent` log, and SEEDS the viewer's stage
//      progress from the connect-time `snapshot` frame's per-user `stages[]`
//      (the mid-creation-refresh fix — the screen shows the truth at once, not
//      a dead all-pending column until the next live event).
//   2. FILTERS to the current `userId`: the per-player character-creation stage
//      events/rows carry `userId`; world-scoped rows (`userId: null`) and other
//      players' are ignored.
//   3. Folds seed + live events into the fixed `LoadingBeat[]` — advancing each
//      beat pending → active → done — and exposes the folded `StageProgress[]`
//      rows (the countdown's input, see creation-eta.ts).
//   4. Flips `done` on EITHER the viewer's live `character_creation_complete`
//      event (backend A8) OR the progress GET reporting their concept
//      `completed` — the RELOAD-STABLE signal: probed once at mount, and
//      re-checked when a snapshot shows the viewer's terminal stage complete,
//      so a completion event missed across a refresh/reconnect can never
//      strand the screen.
//   5. Closes the SSE on unmount; guards every async setState behind a mounted
//      ref so a late frame (a leaky transport delivering after teardown) is a
//      no-op.

/** The `{ beats, done, stages }` the loading surface renders against. `done` is
 *  the reliable per-user signal the view swaps to the character reveal on;
 *  `stages` is the viewer's OWN folded per-player stage progress (pre-filtered
 *  — the `remainingCreationWaitMs` countdown consumes it directly). */
export interface CharacterCreationStream {
  readonly beats: LoadingBeat[]
  readonly done: boolean
  readonly stages: readonly StageProgress[]
}

/** Injected transport + progress probe — default to the real SSE status client
 *  and the real progress GET; tests substitute hand-driven ones. */
export interface CharacterCreationStreamDeps {
  readonly createClient?: (ctx: ApiContext) => SseStatusClient
  readonly fetchProgress?: (
    ctx: ApiContext,
    campaignId: string,
  ) => Promise<CharacterCreationProgress>
}

/** The viewer's terminal pipeline stage — a snapshot reporting it completed
 *  while `done` is still false means the completion event may have been missed
 *  (the recheck trigger). Typed against the canonical slice so a taxonomy
 *  rename fails the compile, not the screen. */
const TERMINAL_STAGE: CharacterCreationStage = 'character_sheet'

interface BeatDef {
  readonly id: string
  readonly stage: CharacterCreationStage
}

/** The fixed "coming into being" beats, in surfacing order. `character_concept`
 *  produces the name + identity, so it lights `name` + `class`; `character_sheet`
 *  rolls the scores + gathers the kit, so it lights `scores` + `kit`.
 *  (`location_selection` is silent mechanical setup — no beat.) This layer emits
 *  only the stable beat IDs — never display strings; the consuming screen maps
 *  each id → `t('characterCreate.loading.beat.<id>')` (this is the platform-neutral
 *  DOM-free data layer, so it owns no copy). */
const CHARACTER_BEATS: readonly BeatDef[] = [
  { id: 'name', stage: 'character_concept' },
  { id: 'class', stage: 'character_concept' },
  { id: 'scores', stage: 'character_sheet' },
  { id: 'kit', stage: 'character_sheet' },
]

const streamPath = (campaignId: string): string =>
  `/api/campaigns/${encodeURIComponent(campaignId)}/status/stream`

/** Parse the first-frame snapshot payload's `stages[]` (the PhaseAndStages wire
 *  shape). Guards the raw shape the way use-worldgen-stream's
 *  `parseSnapshotProgress` does — a non-object or a payload missing the field
 *  yields the empty default — and trusts the wire-union shape of a present
 *  array (the snapshot is our own backend's serialized frame). */
function parseSnapshotStages(raw: unknown): readonly StageProgress[] {
  if (typeof raw !== 'object' || raw === null) return []
  return 'stages' in raw && Array.isArray(raw.stages)
    ? (raw.stages as readonly StageProgress[])
    : []
}

/** Derive a completed stage's `completedAt` from its `startedAt` + the event's
 *  `durationMs` (the wire carries duration, not an end timestamp; mirrors
 *  use-worldgen-stream). Pure — no wall clock — so a re-fold is deterministic.
 *  `null` when the start is unknown/unparseable. */
function completedAtFrom(startedAt: string | null, durationMs: number): string | null {
  if (startedAt === null) return null
  const started = Date.parse(startedAt)
  if (Number.isNaN(started)) return null
  return new Date(started + durationMs).toISOString()
}

/** Advance one viewer stage on a live stage-* event. MONOTONIC within a mount:
 *  a stale buffered `stage-started` (from before a reconnect whose fresher
 *  snapshot already reports the stage completed) never regresses `completed` —
 *  within one loading mount the per-player pipeline only advances (a genuine
 *  re-run goes through reset → a fresh mount). Other event types are ignored. */
function applyViewerStageEvent(
  map: Map<string, StageProgress>,
  ev: PipelineEvent,
  userId: string,
): void {
  if (ev.type === 'stage-started' && ev.userId === userId) {
    const prev = map.get(ev.stage)
    if (prev?.status === 'completed') return
    map.set(ev.stage, {
      stage: ev.stage,
      status: 'running',
      userId,
      costUsd: prev?.costUsd ?? 0,
      startedAt: ev.startedAt,
      completedAt: null,
    })
  } else if (ev.type === 'stage-completed' && ev.userId === userId) {
    const prev = map.get(ev.stage)
    const startedAt = prev?.startedAt ?? null
    map.set(ev.stage, {
      stage: ev.stage,
      status: 'completed',
      userId,
      costUsd: ev.costUsd,
      startedAt,
      completedAt: completedAtFrom(startedAt, ev.durationMs),
    })
  } else if (ev.type === 'stage-failed' && ev.userId === userId) {
    const prev = map.get(ev.stage)
    map.set(ev.stage, {
      stage: ev.stage,
      status: 'failed',
      userId,
      costUsd: prev?.costUsd ?? 0,
      startedAt: prev?.startedAt ?? null,
      completedAt: prev?.completedAt ?? null,
    })
  }
}

/** Fold the live stage-* events over the connect-time snapshot seed, filtered
 *  to the viewer (per-player stage ids repeat across users — only the viewer's
 *  rows may reach the beats/countdown). The seed carries the pre-refresh truth
 *  (statuses + startedAt); live events advance it. `Map` preserves insertion
 *  position, so seeded stages hold their pipeline-order slot. */
function foldViewerStages(
  seed: readonly StageProgress[],
  events: readonly PipelineEvent[],
  userId: string,
): readonly StageProgress[] {
  const map = new Map<string, StageProgress>()
  for (const s of seed) if (s.userId === userId) map.set(s.stage, s)
  for (const ev of events) applyViewerStageEvent(map, ev, userId)
  return [...map.values()]
}

/** Stage status → beat state. `failed` stays `active` (the stage re-runs on
 *  retry — the beat keeps surfacing rather than dying; the failure ROUTING is
 *  the character surface's job, off the concept status). */
const BEAT_STATE: Record<StageProgress['status'], LoadingBeat['state']> = {
  pending: 'pending',
  running: 'active',
  failed: 'active',
  completed: 'done',
}

/** Project the folded viewer stages onto the fixed beat list; an unseen stage
 *  leaves its beats `pending`. `label` is left empty here — the consuming screen
 *  resolves the display copy from the beat `id` (this layer emits IDs only). */
function deriveBeats(stages: readonly StageProgress[]): LoadingBeat[] {
  const statusByStage = new Map(stages.map((s) => [s.stage, s.status]))
  return CHARACTER_BEATS.map((def) => ({
    id: def.id,
    label: '',
    state: BEAT_STATE[statusByStage.get(def.stage) ?? 'pending'],
  }))
}

/** True once the viewer's own `character_creation_complete` event has arrived. */
function deriveDone(events: readonly PipelineEvent[], userId: string): boolean {
  return events.some((ev) => ev.type === 'character_creation_complete' && ev.userId === userId)
}

/** A mounted flag as a ref, so a late SSE frame / probe resolve never setStates
 *  after teardown. */
function useMountedRef(): { readonly current: boolean } {
  const ref = useRef(true)
  useEffect(() => {
    ref.current = true
    return () => {
      ref.current = false
    }
  }, [])
  return ref
}

export function useCharacterCreationStream(
  campaignId: string,
  userId: string,
  deps: CharacterCreationStreamDeps = {},
): CharacterCreationStream {
  const ctx = useApiContext()
  const createClient = deps.createClient ?? createSseStatusClient
  const fetchProgress = deps.fetchProgress ?? getCharacterCreationProgress

  const [events, setEvents] = useState<PipelineEvent[]>([])
  // The latest connect-time snapshot's `stages[]` — the SEED the live events
  // fold onto (a reconnect's fresher snapshot replaces it wholesale).
  const [snapshotStages, setSnapshotStages] = useState<readonly StageProgress[]>([])
  // The reload-stable completion read off the progress GET (see checkProgress).
  const [progressDone, setProgressDone] = useState(false)
  const mountedRef = useMountedRef()
  const probeInFlightRef = useRef(false)

  // The progress probe: the viewer's concept `completed` is the DURABLE
  // completion signal (`character_creation_complete` is a live event — not
  // replayed in the snapshot — so a refresh/reconnect across it would otherwise
  // strand the screen). Coalesces concurrent triggers; a failed probe is calm
  // (the live event remains the primary signal).
  const checkProgress = useCallback((): void => {
    if (probeInFlightRef.current) return
    probeInFlightRef.current = true
    fetchProgress(ctx, campaignId)
      .then((progress) => {
        probeInFlightRef.current = false
        if (!mountedRef.current) return
        const mine = progress.concepts.find((c) => c.userId === userId)
        if (mine?.status === 'completed') setProgressDone(true)
      })
      .catch(() => {
        probeInFlightRef.current = false
      })
  }, [ctx, campaignId, userId, fetchProgress, mountedRef])

  // Open the campaign status stream, accumulate the event log, and seed from
  // each snapshot frame. Filtering to the viewer happens in the derivations
  // below, so the effect never re-runs on a userId change.
  useEffect(() => {
    const client = createClient(ctx)
    const offEvent = client.onEvent((event) => {
      if (!mountedRef.current) return
      setEvents((prev) => [...prev, event])
    })
    const offSnapshot = client.onSnapshot((raw) => {
      if (!mountedRef.current) return
      setSnapshotStages(parseSnapshotStages(raw))
    })
    client.open(streamPath(campaignId))
    return () => {
      offEvent()
      offSnapshot()
      client.close()
    }
  }, [ctx, campaignId, createClient, mountedRef])

  const stages = useMemo(
    () => foldViewerStages(snapshotStages, events, userId),
    [snapshotStages, events, userId],
  )
  const beats = useMemo(() => deriveBeats(stages), [stages])
  const done = useMemo(() => deriveDone(events, userId), [events, userId]) || progressDone

  // Probe once at mount (the refresh-just-after-completion race), and re-check
  // whenever a snapshot reports the viewer's terminal stage completed while
  // done hasn't latched (the missed-event backstop — the AUTHORITATIVE seed
  // says the pipeline finished, so ask the durable source). Keyed off the raw
  // seed, not the fold, so a stale buffered event can't mask the trigger.
  useEffect(() => {
    checkProgress()
  }, [checkProgress])
  useEffect(() => {
    if (done) return
    const terminalDone = snapshotStages.some(
      (s) => s.userId === userId && s.stage === TERMINAL_STAGE && s.status === 'completed',
    )
    if (terminalDone) checkProgress()
  }, [done, snapshotStages, userId, checkProgress])

  return { beats, done, stages }
}
