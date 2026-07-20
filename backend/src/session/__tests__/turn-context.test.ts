// myth-dwyuw — integration tests for `augmentFtContextWithEntityCards`, the
// DB-backed entity-card injector. The pure matching rules are covered in
// entity-card-scan.test.ts; here we exercise the tiered reads against a real DB.
//
// THE MOST IMPORTANT TEST in this file is the enforced-ignorance regression:
// when a canon entity has facts at KNOWN + DISCOVERABLE + SECRET tiers, only the
// KNOWN facts may ever reach the FT's context. Enforced ignorance is a hard
// boundary, not a prompting suggestion.
//
// The guard/fail-soft arms (worldId '', no rows, repo throw) use fakes — no DB.

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import type { Pool } from 'pg'
import { guardTestDatabase } from '../../db/__tests__/guard-db.js'
import { uuidv7 } from '../../repo/uuidv7.js'
import { entities } from '../../repo/entities.js'
import { facts } from '../../repo/facts.js'
import { createUsersRepo } from '../../repo/users.js'
import { createWorldsRepo } from '../../repo/worlds.js'
import { createCampaignsRepo } from '../../repo/campaigns.js'
import { createSessionsRepo } from '../../repo/sessions.js'
import { createRepo, type Repo } from '../../repo/index.js'
import { cleanupTestScope, makeTestScope, type TestScope } from '../../repo/__tests__/_helpers/test-scope.js'
import { createTestPool } from '../../repo/__tests__/_helpers/test-pool.js'
import { augmentFtContextWithEntityCards, type EntityCardRepo } from '../turn-context.js'

const databaseUrl = process.env.DATABASE_URL ?? ''

describe('augmentFtContextWithEntityCards (integration)', () => {
  let pool: Pool
  let repo: Repo
  let scope: TestScope
  let userId: string
  let worldId: string
  let sessionId: string

  beforeAll(async () => {
    await guardTestDatabase(databaseUrl)
    pool = createTestPool(databaseUrl)
    repo = createRepo(pool)
    scope = makeTestScope('turn-context-cards')
  })

  afterAll(async () => {
    await cleanupTestScope(pool, scope)
    await pool.end()
  })

  beforeEach(async () => {
    await cleanupTestScope(pool, scope)
    const users = createUsersRepo(pool)
    const worlds = createWorldsRepo(pool)
    const campaigns = createCampaignsRepo(pool)
    const sessions = createSessionsRepo(pool)

    const owner = await users.create(pool, {
      cognitoSub: scope.userSub(0),
      username: scope.username(0),
      displayName: scope.displayName(0),
    })
    userId = owner.id
    const world = await worlds.create({ createdBy: userId, name: scope.worldName(0), concept: 'Rivermoot.' })
    worldId = world.id
    const campaign = await campaigns.create({ worldId, createdBy: userId, name: scope.campaignName(0) })
    const session = await sessions.create({ campaignId: campaign.id, sessionNumber: 1 })
    sessionId = session.id
  })

  // Seed the canon entity graph the Roud live case describes.
  async function seedRivermoot(): Promise<{ roudId: string }> {
    const roudId = uuidv7()
    const houseId = uuidv7()
    const wardenId = uuidv7() // SECRET entity — must never be injected
    const pcId = uuidv7() // a PC — grounded elsewhere, must be dropped
    const traskId = uuidv7() // single-token name — never matches

    await entities.insert(pool, { id: roudId, worldId, entityType: 'npc', name: 'Captain Marsen Roud', accessLevel: 'known', createdIn: 'stage:test' })
    await entities.insert(pool, { id: houseId, worldId, entityType: 'faction', name: 'House Eyrin', accessLevel: 'known', createdIn: 'stage:test' })
    await entities.insert(pool, { id: wardenId, worldId, entityType: 'npc', name: 'The Cellar Warden', accessLevel: 'secret', createdIn: 'stage:test' })
    // 'pc' is not an InsertEntityInput.entityType — insertPc bakes in type='pc'/access='known'.
    await repo.entities.insertPc({ id: pcId, worldId, name: 'Aldous Finch' })
    await entities.insert(pool, { id: traskId, worldId, entityType: 'npc', name: 'Trask', accessLevel: 'known', createdIn: 'stage:test' })

    await facts.insertMany(pool, [
      // Roud — the KNOWN fact that fixes the gender-invention bug…
      { entityId: roudId, topic: 'standing', accessLevel: 'known', content: 'She is a leading candidate for the harbormaster seat, a slow-water riverwoman with a spotless record.' },
      // …plus higher-tier facts that must NEVER surface in an FT card.
      { entityId: roudId, topic: 'ties', accessLevel: 'discoverable', content: 'She quietly moves cargo for the Unchalked after dark.' },
      { entityId: roudId, topic: 'plot', accessLevel: 'secret', content: 'She has been bribed to lose the harbor ledger before the audit.' },
      { entityId: houseId, topic: 'about', accessLevel: 'known', content: 'A merchant house that controls the upriver tolls.' },
      { entityId: wardenId, topic: 'plot', accessLevel: 'secret', content: 'Keeps the smuggled crates beneath the customs house.' },
    ])
    return { roudId }
  }

  // The canon mention arrives in DM narration (an NPC speaking a name) — the
  // realistic shape of the live bug. Included in the FT read regardless of the
  // player watermark.
  async function appendMention(text: string, seq: number): Promise<void> {
    await repo.sessionMessages.appendDmTurn({
      sessionId,
      turnId: uuidv7(),
      rows: [{ kind: 'dm_text', content: text }],
      seqs: [seq],
      triggerKind: 'auto',
    })
  }

  it('injects the KNOWN card for a canon NPC named mid-scene, preserving the base', async () => {
    await seedRivermoot()
    await appendMention("Trask leaned in. 'Marsen Roud brought me the charter,' he said.", 1)

    const base = '[prep context for the FT]'
    const out = await augmentFtContextWithEntityCards(repo, { worldId, sessionId, maxConsumedSeq: 5, baseFtContext: base })

    expect(out.startsWith(base)).toBe(true)
    expect(out).toContain('- Captain Marsen Roud (npc):')
    expect(out).toContain('leading candidate for the harbormaster seat')
  })

  it('ENFORCED IGNORANCE: never leaks discoverable/secret facts of a matched entity', async () => {
    await seedRivermoot()
    await appendMention("'Marsen Roud brought me the charter,' Trask said.", 1)

    const out = await augmentFtContextWithEntityCards(repo, { worldId, sessionId, maxConsumedSeq: 5, baseFtContext: 'base' })

    // KNOWN fact present…
    expect(out).toContain('leading candidate for the harbormaster seat')
    // …DISCOVERABLE + SECRET facts of the SAME entity absent.
    expect(out).not.toContain('Unchalked after dark')
    expect(out).not.toContain('bribed to lose the harbor ledger')
  })

  it('ENFORCED IGNORANCE: a SECRET-tier entity named by name is never carded', async () => {
    await seedRivermoot()
    // The secret Cellar Warden is spoken by name — it must not be matched at all.
    await appendMention('Behind them, the Cellar Warden watched from the dark.', 1)

    const out = await augmentFtContextWithEntityCards(repo, { worldId, sessionId, maxConsumedSeq: 5, baseFtContext: 'base' })

    expect(out).toBe('base') // no card block appended
    expect(out).not.toContain('Cellar Warden')
    expect(out).not.toContain('smuggled crates')
  })

  it('drops PCs and single-token names from injection', async () => {
    await seedRivermoot()
    await appendMention('Aldous Finch and Trask both spoke at once.', 1)

    const out = await augmentFtContextWithEntityCards(repo, { worldId, sessionId, maxConsumedSeq: 5, baseFtContext: 'base' })

    // Aldous Finch is a PC (grounded via roster/ledger); Trask is single-token.
    expect(out).toBe('base')
  })

  it('does NOT duplicate a card for an entity already grounded in the base ft_context', async () => {
    await seedRivermoot()
    await appendMention("'Marsen Roud brought me the charter,' Trask said.", 1)

    // The prep doc already names Roud → she must not be re-carded (idempotent).
    const base = 'Rivermoot. Captain Marsen Roud oversees the slow-water docks.'
    const out = await augmentFtContextWithEntityCards(repo, { worldId, sessionId, maxConsumedSeq: 5, baseFtContext: base })

    expect(out).toBe(base) // unchanged — no appended block
  })

  it('injects several matched entities in one block', async () => {
    await seedRivermoot()
    await appendMention('A writ from House Eyrin passed to Marsen Roud at the rail.', 1)

    const out = await augmentFtContextWithEntityCards(repo, { worldId, sessionId, maxConsumedSeq: 5, baseFtContext: 'base' })

    expect(out).toContain('- Captain Marsen Roud (npc):')
    expect(out).toContain('- House Eyrin (faction):')
    expect(out).toContain('controls the upriver tolls')
  })

  it('returns the base unchanged when no canon name appears', async () => {
    await seedRivermoot()
    await appendMention('The tavern was quiet; rain ticked on the shutters.', 1)

    const out = await augmentFtContextWithEntityCards(repo, { worldId, sessionId, maxConsumedSeq: 5, baseFtContext: 'base' })
    expect(out).toBe('base')
  })

  // ── guard / fail-soft arms (fakes, no DB) ──────────────────────────────────

  it('returns the base unchanged for an empty worldId (no lookup)', async () => {
    const neverCalled: EntityCardRepo = {
      sessionMessages: { listFtContextRows: () => Promise.reject(new Error('should not read')) },
      entities: { listByWorld: () => Promise.reject(new Error('should not read')) },
      facts: { listByEntities: () => Promise.reject(new Error('should not read')) },
    }
    const out = await augmentFtContextWithEntityCards(neverCalled, { worldId: '', sessionId: 's', maxConsumedSeq: 0, baseFtContext: 'base' })
    expect(out).toBe('base')
  })

  it('fail-soft: a repo throw degrades to the base ft_context, never crashes', async () => {
    const warns: unknown[] = []
    const throwing: EntityCardRepo = {
      sessionMessages: { listFtContextRows: () => Promise.reject(new Error('db down')) },
      entities: { listByWorld: () => Promise.resolve([]) },
      facts: { listByEntities: () => Promise.resolve([]) },
    }
    const out = await augmentFtContextWithEntityCards(
      throwing,
      { worldId: 'w', sessionId: 's', maxConsumedSeq: 0, baseFtContext: 'base' },
      { warn: (o) => warns.push(o) },
    )
    expect(out).toBe('base')
    expect(warns).toHaveLength(1)
  })

  it('returns the base unchanged when the transcript window is empty', async () => {
    const emptyRows: EntityCardRepo = {
      sessionMessages: { listFtContextRows: () => Promise.resolve([]) },
      entities: { listByWorld: () => Promise.reject(new Error('should not read')) },
      facts: { listByEntities: () => Promise.reject(new Error('should not read')) },
    }
    const out = await augmentFtContextWithEntityCards(emptyRows, { worldId: 'w', sessionId: 's', maxConsumedSeq: 0, baseFtContext: 'base' })
    expect(out).toBe('base')
  })
})
