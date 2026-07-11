import { useEffect, useMemo, useRef, useState } from 'react'
import type { PipelineEvent } from '@mythrun/contract/events'
import type { LoadingBeat } from '../contract/index.ts'
import type { ApiContext } from '../api/endpoint.ts'
import { useApiContext } from '../api/client-context.tsx'
import { createSseStatusClient, type SseStatusClient } from '../realtime/sse-status-client.ts'

// useCharacterCreationStream (MYT-90 B5): the DOM-free per-user data layer behind
// the character-creation loading beat (the B4 `CharacterLoadingBeat` renders the
// derived `beats`/`done` — this hook does the folding). It mirrors
// use-worldgen-stream's connection + reducer shape:
//
//   1. Opens the campaign-wide status SSE (`createSseStatusClient`) and
//      accumulates the `PipelineEvent` log.
//   2. FILTERS to the current `userId`: the per-player character-creation stage
//      events (`stage-started`/`stage-completed`) and the terminal
//      `character_creation_complete` event both carry `userId`; world-scoped
//      events (`userId: null`) and other players' events are ignored.
//   3. Folds the viewer's stage progress into the fixed `LoadingBeat[]` — advancing
//      each beat pending → active → done — and flips `done` when the viewer's
//      `character_creation_complete` event (backend A8) arrives.
//   4. Closes the SSE on unmount; guards the async setState behind a mounted ref so
//      a late frame (a leaky transport delivering after teardown) is a no-op.
//
// SCOPE: this folds LIVE events only (per the B5 brief). It does not seed from the
// connect-time snapshot, so a mid-creation refresh restarts the beats from pending
// until the next live event, and a refresh AFTER completion won't re-flip `done`
// (the completion is a live event, not replayed in the snapshot). Snapshot
// rehydration is a follow-up product call — see the B5 report.

/** The `{ beats, done }` the loading beat renders against. `done` is the reliable
 *  per-user signal the view swaps to the character reveal on. */
export interface CharacterCreationStream {
  readonly beats: LoadingBeat[]
  readonly done: boolean
}

/** Injected transport — defaults to the real SSE status client; tests substitute a
 *  hand-driven client. */
export interface CharacterCreationStreamDeps {
  readonly createClient?: (ctx: ApiContext) => SseStatusClient
}

/** The per-player character-creation stages (a mirror of `CharacterCreationStage`
 *  in backend/src/llm/prep/character-creation-processor.ts). `location_selection`
 *  is silent mechanical setup and surfaces no beat; the two content stages each
 *  drive a pair of beats. */
type CharacterCreationStage = 'location_selection' | 'character_concept' | 'character_sheet'

interface BeatDef {
  readonly id: string
  readonly label: string
  readonly stage: CharacterCreationStage
}

/** The fixed "coming into being" beats, in surfacing order. `character_concept`
 *  produces the name + identity, so it lights `name` + `class`; `character_sheet`
 *  rolls the scores + gathers the kit, so it lights `scores` + `kit`. Labels are
 *  `[ph:]` interim placeholders — the display owns final copy (i18n pass). */
const CHARACTER_BEATS: readonly BeatDef[] = [
  { id: 'name', label: '[ph: a name surfaces]', stage: 'character_concept' },
  { id: 'class', label: '[ph: a class and calling take shape]', stage: 'character_concept' },
  { id: 'scores', label: '[ph: ability scores settle]', stage: 'character_sheet' },
  { id: 'kit', label: '[ph: equipment is gathered]', stage: 'character_sheet' },
]

const streamPath = (campaignId: string): string =>
  `/api/campaigns/${encodeURIComponent(campaignId)}/status/stream`

/** Fold the viewer's stage-* events into a per-stage state — `stage-started` →
 *  `active`, `stage-completed` → `done` (a later event for the same stage wins).
 *  Events for other players (or world-scoped `userId: null`) are skipped. */
function foldStageStates(
  events: readonly PipelineEvent[],
  userId: string,
): Map<string, 'active' | 'done'> {
  const states = new Map<string, 'active' | 'done'>()
  for (const ev of events) {
    if (ev.type === 'stage-started' && ev.userId === userId) states.set(ev.stage, 'active')
    else if (ev.type === 'stage-completed' && ev.userId === userId) states.set(ev.stage, 'done')
  }
  return states
}

/** Project the folded stage states onto the fixed beat list; an unseen stage
 *  leaves its beats `pending`. */
function deriveBeats(events: readonly PipelineEvent[], userId: string): LoadingBeat[] {
  const states = foldStageStates(events, userId)
  return CHARACTER_BEATS.map((def) => ({
    id: def.id,
    label: def.label,
    state: states.get(def.stage) ?? 'pending',
  }))
}

/** True once the viewer's own `character_creation_complete` event has arrived. */
function deriveDone(events: readonly PipelineEvent[], userId: string): boolean {
  return events.some((ev) => ev.type === 'character_creation_complete' && ev.userId === userId)
}

/** A mounted flag as a ref, so a late SSE frame never setStates after teardown. */
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

  const [events, setEvents] = useState<PipelineEvent[]>([])
  const mountedRef = useMountedRef()

  // Open the campaign status stream and accumulate the event log. Filtering to the
  // viewer happens in the derivations below, so the effect never re-runs on a
  // userId change.
  useEffect(() => {
    const client = createClient(ctx)
    const offEvent = client.onEvent((event) => {
      if (!mountedRef.current) return
      setEvents((prev) => [...prev, event])
    })
    client.open(streamPath(campaignId))
    return () => {
      offEvent()
      client.close()
    }
  }, [ctx, campaignId, createClient, mountedRef])

  const beats = useMemo(() => deriveBeats(events, userId), [events, userId])
  const done = useMemo(() => deriveDone(events, userId), [events, userId])

  return { beats, done }
}
