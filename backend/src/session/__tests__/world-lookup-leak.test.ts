// backend/src/session/__tests__/world-lookup-leak.test.ts
//
// MYT-72 T10a — the enforced-ignorance LEAK MATRIX. The load-bearing security
// proof that a `secret`-tier world fact NEVER reaches the player through a
// world-knowledge lookup. A lookup runs `gate → resolve → ST-vet → relay`; the
// resolver DELIBERATELY over-pulls all access tiers (incl. `secret`) so the
// ST-vet (Opus) can SEE the secret in order to GATE it. ONLY the vet's relay
// reaches the player. This file proves the PLUMBING of that boundary
// deterministically — the real-Opus gating QUALITY is proven separately by a
// real-LLM smoke.
//
// The five links of the boundary, each proven by a case below:
//   1. The REAL resolver over-pulls the secret tier (graph results carry
//      accessLevel='secret'). — case (b)
//   2. The over-pulled secret reaches the VET INPUT (tier-tagged `results`
//      block). — cases (a)+(b)
//   3. ONLY the vet's relay reaches the orchestrator result; the over-pulled
//      `results` never do. — cases (a)+(b)
//   4. A malformed vet output carrying a secret is REDACTED from logs /
//      diagnostics (redactRawText). — case (c)
//   5. The persisted transcript row carries only the relay. — case (d)
//
// Mock posture: the gate calls Haiku through the `'ai'` SDK boundary. We
// `vi.mock('ai')` and return a controlled gate table so the gate resolves
// deterministically — we do NOT mock world-lookup-gate.ts, world-fact-lookup.ts,
// or ai.ts. The vet is an INJECTED spy closure (`deps.vet`), so the orchestrator
// makes exactly ONE `'ai'` call (the Haiku gate table); the spy captures the vet
// input without an LLM call. The graph channel resolves against REAL PG.

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import * as ai from 'ai'
import type { Pool } from 'pg'
import { guardTestDatabase } from '../../db/__tests__/guard-db.js'
import {
  cleanupTestScope,
  makeTestScope,
  type TestScope,
} from '../../repo/__tests__/_helpers/test-scope.js'
import { createTestPool } from '../../repo/__tests__/_helpers/test-pool.js'
import { uuidv7 } from '../../repo/uuidv7.js'
import { entities } from '../../repo/entities.js'
import { createRepo, type Repo } from '../../repo/index.js'
import { charactersKnownTo, factionTree } from '../../world/retrieval/graph.js'
import {
  runWorldFactLookup,
  type SubstrateResolver,
  type WorldFactLookupDeps,
  type WorldFactLookupInput,
  type WorldFactLookupVet,
} from '../world-fact-lookup.js'
import { assistantToRows, rowsToConversation } from '../transcript-codec.js'
import type { AssistantMessage, ContentPart } from '../tiers/types.js'
import type { SessionMessage } from '../../repo/types.js'
import type { Character } from '../../repo/types.js'
import { runStLookupVet } from '../../llm/st-lookup-vet.js'
import { LlmStructuredOutputError } from '../../llm/errors.js'
import type { LlmCallDiagnostic } from '../../llm/ai.js'
import { logger } from '../../llm/logger.js'

// The one secret sentinel every leak assertion checks. Unmistakable: if this
// exact string surfaces in a player-facing relay / a persisted row / a log /
// a diagnostic, a secret leaked.
const SECRET = 'XYZZY-SECRET-TUNNEL-c0ffee'

const databaseUrl = process.env.DATABASE_URL ?? ''

vi.mock('ai', async () => {
  const actual = await vi.importActual<typeof import('ai')>('ai')
  return { ...actual, generateText: vi.fn() }
})

const mockGenerateText = vi.mocked(ai.generateText)

const HAIKU_USAGE = { inputTokens: 400, outputTokens: 50, totalTokens: 450 }

/** Stub the gate's Haiku table. auto_success → the deterministic roll is
 *  skipped and the vet runs (no rng needed). A rollable table carries a dc +
 *  the three outcome tiers. */
function mockGateTable(
  table:
    | { auto_success: true }
    | {
        auto_success: false
        dc: number
        outcomes: { fail: string; success: string; great_success: string }
      },
): void {
  const full =
    table.auto_success
      ? {
          auto_success: true,
          dc: 10,
          outcomes: { fail: 'F', success: 'S', great_success: 'G' },
        }
      : table
  mockGenerateText.mockResolvedValueOnce({
    output: full,
    finishReason: 'stop',
    usage: HAIKU_USAGE,
  } as never)
}

/** A complete Character row for a DM-channel asker. */
function makeCharacter(overrides: Partial<Character> = {}): Character {
  return {
    id: 'char-1',
    userId: 'user-1',
    entityId: null,
    name: 'Vire',
    level: 3,
    class: 'Wizard',
    species: 'Human',
    background: 'Sage',
    str: 10,
    dex: 12,
    con: 12,
    int: 16,
    wis: 14,
    cha: 10,
    hitPoints: 18,
    maxHitPoints: 18,
    armorClass: 12,
    proficiencyBonus: 2,
    createdAt: new Date('2026-01-01T00:00:00Z'),
    updatedAt: new Date('2026-01-01T00:00:00Z'),
    ...overrides,
  }
}

type VetCapture = Omit<Parameters<WorldFactLookupVet>[0], never>

/** A SPY vet: captures the vet INPUT (so we can prove the over-pulled secret
 *  reached it) and returns a controlled verdict (so we can prove the
 *  orchestrator surfaces only the verdict's text, never the input). */
function spyVet(
  out: { mode: 'relay' | 'none' | 'invent'; text: string; repairAttempted: boolean },
): { vet: WorldFactLookupVet; captured: () => VetCapture } {
  let seen: VetCapture | undefined
  const vet: WorldFactLookupVet = (input) => {
    seen = input
    return Promise.resolve(out)
  }
  return {
    vet,
    captured: () => {
      if (seen === undefined) throw new Error('spyVet: vet was never called')
      return seen
    },
  }
}

function makeDeps(vet: WorldFactLookupVet, overrides: Partial<WorldFactLookupDeps> = {}): WorldFactLookupDeps {
  return {
    gateDeps: { worldTone: 'grim and rain-soaked' },
    vet,
    worldTone: 'grim and rain-soaked',
    ...overrides,
  }
}

function dmGate(): WorldFactLookupInput['gate'] {
  return {
    channel: 'dm',
    topic: 'the Duke and the river bridge',
    worldTone: 'grim and rain-soaked',
    askerSummary: 'Vire, a travelling scholar of modest renown',
    dm: {
      character: makeCharacter(),
      skill: 'history',
      skills: [{ skill_name: 'History', proficiency_level: 'proficient' }],
    },
  }
}

function baseInput(
  resolve: SubstrateResolver,
  overrides: Partial<WorldFactLookupInput> = {},
): WorldFactLookupInput {
  return {
    gate: dmGate(),
    question: 'What do I recall about the old river bridge?',
    recentNarrative: '',
    npcFraming: '',
    resolve,
    ...overrides,
  }
}

describe('MYT-72 T10a — enforced-ignorance leak matrix', () => {
  let pool: Pool
  let repo: Repo
  let scope: TestScope
  let userId: string
  let worldId: string

  beforeAll(async () => {
    await guardTestDatabase(databaseUrl)
    pool = createTestPool(databaseUrl)
    repo = createRepo(pool)
    scope = makeTestScope('world-lookup-leak')
  })
  afterAll(async () => {
    await cleanupTestScope(pool, scope)
    await pool.end()
  })
  beforeEach(async () => {
    vi.clearAllMocks()
    await cleanupTestScope(pool, scope)
    userId = uuidv7()
    worldId = uuidv7()
    await pool.query(
      `INSERT INTO users (id, cognito_sub, display_name, username) VALUES ($1, $2, $3, $4)`,
      [userId, scope.userSub(0), scope.displayName(0), scope.username(0)],
    )
    await pool.query(
      `INSERT INTO worlds (id, created_by, name, concept, status) VALUES ($1, $2, $3, 'C', 'generating')`,
      [worldId, userId, scope.worldName(0)],
    )
  })

  async function seedEntity(
    entityType: 'npc' | 'faction',
    name: string,
    accessLevel: 'known' | 'discoverable' | 'secret',
  ): Promise<string> {
    const id = uuidv7()
    await entities.insert(pool, {
      id,
      worldId,
      entityType,
      name,
      accessLevel,
      createdIn: 'stage:test',
    })
    return id
  }

  // ── (a) secret FACT reaches the vet but not the relay (search channel) ─────
  // A fake `search` resolver: it returns a pre-rendered, tier-annotated results
  // block carrying the secret (modelling searchLore's over-pull WITHOUT the
  // non-deterministic Voyage embedding call). The boundary under test is the
  // orchestrator's: secret IN to the vet, only the vet's relay OUT.

  it('(a) search channel: secret fact reaches the vet input but NOT the relay', async () => {
    const resolve: SubstrateResolver = () =>
      Promise.resolve({
        results: `[tier=secret] The Duke: ${SECRET}\n[tier=known] The bridge was rebuilt.`,
        degraded: false,
        empty: false,
      })
    const { vet, captured } = spyVet({
      mode: 'relay',
      text: 'You recall the bridge was rebuilt after the floods.',
      repairAttempted: false,
    })

    mockGateTable({ auto_success: true })
    const result = await runWorldFactLookup(makeDeps(vet), baseInput(resolve))

    // Link 2 — the over-pulled secret reached the VET input (tier-tagged).
    expect(captured().results).toContain(SECRET)
    expect(captured().results).toContain('[tier=secret]')
    // Link 3 — only the vet's relay reaches the player; the secret does NOT.
    expect(result.relayText).toBe('You recall the bridge was rebuilt after the floods.')
    expect(result.relayText).not.toContain(SECRET)
  })

  it('(a) search channel: even if the vet RELAYS the secret-bearing block verbatim, that text is what the spy returned — proving the orchestrator surfaces ONLY the vet verdict, never the raw input', async () => {
    // Defensive framing: the orchestrator must NEVER echo `resolved.results`.
    // We give the vet a clean relay; the input carries the secret. If the
    // orchestrator ever leaked the input, relayText would carry SECRET.
    const resolve: SubstrateResolver = () =>
      Promise.resolve({
        results: `[tier=secret] ${SECRET}`,
        degraded: false,
        empty: false,
      })
    const { vet } = spyVet({ mode: 'none', text: 'Nothing comes to mind.', repairAttempted: false })

    mockGateTable({ auto_success: true })
    const result = await runWorldFactLookup(makeDeps(vet), baseInput(resolve))

    expect(result.relayText).toBe('Nothing comes to mind.')
    expect(JSON.stringify(result)).not.toContain(SECRET)
  })

  // ── (b) secret ENTITY reaches the vet but not the relay (REAL PG graph) ────
  // The REAL graph resolver over-pulls the secret tier from REAL Postgres. We
  // seed a public faction parent with a `secret`-tier child named with the
  // sentinel, build the resolve closure from the REAL factionTree, and prove
  // the secret child's tier-tagged name reaches the vet input but not the relay.

  it('(b) faction_tree channel (REAL PG): secret child entity over-pulled into the vet input, NOT the relay', async () => {
    const parent = await seedEntity('faction', 'Open Council', 'known')
    const childSecret = await seedEntity('faction', `Cabal of ${SECRET}`, 'secret')
    await pool.query(
      `INSERT INTO entity_hierarchy (id, parent_entity_id, child_entity_id) VALUES ($1, $2, $3)`,
      [uuidv7(), parent, childSecret],
    )

    const resolve: SubstrateResolver = async () => {
      const { nodes } = await factionTree({ repo }, parent)
      return {
        results: nodes.map((n) => `[tier=${n.accessLevel}] ${n.name}`).join('\n'),
        degraded: false,
        empty: nodes.length === 0,
      }
    }
    const { vet, captured } = spyVet({
      mode: 'relay',
      text: 'You recall the Open Council holds the river charters.',
      repairAttempted: false,
    })

    mockGateTable({ auto_success: true })
    const result = await runWorldFactLookup(makeDeps(vet), baseInput(resolve))

    // Links 1+2 — the REAL resolver over-pulled the secret tier; the secret
    // child's name arrives at the vet input, tier-tagged `secret`.
    const vetResults = captured().results
    expect(vetResults).toContain(SECRET)
    expect(vetResults).toContain(`[tier=secret] Cabal of ${SECRET}`)
    // The public parent is present too (proves the over-pull spanned tiers).
    expect(vetResults).toContain('[tier=known] Open Council')
    // Link 3 — the relay carries only the vet's verdict; the secret does NOT.
    expect(result.relayText).toBe('You recall the Open Council holds the river charters.')
    expect(result.relayText).not.toContain(SECRET)
  })

  it('(b) characters_known_to channel (REAL PG): secret neighbor over-pulled into the vet input, NOT the relay', async () => {
    const root = await seedEntity('npc', 'Open NPC', 'known')
    const secretNeighbor = await seedEntity('npc', `Informant ${SECRET}`, 'secret')
    await pool.query(
      `INSERT INTO relationships (id, source_entity_id, target_entity_id, relationship_type, description)
       VALUES ($1, $2, $3, 'knows', 'd')`,
      [uuidv7(), root, secretNeighbor],
    )

    const resolve: SubstrateResolver = async () => {
      const chars = await charactersKnownTo({ repo }, root, {})
      return {
        results: chars.map((c) => `[tier=${c.accessLevel}] ${c.name}`).join('\n'),
        degraded: false,
        empty: chars.length === 0,
      }
    }
    const { vet, captured } = spyVet({
      mode: 'relay',
      text: 'You recall Open NPC keeps to the wharf.',
      repairAttempted: false,
    })

    mockGateTable({ auto_success: true })
    const result = await runWorldFactLookup(makeDeps(vet), baseInput(resolve))

    const vetResults = captured().results
    expect(vetResults).toContain(SECRET)
    expect(vetResults).toContain(`[tier=secret] Informant ${SECRET}`)
    expect(vetResults).toContain('[tier=known] Open NPC')
    expect(result.relayText).toBe('You recall Open NPC keeps to the wharf.')
    expect(result.relayText).not.toContain(SECRET)
  })

  // ── (c) malformed vet output carrying a secret is REDACTED (link 4) ────────
  // Drive runStLookupVet directly down the terminal-failure path with a raw
  // model response embedding the secret. redactRawText:true must keep that
  // secret out of the rethrown error's `.diagnostic` AND the WARN log — so a
  // malformed Opus response can't spill a secret into pipeline_runs.error / SSE.

  it('(c) malformed vet output carrying a secret never reaches the diagnostic or the WARN log', async () => {
    const warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => undefined)
    // Raw text parses as JSON but fails Zod (unknown mode), and embeds the secret.
    const originalErr = new LlmStructuredOutputError('llm returned unparseable structured output', {
      cause: {
        text: JSON.stringify({ mode: 'leaked-mode', text: SECRET, tier: 'known' }),
        name: 'AI_NoObjectGeneratedError',
      },
    })
    mockGenerateText.mockRejectedValueOnce(originalErr)
    // Haiku repair: still Zod-invalid (still secret-bearing).
    mockGenerateText.mockResolvedValueOnce({
      output: { mode: 'still-bad', text: SECRET, tier: 'known' },
      usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
    } as never)
    // Sonnet repair: still Zod-invalid → terminal failure.
    mockGenerateText.mockResolvedValueOnce({
      output: { mode: 'still-bad', text: SECRET, tier: 'known' },
      usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
    } as never)

    let caught: unknown
    try {
      await runStLookupVet({
        question: 'What do I recall about the old bridge?',
        recentNarrative: 'The party crosses the river at dusk.',
        channel: 'dm',
        npcFraming: '',
        results: `[tier=secret] ${SECRET}`,
        resolverDegraded: false,
        sdPlaybook: `SECRET PLAYBOOK: ${SECRET}`,
        worldTone: 'grim and rain-soaked',
      })
    } catch (err) {
      caught = err
    }

    expect(caught).toBe(originalErr)
    const diag = (caught as { diagnostic?: LlmCallDiagnostic }).diagnostic
    expect(diag).toBeDefined()
    expect(diag?.callSite).toBe('st-lookup-vet')
    // redactRawText:true → raw snippet + Zod issues are nulled; the secret is
    // nowhere in the diagnostic.
    expect(diag?.rawTextSnippet).toBeNull()
    expect(diag?.zodIssues).toBeNull()
    expect(JSON.stringify(diag)).not.toContain(SECRET)
    // No WARN-log argument carries the secret.
    expect(warnSpy).toHaveBeenCalled()
    for (const call of warnSpy.mock.calls) {
      expect(JSON.stringify(call)).not.toContain(SECRET)
    }
  })

  // ── (d) persistence round-trip carries no secret (link 5) ──────────────────
  // The persisted tool_result `output` is the secret-free reserved-keys relay
  // shape. assistantToRows → rowsToConversation must round-trip ONLY that relay;
  // the over-pulled results never entered the tool_result, so they can't persist.

  it('(d) transcript round-trip persists only the secret-free relay', () => {
    const toolCallId = 'tc-leak-1'
    const assistant: AssistantMessage = {
      role: 'assistant',
      parts: [
        { kind: 'text', text: 'The scribe pauses, recalling.' },
        {
          kind: 'tool_call',
          toolCallId,
          toolName: 'search_lore',
          input: { question: 'What of the old bridge?' },
        },
        {
          kind: 'tool_result',
          toolCallId,
          toolName: 'search_lore',
          // The secret-free reserved-keys output shape (the relay is the ONLY
          // player-facing content; the over-pulled `results` never entered it).
          output: {
            result: 'You recall the bridge was rebuilt.',
            skill_gate: {
              characterName: 'Vire',
              skill: 'History',
              context: 'the old bridge',
              total: 17,
              dc: 14,
              outcomeTier: 'success',
            },
            roll_hidden: false,
          },
        },
      ],
    }

    const rows = assistantToRows(assistant)
    // No persisted row content carries the secret.
    for (const row of rows) {
      expect(row.content).not.toContain(SECRET)
    }

    // Round-trip back to a conversation: map the DM rows to SessionMessage rows
    // (the shape rowsToConversation reads) and replay.
    const turnId = uuidv7()
    const sessionId = uuidv7()
    const sessionRows: SessionMessage[] = rows.map((row, i) => ({
      id: uuidv7(),
      sessionId,
      seq: i,
      userId: null,
      messageType: row.kind,
      content: row.content,
      createdAt: new Date('2026-01-01T00:00:00Z'),
      turnId,
      turnOrdinal: i,
    }))

    const conversation = rowsToConversation(sessionRows, new Map())
    // The replayed assistant message + every tool_result it carries is
    // secret-free.
    expect(JSON.stringify(conversation)).not.toContain(SECRET)
    const replayed = conversation.find((m) => m.role === 'assistant')
    expect(replayed).toBeDefined()
    const toolResult = replayed?.parts.find(
      (p): p is Extract<ContentPart, { kind: 'tool_result' }> => p.kind === 'tool_result',
    )
    expect(toolResult).toBeDefined()
    expect(JSON.stringify(toolResult?.output)).not.toContain(SECRET)
    // The relay survived the round-trip intact (positive control).
    expect(JSON.stringify(toolResult?.output)).toContain('You recall the bridge was rebuilt.')
  })

  // ── Skill-gate + arbitration matrix (consolidated enforced-ignorance proof) ─
  // These overlap T5's orchestrator tests, but each here makes a SECRET-or-leak
  // assertion: a failed/short-circuited path must never let the secret-bearing
  // resolver output reach the player either.

  it('DM gate FAIL → fail constraint + frame; resolver + vet NOT called (secret-bearing resolver never even runs)', async () => {
    // A high DC + a forced low roll → the deterministic roll fails the gate.
    mockGateTable({
      auto_success: false,
      dc: 25,
      outcomes: { fail: 'It eludes you.', success: 'S', great_success: 'G' },
    })
    let resolverCalled = false
    const resolve: SubstrateResolver = () => {
      resolverCalled = true
      return Promise.resolve({ results: `[tier=secret] ${SECRET}`, degraded: false, empty: false })
    }
    const { vet, captured } = spyVet({ mode: 'relay', text: 'unused', repairAttempted: false })

    // Force a low roll (3 + History +5 = 8 < 25 → fail) via injected rng.
    const result = await runWorldFactLookup(
      makeDeps(vet, { gateDeps: { worldTone: 'grim and rain-soaked', rng: () => 3 } }),
      baseInput(resolve),
    )

    expect(result.relayText).toBe('It eludes you.')
    expect(result.relayText).not.toContain(SECRET)
    expect(resolverCalled).toBe(false)
    expect(() => captured()).toThrow() // vet never ran
  })

  it('DM gate auto_success → no frame; relay = vet text (the over-pulled secret stays in the vet input only)', async () => {
    const resolve: SubstrateResolver = () =>
      Promise.resolve({
        results: `[tier=secret] ${SECRET}`,
        degraded: false,
        empty: false,
      })
    const { vet, captured } = spyVet({
      mode: 'relay',
      text: 'You recall a little of it.',
      repairAttempted: false,
    })

    mockGateTable({ auto_success: true })
    const result = await runWorldFactLookup(makeDeps(vet), baseInput(resolve))

    expect('skillGateFrame' in result).toBe(false)
    expect(result.relayText).toBe('You recall a little of it.')
    expect(captured().results).toContain(SECRET) // secret reached the vet…
    expect(result.relayText).not.toContain(SECRET) // …never the player
  })

  it('miss arbitration: empty pull + vet mode:none → the none relay, no leak', async () => {
    const resolve: SubstrateResolver = () =>
      Promise.resolve({ results: '', degraded: false, empty: true })
    const { vet, captured } = spyVet({
      mode: 'none',
      text: 'You search your memory and come up empty.',
      repairAttempted: false,
    })

    mockGateTable({ auto_success: true })
    const result = await runWorldFactLookup(makeDeps(vet), baseInput(resolve))

    expect(captured().resolverDegraded).toBe(false) // empty ≠ degraded
    expect(result.relayText).toBe('You search your memory and come up empty.')
    expect(result.relayText).not.toContain(SECRET)
  })

  it('miss arbitration: resolver THROWS → resolverDegraded:true to the vet (degraded ≠ empty), no raw error / leak', async () => {
    // A throw mid-pull could carry a secret in its message; the orchestrator
    // must never surface it.
    const resolve: SubstrateResolver = () =>
      Promise.reject(new Error(`pg pool exhausted while reading ${SECRET}`))
    const { vet, captured } = spyVet({
      mode: 'relay',
      text: 'You recall what little you can.',
      repairAttempted: false,
    })

    mockGateTable({ auto_success: true })
    const result = await runWorldFactLookup(makeDeps(vet), baseInput(resolve))

    // degraded biases the vet away from invent — and is distinct from empty.
    expect(captured().resolverDegraded).toBe(true)
    expect(captured().results).toBe('')
    expect(result.relayText).toBe('You recall what little you can.')
    // The thrown error's secret-bearing message never reaches the player.
    expect(result.relayText).not.toContain(SECRET)
  })

  it('repair → fail-soft: vet repairAttempted:true → the channel fail-soft relay, NOT the repair-authored (possibly secret-tainted) text', async () => {
    const resolve: SubstrateResolver = () =>
      Promise.resolve({
        results: `[tier=secret] ${SECRET}`,
        degraded: false,
        empty: false,
      })
    // A repaired tree's prose was re-authored by a different model and is NOT
    // tier-safe — model it as carrying the secret to prove it never surfaces.
    const { vet } = spyVet({
      mode: 'relay',
      text: `REPAIR-AUTHORED, UNVETTED: ${SECRET}`,
      repairAttempted: true,
    })

    mockGateTable({ auto_success: true })
    const result = await runWorldFactLookup(makeDeps(vet), baseInput(resolve))

    expect(result.relayText).toBe("You can't quite bring it to mind.")
    expect(result.relayText).not.toContain('REPAIR-AUTHORED')
    expect(result.relayText).not.toContain(SECRET)
  })

  it('fail-soft: vet THROWS → the channel fail-soft relay, never a raw error or unvetted leak', async () => {
    const resolve: SubstrateResolver = () =>
      Promise.resolve({
        results: `[tier=secret] ${SECRET}`,
        degraded: false,
        empty: false,
      })
    const vet: WorldFactLookupVet = () =>
      Promise.reject(new Error(`opus 529 overloaded; context held ${SECRET}`))

    mockGateTable({ auto_success: true })
    const result = await runWorldFactLookup(makeDeps(vet), baseInput(resolve))

    expect(result.relayText).toBe("You can't quite bring it to mind.")
    expect(result.relayText).not.toContain('529')
    expect(result.relayText).not.toContain(SECRET)
  })

  it('fail-soft (NPC channel): vet THROWS → the NPC-flavored fail-soft relay (differs from DM), no leak', async () => {
    const resolve: SubstrateResolver = () =>
      Promise.resolve({
        results: `[tier=secret] ${SECRET}`,
        degraded: false,
        empty: false,
      })
    const vet: WorldFactLookupVet = () => Promise.reject(new Error('opus down'))
    const npcGate: WorldFactLookupInput['gate'] = {
      channel: 'npc',
      topic: 'the Duke and the river bridge',
      worldTone: 'grim and rain-soaked',
      askerSummary: 'A market fishmonger',
      npc: { entityId: 'entity-1', npcName: 'Marsh the Fishmonger' },
    }

    mockGateTable({ auto_success: true })
    const result = await runWorldFactLookup(
      makeDeps(vet),
      baseInput(resolve, { gate: npcGate, npcFraming: 'Marsh, who knows the docks' }),
    )

    expect(result.relayText).toBe("They don't seem to know.")
    expect(result.relayText).not.toContain(SECRET)
  })
})
