// backend/src/llm/prep/stages/__tests__/world-introduction.test.ts
//
// myth-zaqxh — the world_introduction stage. Contract:
//   - assemble the KNOWN-tier slice ONLY (structural enforced ignorance — the
//     ['known'] filter lives in the repo reads, not the prompt);
//   - one OPUS generateObject call; the LLM writes the prose + picks reference
//     NAMES;
//   - resolve reference names → real {entityId, name}, DROP dangling picks;
//   - persist { prose, references } to worlds.introduction (title is the world
//     name, NOT stored); return OPUS cost math.
//
// generateObject at ../../ai.js wraps the SDK's generateText; we mock the SDK
// layer (starting-situation.test.ts pattern). Real-DB round-trip + real-LLM
// register are covered by the constructed-state smoke.

import { beforeEach, describe, expect, it, vi } from 'vitest'
import { runWorldIntroductionStage } from '../world-introduction.js'
import * as ai from 'ai'
import type { VocabularyRegistry } from '../../../schemas/vocabulary-registry.js'
import { makeFakeRepo, type FakeRepo } from './_helpers/fake-repo.js'
import type { Repo } from '../../../../repo/index.js'

vi.mock('ai', async () => {
  const actual = await vi.importActual<typeof import('ai')>('ai')
  return { ...actual, generateText: vi.fn() }
})

const EMPTY_REGISTRY: VocabularyRegistry = { entries: [], adjacent_franchises: [] }

// A known-tier slice: two factions/locations/npcs the intro can reference.
const KNOWN_ENTITIES = [
  { id: 'ent-court', worldId: 'wld-1', entityType: 'faction', name: 'The Ashen Court', accessLevel: 'known' },
  { id: 'ent-docks', worldId: 'wld-1', entityType: 'location', name: 'Cinderdocks', accessLevel: 'known' },
  { id: 'ent-vell', worldId: 'wld-1', entityType: 'npc', name: 'Vell the Magistrate', accessLevel: 'known' },
]

const PROSE =
  'Ashfall is a city the Ashen Court taxes at every gate, where a merchant’s ledger is worth more ' +
  'than their blade. Power runs through Cinderdocks, the wharf the Court leans on to move ash-glass, ' +
  'and Vell the Magistrate keeps the peace by keeping everyone’s debts.'

// references: two resolvable names + one dangling pick that must be dropped.
const OUTPUT = {
  prose: PROSE,
  references: ['The Ashen Court', 'Cinderdocks', 'A Court That Was Never Made'],
}

function mockLlm(output: unknown = OUTPUT, usage = { inputTokens: 2000, outputTokens: 800, totalTokens: 2800 }): void {
  vi.mocked(ai.generateText).mockResolvedValueOnce({
    output,
    finishReason: 'stop',
    usage,
  } as never)
}

function makeRepo(): FakeRepo {
  const repo = makeFakeRepo()
  repo.entities.listByWorld.mockResolvedValue(KNOWN_ENTITIES)
  return repo
}

const baseArgs = {
  worldId: 'wld-1',
  worldName: 'Ashfall',
  tone: 'grim, mercantile',
  themes: 'debt, power',
  vocabularyRegistry: EMPTY_REGISTRY,
}

describe('runWorldIntroductionStage', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('reads ONLY the known-tier slice (structural enforced ignorance)', async () => {
    mockLlm()
    const repo = makeRepo()
    await runWorldIntroductionStage(repo as unknown as Repo, baseArgs)

    // The ['known'] filter is in the reads, not the prompt — every slice read is
    // known-tier-scoped.
    expect(repo.entities.listByWorld).toHaveBeenCalledWith('wld-1', { accessLevels: ['known'] })
    const factsCall = repo.facts.listByEntities.mock.calls[0] as [readonly string[], { accessLevels: string[] }]
    expect(factsCall[1]).toEqual({ accessLevels: ['known'] })
    const relCall = repo.relationships.listAmong.mock.calls[0] as [readonly string[], string[]]
    expect(relCall[1]).toEqual(['known'])
  })

  it('persists prose + resolved references (dangling dropped), NO stored title', async () => {
    mockLlm()
    const repo = makeRepo()
    await runWorldIntroductionStage(repo as unknown as Repo, baseArgs)

    expect(repo.transaction).toHaveBeenCalledTimes(1)
    expect(repo.worlds.setWorldIntroduction).toHaveBeenCalledTimes(1)
    const call = repo.worlds.setWorldIntroduction.mock.calls[0] as [string, string]
    expect(call[0]).toBe('wld-1')
    const persisted = JSON.parse(call[1]) as Record<string, unknown>
    expect(persisted.prose).toBe(PROSE)
    // The dangling third pick is dropped; the two real names resolve to ids.
    expect(persisted.references).toEqual([
      { entityId: 'ent-court', name: 'The Ashen Court' },
      { entityId: 'ent-docks', name: 'Cinderdocks' },
    ])
    // Title is the world name (mechanical) — never persisted in the intro blob.
    expect('title' in persisted).toBe(false)
  })

  it('resolves reference names case-insensitively and de-dupes', async () => {
    mockLlm({ prose: PROSE, references: ['the ashen court', 'THE ASHEN COURT', 'Cinderdocks'] })
    const repo = makeRepo()
    await runWorldIntroductionStage(repo as unknown as Repo, baseArgs)
    const call = repo.worlds.setWorldIntroduction.mock.calls[0] as [string, string]
    const persisted = JSON.parse(call[1]) as { references: unknown[] }
    expect(persisted.references).toEqual([
      { entityId: 'ent-court', name: 'The Ashen Court' },
      { entityId: 'ent-docks', name: 'Cinderdocks' },
    ])
  })

  it('renders the known slice + the register contrast pair into the prompt', async () => {
    mockLlm()
    await runWorldIntroductionStage(makeRepo() as unknown as Repo, baseArgs)
    const call = vi.mocked(ai.generateText).mock.calls.at(0)?.[0] as unknown as { prompt: string }
    const prompt = call.prompt
    expect(prompt).toContain('Ashfall')
    expect(prompt).toContain('The Ashen Court')
    expect(prompt).toContain('Cinderdocks')
    // The register contrast pair (Miklos's verbatim NOT/YES) must be in the prompt.
    expect(prompt).toContain('Bransville is a city where the streets talk')
    expect(prompt).toContain('Bransville is a city dominated by the thieves guild')
    expect(prompt).not.toContain('{{worldName}}')
    expect(prompt).not.toContain('{{knownWorld}}')
  })

  it('filters vocabulary to the known tier (a secret term never reaches the prompt)', async () => {
    mockLlm()
    const registry: VocabularyRegistry = {
      entries: [
        { term: 'ash-glass', definition: 'the city’s trade currency', avoids: '', source: 'stage_1_5', access_level: 'known' },
        { term: 'the Hollow King', definition: 'the secret power behind the Court', avoids: '', source: 'stage_1_5', access_level: 'secret' },
      ],
      adjacent_franchises: [],
    }
    await runWorldIntroductionStage(makeRepo() as unknown as Repo, { ...baseArgs, vocabularyRegistry: registry })
    const call = vi.mocked(ai.generateText).mock.calls.at(0)?.[0] as unknown as { prompt: string }
    expect(call.prompt).toContain('ash-glass')
    expect(call.prompt).not.toContain('the Hollow King')
  })

  it('renders known facts, prose kernels, and relationships into the slice block', async () => {
    mockLlm()
    const repo = makeRepo()
    repo.proseKernels.listByEntities.mockResolvedValue([
      { id: 'pk-1', entityId: 'ent-court', content: 'A guild of magistrates who own the tax rolls.', createdAt: new Date(), updatedAt: new Date() },
    ])
    repo.facts.listByEntities.mockResolvedValue([
      { id: 'ft-1', entityId: 'ent-court', topic: 'tithe', content: 'They take a cut at every gate.', accessLevel: 'known', narrativeStatus: 'undelivered', source: 'prep', createdAt: new Date(), updatedAt: new Date() },
      // A second fact on the SAME entity — exercises the group-by push path.
      { id: 'ft-2', entityId: 'ent-court', topic: 'seat', content: 'They meet in the old customs house.', accessLevel: 'known', narrativeStatus: 'undelivered', source: 'prep', createdAt: new Date(), updatedAt: new Date() },
    ])
    repo.relationships.listAmong.mockResolvedValue([
      { id: 'rl-1', sourceEntityId: 'ent-court', targetEntityId: 'ent-docks', relationshipType: 'controls', description: 'through the harbormaster', accessLevel: 'known', createdAt: new Date(), synthKey: 'x' },
      // No description → the line renders without a trailing ": ...".
      { id: 'rl-2', sourceEntityId: 'ent-vell', targetEntityId: 'ent-court', relationshipType: 'serves', description: '', accessLevel: 'known', createdAt: new Date(), synthKey: 'y' },
    ])
    await runWorldIntroductionStage(repo as unknown as Repo, baseArgs)
    const prompt = (vi.mocked(ai.generateText).mock.calls.at(0)?.[0] as unknown as { prompt: string }).prompt
    expect(prompt).toContain('A guild of magistrates who own the tax rolls.')
    expect(prompt).toContain('tithe: They take a cut at every gate.')
    expect(prompt).toContain('The Ashen Court controls Cinderdocks: through the harbormaster')
    expect(prompt).toContain('Vell the Magistrate serves The Ashen Court')
  })

  it('tolerates a world with no known entities (renders a placeholder, drops all refs)', async () => {
    mockLlm()
    const repo = makeFakeRepo() // listByWorld defaults to []
    await runWorldIntroductionStage(repo as unknown as Repo, baseArgs)
    const prompt = (vi.mocked(ai.generateText).mock.calls.at(0)?.[0] as unknown as { prompt: string }).prompt
    expect(prompt).toContain('(no entities yet)')
    const call = repo.worlds.setWorldIntroduction.mock.calls[0] as [string, string]
    expect((JSON.parse(call[1]) as { references: unknown[] }).references).toEqual([])
  })

  it('returns OPUS cost math + token passthrough', async () => {
    mockLlm(OUTPUT, { inputTokens: 2000, outputTokens: 800, totalTokens: 2800 })
    const result = await runWorldIntroductionStage(makeRepo() as unknown as Repo, baseArgs)
    // OPUS: (2000 * 5.0 + 800 * 25.0) / 1e6 = 0.03
    expect(result.costUsd).toBeCloseTo(0.03, 6)
    expect(result.inputTokens).toBe(2000)
    expect(result.outputTokens).toBe(800)
  })
})
