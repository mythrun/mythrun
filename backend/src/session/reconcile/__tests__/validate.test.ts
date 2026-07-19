import { describe, it, expect } from 'vitest'
import { type ReconcilePlan } from '../../../llm/schemas/session-reconcile.js'
import { type WorkingSetItem } from '../../working-set/types.js'
import { validateReconcilePlan, type ValidateCtx } from '../validate.js'

// ---------------------------------------------------------------------------
// Builders. These keep each test's intent legible — every case is "a valid
// plan, mutated at exactly one seam" — and pin the structural shape so a schema
// drift surfaces here, not in a silent validator gap.
// ---------------------------------------------------------------------------

const SECRET = 'The duke is the masked cult leader who poisoned the well.'

function entityOp(o: Partial<ReconcilePlan['entities'][number]> = {}): ReconcilePlan['entities'][number] {
  return {
    op: 'mint',
    subjectName: 'Aldric',
    canonEntityId: null,
    name: 'Aldric',
    entityType: 'npc',
    accessLevel: 'known',
    ...o,
  }
}

function factOp(o: Partial<ReconcilePlan['facts'][number]> = {}): ReconcilePlan['facts'][number] {
  return {
    subjectName: 'Aldric',
    topic: 'appearance',
    content: 'A grey-bearded man in a travel-stained cloak.',
    accessLevel: 'known',
    claimedBy: null,
    supersedesFactId: null,
    ...o,
  }
}

function relOp(o: Partial<ReconcilePlan['relationships'][number]> = {}): ReconcilePlan['relationships'][number] {
  return {
    fromSubjectName: 'Aldric',
    toSubjectName: 'Mira',
    relationshipType: 'mentor_of',
    description: 'Aldric trained Mira in the old ways.',
    ...o,
  }
}

function wsItem(o: Partial<WorkingSetItem> = {}): WorkingSetItem {
  return {
    kind: 'fact',
    content: 'ws content',
    subjectName: 'Aldric',
    tier: 'known',
    provenance: { kind: 'objective' },
    source: 'ft_delta',
    id: 'ws-1',
    turnId: 'turn-1',
    embedding: [],
    ...o,
  }
}

function plan(o: Partial<ReconcilePlan> = {}): ReconcilePlan {
  return { entities: [], facts: [], relationships: [], promotions: [], ...o }
}

const CANON_ALDRIC = '0192a000-0000-7000-8000-000000000001'
const LIVE_FACT = '0192b000-0000-7000-8000-000000000001'

function ctx(o: Partial<ValidateCtx> = {}): ValidateCtx {
  return {
    workingSet: [],
    liveCandidateEntityIds: new Set<string>(),
    liveFactIds: new Set<string>(),
    ...o,
  }
}

describe('validateReconcilePlan', () => {
  it('accepts a valid plan and resolves both subjects (mint + match)', () => {
    const p = plan({
      entities: [
        entityOp({ subjectName: 'Aldric', op: 'mint', canonEntityId: null }),
        entityOp({ subjectName: 'Mira', op: 'match', name: 'Mira', canonEntityId: CANON_ALDRIC }),
      ],
      facts: [factOp({ subjectName: 'Aldric' }), factOp({ subjectName: 'Mira' })],
      relationships: [relOp({ fromSubjectName: 'Aldric', toSubjectName: 'Mira' })],
    })
    const result = validateReconcilePlan(p, ctx({ liveCandidateEntityIds: new Set([CANON_ALDRIC]) }))
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.map.get('Aldric')).toEqual({ kind: 'mint' })
    expect(result.map.get('Mira')).toEqual({ kind: 'match', id: CANON_ALDRIC })
  })

  it('DEGRADES a match with an unknown id and unresolvable name to a MINT (total entity ops)', () => {
    const p = plan({
      entities: [entityOp({ op: 'match', subjectName: 'Aldric', name: 'Aldric', canonEntityId: CANON_ALDRIC })],
      facts: [factOp({ subjectName: 'Aldric' })],
    })
    const result = validateReconcilePlan(p, ctx({ liveCandidateEntityIds: new Set(['some-other-id']) }))
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.map.get('Aldric')).toEqual({ kind: 'mint' })
    expect(result.demotions).toEqual([{ subjectName: 'Aldric', name: 'Aldric' }])
  })

  it('DEGRADES a null-id unresolvable match to a MINT the same way', () => {
    const p = plan({
      entities: [entityOp({ op: 'match', subjectName: 'Aldric', name: 'Aldric', canonEntityId: null })],
      facts: [factOp({ subjectName: 'Aldric' })],
    })
    const result = validateReconcilePlan(p, ctx({ liveCandidateEntityIds: new Set([CANON_ALDRIC]) }))
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.map.get('Aldric')).toEqual({ kind: 'mint' })
  })

  // ── myth-<reconcile-rebind> — the name-rebind heal. A match whose id doesn't
  // bind but whose claimed NAME uniquely identifies a live candidate rebinds to
  // that candidate instead of rejecting (Opus reliably names entities and
  // unreliably transcribes UUIDs; 3 consecutive live rejections were this).
  it('HEALS a match with an unknown id when the op name uniquely resolves a candidate', () => {
    const p = plan({
      entities: [
        entityOp({ subjectName: 'Old Renn', op: 'match', name: 'Old Renn', canonEntityId: '0192a000-0000-7000-8000-00000000BAD1' }),
      ],
      facts: [factOp({ subjectName: 'Old Renn' })],
    })
    const result = validateReconcilePlan(
      p,
      ctx({
        liveCandidateEntityIds: new Set([CANON_ALDRIC]),
        candidateIdsByName: new Map([['old renn', CANON_ALDRIC]]),
      }),
    )
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.map.get('Old Renn')).toEqual({ kind: 'match', id: CANON_ALDRIC })
    expect(result.rebinds).toEqual([
      { subjectName: 'Old Renn', name: 'Old Renn', to: CANON_ALDRIC },
    ])
  })

  it('HEALS a null-id match the same way (match-by-name intent)', () => {
    const p = plan({
      entities: [entityOp({ subjectName: 'Bel', op: 'match', name: 'Bel Harren', canonEntityId: null })],
      facts: [factOp({ subjectName: 'Bel' })],
    })
    const result = validateReconcilePlan(
      p,
      ctx({
        liveCandidateEntityIds: new Set([CANON_ALDRIC]),
        candidateIdsByName: new Map([['bel harren', CANON_ALDRIC]]),
      }),
    )
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.map.get('Bel')).toEqual({ kind: 'match', id: CANON_ALDRIC })
  })

  it('prefers the NAME REBIND over the mint-degrade when the name resolves', () => {
    const p = plan({
      entities: [
        entityOp({ subjectName: 'Renn', op: 'match', name: 'Old Renn', canonEntityId: 'bad-id' }),
        entityOp({ subjectName: 'Stranger', op: 'match', name: 'Total Stranger', canonEntityId: 'bad-id-2' }),
      ],
      facts: [factOp({ subjectName: 'Renn' }), factOp({ subjectName: 'Stranger' })],
    })
    const result = validateReconcilePlan(
      p,
      ctx({
        liveCandidateEntityIds: new Set([CANON_ALDRIC]),
        candidateIdsByName: new Map([['old renn', CANON_ALDRIC]]),
      }),
    )
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.map.get('Renn')).toEqual({ kind: 'match', id: CANON_ALDRIC })
    expect(result.map.get('Stranger')).toEqual({ kind: 'mint' })
    expect(result.rebinds).toHaveLength(1)
    expect(result.demotions).toEqual([{ subjectName: 'Stranger', name: 'Total Stranger' }])
  })

  it('valid-id matches record NO rebind (the heal is collision-path only)', () => {
    const p = plan({
      entities: [entityOp({ subjectName: 'Mira', op: 'match', name: 'Mira', canonEntityId: CANON_ALDRIC })],
      facts: [factOp({ subjectName: 'Mira' })],
    })
    const result = validateReconcilePlan(p, ctx({ liveCandidateEntityIds: new Set([CANON_ALDRIC]) }))
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.rebinds).toEqual([])
  })

  it('rejects a fact whose subjectName is in no entity op', () => {
    const p = plan({
      entities: [entityOp({ subjectName: 'Aldric' })],
      facts: [factOp({ subjectName: 'Ghost' })],
    })
    const result = validateReconcilePlan(p, ctx())
    expect(result).toEqual({ ok: false, reason: 'dangling_fact_subject' })
  })

  it('rejects a relationship endpoint in no entity op (from side)', () => {
    const p = plan({
      entities: [entityOp({ subjectName: 'Aldric' })],
      relationships: [relOp({ fromSubjectName: 'Aldric', toSubjectName: 'Ghost' })],
    })
    const result = validateReconcilePlan(p, ctx())
    expect(result).toEqual({ ok: false, reason: 'dangling_relationship_endpoint' })
  })

  it('rejects a relationship endpoint in no entity op (to side via from)', () => {
    const p = plan({
      entities: [entityOp({ subjectName: 'Mira' })],
      relationships: [relOp({ fromSubjectName: 'Ghost', toSubjectName: 'Mira' })],
    })
    const result = validateReconcilePlan(p, ctx())
    expect(result).toEqual({ ok: false, reason: 'dangling_relationship_endpoint' })
  })

  it('rejects a supersedesFactId not in liveFactIds', () => {
    const p = plan({
      entities: [entityOp({ subjectName: 'Aldric' })],
      facts: [factOp({ supersedesFactId: 'not-a-live-fact' })],
    })
    const result = validateReconcilePlan(p, ctx({ liveFactIds: new Set([LIVE_FACT]) }))
    expect(result).toEqual({ ok: false, reason: 'supersede_target_not_live' })
  })

  it('accepts a fact superseding a live fact, and a null supersede', () => {
    const p = plan({
      entities: [entityOp({ subjectName: 'Aldric' })],
      facts: [
        factOp({ supersedesFactId: LIVE_FACT }),
        factOp({ supersedesFactId: null }),
      ],
    })
    const result = validateReconcilePlan(p, ctx({ liveFactIds: new Set([LIVE_FACT]) }))
    expect(result.ok).toBe(true)
  })

  it('rejects a tier downgrade (fact known, working-set item secret)', () => {
    const p = plan({
      entities: [entityOp({ subjectName: 'Aldric' })],
      facts: [factOp({ subjectName: 'Aldric', accessLevel: 'known' })],
    })
    const result = validateReconcilePlan(
      p,
      ctx({ workingSet: [wsItem({ subjectName: 'Aldric', tier: 'secret' })] }),
    )
    expect(result).toEqual({ ok: false, reason: 'tier_downgrade' })
  })

  it('accepts an equal-or-stronger tier (fact secret, working-set item discoverable)', () => {
    const p = plan({
      entities: [entityOp({ subjectName: 'Aldric' })],
      facts: [factOp({ subjectName: 'Aldric', accessLevel: 'secret' })],
    })
    const result = validateReconcilePlan(
      p,
      ctx({ workingSet: [wsItem({ subjectName: 'Aldric', tier: 'discoverable' })] }),
    )
    expect(result.ok).toBe(true)
  })

  it('applies no tier floor when no working-set item matches the subject', () => {
    const p = plan({
      entities: [entityOp({ subjectName: 'Aldric' })],
      facts: [factOp({ subjectName: 'Aldric', accessLevel: 'known' })],
    })
    // working set has a secret item under a DIFFERENT subject — must not apply.
    const result = validateReconcilePlan(
      p,
      ctx({ workingSet: [wsItem({ subjectName: 'Someone Else', tier: 'secret' })] }),
    )
    expect(result.ok).toBe(true)
  })

  it('rejects dropped attribution (attributed item, fact claimedBy null)', () => {
    const p = plan({
      entities: [entityOp({ subjectName: 'Aldric' })],
      facts: [factOp({ subjectName: 'Aldric', claimedBy: null })],
    })
    const result = validateReconcilePlan(
      p,
      ctx({
        workingSet: [
          wsItem({
            subjectName: 'Aldric',
            provenance: { kind: 'attributed', npcEntityId: 'npc-9', npcName: 'Mira' },
          }),
        ],
      }),
    )
    expect(result).toEqual({ ok: false, reason: 'attribution_dropped' })
  })

  it('accepts a null claimedBy when the working-set item is objective', () => {
    const p = plan({
      entities: [entityOp({ subjectName: 'Aldric' })],
      facts: [factOp({ subjectName: 'Aldric', claimedBy: null })],
    })
    const result = validateReconcilePlan(
      p,
      ctx({ workingSet: [wsItem({ subjectName: 'Aldric', provenance: { kind: 'objective' } })] }),
    )
    expect(result.ok).toBe(true)
  })

  it('preserves a present claimedBy on an attributed item', () => {
    const p = plan({
      entities: [entityOp({ subjectName: 'Aldric' })],
      facts: [factOp({ subjectName: 'Aldric', claimedBy: 'Mira' })],
    })
    const result = validateReconcilePlan(
      p,
      ctx({
        workingSet: [
          wsItem({
            subjectName: 'Aldric',
            provenance: { kind: 'attributed', npcEntityId: 'npc-9', npcName: 'Mira' },
          }),
        ],
      }),
    )
    expect(result.ok).toBe(true)
  })

  // -------------------------------------------------------------------------
  // ENFORCED IGNORANCE: the reject reason is a structural code, never prose.
  // A reason that echoed fact.content would leak the very secret the validator
  // exists to protect into the alert/log surface.
  // -------------------------------------------------------------------------

  it('never leaks secret content in a tier_downgrade reason', () => {
    const p = plan({
      entities: [entityOp({ subjectName: 'Aldric' })],
      facts: [factOp({ subjectName: 'Aldric', accessLevel: 'known', content: SECRET })],
    })
    const result = validateReconcilePlan(
      p,
      ctx({ workingSet: [wsItem({ subjectName: 'Aldric', tier: 'secret', content: SECRET })] }),
    )
    expect(result).toEqual({ ok: false, reason: 'tier_downgrade' })
    expect(JSON.stringify(result)).not.toContain(SECRET)
  })

  it('never leaks secret content in an attribution_dropped reason', () => {
    const p = plan({
      entities: [entityOp({ subjectName: 'Aldric' })],
      facts: [factOp({ subjectName: 'Aldric', claimedBy: null, content: SECRET })],
    })
    const result = validateReconcilePlan(
      p,
      ctx({
        workingSet: [
          wsItem({
            subjectName: 'Aldric',
            content: SECRET,
            provenance: { kind: 'attributed', npcEntityId: 'npc-9', npcName: 'Mira' },
          }),
        ],
      }),
    )
    expect(result).toEqual({ ok: false, reason: 'attribution_dropped' })
    expect(JSON.stringify(result)).not.toContain(SECRET)
  })

  // -------------------------------------------------------------------------
  // MYT-74c — promotions: existing candidate fact ids flipped to `known`. A
  // distinct op, NOT subject to the tier_downgrade fact-floor. The only check:
  // each promoted id must be a live candidate fact.
  // -------------------------------------------------------------------------

  it('rejects a promotion id not among live candidate facts', () => {
    const r = validateReconcilePlan(
      plan({ promotions: ['ghost'] }),
      ctx({ liveFactIds: new Set(['real']) }),
    )
    expect(r).toEqual({ ok: false, reason: 'dangling_promotion' })
  })

  it('accepts a promotion of a live candidate fact (not a tier_downgrade)', () => {
    const r = validateReconcilePlan(plan({ promotions: ['real'] }), ctx({ liveFactIds: new Set(['real']) }))
    expect(r.ok).toBe(true)
  })

  it('returns the first REMAINING failure class (entity ops are total now): facts before relationships', () => {
    // The old first-class entity failure (dangling_match) degrades to a mint,
    // so the unresolvable-match entity op no longer rejects — the dangling
    // FACT subject is the first reachable failure.
    const p = plan({
      entities: [entityOp({ op: 'match', canonEntityId: null })],
      facts: [factOp({ subjectName: 'Ghost' })],
    })
    const result = validateReconcilePlan(p, ctx())
    expect(result).toEqual({ ok: false, reason: 'dangling_fact_subject' })
  })
})
