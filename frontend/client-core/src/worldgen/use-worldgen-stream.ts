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
 *  world-gen done (world_ready and beyond). */
export type WorldGenStatus = 'generating' | 'failed' | 'terminal' | 'complete'

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
  readonly retry: () => Promise<void>
}

/** Injected transport/endpoints — defaults to the real ones; tests substitute a
 *  hand-driven SSE client + spy fetch/resume. */
export interface WorldGenStreamDeps {
  readonly createClient?: (ctx: ApiContext) => SseStatusClient
  readonly fetchSnapshot?: (ctx: ApiContext, campaignId: string) => Promise<WorldGenSnapshot>
  readonly resume?: (ctx: ApiContext, campaignId: string) => Promise<unknown>
}

interface GraphSeed {
  readonly nodes: GraphNode[]
  readonly edges: GraphEdge[]
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
 *  its `phase`, per-stage `stages[]`, and `cumulativeCostUsd` (as `costUsd`). */
interface SnapshotProgress {
  readonly phase: PipelinePhase | null
  readonly stages: readonly StageProgress[]
  readonly costUsd: number | null
}

/** Parse the first-frame snapshot payload into its phase + per-stage progress +
 *  cumulative cost. Guards the raw shape the same way the old `phaseFromSnapshot`
 *  did — a non-object, or a payload missing a field, yields the empty/null
 *  default — and trusts the wire-union shape of the present fields (the same
 *  `as`-narrowing this code already applies to `phase`, since the snapshot is
 *  our own backend's serialized `PhaseAndStages`). */
function parseSnapshotProgress(raw: unknown): SnapshotProgress {
  if (typeof raw !== 'object' || raw === null) {
    return { phase: null, stages: [], costUsd: null }
  }
  const phase =
    'phase' in raw && typeof raw.phase === 'string' ? (raw.phase as PipelinePhase) : null
  const stages =
    'stages' in raw && Array.isArray(raw.stages) ? (raw.stages as readonly StageProgress[]) : []
  const costUsd =
    'cumulativeCostUsd' in raw && typeof raw.cumulativeCostUsd === 'number'
      ? raw.cumulativeCostUsd
      : null
  return { phase, stages, costUsd }
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

/** Convert a persisted world-snapshot into finalized seed nodes/edges. Persisted
 *  rows carry the real entity UUID, so a seed node is `finalized` with
 *  `displayId === synthKey === id`; `lastEventIndex` is -1 (pre-stream). */
function snapshotToSeed(snap: WorldGenSnapshot): GraphSeed {
  const nodes = snap.entities.map(
    (e): GraphNode => ({
      synthKey: e.id,
      kind: e.entityType,
      name: e.name,
      displayId: e.id,
      state: 'finalized',
      lastEventIndex: -1,
    }),
  )
  const edges = snap.relationships.map(
    (r): GraphEdge => ({
      synthKey: `seed:${r.sourceEntityId}->${r.targetEntityId}:${r.relationshipType}`,
      from: r.sourceEntityId,
      to: r.targetEntityId,
      relationship: r.relationshipType,
      // A pre-existing edge already present in the snapshot: it should not
      // animate as a weave, so it carries the `snap` stage + the -1 sentinel.
      arrivalIndex: -1,
      sourceStage: 'snap',
    }),
  )
  return { nodes, edges }
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
      if (mountedRef.current) setSeed(snapshotToSeed(snap))
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
  const [override, setOverride] = useState<WorldGenStatus | null>(null)

  const mountedRef = useMountedRef()
  const seededRef = useRef(false)

  // Open the status stream. A live `phase` event drops any retry override —
  // the server's phase is authoritative from then on.
  useEffect(() => {
    const client = createClient(ctx)
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
    })
    const offSnapshot = client.onSnapshot((raw) => {
      if (!mountedRef.current) return
      const snapshot = parseSnapshotProgress(raw)
      if (snapshot.phase !== null) setPhase(snapshot.phase)
      setSnapshotStages(snapshot.stages)
      setCostUsd(snapshot.costUsd)
    })
    client.open(streamPath(campaignId))
    return () => {
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
  const status = override ?? statusForPhase(phase)

  return { phase, nodes, edges, status, stages, costUsd, retry }
}
