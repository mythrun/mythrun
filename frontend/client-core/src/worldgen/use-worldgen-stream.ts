import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type Dispatch,
  type SetStateAction,
} from 'react'
import type { PipelineEvent, PipelinePhase, StageProgress } from '@mythrun/contract/events'
import type { ApiContext } from '../api/endpoint.ts'
import { isHttpError } from '../api/errors.ts'
import { getWorldSnapshot, resumeGeneration, type WorldGenSnapshot } from '../api/campaigns.ts'
import { createSseStatusClient, type SseStatusClient } from '../realtime/sse-status-client.ts'
import { deriveEdges, deriveNodes, type GraphEdge, type GraphNode } from './graph-reducers.ts'
import { snapshotToGraph, type GraphSeed, type GraphSeedSource } from './snapshot-to-graph.ts'

// useWorldGenStream (MYT-89 Phase C, C5): the DOM-free data layer feeding the
// streaming world-gen graph (C4's `WorldGenGraph` takes the derived
// `nodes`/`edges` as props — this hook does the folding). It:
//
//   1. Opens the status SSE (`createSseStatusClient`) and accumulates the
//      `PipelineEvent` log, folding it to nodes/edges via the C1 reducers.
//   2. Tracks `phase` (from the first-frame snapshot + live `phase` events) and
//      a coarse `status` the loading UI branches on.
//   3. Rehydrates (spec §6 Iridessa-C1): once `phase >= world_snapshot_ready`,
//      fetches the world-snapshot ONCE and SEEDS the graph, then folds live
//      events on top. Before that the graph is honestly sparse.
//   4. On `world_gen_failed`, `retry()` calls resume and branches on the
//      response — a 202 keeps watching (`generating`); a terminal HttpError
//      (409 world_gen_capped / phase_not_yet_implementable) → `terminal`.
//   5. Closes the SSE on unmount; guards every async setState behind a
//      mounted ref so a late frame is a no-op.

/** The coarse lifecycle the loading UI renders against. `generating` covers the
 *  whole in-flight window (incl. `world_snapshot_ready`); `failed` is retryable
 *  (retry button); `terminal` is a non-resumable dead end; `complete` is
 *  world-gen done (world_ready and beyond); `denied` is the access-control dead
 *  end — the status stream's open returned 403/404 (not a member / no such
 *  campaign / malformed id), so no phase ever arrives. It wins over every
 *  phase-derived status (the connection failed before any frame). */
export type WorldGenStatus = 'generating' | 'failed' | 'terminal' | 'complete' | 'denied'

/** The park-eligible slice of the failure-class union (llm-outage-resilience
 *  §3.1) — the only classes that ride the auto-resume ladder and therefore the
 *  only ones the parked hold copy keys off. */
export type ParkErrorClass = 'connectivity' | 'rate-limit'

export interface WorldGenStream {
  readonly phase: PipelinePhase | null
  readonly nodes: GraphNode[]
  readonly edges: GraphEdge[]
  readonly status: WorldGenStatus
  /** Per-stage progress from the first-frame snapshot (the C4 status card reads
   *  this). Empty until the first snapshot frame lands. */
  readonly stages: readonly StageProgress[]
  /** Cumulative generation spend from the snapshot's `cumulativeCostUsd`, or
   *  `null` when the payload omits it. */
  readonly costUsd: number | null
  /** True once a connect-time snapshot arrives carrying a NON-EMPTY gen-seed —
   *  i.e. this is a rejoin/refresh of an already-populated generating world
   *  (myth-gcsp1). The view uses it to LAND on the graph act instead of forcing
   *  the loading screen; a genuine first visit (connects during prep, no entities
   *  yet) leaves it false, preserving the deliberate watch-button beat. */
  readonly resumedMidGen: boolean
  /** llm-outage-resilience §3.4 (additive): present iff a park episode is in
   *  progress — the world-gen job contained a connectivity/rate-limit failure
   *  and is auto-resuming. The generating view swaps its wait narrative for
   *  the hold copy while set. AUTHORITATIVE delivery is the (re)connect
   *  snapshot (derive-phase surfaces the persisted stamp — CloudFront buffers
   *  SSE, and the view invites leave-and-return); a live park-eligible
   *  `stage-failed.failureClass` arms it in-window, and any `stage-completed`
   *  clears it (a completed stage ends the park episode, §3.1). Absent = no
   *  park. */
  readonly lastErrorClass?: ParkErrorClass
  /** The park episode's ladder rung (1-based), snapshot-delivered alongside
   *  `lastErrorClass`; absent when no park episode is in progress. */
  readonly resumeAttempt?: number
  readonly retry: () => Promise<void>
}

/** Injected transport/endpoints — defaults to the real ones; tests substitute a
 *  hand-driven SSE client + spy fetch/resume. */
export interface WorldGenStreamDeps {
  readonly createClient?: (ctx: ApiContext) => SseStatusClient
  readonly fetchSnapshot?: (ctx: ApiContext, campaignId: string) => Promise<WorldGenSnapshot>
  readonly resume?: (ctx: ApiContext, campaignId: string) => Promise<unknown>
}

const streamPath = (campaignId: string): string =>
  `/api/campaigns/${encodeURIComponent(campaignId)}/status/stream`

/** Phases where the reveal-boundary stage (world_introduction) has committed, so the
 *  world-snapshot is fetchable — the rehydration gate. Failure phases are
 *  excluded: their UI is the retry surface, not a graph, and a pre-stage-4
 *  failure would 409 `snapshot_not_ready` anyway. */
const SNAPSHOT_READY_PHASES: ReadonlySet<PipelinePhase> = new Set<PipelinePhase>([
  'world_snapshot_ready',
  'world_ready',
  'character_creation',
  'post_creation',
  'complete',
])

const isSnapshotReady = (phase: PipelinePhase | null): boolean =>
  phase !== null && SNAPSHOT_READY_PHASES.has(phase)

/** Map the server phase → the coarse status. `world_snapshot_ready` stays
 *  `generating` (stages 5-7 still run). */
function statusForPhase(phase: PipelinePhase | null): WorldGenStatus {
  switch (phase) {
    case 'world_gen_failed':
      return 'failed'
    case 'failed':
      return 'terminal'
    case 'world_ready':
    case 'character_creation':
    case 'post_creation':
    case 'complete':
      return 'complete'
    default:
      return 'generating' // null, not_started, world_gen, world_snapshot_ready
  }
}

/** The progress the first-frame `snapshot` payload (a PhaseAndStages) carries:
 *  its `phase`, per-stage `stages[]`, `cumulativeCostUsd` (as `costUsd`), and —
 *  for a generating world (myth-gcsp1) — the `entities`/`relationships` gen-seed
 *  that rehydrates the graph on a mid-gen refresh. */
interface SnapshotProgress extends GraphSeedSource {
  readonly phase: PipelinePhase | null
  readonly stages: readonly StageProgress[]
  readonly costUsd: number | null
  /** The §3.4 park stamp surfaced by derive-phase, when one exists. `null` =
   *  the payload omits it (no park episode) — the authoritative clear. */
  readonly lastErrorClass: ParkErrorClass | null
  readonly resumeAttempt: number | null
}

/** Parse the first-frame snapshot payload into its phase + per-stage progress +
 *  cumulative cost + the gen-seed. Guards the raw shape the same way the old
 *  `phaseFromSnapshot` did — a non-object, or a payload missing a field, yields
 *  the empty/null default — and trusts the wire-union shape of the present fields
 *  (the same `as`-narrowing this code already applies to `phase`, since the
 *  snapshot is our own backend's serialized frame). The `entities`/
 *  `relationships` arrays are absent for a non-generating world (or a pre-seed
 *  backend) → they default to empty, so the graph stays sparse and
 *  `resumedMidGen` stays false. */
function parseSnapshotProgress(raw: unknown): SnapshotProgress {
  if (typeof raw !== 'object' || raw === null) {
    return {
      phase: null,
      stages: [],
      costUsd: null,
      lastErrorClass: null,
      resumeAttempt: null,
      entities: [],
      relationships: [],
    }
  }
  const phase =
    'phase' in raw && typeof raw.phase === 'string' ? (raw.phase as PipelinePhase) : null
  const stages =
    'stages' in raw && Array.isArray(raw.stages) ? (raw.stages as readonly StageProgress[]) : []
  const costUsd =
    'cumulativeCostUsd' in raw && typeof raw.cumulativeCostUsd === 'number'
      ? raw.cumulativeCostUsd
      : null
  // The §3.4 park stamp (additive; absent = no park episode). The class is
  // value-checked (not just presence-checked) so a widened backend union can
  // never leak an unknown class into the hold-copy branch.
  const lastErrorClass =
    'lastErrorClass' in raw &&
    (raw.lastErrorClass === 'connectivity' || raw.lastErrorClass === 'rate-limit')
      ? raw.lastErrorClass
      : null
  const resumeAttempt =
    'resumeAttempt' in raw && typeof raw.resumeAttempt === 'number' ? raw.resumeAttempt : null
  const entities =
    'entities' in raw && Array.isArray(raw.entities)
      ? (raw.entities as GraphSeedSource['entities'])
      : []
  const relationships =
    'relationships' in raw && Array.isArray(raw.relationships)
      ? (raw.relationships as GraphSeedSource['relationships'])
      : []
  return { phase, stages, costUsd, lastErrorClass, resumeAttempt, entities, relationships }
}

/** Stage-progress identity: the `(stage, userId)` pair — worldgen stages are
 *  world-scoped (`userId === null`); per-player charcreation stages repeat a
 *  stage id across players, so the userId disambiguates them. Joined on `|`
 *  (as `edgeIdentity` does): `|` can't appear in a snake_case stage id or in a
 *  UUID / empty userId, so the key stays collision-free. */
const stageKey = (stage: string, userId: string | null): string => `${stage}|${userId ?? ''}`

/** Derive a completed stage's `completedAt` from its `startedAt` + the event's
 *  `durationMs` (the wire carries duration, not an end timestamp). Pure — no
 *  wall clock — so a re-fold is deterministic. `null` when the start is unknown
 *  (a stage that completed before we ever saw its `stage-started`). */
function completedAtFrom(startedAt: string | null, durationMs: number): string | null {
  if (startedAt === null) return null
  const started = Date.parse(startedAt)
  if (Number.isNaN(started)) return null
  return new Date(started + durationMs).toISOString()
}

/** Advance one stage's entry in the accumulator on a live stage-* event.
 *  `stage-started` sets `running` (appending the stage if the snapshot never
 *  carried it — pipeline_runs rows are created lazily, so a mid-window snapshot
 *  omits not-yet-started stages); `stage-completed` sets `completed` + the live
 *  cost/end; `stage-failed` sets `failed`. Other event types are ignored. */
function applyStageEvent(map: Map<string, StageProgress>, ev: PipelineEvent): void {
  if (ev.type === 'stage-started') {
    const key = stageKey(ev.stage, ev.userId)
    const prev = map.get(key)
    map.set(key, {
      stage: ev.stage,
      status: 'running',
      userId: ev.userId,
      costUsd: prev?.costUsd ?? 0,
      startedAt: ev.startedAt,
      completedAt: null,
    })
  } else if (ev.type === 'stage-completed') {
    const key = stageKey(ev.stage, ev.userId)
    const prev = map.get(key)
    const startedAt = prev?.startedAt ?? null
    map.set(key, {
      stage: ev.stage,
      status: 'completed',
      userId: ev.userId,
      costUsd: ev.costUsd,
      startedAt,
      completedAt: completedAtFrom(startedAt, ev.durationMs),
    })
  } else if (ev.type === 'stage-failed') {
    const key = stageKey(ev.stage, ev.userId)
    const prev = map.get(key)
    map.set(key, {
      stage: ev.stage,
      status: 'failed',
      userId: ev.userId,
      costUsd: prev?.costUsd ?? 0,
      startedAt: prev?.startedAt ?? null,
      completedAt: prev?.completedAt ?? null,
    })
  }
}

/** Fold the live stage-* events over the connect-time snapshot's `stages[]` so
 *  the status-card % and fog fade ADVANCE during gen (the MYT-89 C7 fix). The
 *  snapshot seeds the order (already taxonomy-sorted by the backend); stages
 *  started live but absent from the snapshot append in start order (= taxonomy
 *  order for the sequential worldgen pipeline). `Map` preserves insertion
 *  position across in-place updates, so seeded stages hold their slot. */
function foldStages(
  seed: readonly StageProgress[],
  events: readonly PipelineEvent[],
): readonly StageProgress[] {
  const map = new Map<string, StageProgress>()
  for (const s of seed) map.set(stageKey(s.stage, s.userId), s)
  for (const ev of events) applyStageEvent(map, ev)
  return [...map.values()]
}

/** Overlay live-folded nodes on the seed. A live node whose resolved identity
 *  (`displayId`, the real UUID once finalized) matches a seed node supersedes
 *  it — so an entity the snapshot has AND the stream re-emits renders once (the
 *  seam guard), the live copy winning as the fresher one. */
function mergeNodes(seed: GraphNode[], live: GraphNode[]): GraphNode[] {
  const liveIds = new Set(live.map((n) => n.displayId))
  return [...seed.filter((n) => !liveIds.has(n.displayId)), ...live]
}

const edgeIdentity = (e: GraphEdge): string => `${e.from}|${e.to}|${e.relationship}`

function mergeEdges(seed: GraphEdge[], live: GraphEdge[]): GraphEdge[] {
  const liveKeys = new Set(live.map(edgeIdentity))
  return [...seed.filter((e) => !liveKeys.has(edgeIdentity(e))), ...live]
}

/** A mounted flag as a ref, so async callbacks (snapshot fetch, resume) never
 *  setState after teardown. */
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

function loadSeed(
  fetchSnapshot: (ctx: ApiContext, id: string) => Promise<WorldGenSnapshot>,
  ctx: ApiContext,
  campaignId: string,
  mountedRef: { readonly current: boolean },
  setSeed: Dispatch<SetStateAction<GraphSeed | null>>,
): Promise<void> {
  return fetchSnapshot(ctx, campaignId)
    .then((snap) => {
      if (mountedRef.current) setSeed(snapshotToGraph(snap))
    })
    .catch(() => {
      // 409 snapshot_not_ready race / transient — leave the graph sparse.
    })
}

async function runResume(
  resume: (ctx: ApiContext, id: string) => Promise<unknown>,
  ctx: ApiContext,
  campaignId: string,
  mountedRef: { readonly current: boolean },
  setOverride: Dispatch<SetStateAction<WorldGenStatus | null>>,
): Promise<void> {
  try {
    await resume(ctx, campaignId)
    if (mountedRef.current) setOverride('generating') // 202 → keep watching
  } catch (err) {
    // A terminal resume code (409 world_gen_capped / phase_not_yet_implementable)
    // → can't retry. A transient (network) failure stays 'failed' (retryable).
    if (mountedRef.current && isHttpError(err)) setOverride('terminal')
  }
}

export function useWorldGenStream(
  ctx: ApiContext,
  campaignId: string,
  deps: WorldGenStreamDeps = {},
): WorldGenStream {
  const createClient = deps.createClient ?? createSseStatusClient
  const fetchSnapshot = deps.fetchSnapshot ?? getWorldSnapshot
  const resume = deps.resume ?? resumeGeneration

  const [events, setEvents] = useState<PipelineEvent[]>([])
  const [phase, setPhase] = useState<PipelinePhase | null>(null)
  // The connect-time snapshot's per-stage progress — the SEED the live stage-*
  // events fold onto (see `foldStages`). Not the rendered value: `stages` below.
  const [snapshotStages, setSnapshotStages] = useState<readonly StageProgress[]>([])
  const [costUsd, setCostUsd] = useState<number | null>(null)
  const [seed, setSeed] = useState<GraphSeed | null>(null)
  const [resumedMidGen, setResumedMidGen] = useState(false)
  const [override, setOverride] = useState<WorldGenStatus | null>(null)
  // The §3.4 park episode, as one atomic pair (class + ladder rung). The
  // snapshot SETS it authoritatively on every (re)connect frame — including
  // back to null when the payload omits the stamp; the live events only
  // optimize inside an open window (arm on park-eligible stage-failed, clear
  // on any stage-completed — a completed stage ends the episode, §3.1).
  const [park, setPark] = useState<{
    readonly cls: ParkErrorClass
    readonly attempt: number | null
  } | null>(null)
  // The access-control dead end: the SSE open returned 403/404, so the client's
  // connection settled `failed{denied}` and STOPPED retrying — no snapshot, no
  // phase, ever. Surfaced as the coarse `denied` status so the route can render a
  // calm no-access screen instead of stranding on the phase===null loading beat.
  const [denied, setDenied] = useState(false)

  const mountedRef = useMountedRef()
  const seededRef = useRef(false)

  // Open the status stream. A live `phase` event drops any retry override —
  // the server's phase is authoritative from then on.
  useEffect(() => {
    const client = createClient(ctx)
    // The only terminal connection outcome the stream surfaces: 403/404 → the
    // access-control dead end. `exhausted` (the backoff ceiling) is a transient
    // network outage the client re-arms from, not a route-level dead end, so it
    // is intentionally not folded here. `denied` is monotonic within a mount (no
    // retry affordance clears it), and — like every other state here — it is not
    // reset across a bare `:id` change (the route remounts per campaign).
    const offConn = client.connectionState.subscribe((state) => {
      if (!mountedRef.current) return
      if (state.status === 'failed' && state.failedReason === 'denied') setDenied(true)
    })
    const offEvent = client.onEvent((event) => {
      if (!mountedRef.current) return
      setEvents((prev) => [...prev, event])
      if (event.type === 'phase') {
        setPhase(event.phase)
        setOverride(null)
      }
      // cost-update is ABSOLUTE (post-commit cumulative) — track it live so the
      // status card's spend advances instead of freezing at the snapshot value.
      if (event.type === 'cost-update') setCostUsd(event.cumulativeUsd)
      // The live park optimization (§3.4): a park-eligible class arms the hold
      // in-window (the rung stays whatever the last snapshot said); any
      // completed stage ends the episode. Other classes (abort/other/absent)
      // ride today's failure surfaces untouched.
      if (event.type === 'stage-failed') {
        const cls = event.failureClass
        if (cls === 'connectivity' || cls === 'rate-limit') {
          setPark((prev) => ({ cls, attempt: prev?.attempt ?? null }))
        }
      }
      if (event.type === 'stage-completed') setPark(null)
    })
    const offSnapshot = client.onSnapshot((raw) => {
      if (!mountedRef.current) return
      const snapshot = parseSnapshotProgress(raw)
      if (snapshot.phase !== null) setPhase(snapshot.phase)
      setSnapshotStages(snapshot.stages)
      setCostUsd(snapshot.costUsd)
      // Authoritative park SET (never a merge): a frame without the stamp
      // clears any live-armed hold — the backend derivation is the truth on
      // every (re)connect.
      setPark(
        snapshot.lastErrorClass !== null
          ? { cls: snapshot.lastErrorClass, attempt: snapshot.resumeAttempt }
          : null,
      )
      // myth-gcsp1: a connect frame carrying a non-empty gen-seed is a mid-gen
      // rejoin/refresh — SEED the graph from it at once (the world-snapshot route
      // still 409s pre-reveal, so this is the only pre-reveal rehydration path)
      // and flag the resume so the view lands on the graph act. The live events
      // fold on top; the post-boundary world-snapshot seed still refines at the
      // reveal. An empty seed (fresh gen in prep) leaves both untouched.
      if (snapshot.entities.length > 0) {
        setSeed(snapshotToGraph(snapshot))
        setResumedMidGen(true)
      }
    })
    client.open(streamPath(campaignId))
    return () => {
      offConn()
      offEvent()
      offSnapshot()
      client.close()
    }
  }, [ctx, campaignId, createClient, mountedRef])

  // Rehydrate ONCE the moment the snapshot becomes fetchable.
  useEffect(() => {
    if (seededRef.current || !isSnapshotReady(phase)) return
    seededRef.current = true
    void loadSeed(fetchSnapshot, ctx, campaignId, mountedRef, setSeed)
  }, [phase, ctx, campaignId, fetchSnapshot, mountedRef])

  const retry = useCallback(
    () => runResume(resume, ctx, campaignId, mountedRef, setOverride),
    [resume, ctx, campaignId, mountedRef],
  )

  const nodes = useMemo(
    () => mergeNodes(seed?.nodes ?? [], deriveNodes(events)),
    [seed, events],
  )
  const edges = useMemo(
    () => mergeEdges(seed?.edges ?? [], deriveEdges(events)),
    [seed, events],
  )
  // Live-folded per-stage progress: the snapshot seeds it, the stage-* events
  // advance it (mirrors the nodes/edges derivation). This is what unfreezes the
  // status-card % + fog fade for the whole gen (MYT-89 C7).
  const stages = useMemo(() => foldStages(snapshotStages, events), [snapshotStages, events])
  // `denied` is terminal and frame-independent (it happened before any phase), so
  // it wins over the phase/override-derived status.
  const status: WorldGenStatus = denied ? 'denied' : (override ?? statusForPhase(phase))

  return {
    phase,
    nodes,
    edges,
    status,
    stages,
    costUsd,
    resumedMidGen,
    // Spread-omit the absent park fields (exactOptionalPropertyTypes — the
    // wire discipline: absent, never an explicit undefined).
    ...(park !== null
      ? { lastErrorClass: park.cls, ...(park.attempt !== null ? { resumeAttempt: park.attempt } : {}) }
      : {}),
    retry,
  }
}
