// backend/src/session/reconcile/validate.ts
//
// MYT-74a T4 — the security-critical reconcile-plan validator. PURE (no I/O).
//
// Runs AFTER the Opus reconciler returns a plan (and after any repair), inside
// the reconcile worker. It checks the plan's structural integrity (every
// fact/relationship subject resolves to an entity op; matches + supersedes
// point at live canon rows) AND mechanically enforces the tier + attribution
// policy (a fact may never DOWNGRADE the tier of its working-set item, and an
// attributed item's fact may never DROP its NPC attribution).
//
// ZFC: tier/attribution preservation is POLICY enforcement — the mechanical
// chokepoint, the explicit ZFC exception. No LLM judgment lives here.
//
// ENFORCED IGNORANCE (load-bearing): the validated plan contains secret prose.
// A reject `reason` is therefore a STRUCTURAL CODE ONLY — never `fact.content`,
// never working-set content, never any prose. A reason that echoed content
// would leak the very secret this validator exists to protect into the
// alert/log surface.

import { type ReconcilePlan } from '../../llm/schemas/session-reconcile.js'
import { type WorkingSetItem } from '../working-set/types.js'
import { type AccessLevel } from '../../repo/facts.js'

/** Inputs the validator joins the plan against. All read-only. */
export interface ValidateCtx {
  readonly workingSet: readonly WorkingSetItem[]
  readonly liveCandidateEntityIds: ReadonlySet<string> // ids of canon entities the plan may 'match'
  readonly liveFactIds: ReadonlySet<string> // ids of live canon facts a supersede may target
}

/** How a subjectName resolves for the commit: an existing canon id, or a mint. */
export type SubjectResolution =
  | { readonly kind: 'match'; readonly id: string }
  | { readonly kind: 'mint' }

export type ValidateResult =
  | { readonly ok: true; readonly map: ReadonlyMap<string, SubjectResolution> }
  | { readonly ok: false; readonly reason: ValidateRejectReason }

export type ValidateRejectReason =
  | 'dangling_match' // a match op's canonEntityId is null OR not in liveCandidateEntityIds
  | 'dangling_fact_subject' // a fact.subjectName not resolvable to an entity op
  | 'dangling_relationship_endpoint' // a relationship endpoint not resolvable to an entity op
  | 'supersede_target_not_live' // a supersedesFactId not in liveFactIds
  | 'tier_downgrade' // a fact.accessLevel weaker than its working-set item's tier
  | 'attribution_dropped' // an attributed item's fact has claimedBy:null

const TIER_RANK: Record<AccessLevel, number> = { known: 0, discoverable: 1, secret: 2 }

/**
 * Validate a reconcile plan against the working set + loaded live canon ids.
 * Returns the first failure in deterministic order (entities -> facts ->
 * relationships), else `{ok:true, map}` where `map` resolves every entity-op
 * subjectName so the commit can bind fact/relationship subjects.
 */
export function validateReconcilePlan(plan: ReconcilePlan, ctx: ValidateCtx): ValidateResult {
  // First working-set item per subjectName — the carried-through stamped key is
  // the tier-floor + attribution join key.
  const wsBySubject = firstBySubject(ctx.workingSet)

  // 1. Entity ops -> resolution map. A match must point at a live candidate.
  const map = new Map<string, SubjectResolution>()
  for (const e of plan.entities) {
    if (e.op === 'match') {
      if (e.canonEntityId === null || !ctx.liveCandidateEntityIds.has(e.canonEntityId)) {
        return { ok: false, reason: 'dangling_match' }
      }
      map.set(e.subjectName, { kind: 'match', id: e.canonEntityId })
    } else {
      map.set(e.subjectName, { kind: 'mint' })
    }
  }

  // 2-5. Facts: subject resolvable; supersede target live; tier floor; attribution.
  for (const f of plan.facts) {
    if (!map.has(f.subjectName)) return { ok: false, reason: 'dangling_fact_subject' }
    if (f.supersedesFactId !== null && !ctx.liveFactIds.has(f.supersedesFactId)) {
      return { ok: false, reason: 'supersede_target_not_live' }
    }
    const item = wsBySubject.get(f.subjectName)
    if (item !== undefined) {
      if (TIER_RANK[f.accessLevel] < TIER_RANK[item.tier]) {
        return { ok: false, reason: 'tier_downgrade' }
      }
      if (item.provenance.kind === 'attributed' && f.claimedBy === null) {
        return { ok: false, reason: 'attribution_dropped' }
      }
    }
  }

  // 2. Relationships: both endpoints resolvable to an entity op.
  for (const r of plan.relationships) {
    if (!map.has(r.fromSubjectName) || !map.has(r.toSubjectName)) {
      return { ok: false, reason: 'dangling_relationship_endpoint' }
    }
  }

  return { ok: true, map }
}

/** First working-set item per subjectName (later duplicates ignored). */
function firstBySubject(items: readonly WorkingSetItem[]): ReadonlyMap<string, WorkingSetItem> {
  const m = new Map<string, WorkingSetItem>()
  for (const it of items) {
    if (!m.has(it.subjectName)) m.set(it.subjectName, it)
  }
  return m
}
