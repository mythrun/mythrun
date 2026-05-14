// Per MYT-52 T12 / design §3.6 + §D5. Stage 7 non-streaming handler.
// Unified-dispatch contract: handler receives a mid-txn PoolClient and
// returns `StageDispatchResult` (finalizedEvents + capExhausted). Mocks
// `ai` + a single client; no Pool, no Redis (outer scope publishes
// finalizedEvents after COMMIT).

import type { PoolClient } from 'pg'
import type pino from 'pino'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { generateText } from 'ai'
import { runCoherencePassStage } from '../coherence-pass.js'
import type { PipelineEvent } from '../../../../contract/pipeline-events.js'

vi.mock('ai', async (importOriginal) => {
  const actual = await importOriginal<typeof import('ai')>()
  return {
    ...actual,
    generateText: vi.fn(),
    Output: { object: vi.fn((opts: unknown) => opts) },
  }
})

const mockGenerateText = vi.mocked(generateText)

const WORLD_ID = '00000000-0000-0000-0000-00000000aaaa'

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
}
interface LoggerSpy {
  warn: ReturnType<typeof vi.fn>
  info: ReturnType<typeof vi.fn>
}

// Adapter casts — spies are structurally compatible with the Pick<>
// surface the handler uses; cast at the call site to keep tests typed.
const asClient = (s: ClientSpy): PoolClient => s as unknown as PoolClient
const asLogger = (s: LoggerSpy): pino.Logger => s as unknown as pino.Logger

// SELECTs return canned world inventory + cost-cap rows; UPDATE/DELETE
// are spied. The single client handles BOTH the cost-cap reads (which
// used to go through `pool.query`) AND the inventory/apply queries —
// reflects the unified contract where the outer scope passes one
// already-BEGUN client.
function makeClient(
  opts: { capUsd?: number; completedCostUsd?: number } = {},
): ClientSpy {
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
  return {
    query: vi.fn().mockImplementation((sql: string) => {
      if (sql.includes('world_gen_cost_cap_usd')) {
        return { rows: [{ value: String(capUsd) }] }
      }
      if (sql.includes('COALESCE(SUM(cost_usd)')) {
        return { rows: [{ total: completedCostUsd }] }
      }
      if (sql.includes('FROM entities')) return { rows: entityRows }
      if (sql.includes('FROM prose_kernels')) return { rows: proseRows }
      if (sql.includes('FROM facts')) return { rows: factRows }
      if (sql.startsWith('SELECT r.id') || sql.includes('FROM relationships')) {
        return { rows: relRows }
      }
      return { rows: [], rowCount: 1 }
    }),
  }
}

function makeLogger(): LoggerSpy {
  return { warn: vi.fn(), info: vi.fn() }
}

interface TestRun {
  client: ClientSpy
  logger: LoggerSpy
}

async function runStage(
  poolOpts: { capUsd?: number; completedCostUsd?: number } = {},
): Promise<TestRun & { result: Awaited<ReturnType<typeof runCoherencePassStage>> }> {
  const client = makeClient(poolOpts)
  const logger = makeLogger()
  const result = await runCoherencePassStage(asClient(client), {
    logger: asLogger(logger),
    worldId: WORLD_ID,
    synthKeyByEntityId: SYNTH,
  })
  return { client, logger, result }
}

// Helpers to read finalizedEvents by type narrowing without leaking the
// `any` cast across the test body.
function eventsOfType<T extends PipelineEvent['type']>(
  events: readonly PipelineEvent[],
  type: T,
): Extract<PipelineEvent, { type: T }>[] {
  return events.filter((e): e is Extract<PipelineEvent, { type: T }> => e.type === type)
}

describe('runCoherencePassStage', () => {
  beforeEach(() => {
    mockGenerateText.mockReset()
  })

  it('applies one of each patch kind + returns finalizedEvents for outer publish', async () => {
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

    const { result } = await runStage()

    // Sonnet pricing: 14000/1M * 3 + 2000/1M * 15 = 0.042 + 0.030 = 0.072
    expect(result.costUsd).toBeCloseTo(0.072, 4)
    expect(result.inputTokens).toBe(14000)
    expect(result.outputTokens).toBe(2000)
    expect(result.capExhausted).toBe(false)

    // 5 finalized events (per §3.6 — fix_fact emits nothing;
    // fix_relationship emits both edge-removed AND edge-added).
    expect(result.finalizedEvents).toHaveLength(5)

    const updates = eventsOfType(result.finalizedEvents, 'entity-updated')
    const prose = updates.find((p) => p.synthKey === SYNTH[ENTITY_A])
    expect(prose?.patch).toMatchObject({
      prose: 'A weathered fishing village half-rebuilt after the fire.',
    })
    const rename = updates.find((p) => p.synthKey === SYNTH[ENTITY_B])
    expect(rename?.patch).toMatchObject({ name: 'Mara Salt-Hand' })

    const removed = eventsOfType(result.finalizedEvents, 'edge-removed')
    const edgeRemovedR = removed.find((p) => p.synthKey === SYNTH[REL_R])
    expect(edgeRemovedR?.reason).toBe('coherence_deleted')
    const edgeRemovedS = removed.find((p) => p.synthKey === SYNTH[REL_S])
    expect(edgeRemovedS?.reason).toBe('coherence_deleted')

    const added = eventsOfType(result.finalizedEvents, 'edge-added')
    const edgeAdded = added.find((p) => p.relationship === 'distrusts')
    expect(edgeAdded?.description).toBe(
      'Mara distrusts the village elders and avoids the upper square.',
    )
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

    const { logger, result } = await runStage()

    // Only the good fix_prose event should appear in finalizedEvents.
    expect(result.finalizedEvents).toHaveLength(1)
    const [payload] = result.finalizedEvents
    expect(payload?.type).toBe('entity-updated')
    if (payload?.type === 'entity-updated') {
      expect(payload.synthKey).toBe(SYNTH[ENTITY_A])
    }

    // Five unknown-id WARN logs (one per skipped patch).
    expect(logger.warn).toHaveBeenCalledTimes(5)
  })

  it('completes successfully when LLM emits zero patches (no-op coherence)', async () => {
    mockGenerateText.mockResolvedValueOnce({
      output: { patches: [] },
      usage: { inputTokens: 14000, outputTokens: 50, totalTokens: 14050 },
    } as unknown as Awaited<ReturnType<typeof generateText>>)

    const { result } = await runStage()

    // Cost > 0 even with zero patches — the LLM still ran.
    expect(result.costUsd).toBeGreaterThan(0)
    expect(result.inputTokens).toBe(14000)
    expect(result.outputTokens).toBe(50)
    expect(result.capExhausted).toBe(false)
    expect(result.finalizedEvents).toEqual([])
  })

  it('cap-fire exception: cap exhausted pre-stage signals capExhausted + phase:complete via finalizedEvents (per §D5)', async () => {
    // Cumulative cost from stages 1-6 already at $3.05 against a $3.00 cap.
    // Stage 7 must NOT call the LLM, NOT refund. The outer scope reads
    // capExhausted=true + the phase:complete event from finalizedEvents
    // and decides what to do (flip worlds.status, publish phase).
    const { logger, result } = await runStage({
      capUsd: 3,
      completedCostUsd: 3.05,
    })

    // No LLM call.
    expect(mockGenerateText).not.toHaveBeenCalled()

    // No cost incurred.
    expect(result.costUsd).toBe(0)
    expect(result.inputTokens).toBe(0)
    expect(result.outputTokens).toBe(0)

    // capExhausted signal set; finalizedEvents carries the phase:complete
    // event for the outer scope to publish (NOT world_gen_failed).
    expect(result.capExhausted).toBe(true)
    expect(result.finalizedEvents).toEqual([{ type: 'phase', phase: 'complete' }])

    // WARN log emitted.
    expect(logger.warn).toHaveBeenCalledTimes(1)
    const warnArgs = logger.warn.mock.calls[0]
    expect(JSON.stringify(warnArgs)).toContain('coherence_pass')
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

    const { result } = await runStage()
    const added = eventsOfType(result.finalizedEvents, 'edge-added')

    // First fix: relationship REL_R — newType='allies_with', description
    // falls back to existing 'Mara distrusts the village elders.'
    const addedR = added.find((p) => p.relationship === 'allies_with')
    expect(addedR?.description).toBe('Mara distrusts the village elders.')

    // Second fix: relationship REL_S — type falls back to 'employed_by',
    // description replaces.
    const addedS = added.find((p) => p.relationship === 'employed_by')
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
