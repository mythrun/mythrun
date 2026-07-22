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
  /** Name-rebind heal (lowercased trimmed candidate name → id; names carried by
   *  more than one candidate are EXCLUDED at construction). A match op whose
   *  canonEntityId doesn't bind — Opus reliably names entities and unreliably
   *  transcribes UUIDs — rebinds to the candidate its claimed `name` uniquely
   *  identifies, instead of rejecting the whole plan and re-spending the Opus
   *  call. Optional so older callers/tests keep strict behavior. */
  readonly candidateIdsByName?: ReadonlyMap<string, string>
}

/** How a subjectName resolves for the commit: an existing canon id, or a mint. */
export type SubjectResolution =
  | { readonly kind: 'match'; readonly id: string }
  | { readonly kind: 'mint' }

/** One healed match: the plan claimed `name` under a non-binding id; the
 *  validator rebound it to the unique live candidate `to`. Surfaced so the
 *  processor can log the heal (counts + names are not secret content). */
interface MatchRebind {
  readonly subjectName: string
  readonly name: string
  readonly to: string
}

/** One degraded match: neither the claimed id nor the claimed name resolved a
 *  live canon entity, so the op minted instead of rejecting the whole plan.
 *  With the processor's canon-by-name pre-pass in front, a demotion means the
 *  name genuinely is not in canon — i.e. the model said 'match' about a new
 *  thing, and mint is what it meant. */
interface MatchDemotion {
  readonly subjectName: string
  readonly name: string
}

export type ValidateResult =
  | {
      readonly ok: true
      readonly map: ReadonlyMap<string, SubjectResolution>
      readonly rebinds: readonly MatchRebind[]
      readonly demotions: readonly MatchDemotion[]
    }
  | { readonly ok: false; readonly reason: ValidateRejectReason }

type ValidateRejectReason =
  | 'dangling_fact_subject' // a fact.subjectName not resolvable to an entity op
  | 'dangling_relationship_endpoint' // a relationship endpoint not resolvable to an entity op
  | 'supersede_target_not_live' // a supersedesFactId not in liveFactIds
  | 'tier_downgrade' // a fact.accessLevel weaker than its working-set item's tier
  | 'attribution_dropped' // an attributed item's fact has claimedBy:null
  | 'dangling_promotion' // a promotions[] id not in liveFactIds

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

  // 1. Entity ops -> resolution map. A match must point at a live candidate —
  //    with the NAME-REBIND heal: a non-binding id (null, hallucinated, or a
  //    mis-transcribed UUID) whose claimed `name` uniquely identifies a live
  //    candidate rebinds to that candidate instead of rejecting the plan (each
  //    rejection re-spends the whole Opus reconcile; three consecutive live
  //    rejections were exactly this failure).
  const map = new Map<string, SubjectResolution>()
  const rebinds: MatchRebind[] = []
  const demotions: MatchDemotion[] = []
  for (const e of plan.entities) {
    if (e.op === 'match') {
      if (e.canonEntityId !== null && ctx.liveCandidateEntityIds.has(e.canonEntityId)) {
        map.set(e.subjectName, { kind: 'match', id: e.canonEntityId })
        continue
      }
      const healed = ctx.candidateIdsByName?.get(e.name.trim().toLowerCase())
      if (healed !== undefined) {
        rebinds.push({ subjectName: e.subjectName, name: e.name, to: healed })
        map.set(e.subjectName, { kind: 'match', id: healed })
        continue
      }
      // Total: an unresolvable match MINTS rather than rejecting the plan (a
      // rejection re-spends the whole Opus reconcile and, at attempts-cap,
      // bricks the campaign at the boundary — seen live, 5/5 rejections).
      demotions.push({ subjectName: e.subjectName, name: e.name })
      map.set(e.subjectName, { kind: 'mint' })
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

  // 6. Promotions: every promoted id must be a live candidate fact.
  for (const id of plan.promotions) {
    if (!ctx.liveFactIds.has(id)) return { ok: false, reason: 'dangling_promotion' }
  }

  return { ok: true, map, rebinds, demotions }
}

/** First working-set item per subjectName (later duplicates ignored). */
function firstBySubject(items: readonly WorkingSetItem[]): ReadonlyMap<string, WorkingSetItem> {
  const m = new Map<string, WorkingSetItem>()
  for (const it of items) {
    if (!m.has(it.subjectName)) m.set(it.subjectName, it)
  }
  return m
}
