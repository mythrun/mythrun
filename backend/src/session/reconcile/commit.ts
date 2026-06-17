// backend/src/session/reconcile/commit.ts
//
// MYT-74a T9 — the transactional multi-substrate commit applier. The
// deterministic code that folds a VALIDATED reconcile plan into durable canon
// in ONE transaction. Runs AFTER the Opus reconciler + the T4 validator
// (`validateReconcilePlan` returned `{ok:true, map}`); it does NO judgment of
// its own — every decision (match vs mint, tier, attribution) is already baked
// into the plan + map.
//
// The transaction touches four substrates atomically: entities, facts (append +
// supersede + embedding), relationships, and the sub-faction hierarchy. Its LAST
// in-tx statement is the conditional `markReconciled` gate — the idempotency
// mutex. If a concurrent execution already reconciled this session
// (`markReconciled` → 0), the WHOLE transaction rolls back, so a re-run never
// double-writes canon. This is the only place the gate's rowCount is consulted;
// `sessions.markReconciled` is the single-statement conditional UPDATE behind it.
//
// ENFORCED IGNORANCE: the plan carries secret prose, but this module only writes
// it to durable rows — it never logs content or surfaces a prose-bearing error.

import { ROLLBACK, type Repo } from '../../repo/index.js'
import { uuidv7 } from '../../repo/uuidv7.js'
import { type ReconcilePlan } from '../../llm/schemas/session-reconcile.js'
import { type WorkingSetItem } from '../working-set/types.js'
import { type SubjectResolution } from './validate.js'

/** Inputs to a single reconcile commit. All read-only. `map` is the resolution
 *  map a successful `validateReconcilePlan` returned; `factEmbeddings` is
 *  parallel to `plan.facts` (an empty inner array = skip the embed for that
 *  fact). */
export interface ReconcileCommitArgs {
  readonly plan: ReconcilePlan
  readonly map: ReadonlyMap<string, SubjectResolution>
  readonly workingSet: readonly WorkingSetItem[]
  readonly worldId: string
  readonly sessionId: string
  readonly factEmbeddings: readonly (readonly number[])[]
}

/** Convert an embedding (number[]) to the pgvector `'[f1,…,fN]'` text literal
 *  the `$::vector` cast expects. Local copy of the private helper in
 *  embed-write.ts / search.ts (they intentionally do not share it). */
function toVectorLiteral(v: readonly number[]): string {
  return `[${v.join(',')}]`
}

/**
 * Apply a validated reconcile plan to durable canon in one transaction.
 *
 * Returns `{committed:true}` on a clean commit, `{committed:false}` when the
 * reconciled_at gate already fired for this session (the tx rolled back, no
 * canon written). The `repo` surface need only expose `transaction`; the body
 * works through the tx-bound namespaces.
 */
export async function applyReconcileCommit(
  repo: Pick<Repo, 'transaction'>,
  args: ReconcileCommitArgs,
): Promise<{ committed: boolean }> {
  const { plan, map, workingSet, worldId, sessionId, factEmbeddings } = args

  const result = await repo.transaction(async (tx) => {
    // 1. Resolve every entity-op subjectName to a concrete id: a match reuses
    //    the canon id, a mint gets a fresh uuidv7. Built from the validated map
    //    so it covers every subject the plan's facts/relationships reference.
    const resolvedIds = new Map<string, string>()
    for (const [subjectName, resolution] of map) {
      resolvedIds.set(
        subjectName,
        resolution.kind === 'match' ? resolution.id : uuidv7(),
      )
    }

    // 2. Mint new entities. The validator guarantees every mint subject is in
    //    the map, so the lookup never misses — but we guard rather than assert.
    for (const e of plan.entities) {
      if (e.op !== 'mint') continue
      const id = resolvedIds.get(e.subjectName)
      /* c8 ignore start — unreachable: the validated map holds every entity-op
       * subjectName; the guard exists for TS narrowing, not a real path. */
      if (id === undefined) return ROLLBACK
      /* c8 ignore stop */
      await tx.entities.insert({
        id,
        worldId,
        entityType: e.entityType,
        name: e.name,
        accessLevel: e.accessLevel,
        createdIn: `session:${sessionId}`,
      })
    }

    // 3. Append facts (append-only canon), supersede the old fact when asked,
    //    and write the embedding when one was supplied for that fact.
    for (let i = 0; i < plan.facts.length; i++) {
      const f = plan.facts[i]
      /* c8 ignore next — array bound: i < length, so f is always defined. */
      if (f === undefined) return ROLLBACK
      const entityId = resolvedIds.get(f.subjectName)
      /* c8 ignore start — unreachable: the validator rejects any fact whose
       * subjectName is in no entity op, so the map always resolves it. */
      if (entityId === undefined) return ROLLBACK
      /* c8 ignore stop */
      const newId = await tx.facts.insertReconciled({
        entityId,
        topic: f.topic,
        content: f.content,
        accessLevel: f.accessLevel,
      })
      if (f.supersedesFactId !== null) {
        await tx.facts.setSuperseded(f.supersedesFactId, newId)
      }
      const embedding = factEmbeddings[i]
      if (embedding !== undefined && embedding.length > 0) {
        await tx.facts.updateEmbedding(newId, toVectorLiteral(embedding))
      }
    }

    // 4. Relationships: directed session edges (synth_key NULL — these are not
    //    addressed on the wire by synth_key the way world-gen edges are).
    for (const r of plan.relationships) {
      const sourceEntityId = resolvedIds.get(r.fromSubjectName)
      const targetEntityId = resolvedIds.get(r.toSubjectName)
      /* c8 ignore start — unreachable: the validator rejects any relationship
       * endpoint in no entity op, so both ends always resolve in the map. */
      if (sourceEntityId === undefined || targetEntityId === undefined) return ROLLBACK
      /* c8 ignore stop */
      await tx.relationships.insertIntegrationEdge({
        sourceEntityId,
        targetEntityId,
        relationshipType: r.relationshipType,
        description: r.description,
      })
    }

    // 5. Hierarchy (best-effort substrate). A working-set entity item carrying a
    //    parentName signals a sub-faction edge. The child must resolve in THIS
    //    plan; the parent resolves either in the plan OR — the common case, a
    //    sub-faction of an EXISTING faction the reconciler had no new facts about
    //    so never emitted an op for — against existing canon by normalized name.
    //    Skip (not fail) when the parent is unknown or the child is already
    //    parented (UNIQUE child_entity_id). (The real-LLM smoke surfaced that
    //    resolving only against the plan dropped the typical existing-parent edge.)
    for (const item of workingSet) {
      if (item.kind !== 'entity') continue
      const parentName = item.parentName
      if (parentName === undefined || parentName.length === 0) continue
      const childId = resolvedIds.get(item.subjectName)
      if (childId === undefined) continue
      // Parent resolves in the plan, else against existing canon by name.
      const parentId =
        resolvedIds.get(parentName) ??
        (await tx.entities.findIdByWorldAndNormalizedName(worldId, parentName))
      if (parentId === null) continue
      const existing = await tx.entityHierarchy.listExistingChildIds([childId], worldId)
      if (existing.length > 0) continue
      await tx.entityHierarchy.insert({ parentEntityId: parentId, childEntityId: childId })
    }

    // 6. Play-marking: flag every entity the plan minted or matched as touched.
    await tx.entities.markTouchedByPlay([...resolvedIds.values()])

    // 7. Gate (LAST statement). markReconciled sets reconciled_at only when it
    //    is still NULL. A 0 rowCount means a concurrent execution already
    //    reconciled this session — roll the whole tx back so no duplicate canon
    //    lands. The first execution gets 1 and commits.
    const gated = await tx.sessions.markReconciled(sessionId)
    if (gated === 0) return ROLLBACK
    return true
  })

  return { committed: result !== ROLLBACK }
}
