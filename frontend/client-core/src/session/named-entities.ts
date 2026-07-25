// named-entities (ux-run3 myth-ry14g) — which of the world's people and places
// the LIVE session has actually named, so the wiki index can lead with them
// instead of rendering the scene's antagonist and a session-one shopkeeper as
// alphabetical equals. The transcript already knows; the sidebar just has to
// ask.
//
// ZFC: no cognition. The naming is decided by the SAME mechanical name matcher
// that underlines entities in the prose (`entity-index.ts`) — a longest-first
// alternation over the world's known-tier entity names. Nothing is classified,
// ranked, or scored here; this module only accumulates the matcher's hits.
//
// Membership is CUMULATIVE for the session and never decays: an entity named in
// turn one still belongs to "this session" at turn forty. Decay would need a
// notion of "the current scene", and nothing on the wire marks a scene boundary
// — inventing one would be exactly the local intelligence ZFC forbids.
//
// Only SETTLED dm prose is scanned. A mid-stream turn's text is still growing,
// so scanning it would both churn (a rescan per text_delta) and risk matching a
// half-typed name; the turn joins the moment it settles.

import { useMemo, useRef } from 'react'
import type { EntityIndex } from './entity-index.ts'
import type { TranscriptItem } from './transcript-types.ts'

/** The accumulator: which transcript rows have been scanned, and the entity ids
 *  found so far. `ids` keeps FIRST-NAMED order (deterministic, replay-stable);
 *  the wiki reads it as a membership set. */
export interface NamedEntitiesState {
  readonly scannedKeys: ReadonlySet<string>
  readonly ids: readonly string[]
}

/** The zero state — nothing scanned, nobody named. */
export const emptyNamedEntities: NamedEntitiesState = { scannedKeys: new Set(), ids: [] }

/**
 * Fold every not-yet-scanned SETTLED dm row through the matcher and add its
 * entity hits. Returns the SAME state object when nothing new was named, so a
 * caller can hand the result straight to a memoized consumer without churning
 * its identity on every delta.
 */
export function accumulateNamedEntities(
  state: NamedEntitiesState,
  items: readonly TranscriptItem[],
  index: EntityIndex,
): NamedEntitiesState {
  const scanned = new Set(state.scannedKeys)
  const ids = new Set(state.ids)
  const found: string[] = [...state.ids]
  let changed = false
  for (const item of items) {
    if (item.kind !== 'dm' || item.streaming || scanned.has(item.key)) continue
    scanned.add(item.key)
    changed = true
    for (const segment of index.segment(item.text)) {
      if (segment.kind !== 'entity' || ids.has(segment.entityId)) continue
      ids.add(segment.entityId)
      found.push(segment.entityId)
    }
  }
  if (!changed) return state
  return { scannedKeys: scanned, ids: found }
}

/**
 * The route hook: the entity ids this session has named, accumulated across
 * turns. The accumulator lives in a ref (a pure memo cache — re-running the fold
 * is idempotent, so a StrictMode double-render returns the same value) and RESETS
 * whenever the matcher identity changes: a new `index` means a refetched world
 * snapshot, and ids from the previous compile must not survive it.
 *
 * Returns a stable array reference while nothing new is named — the wiki's
 * presence split re-renders only when the answer actually changed.
 */
export function useNamedEntities(
  items: readonly TranscriptItem[],
  index: EntityIndex | undefined,
): readonly string[] {
  const state = useRef<NamedEntitiesState>(emptyNamedEntities)
  const compiled = useRef<EntityIndex | undefined>(undefined)
  return useMemo(() => {
    if (compiled.current !== index) {
      compiled.current = index
      state.current = emptyNamedEntities
    }
    if (index === undefined) return state.current.ids
    state.current = accumulateNamedEntities(state.current, items, index)
    return state.current.ids
  }, [items, index])
}
