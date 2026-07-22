// KNOWLEDGE CACHE — ONE world-snapshot fetch → THREE projections, boundary
// refetch (MYT-94 Task 2). The spine of the in-session knowledge layer: a single
// `getWorldSnapshot` read (member-readable, known-tier, server-filtered) feeds the
// World Wiki tab (`toWikiViewModel`), the Relationship Graph tab (`snapshotToGraph`)
// and the settled-prose highlighter (`buildEntityIndex`) from the SAME snapshot.
//
// ENFORCED IGNORANCE / ZFC (spec §6). The cache adds NO tier logic and consumes
// NO session frame: the snapshot is already the known-tier member projection, and
// a session-BOUNDARY `refreshToken` bump (mount / WS reconnect) is the ONLY
// promotion path. There is no tier-promotion frame on the session WS channel, so
// the cache can never ingest pre-flip content. That invariant is made executable
// below (`CACHE_PROMOTION_FRAME_TYPES` is empty; `frameRefetchesCache` is always
// false) and asserted by the test.
//
// QUIET REFETCH (mirrors `useWikiModel`, reveal-wiki-panel.tsx). `loading` is only
// ever true before the FIRST settle; the current cache stays live until a fresh one
// resolves; a refetch FAILURE keeps the prior cache (no error flash — `failed`
// stays false once any cache has resolved); an `active` flag drops a late resolve
// after unmount / a superseded refetch. A first-fetch failure (incl. a 409
// `snapshot_not_ready` race) settles to the calm empty cache (`failed:true`).
//
// GRAPH PROJECTION IS INJECTED (deviation from the plan's hard import — see the
// report). Task 4's canonical `snapshotToGraph` is not landed yet, so the cache
// takes it through `deps.snapshotToGraph` rather than importing it (which would be
// a compile dependency on a module that does not exist). This avoids authoring a
// divergent second adapter (Ambiguity G) AND keeps the deliverable self-verifying;
// the composition (Task 14) passes the canonical adapter. `GraphSeed` is now imported
// from Task 4's `snapshot-to-graph.ts` (the canonical decl) and re-exported here; the
// worldgen slice owns the main-barrel export.

import { useEffect, useState } from 'react'
import type { ServerFrame } from '@mythrun/contract/events'
import type { GraphSeed } from '../worldgen/snapshot-to-graph.ts'
import { toWikiViewModel, type WikiViewModel } from '../worldgen/wiki-view-model.ts'
import { getWorldSnapshot, type WorldGenSnapshot } from '../api/campaigns.ts'
import { useApiContext } from '../api/client-context.tsx'
import type { ApiContext } from '../api/endpoint.ts'
import { buildEntityIndex, type EntityIndex } from './entity-index.ts'

/** Projects a member-readable snapshot into the finalized graph seed — Task 4's
 *  canonical `snapshotToGraph`, injected here (see the module header). */
export type SnapshotToGraph = (snapshot: WorldGenSnapshot) => GraphSeed

/** The three snapshot projections + their settle state. */
export interface KnowledgeCache {
  readonly wiki: WikiViewModel | null
  readonly graph: GraphSeed | null
  readonly index: EntityIndex | null
  /** True only before the FIRST settle (resolve OR reject). */
  readonly loading: boolean
  /** The last (re)fetch rejected AND no cache ever resolved. A refetch failure
   *  with a prior cache leaves this false (the old cache stays live). */
  readonly failed: boolean
}

/** Injected dependencies. `snapshotToGraph` is required (Task 4's canonical
 *  adapter, passed by the composition); `fetchSnapshot` defaults to the real
 *  `getWorldSnapshot` endpoint and is injected only by tests. */
export interface KnowledgeCacheDeps {
  readonly snapshotToGraph: SnapshotToGraph
  readonly fetchSnapshot?: (ctx: ApiContext, campaignId: string) => Promise<WorldGenSnapshot>
}

const EMPTY_CACHE: KnowledgeCache = {
  wiki: null,
  graph: null,
  index: null,
  loading: true,
  failed: false,
}

/**
 * Fetch the member-readable world snapshot ONCE and derive all three projections
 * from it; refetch quietly whenever `refreshToken` bumps (a session mount / WS
 * reconnect boundary — the only promotion path). The current cache stays rendered
 * until a fresh one resolves, so a boundary refetch never flashes.
 */
export function useKnowledgeCache(
  campaignId: string,
  refreshToken: number,
  deps: KnowledgeCacheDeps,
): KnowledgeCache {
  const { snapshotToGraph, fetchSnapshot = getWorldSnapshot } = deps
  const ctx = useApiContext()
  const [cache, setCache] = useState<KnowledgeCache>(EMPTY_CACHE)

  useEffect(() => {
    let active = true
    void fetchSnapshot(ctx, campaignId)
      .then((snapshot) => {
        if (!active) return
        setCache({
          wiki: toWikiViewModel(snapshot),
          graph: snapshotToGraph(snapshot),
          index: buildEntityIndex(snapshot),
          loading: false,
          failed: false,
        })
      })
      .catch(() => {
        if (!active) return
        // A first-fetch failure settles to the calm empty cache; a refetch failure
        // keeps the prior cache live (no flash) — `wiki !== null` iff one resolved.
        setCache((prior) =>
          prior.wiki === null
            ? { ...prior, loading: false, failed: true }
            : { ...prior, loading: false },
        )
      })
    return () => {
      active = false
    }
  }, [ctx, campaignId, refreshToken, fetchSnapshot, snapshotToGraph])

  return cache
}

/**
 * ServerFrame types that promote the knowledge cache (trigger a refetch). EMPTY
 * by design (spec §6): the ONLY promotion path is a session-boundary `refreshToken`
 * bump. No frame on the session WS channel carries pre-flip / tier-promotion
 * content, so none may feed the cache. Adding a type here (with a matching consumer)
 * would be the single, reviewed change that opens a frame-driven path — the
 * invariant test guards against it slipping in silently.
 */
export const CACHE_PROMOTION_FRAME_TYPES: readonly ServerFrame['type'][] = []

/** Executable form of the enforced-ignorance invariant: does folding a frame of
 *  this type promote (refetch) the cache? Always false today. */
export function frameRefetchesCache(frameType: ServerFrame['type']): boolean {
  return (CACHE_PROMOTION_FRAME_TYPES as readonly string[]).includes(frameType)
}
