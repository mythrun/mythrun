// Per MYT-52 T12 / design §3.6 + §D5. Stage 7 non-streaming handler.
// Mocks `ai` + pg pool/client + ioredis publish.

import type { Pool } from 'pg'
import type { Redis } from 'ioredis'
import type pino from 'pino'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { generateText } from 'ai'
import { runCoherencePassStage } from '../coherence-pass.js'

vi.mock('ai', async (importOriginal) => {
  const actual = await importOriginal<typeof import('ai')>()
  return {
    ...actual,
    generateText: vi.fn(),
    Output: { object: vi.fn((opts: unknown) => opts) },
  }
})

const mockGenerateText = vi.mocked(generateText)

interface ParsedEvent {
  type: string
  synthKey?: string
  patch?: { prose?: string; name?: string }
  reason?: string
  relationship?: string
  description?: string
  phase?: string
  from?: string
  to?: string
}

function parsedPayloads(redis: RedisSpy): ParsedEvent[] {
  return redis.publish.mock.calls.map((call): ParsedEvent => {
    const raw: unknown = call[1]
    return JSON.parse(String(raw)) as ParsedEvent
  })
}

const WORLD_ID = '00000000-0000-0000-0000-00000000aaaa'
const CAMPAIGN_ID = '00000000-0000-0000-0000-00000000bbbb'
const USER_ID = '00000000-0000-0000-0000-00000000cccc'

// UUIDs used in fixtures. Held as constants so the tests can assert
// exact SQL parameter strings without typos.
const ENTITY_A = '11111111-1111-1111-1111-111111111111'
const ENTITY_B = '22222222-2222-2222-2222-222222222222'
const ENTITY_C = '33333333-3333-3333-3333-333333333333'
const FACT_X = '44444444-4444-4444-4444-444444444444'
const REL_R = '55555555-5555-5555-5555-555555555555'
const REL_S = '66666666-6666-6666-6666-666666666666'
const UNKNOWN_ENTITY = '99999999-9999-9999-9999-999999999999'
const UNKNOWN_FACT = '99999999-9999-9999-9999-99999999fff0'
const UNKNOWN_REL = '99999999-9999-9999-9999-99999999fff1'

// SynthKeys minted by stages 2/3/4 for those entities/rels. Stage 7
// resolves entityId → synthKey via the supplied map.
const SYNTH = {
  [ENTITY_A]: 'world_and_factions/regions/0',
  [ENTITY_B]: 'locations_and_npcs/npcs/0',
  [ENTITY_C]: 'locations_and_npcs/locations/0',
  [REL_R]: 'entity_relationships/edges/0',
  [REL_S]: 'entity_relationships/edges/1',
}

interface ClientSpy {
  query: ReturnType<typeof vi.fn>
  release: ReturnType<typeof vi.fn>
}
interface PoolSpy {
  connect: ReturnType<typeof vi.fn>
  query: ReturnType<typeof vi.fn>
}
interface RedisSpy {
  publish: ReturnType<typeof vi.fn>
}
interface LoggerSpy {
  warn: ReturnType<typeof vi.fn>
  info: ReturnType<typeof vi.fn>
}

// Adapter casts — spies are structurally compatible with the Pick<>
// surface the handler uses; cast at the call site to keep tests typed.
const asPool = (s: PoolSpy): Pool => s as unknown as Pool
const asRedis = (s: RedisSpy): Redis => s as unknown as Redis
const asLogger = (s: LoggerSpy): pino.Logger => s as unknown as pino.Logger

// SELECTs return canned world inventory; UPDATE/DELETE/BEGIN/COMMIT are spied.
function makePool(
  opts: { capUsd?: number; completedCostUsd?: number } = {},
): { pool: PoolSpy; client: ClientSpy } {
  const capUsd = opts.capUsd ?? 3
  const completedCostUsd = opts.completedCostUsd ?? 0.5

  const entityRows = [
    { id: ENTITY_A, world_id: WORLD_ID, entity_type: 'location', name: 'Old Eredil' },
    { id: ENTITY_B, world_id: WORLD_ID, entity_type: 'npc', name: 'Mara' },
    { id: ENTITY_C, world_id: WORLD_ID, entity_type: 'location', name: 'The Wharf' },
  ]
  const proseRows = [
    { entity_id: ENTITY_A, content: 'A weathered fishing village.' },
    { entity_id: ENTITY_B, content: 'A guarded harbormaster.' },
    { entity_id: ENTITY_C, content: 'The salt-eaten wharf.' },
  ]
  const factRows = [
    {
      id: FACT_X,
      entity_id: ENTITY_A,
      topic: 'history',
      access_level: 'public',
      content: 'The village burned down in the great fire.',
    },
  ]
  const relRows = [
    {
      id: REL_R,
      source_entity_id: ENTITY_A,
      target_entity_id: ENTITY_B,
      relationship_type: 'rivalry',
      description: 'Mara distrusts the village elders.',
    },
    {
      id: REL_S,
      source_entity_id: ENTITY_B,
      target_entity_id: ENTITY_C,
      relationship_type: 'employed_by',
      description: 'Mara works the wharf.',
    },
  ]
  const client: ClientSpy = {
    query: vi.fn().mockImplementation((sql: string) => {
      if (sql.startsWith('BEGIN') || sql.startsWith('COMMIT') || sql.startsWith('ROLLBACK')) {
        return { rows: [] }
      }
      if (sql.includes('FROM entities')) return { rows: entityRows }
      if (sql.includes('FROM prose_kernels')) return { rows: proseRows }
      if (sql.includes('FROM facts')) return { rows: factRows }
      if (sql.startsWith('SELECT r.id') || sql.includes('FROM relationships')) {
        return { rows: relRows }
      }
      return { rows: [], rowCount: 1 }
    }),
    release: vi.fn(),
  }

  const pool: PoolSpy = {
    connect: vi.fn().mockResolvedValue(client),
    query: vi.fn().mockImplementation((sql: string) => {
      if (sql.includes('world_gen_cost_cap_usd')) {
        return { rows: [{ value: String(capUsd) }] }
      }
      if (sql.includes('COALESCE(SUM(cost_usd)')) {
        return { rows: [{ total: completedCostUsd }] }
      }
      return { rows: [], rowCount: 1 }
    }),
  }
  return { pool, client }
}

function makeRedis(): RedisSpy {
  return { publish: vi.fn().mockResolvedValue(1) }
}

function makeLogger(): LoggerSpy {
  return { warn: vi.fn(), info: vi.fn() }
}

const baseArgs = {
  worldId: WORLD_ID,
  campaignId: CAMPAIGN_ID,
  userId: USER_ID,
  keyPrefix: 'test:',
  synthKeyByEntityId: SYNTH,
}

interface TestRun {
  pool: PoolSpy
  client: ClientSpy
  redis: RedisSpy
  logger: LoggerSpy
}

async function runStage(
  poolOpts: { capUsd?: number; completedCostUsd?: number } = {},
): Promise<TestRun & { result: Awaited<ReturnType<typeof runCoherencePassStage>> }> {
  const { pool, client } = makePool(poolOpts)
  const redis = makeRedis()
  const logger = makeLogger()
  const result = await runCoherencePassStage({
    pool: asPool(pool),
    redisRealtime: asRedis(redis),
    logger: asLogger(logger),
    ...baseArgs,
  })
  return { pool, client, redis, logger, result }
}

describe('runCoherencePassStage', () => {
  beforeEach(() => {
    mockGenerateText.mockReset()
  })

  it('applies one of each patch kind + publishes SSE events post-COMMIT', async () => {
    mockGenerateText.mockResolvedValueOnce({
      output: {
        patches: [
          {
            kind: 'fix_prose',
            entityId: ENTITY_A,
            newProse: 'A weathered fishing village half-rebuilt after the fire.',
            rationale: 'Prose said burned-down but a fact references active bakery.',
          },
          {
            kind: 'fix_fact',
            factId: FACT_X,
            newContent: 'The village burned a generation ago; only the harbor remains.',
            rationale: 'Original wording contradicted the rebuild timeline elsewhere.',
          },
          {
            kind: 'rename_entity',
            entityId: ENTITY_B,
            newName: 'Mara Salt-Hand',
            rationale: 'Other entities reference Mara Salt-Hand; full name unifies.',
          },
          {
            kind: 'fix_relationship',
            relationshipId: REL_R,
            newType: 'distrusts',
            newDescription: 'Mara distrusts the village elders and avoids the upper square.',
            rationale: 'Type rivalry was too strong for the prose; softened to distrust.',
          },
          {
            kind: 'delete_relationship',
            relationshipId: REL_S,
            rationale: 'Duplicate relationship; redundant with REL_R after fix.',
          },
        ],
      },
      usage: { inputTokens: 14000, outputTokens: 2000, totalTokens: 16000 },
    } as unknown as Awaited<ReturnType<typeof generateText>>)

    const { client, redis, result } = await runStage()

    // Sonnet pricing: 14000/1M * 3 + 2000/1M * 15 = 0.042 + 0.030 = 0.072
    expect(result.costUsd).toBeCloseTo(0.072, 4)
    expect(result.inputTokens).toBe(14000)
    expect(result.outputTokens).toBe(2000)

    // Transaction was opened + committed exactly once.
    const begins = client.query.mock.calls.filter((c) => String(c[0]).startsWith('BEGIN'))
    const commits = client.query.mock.calls.filter((c) => String(c[0]).startsWith('COMMIT'))
    expect(begins.length).toBe(1)
    expect(commits.length).toBe(1)

    // 5 SSE events (per §3.6 — fix_fact emits nothing; fix_relationship
    // emits both edge-removed AND edge-added).
    expect(redis.publish).toHaveBeenCalledTimes(5)
    const payloads = parsedPayloads(redis)

    const prose = payloads.find(
      (p) => p.type === 'entity-updated' && p.synthKey === SYNTH[ENTITY_A],
    )
    expect(prose?.patch).toMatchObject({
      prose: 'A weathered fishing village half-rebuilt after the fire.',
    })

    const rename = payloads.find(
      (p) => p.type === 'entity-updated' && p.synthKey === SYNTH[ENTITY_B],
    )
    expect(rename?.patch).toMatchObject({ name: 'Mara Salt-Hand' })

    const edgeRemovedR = payloads.find(
      (p) => p.type === 'edge-removed' && p.synthKey === SYNTH[REL_R],
    )
    expect(edgeRemovedR?.reason).toBe('coherence_deleted')

    const edgeAdded = payloads.find(
      (p) => p.type === 'edge-added' && p.relationship === 'distrusts',
    )
    expect(edgeAdded?.description).toBe(
      'Mara distrusts the village elders and avoids the upper square.',
    )

    const edgeRemovedS = payloads.find(
      (p) => p.type === 'edge-removed' && p.synthKey === SYNTH[REL_S],
    )
    expect(edgeRemovedS?.reason).toBe('coherence_deleted')
  })

  it('skips patches that reference unknown UUIDs and logs WARN, but applies the rest', async () => {
    mockGenerateText.mockResolvedValueOnce({
      output: {
        patches: [
          // One good patch + five hallucinated-id patches (skipped + warned).
          {
            kind: 'fix_prose',
            entityId: ENTITY_A,
            newProse: 'A weathered fishing village that has slowly rebuilt itself.',
            rationale: 'Prose said burned-down but a fact references active bakery.',
          },
          {
            kind: 'fix_prose',
            entityId: UNKNOWN_ENTITY,
            newProse: 'Some prose that should never be persisted to the DB.',
            rationale: 'LLM hallucinated this entity id.',
          },
          {
            kind: 'fix_fact',
            factId: UNKNOWN_FACT,
            newContent: 'New content that should never land.',
            rationale: 'LLM hallucinated this fact id.',
          },
          {
            kind: 'delete_relationship',
            relationshipId: UNKNOWN_REL,
            rationale: 'LLM hallucinated this relationship id.',
          },
          {
            kind: 'rename_entity',
            entityId: UNKNOWN_ENTITY,
            newName: 'Phantom Name',
            rationale: 'LLM hallucinated this entity id.',
          },
          {
            kind: 'fix_relationship',
            relationshipId: UNKNOWN_REL,
            newType: 'phantom_link',
            rationale: 'LLM hallucinated this relationship id.',
          },
        ],
      },
      usage: { inputTokens: 14000, outputTokens: 2000, totalTokens: 16000 },
    } as unknown as Awaited<ReturnType<typeof generateText>>)

    const { redis, logger } = await runStage()

    // Only the good fix_prose event should publish.
    expect(redis.publish).toHaveBeenCalledTimes(1)
    const payload = parsedPayloads(redis)[0]
    expect(payload?.type).toBe('entity-updated')
    expect(payload?.synthKey).toBe(SYNTH[ENTITY_A])

    // Five unknown-id WARN logs (one per skipped patch).
    expect(logger.warn).toHaveBeenCalledTimes(5)
  })

  it('completes successfully when LLM emits zero patches (no-op coherence)', async () => {
    mockGenerateText.mockResolvedValueOnce({
      output: { patches: [] },
      usage: { inputTokens: 14000, outputTokens: 50, totalTokens: 14050 },
    } as unknown as Awaited<ReturnType<typeof generateText>>)

    const { client, redis, result } = await runStage()

    // Cost > 0 even with zero patches — the LLM still ran.
    expect(result.costUsd).toBeGreaterThan(0)
    expect(result.inputTokens).toBe(14000)
    expect(result.outputTokens).toBe(50)

    // No SSE events.
    expect(redis.publish).toHaveBeenCalledTimes(0)

    // Transaction was still opened+committed (no patches to apply, but
    // the BEGIN/COMMIT shell remains for shape-consistency).
    const begins = client.query.mock.calls.filter((c) => String(c[0]).startsWith('BEGIN'))
    const commits = client.query.mock.calls.filter((c) => String(c[0]).startsWith('COMMIT'))
    expect(begins.length).toBe(1)
    expect(commits.length).toBe(1)
  })

  it('cap-fire exception: cap exhausted pre-stage marks world complete, NOT failed (per §D5)', async () => {
    // Cumulative cost from stages 1-6 already at $3.05 against a $3.00 cap.
    // Stage 7 must NOT call the LLM, NOT refund, must mark
    // worlds.status = 'complete', publish phase: complete, log WARN.
    const { pool, redis, logger, result } = await runStage({
      capUsd: 3,
      completedCostUsd: 3.05,
    })

    // No LLM call.
    expect(mockGenerateText).not.toHaveBeenCalled()

    // No cost incurred.
    expect(result.costUsd).toBe(0)
    expect(result.inputTokens).toBe(0)
    expect(result.outputTokens).toBe(0)

    // worlds.status flipped to 'complete'.
    const completeUpdate = pool.query.mock.calls.find((c) => {
      const sql: unknown = c[0]
      return (
        typeof sql === 'string' &&
        sql.includes('UPDATE worlds') &&
        sql.includes("'complete'")
      )
    })
    expect(completeUpdate).toBeDefined()
    expect(completeUpdate?.[1]).toEqual([WORLD_ID])

    // phase: complete emitted (NOT world_gen_failed).
    const payloads = parsedPayloads(redis)
    const phaseComplete = payloads.find((p) => p.type === 'phase' && p.phase === 'complete')
    expect(phaseComplete).toBeDefined()
    const phaseFailed = payloads.find(
      (p) => p.type === 'phase' && p.phase === 'world_gen_failed',
    )
    expect(phaseFailed).toBeUndefined()

    // WARN log emitted.
    expect(logger.warn).toHaveBeenCalledTimes(1)
    const warnArgs = logger.warn.mock.calls[0]
    expect(JSON.stringify(warnArgs)).toContain('coherence_pass')

    // result.capExhausted signal is set so the processor can skip its
    // own cap-and-refund branch.
    expect(result.capExhausted).toBe(true)
  })

  it('fix_relationship preserves existing fields when newType / newDescription are omitted', async () => {
    // Exercises the `?? existing.relationshipType` + `?? existing.description`
    // fallback arms when the LLM emits a fix_relationship patch with only
    // one of the two optional fields populated.
    mockGenerateText.mockResolvedValueOnce({
      output: {
        patches: [
          {
            // Only newType supplied — description falls back to existing.
            kind: 'fix_relationship',
            relationshipId: REL_R,
            newType: 'allies_with',
            rationale: 'Rivalry is too strong; allies fits the prose better.',
          },
          {
            // Only newDescription supplied — type falls back to existing.
            kind: 'fix_relationship',
            relationshipId: REL_S,
            newDescription: 'Mara now serves as the wharf master, hand-picked.',
            rationale: 'Description was too thin; sharpening with new detail.',
          },
        ],
      },
      usage: { inputTokens: 14000, outputTokens: 200, totalTokens: 14200 },
    } as unknown as Awaited<ReturnType<typeof generateText>>)

    const { redis } = await runStage()
    const payloads = parsedPayloads(redis)

    // First fix: relationship REL_R — newType='allies_with', description
    // falls back to existing 'Mara distrusts the village elders.'
    const addedR = payloads.find(
      (p) => p.type === 'edge-added' && p.relationship === 'allies_with',
    )
    expect(addedR?.description).toBe('Mara distrusts the village elders.')

    // Second fix: relationship REL_S — type falls back to 'employed_by',
    // description replaces.
    const addedS = payloads.find(
      (p) => p.type === 'edge-added' && p.relationship === 'employed_by',
    )
    expect(addedS?.description).toBe('Mara now serves as the wharf master, hand-picked.')
  })

  it('renders the world dump into the {{worldDump}} placeholder of the prompt', async () => {
    mockGenerateText.mockResolvedValueOnce({
      output: { patches: [] },
      usage: { inputTokens: 14000, outputTokens: 50, totalTokens: 14050 },
    } as unknown as Awaited<ReturnType<typeof generateText>>)

    await runStage()
    const callArgs = mockGenerateText.mock.calls[0]
    expect(callArgs).toBeDefined()
    const firstArg = callArgs?.[0] as { prompt: string } | undefined
    const prompt = firstArg?.prompt ?? ''
    // Each entity UUID + its prose should appear in the dump.
    expect(prompt).toContain(ENTITY_A)
    expect(prompt).toContain('weathered fishing village')
    expect(prompt).toContain(FACT_X)
    expect(prompt).toContain('burned down in the great fire')
    expect(prompt).toContain(REL_R)
    expect(prompt).toContain('rivalry')
    expect(prompt).not.toContain('{{worldDump}}')
  })
})
