// backend/src/session/reconcile/__tests__/commit.test.ts
//
// MYT-74a T9 — the transactional multi-substrate commit applier. Real PG
// (mythrun_test); scoped fixtures. Drives `applyReconcileCommit` end-to-end
// against durable canon: mint + match entities, append + supersede facts (with
// embeddings), session relationship edges, the best-effort sub-faction
// hierarchy edge, play-marking, and the conditional reconciled_at gate.
//
// The gate is the idempotency mutex: a second commit on an already-reconciled
// session must roll the WHOLE transaction back (no duplicate canon), returning
// {committed:false}.

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import type { Pool } from 'pg'
import { guardTestDatabase } from '../../../db/__tests__/guard-db.js'
import { uuidv7 } from '../../../repo/uuidv7.js'
import { createRepo, type Repo } from '../../../repo/index.js'
import { type ReconcilePlan } from '../../../llm/schemas/session-reconcile.js'
import { type WorkingSetItem } from '../../working-set/types.js'
import { type SubjectResolution } from '../validate.js'
import { cleanupTestScope, makeTestScope, type TestScope } from '../../../repo/__tests__/_helpers/test-scope.js'
import { createTestPool } from '../../../repo/__tests__/_helpers/test-pool.js'
import { applyReconcileCommit } from '../commit.js'

const databaseUrl = process.env.DATABASE_URL ?? ''
const VECTOR_DIMS = 512

/** A 512-dim embedding (a 1 at `axis`, else 0) as a number[] — the commit
 *  builds the pgvector literal itself. */
function unitEmbedding(axis: number): readonly number[] {
  const v = new Array<number>(VECTOR_DIMS).fill(0)
  v[axis] = 1
  return v
}

/** A working-set item with sane defaults — every case overrides exactly the
 *  fields that matter for the hierarchy substrate (kind, subjectName,
 *  parentName). Mirrors validate.test.ts's `wsItem`. */
function wsItem(o: Partial<WorkingSetItem> = {}): WorkingSetItem {
  return {
    kind: 'entity',
    content: 'ws content',
    subjectName: 'subject',
    tier: 'known',
    provenance: { kind: 'objective' },
    source: 'ft_delta',
    id: `ws-${Math.random().toString(36).slice(2)}`,
    turnId: 'turn-1',
    embedding: [],
    ...o,
  }
}

interface Seed {
  readonly userId: string
  readonly worldId: string
  readonly campaignId: string
  readonly sessionId: string
  /** A pre-existing canon entity the plan will `match`. */
  readonly canonFactionId: string
  /** A live canon fact under the matched entity the plan will supersede. */
  readonly liveFactId: string
}

describe('applyReconcileCommit (MYT-74a T9, integration)', () => {
  let pool: Pool
  let repo: Repo
  let scope: TestScope

  beforeAll(async () => {
    await guardTestDatabase(databaseUrl)
    pool = createTestPool(databaseUrl)
    repo = createRepo(pool)
    scope = makeTestScope('reconcile-commit')
  })
  afterAll(async () => {
    await cleanupTestScope(pool, scope)
    await pool.end()
  })
  beforeEach(async () => {
    await cleanupTestScope(pool, scope)
  })

  /** Seed user → world → campaign → session, plus one canon faction entity
   *  with a live fact (the supersede target). Returns every id the plan binds. */
  async function seed(): Promise<Seed> {
    const userId = uuidv7()
    const worldId = uuidv7()
    const canonFactionId = uuidv7()
    await pool.query(
      `INSERT INTO users (id, cognito_sub, display_name, username) VALUES ($1, $2, $3, $4)`,
      [userId, scope.userSub(0), scope.displayName(0), scope.username(0)],
    )
    await pool.query(
      `INSERT INTO worlds (id, created_by, name, concept, status) VALUES ($1, $2, $3, 'C', 'generating')`,
      [worldId, userId, scope.worldName(0)],
    )
    const campaign = await pool.query<{ id: string }>(
      `INSERT INTO campaigns (id, world_id, created_by, name) VALUES ($1, $2, $3, $4) RETURNING id`,
      [uuidv7(), worldId, userId, scope.campaignName(0)],
    )
    const campaignId = campaign.rows[0]?.id
    if (!campaignId) throw new Error('campaign insert returned no id')
    const session = await pool.query<{ id: string }>(
      `INSERT INTO sessions (id, campaign_id, session_number, status) VALUES ($1, $2, 1, 'active') RETURNING id`,
      [uuidv7(), campaignId],
    )
    const sessionId = session.rows[0]?.id
    if (!sessionId) throw new Error('session insert returned no id')

    // The match target: a faction that already exists in canon.
    await repo.entities.insert({
      id: canonFactionId,
      worldId,
      entityType: 'faction',
      name: 'The Ashen Court',
      accessLevel: 'known',
      createdIn: 'stage:test',
    })
    // The supersede target: a live fact under the matched faction.
    const liveFactId = await repo.facts.insertReconciled({
      entityId: canonFactionId,
      topic: 'leadership',
      content: 'The Ashen Court is led by an unknown figure.',
      accessLevel: 'known',
    })

    return { userId, worldId, campaignId, sessionId, canonFactionId, liveFactId }
  }

  /** Build a plan + resolution map + working set for the happy path:
   *   - mint entity "Brother Vael" (npc), child of the matched faction;
   *   - match entity "The Ashen Court" → the seeded canon faction;
   *   - one fact under Vael (with an embedding);
   *   - one fact under the faction that SUPERSEDES the seeded live fact;
   *   - a relationship Vael → The Ashen Court;
   *   - a working-set item for Vael carrying parentName = 'The Ashen Court'
   *     (the sub-faction hierarchy signal). */
  function happyPlan(s: Seed): {
    plan: ReconcilePlan
    map: ReadonlyMap<string, SubjectResolution>
    workingSet: readonly WorkingSetItem[]
    factEmbeddings: readonly (readonly number[])[]
  } {
    const plan: ReconcilePlan = {
      entities: [
        {
          op: 'mint',
          subjectName: 'Brother Vael',
          canonEntityId: null,
          name: 'Brother Vael',
          entityType: 'npc',
          accessLevel: 'known',
        },
        {
          op: 'match',
          subjectName: 'The Ashen Court',
          canonEntityId: s.canonFactionId,
          name: 'The Ashen Court',
          entityType: 'faction',
          accessLevel: 'known',
        },
      ],
      facts: [
        {
          subjectName: 'Brother Vael',
          topic: 'role',
          content: 'Brother Vael is the courts confessor.',
          accessLevel: 'known',
          claimedBy: null,
          supersedesFactId: null,
        },
        {
          subjectName: 'The Ashen Court',
          topic: 'leadership',
          content: 'The Ashen Court is led by the Pale Matriarch.',
          accessLevel: 'known',
          claimedBy: null,
          supersedesFactId: s.liveFactId,
        },
      ],
      relationships: [
        {
          fromSubjectName: 'Brother Vael',
          toSubjectName: 'The Ashen Court',
          relationshipType: 'member_of',
          description: 'Brother Vael serves the Ashen Court.',
        },
      ],
    }
    const map = new Map<string, SubjectResolution>([
      ['Brother Vael', { kind: 'mint' }],
      ['The Ashen Court', { kind: 'match', id: s.canonFactionId }],
    ])
    const workingSet: readonly WorkingSetItem[] = [
      wsItem({ subjectName: 'Brother Vael', parentName: 'The Ashen Court' }),
    ]
    // Parallel to plan.facts: embed the first fact, skip the second.
    const factEmbeddings: readonly (readonly number[])[] = [unitEmbedding(0), []]
    return { plan, map, workingSet, factEmbeddings }
  }

  it('commits mint + match + fact append + supersede + embed + relationship + hierarchy + gate', async () => {
    const s = await seed()
    const { plan, map, workingSet, factEmbeddings } = happyPlan(s)

    const result = await applyReconcileCommit(repo, {
      plan,
      map,
      workingSet,
      worldId: s.worldId,
      sessionId: s.sessionId,
      factEmbeddings,
    })
    expect(result).toEqual({ committed: true })

    // 1. The minted entity exists with the session provenance marker.
    const vael = await repo.entities.findByWorldAndName(s.worldId, 'Brother Vael')
    expect(vael).not.toBeNull()
    if (!vael) throw new Error('expected the minted Vael entity')
    expect(vael.entityType).toBe('npc')
    const vaelCreatedIn = await pool.query<{ created_in: string }>(
      `SELECT created_in FROM entities WHERE id = $1`,
      [vael.id],
    )
    expect(vaelCreatedIn.rows[0]?.created_in).toBe(`session:${s.sessionId}`)

    // 2. Live facts under Vael: the appended session fact.
    const vaelFacts = await repo.facts.listByEntities([vael.id], { accessLevels: ['known'] })
    expect(vaelFacts).toHaveLength(1)
    const vaelFact = vaelFacts[0]
    if (!vaelFact) throw new Error('expected Vael fact')
    expect(vaelFact.source).toBe('session')
    expect(vaelFact.content).toBe('Brother Vael is the courts confessor.')

    // 3. The minted fact's embedding was written (the first factEmbeddings entry).
    const vaelFactEmbed = await pool.query<{ embedding: string | null }>(
      `SELECT embedding FROM facts WHERE id = $1`,
      [vaelFact.id],
    )
    expect(vaelFactEmbed.rows[0]?.embedding).not.toBeNull()

    // 4. The supersede: the old live fact now points at the new one + has NULL
    //    embedding; the live read under the faction surfaces only the new fact.
    const factionLive = await repo.facts.listByEntities([s.canonFactionId], {
      accessLevels: ['known'],
    })
    expect(factionLive).toHaveLength(1)
    const newFactionFact = factionLive[0]
    if (!newFactionFact) throw new Error('expected the live faction fact')
    expect(newFactionFact.content).toBe('The Ashen Court is led by the Pale Matriarch.')

    const oldRow = await pool.query<{ superseded_by: string | null; embedding: string | null }>(
      `SELECT superseded_by, embedding FROM facts WHERE id = $1`,
      [s.liveFactId],
    )
    expect(oldRow.rows[0]?.superseded_by).toBe(newFactionFact.id)
    expect(oldRow.rows[0]?.embedding).toBeNull()
    // The second factEmbeddings entry was [] → no embedding written on the new
    // faction fact either.
    const newFactionEmbed = await pool.query<{ embedding: string | null }>(
      `SELECT embedding FROM facts WHERE id = $1`,
      [newFactionFact.id],
    )
    expect(newFactionEmbed.rows[0]?.embedding).toBeNull()

    // 5. The relationship edge (Vael → faction) exists, synth_key NULL.
    const relRow = await pool.query<{ relationship_type: string; synth_key: string | null }>(
      `SELECT relationship_type, synth_key FROM relationships
        WHERE source_entity_id = $1 AND target_entity_id = $2`,
      [vael.id, s.canonFactionId],
    )
    expect(relRow.rows[0]?.relationship_type).toBe('member_of')
    expect(relRow.rows[0]?.synth_key).toBeNull()

    // 6. The hierarchy edge: Vael (child) → faction (parent).
    const hierRow = await pool.query<{ parent_entity_id: string }>(
      `SELECT parent_entity_id FROM entity_hierarchy WHERE child_entity_id = $1`,
      [vael.id],
    )
    expect(hierRow.rows[0]?.parent_entity_id).toBe(s.canonFactionId)

    // 7. Play-marking: both the minted Vael and the matched faction are touched.
    const touched = await pool.query<{ id: string; encountered: boolean; modified_by_play: boolean }>(
      `SELECT id, encountered, modified_by_play FROM entities WHERE id = ANY($1)`,
      [[vael.id, s.canonFactionId]],
    )
    expect(touched.rows).toHaveLength(2)
    for (const row of touched.rows) {
      expect(row.encountered).toBe(true)
      expect(row.modified_by_play).toBe(true)
    }

    // 8. The gate: reconciled_at is now set.
    const sess = await repo.sessions.getById(s.sessionId)
    expect(sess?.reconciledAt).not.toBeNull()
  })

  it('is idempotent: a second commit on an already-reconciled session rolls back, creating no duplicate canon', async () => {
    const s = await seed()
    const { plan, map, workingSet, factEmbeddings } = happyPlan(s)

    const first = await applyReconcileCommit(repo, {
      plan,
      map,
      workingSet,
      worldId: s.worldId,
      sessionId: s.sessionId,
      factEmbeddings,
    })
    expect(first).toEqual({ committed: true })

    // Snapshot row counts after the first (successful) commit.
    const entityCountBefore = await pool.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM entities WHERE world_id = $1`,
      [s.worldId],
    )
    const factCountBefore = await pool.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM facts f
         JOIN entities e ON e.id = f.entity_id WHERE e.world_id = $1`,
      [s.worldId],
    )
    const relCountBefore = await pool.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM relationships r
         JOIN entities e ON e.id = r.source_entity_id WHERE e.world_id = $1`,
      [s.worldId],
    )

    // A second commit on the SAME session — the reconciled_at gate now returns
    // 0 → the whole tx rolls back.
    const second = await applyReconcileCommit(repo, {
      plan,
      map,
      workingSet,
      worldId: s.worldId,
      sessionId: s.sessionId,
      factEmbeddings,
    })
    expect(second).toEqual({ committed: false })

    const entityCountAfter = await pool.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM entities WHERE world_id = $1`,
      [s.worldId],
    )
    const factCountAfter = await pool.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM facts f
         JOIN entities e ON e.id = f.entity_id WHERE e.world_id = $1`,
      [s.worldId],
    )
    const relCountAfter = await pool.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM relationships r
         JOIN entities e ON e.id = r.source_entity_id WHERE e.world_id = $1`,
      [s.worldId],
    )

    expect(entityCountAfter.rows[0]?.n).toBe(entityCountBefore.rows[0]?.n)
    expect(factCountAfter.rows[0]?.n).toBe(factCountBefore.rows[0]?.n)
    expect(relCountAfter.rows[0]?.n).toBe(relCountBefore.rows[0]?.n)
  })

  it('hierarchy is best-effort: skips non-entity items, parentless entities, unresolved parents, and already-parented children', async () => {
    const s = await seed()
    // Two minted entities: a parent faction "Cabal" and a child npc "Acolyte".
    const plan: ReconcilePlan = {
      entities: [
        {
          op: 'mint',
          subjectName: 'Cabal',
          canonEntityId: null,
          name: 'The Cabal',
          entityType: 'faction',
          accessLevel: 'known',
        },
        {
          op: 'mint',
          subjectName: 'Acolyte',
          canonEntityId: null,
          name: 'An Acolyte',
          entityType: 'npc',
          accessLevel: 'known',
        },
      ],
      facts: [],
      relationships: [],
    }
    const map = new Map<string, SubjectResolution>([
      ['Cabal', { kind: 'mint' }],
      ['Acolyte', { kind: 'mint' }],
    ])
    const workingSet: readonly WorkingSetItem[] = [
      // (a) kind !== 'entity' → skipped at the kind guard.
      wsItem({ kind: 'fact', subjectName: 'Acolyte', parentName: 'Cabal' }),
      // (b) entity item with NO parentName → skipped at the parentName guard.
      wsItem({ subjectName: 'Cabal' }),
      // (c) entity item whose parentName resolves to nothing in this plan →
      //     skipped at the resolve guard (best-effort: parent is canon-only).
      wsItem({ subjectName: 'Acolyte', parentName: 'A Parent Not In This Plan' }),
    ]

    const first = await applyReconcileCommit(repo, {
      plan,
      map,
      workingSet,
      worldId: s.worldId,
      sessionId: s.sessionId,
      factEmbeddings: [],
    })
    expect(first).toEqual({ committed: true })

    // No hierarchy edge for Acolyte: its only entity-item parent was unresolved.
    const acolyte = await repo.entities.findByWorldAndName(s.worldId, 'An Acolyte')
    if (!acolyte) throw new Error('expected the minted Acolyte entity')
    const hierAfterFirst = await pool.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM entity_hierarchy WHERE child_entity_id = $1`,
      [acolyte.id],
    )
    expect(hierAfterFirst.rows[0]?.n).toBe('0')

    // (d) already-parented child: parent the Acolyte under the Cabal directly,
    //     then run a SECOND commit (fresh session) whose working set DOES carry
    //     a resolving parentName for the Acolyte. The existing-child guard must
    //     skip it rather than violating UNIQUE(child_entity_id).
    const cabal = await repo.entities.findByWorldAndName(s.worldId, 'The Cabal')
    if (!cabal) throw new Error('expected the minted Cabal entity')
    await repo.entityHierarchy.insert({ parentEntityId: cabal.id, childEntityId: acolyte.id })

    // A fresh campaign for session2 — idx_sessions_one_active permits only one
    // active session per campaign, and seed()'s session is still active.
    const campaign2 = await pool.query<{ id: string }>(
      `INSERT INTO campaigns (id, world_id, created_by, name) VALUES ($1, $2, $3, $4) RETURNING id`,
      [uuidv7(), s.worldId, s.userId, scope.campaignName(1)],
    )
    const campaign2Id = campaign2.rows[0]?.id
    if (!campaign2Id) throw new Error('campaign2 insert returned no id')
    const session2 = await pool.query<{ id: string }>(
      `INSERT INTO sessions (id, campaign_id, session_number, status) VALUES ($1, $2, 1, 'active') RETURNING id`,
      [uuidv7(), campaign2Id],
    )
    const session2Id = session2.rows[0]?.id
    if (!session2Id) throw new Error('session2 insert returned no id')

    // A plan that re-matches both entities and a working set that WOULD parent
    // Acolyte under Cabal — but Acolyte already has a parent, so it's skipped.
    const plan2: ReconcilePlan = {
      entities: [
        {
          op: 'match',
          subjectName: 'Cabal',
          canonEntityId: cabal.id,
          name: 'The Cabal',
          entityType: 'faction',
          accessLevel: 'known',
        },
        {
          op: 'match',
          subjectName: 'Acolyte',
          canonEntityId: acolyte.id,
          name: 'An Acolyte',
          entityType: 'npc',
          accessLevel: 'known',
        },
      ],
      facts: [],
      relationships: [],
    }
    const map2 = new Map<string, SubjectResolution>([
      ['Cabal', { kind: 'match', id: cabal.id }],
      ['Acolyte', { kind: 'match', id: acolyte.id }],
    ])
    const workingSet2: readonly WorkingSetItem[] = [
      wsItem({ subjectName: 'Acolyte', parentName: 'Cabal' }),
    ]

    const second = await applyReconcileCommit(repo, {
      plan: plan2,
      map: map2,
      workingSet: workingSet2,
      worldId: s.worldId,
      sessionId: session2Id,
      factEmbeddings: [],
    })
    expect(second).toEqual({ committed: true })

    // Still exactly one hierarchy row for Acolyte (the manual one) — the commit
    // skipped the duplicate rather than throwing on UNIQUE(child_entity_id).
    const hierAfterSecond = await pool.query<{ parent_entity_id: string }>(
      `SELECT parent_entity_id FROM entity_hierarchy WHERE child_entity_id = $1`,
      [acolyte.id],
    )
    expect(hierAfterSecond.rows).toHaveLength(1)
    expect(hierAfterSecond.rows[0]?.parent_entity_id).toBe(cabal.id)
  })
})
