// backend/src/llm/prep/stages/__tests__/character-integration.test.ts
//
// MYT-54 T10: campaign-scoped character-integration handler. Single Opus
// pass over the whole party, then a single transaction that creates one PC
// entity per player, materializes PC↔world + PC↔PC relationships, writes
// starter facts + prose kernels, flips `character_concepts.status` to
// 'integrated', and flips `campaigns.status` to 'active'.
//
// Mocking pattern lifted from character-sheet.test.ts / coherence-pass.test.ts:
// the AI SDK's `generateText` is the single underlying call (the
// `generateObject` wrapper in our ai.ts delegates to it under the hood with
// Output.object schema). We mock `'ai'`'s `generateText` directly so the
// real prompt rendering + schema parsing path runs in tests.
//
// Real Postgres seed pattern: per-test scope via makeTestScope; cleanup
// removes scope-owned rows after each test and the pool at afterAll.

import { describe, it, expect, vi, beforeAll, beforeEach, afterAll } from 'vitest'
import { fileURLToPath } from 'node:url'
import { resolve } from 'node:path'
import pino, { type DestinationStream } from 'pino'
import type { Pool } from 'pg'
import * as ai from 'ai'
import { guardTestDatabase } from '../../../../db/__tests__/guard-db.js'
import { runMigrations } from '../../../../db/migrate.js'
import { uuidv7 } from '../../../../repo/uuidv7.js'
import {
  cleanupTestScope,
  makeTestScope,
  type TestScope,
} from '../../../../repo/__tests__/_helpers/test-scope.js'
import { createTestPool } from '../../../../repo/__tests__/_helpers/test-pool.js'
import { createRepo } from '../../../../repo/index.js'
import { runCharacterIntegrationStage } from '../character-integration.js'
import { CostCapExceededError } from '../../cost-cap.js'
import { LlmStructuredOutputError } from '../../../errors.js'

vi.mock('ai', async () => {
  const actual = await vi.importActual<typeof import('ai')>('ai')
  return { ...actual, generateText: vi.fn() }
})

const mockGenerateText = vi.mocked(ai.generateText)

const databaseUrl = process.env.DATABASE_URL ?? ''
const here = fileURLToPath(import.meta.url)
const REAL_MIGRATIONS_DIR = resolve(here, '../../../../../../migrations')

function silentLogger(): ReturnType<typeof pino> {
  const sink: DestinationStream = {
    write: () => {
      // discard log output
    },
  }
  return pino(
    { base: { component: 'migrate' }, serializers: { err: pino.stdSerializers.err } },
    sink,
  )
}

// Reusable narrative shape — every seeded PC gets one of these as
// `character_concepts.concept_output` JSONB.
function makeNarrative(name: string): Record<string, unknown> {
  return {
    name,
    race: 'human',
    class: 'cleric',
    background: 'acolyte',
    level: 1,
    alignment: 'lawful neutral',
    age: 27,
    gender: 'man',
    physical_description:
      `A weather-worn ${name.toLowerCase()} with the bearing of someone who has walked too many roads alone in a country that has long since stopped remembering them.`,
    personality_traits: ['speaks in measured tones', 'pauses before answering'],
    ideals: ['order serves the weak'],
    bonds: ['the temple that raised them'],
    flaws: ['quick to suspect deception'],
    backstory:
      'Apprenticed at the Bone Sept in their twelfth year, when the priests took them in after a winter on the moors orphaned them. Twenty years later, when the Sept burned, they walked out with a tin ladle and a name they were no longer sure was theirs. They have been on the road since, doing temple work for coin, telling themselves they are still a cleric of the Hollow, listening for the small voice that used to answer them at the altar.',
  }
}

// Small array-access helper — eslint forbids non-null assertions, and
// every test that picks `userIds[N]` from a known-length seed needs a
// safe narrow.
function at<T>(arr: readonly T[], i: number): T {
  const v = arr[i]
  if (v === undefined) throw new Error(`array index ${String(i)} is out of bounds`)
  return v
}

// The Vercel AI SDK's generateText returns a wide shape; tests need only
// `output` (the parsed object), `finishReason`, and `usage`. Cast to `never`
// at the call site — matches the established peer-test convention.
function generateTextMockReturn(payload: unknown): never {
  return {
    output: payload,
    finishReason: 'stop',
    usage: { inputTokens: 2000, outputTokens: 1000, totalTokens: 3000 },
  } as never
}

interface SeedResult {
  readonly campaignId: string
  readonly worldId: string
  readonly ownerUserId: string
  readonly userIds: readonly string[]
  readonly locationId: string
  readonly factionId: string
}

// Helper to clean characters scoped to a TestScope's users — characters.user_id
// is RESTRICT-FK, must precede the scope user delete (myth-5jdo).
async function cleanupCharactersFor(p: Pool, scope: TestScope): Promise<void> {
  await p.query(
    `DELETE FROM characters
       WHERE user_id IN (SELECT id FROM users WHERE cognito_sub LIKE $1)`,
    [`${scope.id}%`],
  )
  await cleanupTestScope(p, scope)
}

describe('runCharacterIntegrationStage (MYT-54)', () => {
  let pool: Pool
  let scope: TestScope
  let userCounter = 0

  beforeAll(async () => {
    await guardTestDatabase(databaseUrl)
    pool = createTestPool(databaseUrl)
    await runMigrations({
      pool,
      migrationsDir: REAL_MIGRATIONS_DIR,
      logger: silentLogger(),
    })
    scope = makeTestScope('charint54')
  })

  afterAll(async () => {
    await cleanupCharactersFor(pool, scope)
    await pool.end()
  })

  beforeEach(async () => {
    vi.clearAllMocks()
    await cleanupCharactersFor(pool, scope)
  })

  async function seed(partySize: number): Promise<SeedResult> {
    const worldId = uuidv7()
    const campaignId = uuidv7()
    const locationId = uuidv7()
    const factionId = uuidv7()
    const userIds: string[] = []

    // First member is the owner.
    const ownerUserId = uuidv7()
    userIds.push(ownerUserId)
    await pool.query(
      `INSERT INTO users (id, cognito_sub, display_name, username)
       VALUES ($1, $2, $3, $4)`,
      [
        ownerUserId,
        scope.userSub(userCounter),
        scope.displayName(userCounter),
        scope.username(userCounter),
      ],
    )
    userCounter += 1

    for (let i = 1; i < partySize; i += 1) {
      const uid = uuidv7()
      userIds.push(uid)
      await pool.query(
        `INSERT INTO users (id, cognito_sub, display_name, username)
         VALUES ($1, $2, $3, $4)`,
        [
          uid,
          scope.userSub(userCounter),
          scope.displayName(userCounter),
          scope.username(userCounter),
        ],
      )
      userCounter += 1
    }

    await pool.query(
      `INSERT INTO worlds (
         id, created_by, name, concept, status,
         starting_situation_entries, vocabulary_registry
       )
       VALUES ($1, $2, $3, 'C', 'complete', $4::jsonb, $5::jsonb)`,
      [
        worldId,
        ownerUserId,
        scope.worldName(userCounter),
        JSON.stringify([
          {
            index: 0,
            locationEntityId: locationId,
            prose: 'The party gathers at The Tavern as the storm breaks.',
          },
        ]),
        JSON.stringify({ entries: [], adjacent_franchises: [] }),
      ],
    )
    await pool.query(
      `INSERT INTO campaigns (id, world_id, created_by, name, status, starting_situation_index)
       VALUES ($1, $2, $3, $4, 'setup', 0)`,
      [campaignId, worldId, ownerUserId, scope.campaignName(userCounter)],
    )

    // Owner is the first member, role 'owner'; others 'player'.
    for (const [i, uid] of userIds.entries()) {
      await pool.query(
        `INSERT INTO campaign_members (id, campaign_id, user_id, role, invite_accepted)
         VALUES ($1, $2, $3, $4, true)`,
        [uuidv7(), campaignId, uid, i === 0 ? 'owner' : 'player'],
      )
    }

    // World entities: one location and one faction the LLM can reference.
    await pool.query(
      `INSERT INTO entities (id, world_id, entity_type, name, access_level)
       VALUES ($1, $2, 'location', 'The Tavern', 'known')`,
      [locationId, worldId],
    )
    await pool.query(
      `INSERT INTO entities (id, world_id, entity_type, name, access_level)
       VALUES ($1, $2, 'faction', 'Bone Sept', 'known')`,
      [factionId, worldId],
    )

    // One completed character_concepts + characters row per party member.
    for (const [i, uid] of userIds.entries()) {
      const characterId = uuidv7()
      await pool.query(
        `INSERT INTO character_concepts (
           id, campaign_id, user_id, concept_text, situation_grounding_text,
           status, concept_output
         )
         VALUES ($1, $2, $3, $4, $5, 'completed', $6::jsonb)`,
        [
          uuidv7(),
          campaignId,
          uid,
          `A cleric concept for player ${String(i)} drawn from the bone sept tradition.`,
          `Arrived at The Tavern through the autumn storms for player ${String(i)}.`,
          JSON.stringify(makeNarrative(`Player${String(i)}`)),
        ],
      )
      await pool.query(
        `INSERT INTO characters (
           id, user_id, name, level, class, species, background,
           str, dex, con, int, wis, cha,
           hit_points, max_hit_points, armor_class, proficiency_bonus
         )
         VALUES ($1, $2, $3, 1, 'cleric', 'human', 'acolyte',
                 12, 10, 14, 13, 16, 11, 9, 9, 14, 2)`,
        [characterId, uid, `Player${String(i)}`],
      )
      await pool.query(
        `INSERT INTO campaign_characters (id, campaign_id, character_id, user_id)
         VALUES ($1, $2, $3, $4)`,
        [uuidv7(), campaignId, characterId, uid],
      )
    }

    return { campaignId, worldId, ownerUserId, userIds, locationId, factionId }
  }

  it('writes PC entities + facts + relationships + flips campaign to active (happy 3-PC)', async () => {
    const { campaignId, ownerUserId, userIds, factionId } = await seed(3)
    const secondUserId = at(userIds, 1)

    mockGenerateText.mockResolvedValueOnce(
      generateTextMockReturn({
        characters: userIds.map((uid, i) => ({
          userId: uid,
          displayName: `Player${String(i)}`,
          entity: {
            name: `PC ${String(i)}`,
            proseKernel:
              `Player${String(i)} is a cleric who came down from the northern hills to serve at the temple that raised them, carrying a sept-mark on their hand.`,
          },
          facts: [
            {
              content: `Player${String(i)} was raised at the Bone Sept and bears its faded mark.`,
              tags: ['origin'],
              aboutEntityId: null,
            },
          ],
          relationships:
            i === 0
              ? [
                  {
                    targetKind: 'pc' as const,
                    targetUserId: secondUserId,
                    type: 'sibling_of',
                    description:
                      'They are siblings, raised together at the Bone Sept before the burning.',
                  },
                  {
                    targetKind: 'faction' as const,
                    targetId: factionId,
                    type: 'apprenticed_at',
                    description:
                      'Apprenticed at the Bone Sept in their twelfth year before the burning.',
                  },
                ]
              : [],
        })),
      }),
    )

    const result = await runCharacterIntegrationStage(createRepo(pool), {
      campaignId,
      ownerUserId,
    })

    expect(result.characterIds).toHaveLength(3)
    expect(result.llmCostUsd).toBeGreaterThan(0)

    const { rows: campRows } = await pool.query<{ status: string }>(
      `SELECT status FROM campaigns WHERE id = $1`,
      [campaignId],
    )
    expect(campRows[0]?.status).toBe('active')

    const { rows: pcRows } = await pool.query<{ id: string }>(
      `SELECT id FROM entities WHERE world_id = (SELECT world_id FROM campaigns WHERE id = $1) AND entity_type = 'pc'`,
      [campaignId],
    )
    expect(pcRows).toHaveLength(3)

    // PC↔PC sibling edge from player 0 to player 1 + worker-mirrored edge
    // from player 1 to player 0 + the player-0 → faction edge = 3 total.
    const { rows: relRows } = await pool.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM relationships
         WHERE source_entity_id IN (SELECT id FROM entities WHERE entity_type = 'pc'
                                       AND world_id = (SELECT world_id FROM campaigns WHERE id = $1))`,
      [campaignId],
    )
    expect(Number(relRows[0]?.count)).toBeGreaterThanOrEqual(3)

    // character_concepts all flipped to integrated.
    const { rows: concRows } = await pool.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM character_concepts
         WHERE campaign_id = $1 AND status = 'integrated'`,
      [campaignId],
    )
    expect(Number(concRows[0]?.count)).toBe(3)

    // characters.entity_id populated for every PC. Resolve characters via
    // campaign_characters join (characters.campaign_id was dropped in
    // migration 009).
    const { rows: chRows } = await pool.query<{ entity_id: string | null }>(
      `SELECT ch.entity_id
         FROM characters ch
         JOIN campaign_characters cc ON cc.character_id = ch.id
        WHERE cc.campaign_id = $1`,
      [campaignId],
    )
    expect(chRows).toHaveLength(3)
    for (const r of chRows) {
      expect(r.entity_id).not.toBeNull()
    }

    // prose_kernels written for every PC entity.
    const { rows: pkRows } = await pool.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM prose_kernels
         WHERE entity_id IN (SELECT id FROM entities WHERE entity_type = 'pc'
                                       AND world_id = (SELECT world_id FROM campaigns WHERE id = $1))`,
      [campaignId],
    )
    expect(Number(pkRows[0]?.count)).toBe(3)
  })

  it('throws LlmStructuredOutputError when characters.length !== party.length', async () => {
    const { campaignId, ownerUserId } = await seed(3)

    mockGenerateText.mockResolvedValueOnce(
      generateTextMockReturn({
        characters: [], // wrong count — schema requires >=1 so we need a single-entry
      }),
    )
    // The schema enforces `characters.length >= 1`, so an empty array fails
    // at parse time → repair attempts → final LlmStructuredOutputError.
    // For a length-mismatch invariant where the count is wrong but non-zero,
    // we mock a 1-entry response against a 3-PC party.
    mockGenerateText.mockReset()
    mockGenerateText.mockResolvedValue(
      generateTextMockReturn({
        characters: [
          {
            userId: uuidv7(), // doesn't match any party member either
            displayName: 'Solo',
            entity: {
              name: 'Solo PC',
              proseKernel:
                'A solo entry where the LLM returned only one character for a three-PC party — this should trip the worker-side invariant after schema parse succeeds.',
            },
            facts: [
              {
                content:
                  'Some self-fact for the solo PC describing why they exist.',
                tags: ['origin'],
                aboutEntityId: null,
              },
            ],
            relationships: [],
          },
        ],
      }),
    )

    await expect(
      runCharacterIntegrationStage(createRepo(pool), { campaignId, ownerUserId }),
    ).rejects.toBeInstanceOf(LlmStructuredOutputError)
  })

  it('throws CostCapExceededError when running estimate would exceed character_creation_cost_cap_usd', async () => {
    const { campaignId, ownerUserId } = await seed(3)

    // Pre-load completed runs that already total $4.99 against a $5.00 cap.
    await pool.query(
      `INSERT INTO pipeline_runs (id, campaign_id, stage, status, cost_usd, user_id)
       VALUES ($1, $2, 'character_concept', 'completed', 4.99, NULL)`,
      [uuidv7(), campaignId],
    )

    await expect(
      runCharacterIntegrationStage(createRepo(pool), { campaignId, ownerUserId }),
    ).rejects.toBeInstanceOf(CostCapExceededError)
    // LLM must NOT have been called once the cap is exhausted.
    expect(mockGenerateText).not.toHaveBeenCalled()
  })

  it('drops unknown targetId in relationships and logs (does not fail)', async () => {
    const { campaignId, ownerUserId, userIds } = await seed(1)

    mockGenerateText.mockResolvedValueOnce(
      generateTextMockReturn({
        characters: [
          {
            userId: at(userIds, 0),
            displayName: 'Solo',
            entity: {
              name: 'Solo PC',
              proseKernel:
                'A solo PC integration test fixture whose only emitted relationship points at a UUID the world dump does not contain, which the worker should silently drop.',
            },
            facts: [
              {
                content:
                  'A self-fact describing why this solo PC came to the tavern in the storm.',
                tags: ['origin'],
                aboutEntityId: null,
              },
            ],
            relationships: [
              {
                targetKind: 'npc' as const,
                targetId: '019eeeee-0000-0000-0000-deadbeefdead',
                type: 'mentor_of',
                description:
                  'A relationship the LLM invented for an NPC the world dump does not contain.',
              },
            ],
          },
        ],
      }),
    )

    const result = await runCharacterIntegrationStage(createRepo(pool), {
      campaignId,
      ownerUserId,
    })

    expect(result.characterIds).toHaveLength(1)
    const { rows: relRows } = await pool.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM relationships
         WHERE source_entity_id = $1`,
      [result.characterIds[0]],
    )
    expect(Number(relRows[0]?.count)).toBe(0)
  })

  it('mirrors PC↔PC relationships when only one side was emitted by the LLM', async () => {
    const { campaignId, ownerUserId, userIds } = await seed(2)

    mockGenerateText.mockResolvedValueOnce(
      generateTextMockReturn({
        characters: [
          {
            userId: at(userIds, 0),
            displayName: 'Ada',
            entity: {
              name: 'Ada',
              proseKernel:
                'Ada is the elder sibling, raised at the Bone Sept before the burning and now wandering the wet roads searching for word of her brother.',
            },
            facts: [
              {
                content: 'Ada is the elder of the two siblings from the Bone Sept.',
                tags: ['family'],
                aboutEntityId: null,
              },
            ],
            relationships: [
              {
                targetKind: 'pc' as const,
                targetUserId: at(userIds, 1),
                type: 'sibling_of',
                description: 'Older sibling of Ben; raised together at the Bone Sept.',
              },
            ],
          },
          {
            userId: at(userIds, 1),
            displayName: 'Ben',
            entity: {
              name: 'Ben',
              proseKernel:
                'Ben is the younger sibling, equally a cleric of the Hollow but more given to suspicion of strangers and the silences between songs.',
            },
            facts: [
              {
                content: 'Ben is the younger of the two siblings from the Bone Sept.',
                tags: ['family'],
                aboutEntityId: null,
              },
            ],
            relationships: [], // LLM emitted the edge only on Ada's side
          },
        ],
      }),
    )

    await runCharacterIntegrationStage(createRepo(pool), { campaignId, ownerUserId })

    const { rows: pcEntityRows } = await pool.query<{ id: string; name: string }>(
      `SELECT id, name FROM entities
         WHERE entity_type = 'pc'
           AND world_id = (SELECT world_id FROM campaigns WHERE id = $1)`,
      [campaignId],
    )
    expect(pcEntityRows).toHaveLength(2)
    const adaEntity = pcEntityRows.find((r) => r.name === 'Ada')
    const benEntity = pcEntityRows.find((r) => r.name === 'Ben')
    if (adaEntity === undefined || benEntity === undefined) {
      throw new Error('PC entities missing for Ada/Ben after integration')
    }

    const { rows: relRows } = await pool.query<{
      source_entity_id: string
      target_entity_id: string
      relationship_type: string
    }>(
      `SELECT source_entity_id, target_entity_id, relationship_type
         FROM relationships
        WHERE source_entity_id = ANY($1::uuid[])`,
      [pcEntityRows.map((r) => r.id)],
    )
    expect(relRows).toHaveLength(2)
    const adaToBen = relRows.find(
      (r) => r.source_entity_id === adaEntity.id && r.target_entity_id === benEntity.id,
    )
    const benToAda = relRows.find(
      (r) => r.source_entity_id === benEntity.id && r.target_entity_id === adaEntity.id,
    )
    expect(adaToBen).toBeDefined()
    expect(benToAda).toBeDefined()
    // Same edge type on both sides (mirror).
    expect(benToAda?.relationship_type).toBe('sibling_of')
  })

  it('writes newFacts to existing world entities', async () => {
    const { campaignId, ownerUserId, userIds, worldId } = await seed(1)

    // Seed one extra world NPC entity that the LLM will add a fact to.
    const npcId = uuidv7()
    await pool.query(
      `INSERT INTO entities (id, world_id, entity_type, name, access_level)
       VALUES ($1, $2, 'npc', $3, 'known')`,
      [npcId, worldId, `${scope.id}-Ranulf`],
    )

    mockGenerateText.mockResolvedValueOnce(
      generateTextMockReturn({
        characters: [
          {
            userId: at(userIds, 0),
            displayName: 'Solo',
            entity: {
              name: 'Solo PC',
              proseKernel:
                'A solo PC whose backstory adds a small fact to an existing NPC the world dump already knows about.',
            },
            facts: [
              {
                content:
                  'A self-fact about why this PC sought out Ranulf in the first place.',
                tags: ['origin'],
                aboutEntityId: null,
              },
            ],
            relationships: [],
          },
        ],
        newFacts: [
          {
            entityId: npcId,
            content:
              "Ranulf still has the woolen scarf this PC's mother knitted him before she died.",
            tags: ['backstory'],
          },
        ],
      }),
    )

    await runCharacterIntegrationStage(createRepo(pool), { campaignId, ownerUserId })

    const { rows: npcFactRows } = await pool.query<{ content: string }>(
      `SELECT content FROM facts WHERE entity_id = $1`,
      [npcId],
    )
    expect(npcFactRows).toHaveLength(1)
    expect(npcFactRows[0]?.content).toContain('woolen scarf')
  })

  it('disambiguates PC entity names when two PCs collide on entity.name', async () => {
    const { campaignId, ownerUserId, userIds, worldId } = await seed(2)

    mockGenerateText.mockResolvedValueOnce(
      generateTextMockReturn({
        characters: userIds.map((userId) => ({
          userId,
          displayName: 'Marik',
          entity: {
            name: 'Marik',  // same name for both — collides on entities(world_id, name)
            proseKernel:
              'Two PCs both want to be named Marik. The worker must disambiguate post-LLM by appending a userId-fragment suffix.',
          },
          facts: [
            {
              content: 'Both Mariks have a long-standing rivalry over the same name.',
              tags: ['backstory'],
              aboutEntityId: null,
            },
          ],
          relationships: [],
        })),
      }),
    )

    await runCharacterIntegrationStage(createRepo(pool), { campaignId, ownerUserId })

    const { rows: pcRows } = await pool.query<{ id: string; name: string }>(
      `SELECT id, name FROM entities WHERE entity_type = 'pc' AND world_id = $1`,
      [worldId],
    )
    expect(pcRows).toHaveLength(2)
    // Both names start with 'Marik' but differ (suffix disambiguation).
    const names = pcRows.map((r) => r.name).sort()
    expect(names[0]).toMatch(/^Marik/)
    expect(names[1]).toMatch(/^Marik/)
    expect(names[0]).not.toBe(names[1])
  })

  it('drops unknown targetUserId in PC↔PC relationships and logs', async () => {
    const { campaignId, ownerUserId, userIds } = await seed(1)

    mockGenerateText.mockResolvedValueOnce(
      generateTextMockReturn({
        characters: [
          {
            userId: at(userIds, 0),
            displayName: 'Solo',
            entity: {
              name: 'Solo PC',
              proseKernel:
                'A solo PC whose emitted PC↔PC relationship points at a userId not in the party set.',
            },
            facts: [
              {
                content: 'A self-fact for the dropped-pc-userId coverage test.',
                tags: ['origin'],
                aboutEntityId: null,
              },
            ],
            relationships: [
              {
                targetKind: 'pc' as const,
                targetUserId: '019eeeee-0000-0000-0000-ffffffffffff',
                type: 'rival_of',
                description: 'A PC↔PC rivalry that points at a userId not in this party.',
              },
            ],
          },
        ],
      }),
    )

    const result = await runCharacterIntegrationStage(createRepo(pool), { campaignId, ownerUserId })

    expect(result.characterIds).toHaveLength(1)
    const { rows: relRows } = await pool.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM relationships WHERE source_entity_id = $1`,
      [result.characterIds[0]],
    )
    expect(Number(relRows[0]?.count)).toBe(0)
  })

  it('drops newFacts with unknown entityId and logs', async () => {
    const { campaignId, ownerUserId, userIds } = await seed(1)

    mockGenerateText.mockResolvedValueOnce(
      generateTextMockReturn({
        characters: [
          {
            userId: at(userIds, 0),
            displayName: 'Solo',
            entity: {
              name: 'Solo PC',
              proseKernel:
                'A solo PC whose newFacts entry points at an entity UUID the world dump does not contain.',
            },
            facts: [
              {
                content: 'A self-fact for the dropped-newFacts coverage test.',
                tags: ['origin'],
                aboutEntityId: null,
              },
            ],
            relationships: [],
          },
        ],
        newFacts: [
          {
            entityId: '019eeeee-0000-0000-0000-cccccccccccc',
            content: 'A fact the LLM invented for an entity the world dump does not contain.',
            tags: ['backstory'],
          },
        ],
      }),
    )

    await runCharacterIntegrationStage(createRepo(pool), { campaignId, ownerUserId })

    // Verify NO facts.entity_id matches the hallucinated UUID.
    const { rows: factRows } = await pool.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM facts WHERE entity_id = $1`,
      ['019eeeee-0000-0000-0000-cccccccccccc'],
    )
    expect(Number(factRows[0]?.count)).toBe(0)
  })
})
