// backend/src/session/__tests__/scribe-leak.test.ts
//
// MYT-73 T12 — the enforced-ignorance LEAK MATRIX for the Scribe reconciler.
// The load-bearing security proof that a CORE SECRET (the prep's sd_playbook)
// NEVER reaches a player through the post-turn Scribe flow. The Scribe job
// embeds the turn's proposed facts, runs a Haiku secret tripwire over the
// player-facing prose, and on a core-secret breach authors (Opus) a
// secret-preserving retcon `Z` delivered via a player-less correction turn.
// Every link of that boundary is a place a secret could escape; each case
// below proves one link holds, DETERMINISTICALLY — the real-Opus / real-Haiku
// QUALITY is proven separately by the gated real-LLM smoke (myt-73-scribe-smoke).
//
// The five links, each proven by a case:
//   (a) A malformed tripwire output carrying a secret is REDACTED from logs /
//       diagnostics (redactRawText) — the secret never spills into
//       pipeline_runs.error / SSE.
//   (b) The retcon `Z` never reveals the secret (a SEMANTIC leak check, not a
//       single-token substring) — and that leak check can actually FAIL.
//   (c) The working set never holds a raw sd_playbook secret string — the
//       retcon supersede carries only the secret-free `Z`; the opaque secretRef
//       handle rides `subjectName`.
//   (d) An `attributed` NPC-claim working-set item never elevates to objective
//       truth in the search_lore read-merge relay (it renders `[claim by {npc}]`).
//   (e) A secret-tier working-set item never appears in buildModelMessages /
//       FtTurnContext.workingSet — the FT ignores `workingSet` entirely.
//
// Mock posture (mirrors world-lookup-leak.test.ts + secret-tripwire.test.ts):
//   - case (a) drives runSecretTripwire down its terminal-failure path with
//     `vi.mock('ai')` returning controlled (secret-bearing) outputs. We mock the
//     `'ai'` SDK boundary (generateText), NOT ai.ts — the wrapper's
//     generateObject drives the SDK's generateText (Output.object) underneath.
//   - cases (b)+(c) drive the real processScribeJob with INJECTED tripwire /
//     retcon spies (ScribeProcessorDeps), a real ioredis-mock working set, and
//     recording fakes — no LLM call, so the boundary is deterministic.
//   - case (d) drives the REAL search_lore execute closure (the T8 cosine-merge),
//     reading the rendered results string just as world-fact-lookup does.
//   - case (e) constructs an FtTurnContext with a FORCED secret-tier workingSet
//     item and calls the real buildModelMessages.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as ai from 'ai'
import type { ToolExecutionOptions, ToolSet } from 'ai'
import RedisMock from 'ioredis-mock'
import type { Redis } from 'ioredis'

import { runSecretTripwire } from '../../llm/secret-tripwire.js'
import { LlmStructuredOutputError } from '../../llm/errors.js'
import type { LlmCallDiagnostic } from '../../llm/ai.js'
import { logger } from '../../llm/logger.js'

import { processScribeJob, type ScribeProcessorDeps } from '../scribe-worker.js'
import { makeWorkingSetRepo } from '../../redis/working-set.js'
import type { ScribeJobPayload } from '../scribe-queue.js'
import type { TurnJobPayload } from '../turn-queue.js'
import type { SecretTripwireOutput } from '../../llm/secret-tripwire.js'
import type { RetconAuthorOutput } from '../../llm/retcon-author.js'
import type { WorkingSetItem } from '../working-set/types.js'

import { buildFtTools, type FtToolDeps } from '../tiers/ft-tools.js'
import { buildModelMessages } from '../tiers/fast-thinker.js'
import type { FtTurnContext } from '../tiers/types.js'
import type { WorldFactLookupResult, WorldFactLookupVet } from '../world-fact-lookup.js'
import * as worldFactLookup from '../world-fact-lookup.js'
import type { SearchResolvers } from '../../world/retrieval/search.js'
import type { GraphDeps } from '../../world/retrieval/graph.js'
import type { MechanicalReads } from '../skill-check.js'
import type { Character } from '../../repo/types.js'
import type { LedgerOps, LedgerTxRunner } from '../rules-lawyer.js'

// The ONE unmistakable SECRET sentinel every leak assertion checks. If this
// exact string surfaces in a player-facing relay / a persisted working-set item
// / a model-message array / a log / a diagnostic, a core secret leaked.
const SECRET = 'XYZZY-SECRET-RETCON-c0ffee'

// The distinctive tokens a leaky retcon would surface — the semantic leak set
// (case (b)). NOT a single-token substring: a paraphrase that drops the literal
// sentinel but keeps the secret's distinctive nouns is still a leak.
const SECRET_PARAPHRASE_TOKENS = [SECRET, 'Vex201-the-hidden-heir', 'Obsidian-Cabal-XYZZY']

// The full secret playbook string — the raw sd_playbook the tripwire + retcon
// reason over. It must never appear, verbatim or in distinctive part, in any
// player-facing surface.
const SD_PLAYBOOK =
  `CORE SECRET: the innkeeper is Vex201-the-hidden-heir, secretly bound to the ` +
  `Obsidian-Cabal-XYZZY. Sentinel ${SECRET}. Never reveal to players.`

vi.mock('ai', async (importOriginal) => ({
  ...(await importOriginal<typeof import('ai')>()),
  generateText: vi.fn(),
}))
const mockGenerateText = vi.mocked(ai.generateText)

// For case (d) the search_lore tool calls the real orchestrator; mock it so the
// test exercises the TOOL's read-merge closure (the T8 cosine-merge + render),
// not the full gate/resolve/vet flow (its own tested unit).
vi.mock('../world-fact-lookup.js', async () => {
  const actual =
    await vi.importActual<typeof import('../world-fact-lookup.js')>('../world-fact-lookup.js')
  return { ...actual, runWorldFactLookup: vi.fn() }
})
const mockRunWorldFactLookup = vi.mocked(worldFactLookup.runWorldFactLookup)

beforeEach(() => {
  vi.clearAllMocks()
})

// ===========================================================================
// (a) tripwire terminal-failure path is redacted
//
// Structurally identical to world-lookup-leak.test.ts case (c): drive
// runSecretTripwire down the terminal-failure path with a raw model response
// embedding the SECRET. `redactRawText: true` must keep that secret out of the
// rethrown error's `.diagnostic` AND every WARN-log argument — a malformed
// Haiku/Sonnet response must not spill a secret into pipeline_runs.error / SSE.
// ===========================================================================

describe('MYT-73 T12 leak matrix — (a) tripwire terminal failure is redacted', () => {
  it('a secret-bearing malformed tripwire output never reaches the diagnostic or the WARN log', async () => {
    const warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => undefined)

    // The primary call rejects with a structured error whose rawText parses as
    // JSON but fails Zod (confidence out of range) and embeds the SECRET.
    const originalErr = new LlmStructuredOutputError('llm returned unparseable structured output', {
      cause: {
        text: JSON.stringify({ breached: true, confidence: 9, secretRef: SECRET }),
        name: 'AI_NoObjectGeneratedError',
      },
    })
    mockGenerateText.mockRejectedValueOnce(originalErr)
    // Haiku repair: still Zod-invalid (still secret-bearing).
    mockGenerateText.mockResolvedValueOnce({
      output: { breached: true, confidence: 9, secretRef: SECRET },
      usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
    } as never)
    // Sonnet repair: still Zod-invalid → terminal failure.
    mockGenerateText.mockResolvedValueOnce({
      output: { breached: true, confidence: 9, secretRef: SECRET },
      usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
    } as never)

    let caught: unknown
    try {
      await runSecretTripwire({
        prose: `The innkeeper bows: "I am ${SECRET}, the hidden heir."`,
        secrets: `[SECRET-1] ${SD_PLAYBOOK}`,
      })
    } catch (err) {
      caught = err
    }

    expect(caught).toBe(originalErr)
    const diag = (caught as { diagnostic?: LlmCallDiagnostic }).diagnostic
    expect(diag).toBeDefined()
    expect(diag?.callSite).toBe('secret-tripwire')
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
})

// ===========================================================================
// Scribe processor harness for (b) + (c). A real ioredis-mock working set, a
// real makeWorkingSetRepo, recording fakes for repo/triggerState/queue, and
// INJECTED tripwire/retcon spies (so the boundary is deterministic — no LLM).
// ===========================================================================

const CAMPAIGN = 'c-leak-1'
const SESSION = 's-leak-1'
const WORLD = 'w-leak-1'
const TURN = 't-leak-1'

function tripwireBreach(secretRef = '[SECRET-1]'): SecretTripwireOutput {
  return {
    result: { breached: true, confidence: 0.4, secretRef },
    usage: { totalTokens: 5 } as unknown as SecretTripwireOutput['usage'],
    repairAttempted: false,
  }
}

function retconOut(retconText: string): RetconAuthorOutput {
  return {
    result: { retconText, supersededContent: 'the innkeeper is just an innkeeper', tier: 'known' },
    usage: { totalTokens: 200 } as unknown as RetconAuthorOutput['usage'],
    repairAttempted: false,
  }
}

interface ScribeHarness {
  deps: ScribeProcessorDeps
  redis: Redis
  workingSetLoad: () => Promise<WorkingSetItem[]>
  enqueuedTurns: TurnJobPayload[]
}

// ioredis-mock shares ONE in-memory backing store across `new RedisMock()`
// instances, so a fresh instance does NOT isolate working-set state — a unique
// key prefix per harness does. Bump it per harness so cases don't bleed.
let harnessSeq = 0

function makeScribeHarness(
  runTripwire: ScribeProcessorDeps['runTripwire'],
  runRetcon: ScribeProcessorDeps['runRetcon'],
): ScribeHarness {
  const redis: Redis = new RedisMock()
  const repo = makeWorkingSetRepo(redis, `leaktest-${String(harnessSeq++)}:`)
  const enqueuedTurns: TurnJobPayload[] = []

  const deps: ScribeProcessorDeps = {
    repo: {
      sessions: { getActiveByCampaign: () => Promise.resolve({ sessionNumber: 3 }) },
      sessionPreps: { getBy: () => Promise.resolve({ sdPlaybook: SD_PLAYBOOK }) },
    },
    triggerState: { getRespondedSeq: () => Promise.resolve(7) },
    workingSet: {
      load: (c) => repo.load(c),
      append: (c, items) => repo.append(c, items),
      evictIfOver: (c, cap) => repo.evictIfOver(c, cap),
    },
    embedder: {
      // Deterministic 3-dim vectors — the working-set merge is irrelevant here.
      embedDocuments: (texts) => Promise.resolve(texts.map((_t, i) => [i, i + 1, i + 2])),
    },
    runTripwire,
    runRetcon,
    sessionTurnQueue: {
      add: ((_name: string, payload: TurnJobPayload) => {
        enqueuedTurns.push(payload)
        return Promise.resolve({})
      }) as ScribeProcessorDeps['sessionTurnQueue']['add'],
    },
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  }

  return { deps, redis, workingSetLoad: () => repo.load(CAMPAIGN), enqueuedTurns }
}

function scribeJob(over: Partial<ScribeJobPayload> = {}): { data: ScribeJobPayload } {
  return {
    data: {
      campaignId: CAMPAIGN,
      sessionId: SESSION,
      turnId: TURN,
      worldId: WORLD,
      // The FT's player-facing prose BREAKS the secret (states it openly).
      prose: `The innkeeper leans in: "I am ${SECRET}, the hidden heir, bound to the Obsidian-Cabal-XYZZY."`,
      worldDelta: null,
      injections: [],
      ...over,
    },
  }
}

/** The semantic leak check: does `text` reveal ANY distinctive token of the
 *  secret (the literal sentinel OR a paraphrase noun)? Returns the leaked tokens.
 *  Case (b) proves both that this CATCHES a leaky retcon and that the clean
 *  retcon passes it. */
function leakedTokens(text: string): string[] {
  return SECRET_PARAPHRASE_TOKENS.filter((t) => text.includes(t))
}

// ===========================================================================
// (b) the retcon `Z` never reveals the secret — a SEMANTIC check that can FAIL
// ===========================================================================

describe('MYT-73 T12 leak matrix — (b) the retcon Z never reveals the secret', () => {
  it('a CLEAN retcon spy → the correction text + working-set retcon item pass the semantic leak check', async () => {
    const cleanZ = 'Correction — the innkeeper is no one of note; forget the bow, it was a trick of the light.'
    const runTripwire = vi.fn().mockResolvedValue(tripwireBreach())
    const runRetcon = vi.fn().mockResolvedValue(retconOut(cleanZ))
    const h = makeScribeHarness(runTripwire, runRetcon)

    await processScribeJob(h.deps, scribeJob())

    // The enqueued correction turn carries the secret-free Z.
    expect(h.enqueuedTurns).toHaveLength(1)
    const correction = h.enqueuedTurns[0]
    expect(correction?.trigger.kind).toBe('correction')
    expect(correction?.correctionText).toBe(cleanZ)
    expect(leakedTokens(correction?.correctionText ?? '')).toEqual([])

    // The working-set retcon supersede carries only the clean Z.
    const ws = await h.workingSetLoad()
    const retcon = ws.find((i) => i.source === 'retcon')
    expect(retcon).toBeDefined()
    expect(leakedTokens(retcon?.content ?? '')).toEqual([])
  })

  it('a LEAKY retcon spy → the semantic leak check CATCHES it (break-it-to-prove-it)', async () => {
    // A retcon that drops the literal sentinel but keeps the secret's distinctive
    // nouns (paraphrase leak) — the substring check would miss the sentinel but
    // the paraphrase-token set CATCHES it.
    const leakyZ = 'Correction — the innkeeper is in fact Vex201-the-hidden-heir, of the Obsidian-Cabal-XYZZY.'
    const runTripwire = vi.fn().mockResolvedValue(tripwireBreach())
    const runRetcon = vi.fn().mockResolvedValue(retconOut(leakyZ))
    const h = makeScribeHarness(runTripwire, runRetcon)

    await processScribeJob(h.deps, scribeJob())

    const correction = h.enqueuedTurns[0]
    // The leak check FIRES — proving the assertion in the clean case above can
    // actually fail (the security proof is load-bearing, not vacuous).
    const leaks = leakedTokens(correction?.correctionText ?? '')
    expect(leaks.length).toBeGreaterThan(0)
    expect(leaks).toContain('Vex201-the-hidden-heir')
    expect(leaks).toContain('Obsidian-Cabal-XYZZY')
  })
})

// ===========================================================================
// (c) the working set never contains a raw sd_playbook secret string
// ===========================================================================

describe('MYT-73 T12 leak matrix — (c) the working set holds no raw secret', () => {
  it('after a breach + a secret-free retcon, no working-set item serializes the raw secret / sd_playbook', async () => {
    const cleanZ = 'Correction — the innkeeper kept to themselves; pay them no mind.'
    const runTripwire = vi.fn().mockResolvedValue(tripwireBreach('[SECRET-1]'))
    const runRetcon = vi.fn().mockResolvedValue(retconOut(cleanZ))
    const h = makeScribeHarness(runTripwire, runRetcon)

    await processScribeJob(h.deps, scribeJob())

    const ws = await h.workingSetLoad()
    expect(ws.length).toBeGreaterThan(0)
    // NO item's serialized JSON carries the raw SECRET, any paraphrase token, or
    // the sd_playbook text. The retcon supersede carries only the secret-free Z;
    // its subjectName is the OPAQUE secretRef handle, not the secret.
    const serialized = JSON.stringify(ws)
    expect(serialized).not.toContain(SECRET)
    expect(serialized).not.toContain('Vex201-the-hidden-heir')
    expect(serialized).not.toContain('Obsidian-Cabal-XYZZY')
    expect(serialized).not.toContain(SD_PLAYBOOK)

    // The retcon item's subjectName is the opaque handle (not secret-derived),
    // and the secret-bearing `supersededContent` is NEVER persisted (§8c) — the
    // real-LLM smoke proved Opus fills it with the secret-naming false statement.
    const retcon = ws.find((i) => i.source === 'retcon')
    expect(retcon?.subjectName).toBe('[SECRET-1]')
    expect(retcon?.content).toBe(cleanZ)
    expect(retcon?.supersededContent).toBeUndefined()
  })
})

// ===========================================================================
// (d) an `attributed` NPC-claim item never elevates to objective truth
//
// The messy merge (Tikal-I2): build a working set holding an `attributed` item
// whose content carries a claim, surfaced by a LATER search_lore BESIDE
// objective canon hits, asked by a DIFFERENT asker. The rendered lore block —
// produced by the REAL T8 read-merge (cosine-merge + renderLoreHits) — must tag
// the attributed item as `[claim by {npc}]`, NEVER as objective canon.
// ===========================================================================

// The search_lore tool surface fakes (mirrors ft-tools.test.ts). We exercise the
// real read-merge closure the tool hands the (mocked) orchestrator.
function makeCharacter(): Character {
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
  }
}

function foundMech(): MechanicalReads {
  return {
    findSessionParticipantCharacterByName: vi.fn().mockResolvedValue({
      outcome: 'found',
      character: makeCharacter(),
      skills: [{ skill_name: 'History', proficiency_level: 'proficient' }],
    }),
  }
}

function fakeLedger(): LedgerOps {
  const unimplemented =
    (name: string) =>
    (): never => {
      throw new Error(`fakeLedger.${name} not stubbed`)
    }
  return {
    findLedgerCharacterByName: unimplemented('findLedgerCharacterByName'),
    debitGold: unimplemented('debitGold'),
    creditGold: unimplemented('creditGold'),
    debitItem: unimplemented('debitItem'),
    acquireItem: unimplemented('acquireItem'),
    debitFeatureUse: unimplemented('debitFeatureUse'),
    debitSpellSlot: unimplemented('debitSpellSlot'),
    readSpellSlots: unimplemented('readSpellSlots'),
    readCharacterSpells: unimplemented('readCharacterSpells'),
    writeHp: unimplemented('writeHp'),
    applyCondition: unimplemented('applyCondition'),
    clearCondition: unimplemented('clearCondition'),
    shortRest: unimplemented('shortRest'),
    longRest: unimplemented('longRest'),
    readRestParticipants: unimplemented('readRestParticipants'),
    writeLedgerEvent: unimplemented('writeLedgerEvent'),
    findLedgerEvent: unimplemented('findLedgerEvent'),
    readPartyLedgerSnapshot: unimplemented('readPartyLedgerSnapshot'),
  }
}

const passthroughTx: LedgerTxRunner = (fn) => fn(fakeLedger())

/** A real cosine (empty/zero/mismatched → 0) for the merge ranking. */
function realCosine(a: readonly number[], b: readonly number[]): number {
  if (a.length === 0 || a.length !== b.length) return 0
  let dot = 0
  let na = 0
  let nb = 0
  for (let i = 0; i < a.length; i++) {
    const x = a[i] ?? 0
    const y = b[i] ?? 0
    dot += x * y
    na += x * x
    nb += y * y
  }
  if (na === 0 || nb === 0) return 0
  return dot / (Math.sqrt(na) * Math.sqrt(nb))
}

const fakeVet: WorldFactLookupVet = vi
  .fn()
  .mockResolvedValue({ mode: 'relay', text: '', tier: 'known', repairAttempted: false })

const DM_RELAY: WorldFactLookupResult = {
  relayText: 'You recall what little you can of the harbor.',
  rollHidden: false,
  vetMode: 'relay',
  vetTier: 'known',
}

function searchLoreDeps(
  search: SearchResolvers,
  workingSet: () => Promise<WorkingSetItem[]>,
): FtToolDeps {
  return {
    mech: foundMech(),
    sessionId: 'session-1',
    worldTone: 'grim and rain-soaked',
    ledger: fakeLedger(),
    runInTx: passthroughTx,
    turnId: 'turn-1',
    worldId: 'world-1',
    search,
    graph: {} as GraphDeps,
    resolveEntityId: vi.fn().mockResolvedValue('ent-1'),
    recentNarrative: () => 'the recent narration',
    vet: fakeVet,
    askerSummary: vi.fn().mockResolvedValue('a public asker summary'),
    recordInjection: vi.fn(),
    workingSet,
    cosine: realCosine,
    // MYT-75 combat surface — inert here (the scribe-leak suite drives only the
    // lookup tools; the combat tools never execute on this path).
    combatParty: vi.fn().mockResolvedValue([]),
    recordCombat: vi.fn(),
    pendingInitiate: vi.fn().mockReturnValue(null),
  }
}

function requireExecute(
  tools: ToolSet,
  name: string,
): (input: unknown, opts: ToolExecutionOptions) => unknown {
  const exec = tools[name]?.execute
  if (exec === undefined) throw new Error(`${name}.execute missing`)
  return exec
}

describe('MYT-73 T12 leak matrix — (d) an attributed NPC-claim never elevates to objective truth', () => {
  it('a later search_lore (DIFFERENT asker) renders the attributed item as [claim by {npc}], canon as objective', async () => {
    mockRunWorldFactLookup.mockResolvedValue(DM_RELAY)

    // An OBJECTIVE canon hit (true in-world) beside the attributed working-set item.
    const canonHits = [
      {
        source: 'fact' as const,
        entityId: 'e-canon',
        entityName: 'The Harbor',
        content: 'The harbor was rebuilt after the floods.',
        accessLevel: 'known' as const,
        score: 0.95,
      },
    ]
    // The attributed item: a CLAIM by an NPC (Marsh) — recorded on a PRIOR NPC
    // turn — now surfaced on a DM-channel recall by a DIFFERENT asker (Vire).
    const attributedItem: WorkingSetItem = {
      id: 'ws-attr-1',
      turnId: 'prev-turn',
      kind: 'fact',
      content: 'The harbor secretly answers to the smugglers.',
      subjectName: 'the harbor',
      tier: 'known',
      provenance: { kind: 'attributed', npcEntityId: 'npc-marsh', npcName: 'Marsh the Fishmonger' },
      source: 'st_injection',
      embedding: [1, 0, 0],
    }

    const search: SearchResolvers = {
      searchLore: vi.fn().mockResolvedValue({ hits: canonHits, queryVec: [1, 0, 0] }),
      findSimilarEntities: vi.fn().mockResolvedValue([]),
    }
    const workingSet = vi
      .fn<() => Promise<WorkingSetItem[]>>()
      .mockResolvedValue([attributedItem])

    const tools = buildFtTools(searchLoreDeps(search, workingSet))
    const exec = requireExecute(tools, 'search_lore')
    // The DM-channel asker (Vire) is a DIFFERENT asker than the NPC who claimed it.
    await exec(
      { channel: 'dm', topic: 'the harbor', skill: 'history', asker_name: 'Vire' },
      { toolCallId: 'c1', messages: [] },
    )

    // Pull the resolve closure the tool handed the (mocked) orchestrator and run
    // it — this is the REAL T8 cosine-merge + renderLoreHits, the same rendered
    // string the ST-vet reads.
    const lastCall = mockRunWorldFactLookup.mock.calls.at(-1)
    if (lastCall === undefined) throw new Error('runWorldFactLookup not called')
    const resolved = await lastCall[1].resolve()

    // The attributed item is tagged a CLAIM — never objective truth.
    expect(resolved.results).toContain('[claim by Marsh the Fishmonger]')
    expect(resolved.results).toContain('The harbor secretly answers to the smugglers.')
    // The objective canon hit is NOT tagged as a claim (it renders plain).
    expect(resolved.results).toContain('[tier=known] The Harbor: The harbor was rebuilt after the floods.')
    expect(resolved.results).not.toContain('[claim by Marsh the Fishmonger] [tier=known] The Harbor')
    // The attributed line carries the claim prefix BEFORE its tier annotation.
    const attrLine = resolved.results
      .split('\n')
      .find((l) => l.includes('The harbor secretly answers to the smugglers.'))
    expect(attrLine).toBeDefined()
    expect(attrLine?.startsWith('[claim by Marsh the Fishmonger]')).toBe(true)
  })
})

// ===========================================================================
// (e) a secret-tier working-set item never appears in buildModelMessages
//
// Construct an FtTurnContext whose `workingSet` is FORCED to carry a secret-tier
// item bearing the SECRET (a hostile/buggy caller — workingSet is pinned `[]` in
// production). buildModelMessages must IGNORE workingSet entirely: the rendered
// message array carries no trace of the secret.
// ===========================================================================

describe('MYT-73 T12 leak matrix — (e) a secret-tier workingSet item never reaches buildModelMessages', () => {
  it('buildModelMessages ignores FtTurnContext.workingSet even when forced to carry a secret', () => {
    const secretItem: WorkingSetItem = {
      id: 'ws-secret-1',
      turnId: 'turn-1',
      kind: 'fact',
      content: `The innkeeper is ${SECRET}, the hidden heir.`,
      subjectName: SECRET,
      tier: 'secret',
      provenance: { kind: 'objective' },
      source: 'retcon',
      supersededContent: SD_PLAYBOOK,
      embedding: [],
    }

    // A hostile caller forces a populated workingSet (production pins it `[]`).
    const ctx: FtTurnContext = {
      campaignId: CAMPAIGN,
      ftContext: 'A weathered harbor town under grey rain.',
      ftHistory: [
        {
          v: 1,
          role: 'user',
          characterName: 'Vire',
          parts: [{ kind: 'text', text: 'I ask the innkeeper who they are.' }],
        },
      ],
      participants: ['Vire'],
      usage: { input: 0, output: 0 },
      workingSet: [secretItem],
    }

    const messages = buildModelMessages(ctx)
    const serialized = JSON.stringify(messages)
    // The FT renderer never reads workingSet — the secret cannot leak even from a
    // hostile/buggy caller that populated it.
    expect(serialized).not.toContain(SECRET)
    expect(serialized).not.toContain(SD_PLAYBOOK)
    // Positive control: the public ftContext + the player turn DID render.
    expect(serialized).toContain('A weathered harbor town under grey rain.')
    expect(serialized).toContain('I ask the innkeeper who they are.')
  })
})

afterEach(() => {
  vi.restoreAllMocks()
})
