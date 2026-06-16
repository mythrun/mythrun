import { beforeEach, describe, expect, it, vi } from 'vitest'
import * as stLookupVet from '../../../llm/st-lookup-vet.js'
import type { VoyageEmbedder } from '../../../llm/embed.js'
import type { StLookupVetInput, StLookupVetOutput } from '../../../llm/st-lookup-vet.js'
import {
  buildLookupDeps,
  type LookupWiringArgs,
  type LookupWiringDeps,
  type LookupWiringRepo,
} from '../lookup-wiring.js'
import type { WorkingSetProposal } from '../../working-set/types.js'

// Mock the Opus ST-vet (it would otherwise spend Opus tokens + hit the network).
// The vet closure under test threads the secret sdPlaybook INTO this call — the
// enforced-ignorance assertion reads what runStLookupVet received.
vi.mock('../../../llm/st-lookup-vet.js', async () => {
  const actual =
    await vi.importActual<typeof import('../../../llm/st-lookup-vet.js')>(
      '../../../llm/st-lookup-vet.js',
    )
  return { ...actual, runStLookupVet: vi.fn() }
})

const mockRunStLookupVet = vi.mocked(stLookupVet.runStLookupVet)

const WORLD_ID = 'w-1'
const CAMPAIGN_ID = 'c-1'
const SESSION_ID = 's-1'
const RECENT = 'The party stands at the gate.'

/** A fake embedder. By default `embedQuery` resolves empty (the resolvers defer
 *  their I/O, so it's never reached in most tests); pass `rejectWith` to make a
 *  real `searchLore` call fail, exercising the TOTAL swallow → searchLogger.warn
 *  forwarder. */
function fakeEmbedder(rejectWith?: Error): VoyageEmbedder {
  return {
    embedDocuments: () => Promise.resolve([]),
    embedQuery: () => (rejectWith ? Promise.reject(rejectWith) : Promise.resolve([])),
  }
}

const silentLogger = { warn: vi.fn() }

/** A fake `LookupWiringRepo`. Overrides let a test set the resolved session
 *  number, the prep row (incl. sdPlaybook), and the entity-id lookup. Cast
 *  through `unknown` to `LookupWiringRepo` — only the methods the wiring reads
 *  are stubbed (transaction/worldRetrieval are never invoked here). */
function fakeRepo(overrides?: {
  session?: { sessionNumber: number } | null
  prep?: { sdPlaybook: string } | null
  entityId?: string | null
  getByCalls?: { campaignId: string; sessionNumber: number }[]
  findIdCalls?: { worldId: string; name: string }[]
}): LookupWiringRepo {
  const session = overrides?.session === undefined ? { sessionNumber: 3 } : overrides.session
  const prep = overrides?.prep === undefined ? { sdPlaybook: 'SECRET PLAYBOOK' } : overrides.prep
  return {
    transaction: vi.fn(),
    worldRetrieval: {} as LookupWiringRepo['worldRetrieval'],
    entities: {
      findIdByWorldAndNormalizedName: (worldId: string, name: string) => {
        overrides?.findIdCalls?.push({ worldId, name })
        return Promise.resolve(overrides?.entityId === undefined ? 'e-1' : overrides.entityId)
      },
    } as unknown as LookupWiringRepo['entities'],
    sessions: {
      getById: () => Promise.resolve(session),
    } as unknown as LookupWiringRepo['sessions'],
    sessionPreps: {
      getBy: (campaignId: string, sessionNumber: number) => {
        overrides?.getByCalls?.push({ campaignId, sessionNumber })
        return Promise.resolve(prep)
      },
    } as unknown as LookupWiringRepo['sessionPreps'],
  }
}

function deps(repo: LookupWiringRepo): LookupWiringDeps {
  return { repo, embedder: fakeEmbedder(), logger: silentLogger }
}

const recordInjection = vi.fn<(p: WorkingSetProposal) => void>()

const args: LookupWiringArgs = {
  worldId: WORLD_ID,
  campaignId: CAMPAIGN_ID,
  sessionId: SESSION_ID,
  recentNarrative: RECENT,
  recordInjection,
}

/** A vet input minus sdPlaybook (the shape the orchestrator hands the closure). */
function vetInput(over?: Partial<Omit<StLookupVetInput, 'sdPlaybook'>>): Omit<
  StLookupVetInput,
  'sdPlaybook'
> {
  return {
    question: 'Who runs the docks?',
    recentNarrative: RECENT,
    channel: 'dm',
    npcFraming: '',
    results: '[tier=known] The Harbormaster',
    resolverDegraded: false,
    worldTone: 'grim',
    ...over,
  }
}

function mockVetOnce(
  result: { mode: 'relay' | 'none' | 'invent'; text: string; tier: 'known' | 'discoverable' | 'secret' },
  repairAttempted = false,
): void {
  // The wiring maps only result/repairAttempted (usage is irrelevant here), so a
  // minimal `usage` cast through `never` keeps the mock terse — the full
  // token-details shape would be dead weight.
  mockRunStLookupVet.mockResolvedValueOnce({
    result,
    usage: {} as never,
    repairAttempted,
  } satisfies StLookupVetOutput)
}

beforeEach(() => {
  vi.clearAllMocks()
})

describe('buildLookupDeps — askerSummary', () => {
  it('dm channel renders the PC-recall line WITH the skill', async () => {
    const result = buildLookupDeps(deps(fakeRepo()), args)
    const summary = await result.askerSummary('dm', { topic: 'the Harbor Guild', skill: 'history' })
    expect(summary).toBe('A player character recalling the Harbor Guild via history.')
  })

  it('dm channel renders the PC-recall line WITHOUT a skill', async () => {
    const result = buildLookupDeps(deps(fakeRepo()), args)
    const summary = await result.askerSummary('dm', { topic: 'the Harbor Guild' })
    expect(summary).toBe('A player character recalling the Harbor Guild.')
  })

  it('npc channel renders the speaking NPC line WITH a name', async () => {
    const result = buildLookupDeps(deps(fakeRepo()), args)
    const summary = await result.askerSummary('npc', { topic: 'the old war', npcName: 'Sera' })
    expect(summary).toBe('Sera, recalling what they know of the old war.')
  })

  it('npc channel falls back to "An onlooker" with no npcName', async () => {
    const result = buildLookupDeps(deps(fakeRepo()), args)
    const summary = await result.askerSummary('npc', { topic: 'the old war' })
    expect(summary).toBe('An onlooker, recalling what they know of the old war.')
  })
})

describe('buildLookupDeps — vet closure (sdPlaybook boundary)', () => {
  it('resolves the session number and threads the secret sdPlaybook into runStLookupVet', async () => {
    const getByCalls: { campaignId: string; sessionNumber: number }[] = []
    const repo = fakeRepo({
      session: { sessionNumber: 7 },
      prep: { sdPlaybook: 'THE SECRET' },
      getByCalls,
    })
    mockVetOnce({ mode: 'relay', text: 'You recall the Harbormaster.', tier: 'known' })

    const result = buildLookupDeps(deps(repo), args)
    const out = await result.vet(vetInput())

    // The prep was read for THIS campaign + the resolved session number.
    expect(getByCalls).toEqual([{ campaignId: CAMPAIGN_ID, sessionNumber: 7 }])
    // The secret sdPlaybook was threaded into the (mocked) vet call alongside the
    // orchestrator's vetInput.
    expect(mockRunStLookupVet).toHaveBeenCalledTimes(1)
    const passed = mockRunStLookupVet.mock.calls[0]?.[0]
    expect(passed?.sdPlaybook).toBe('THE SECRET')
    expect(passed?.question).toBe('Who runs the docks?')
    // The closure surfaces result.mode / result.text / result.tier (MYT-73) +
    // repairAttempted — tier flows out so recordInjection can stamp the fact.
    expect(out).toEqual({
      mode: 'relay',
      text: 'You recall the Harbormaster.',
      tier: 'known',
      repairAttempted: false,
    })
  })

  it('maps repairAttempted through from the vet output', async () => {
    mockVetOnce({ mode: 'none', text: 'Nothing comes to mind.', tier: 'secret' }, true)
    const result = buildLookupDeps(deps(fakeRepo()), args)
    const out = await result.vet(vetInput())
    expect(out.repairAttempted).toBe(true)
    expect(out.mode).toBe('none')
  })

  it('defaults sdPlaybook to "" when the session row is absent (sessionNumber guard)', async () => {
    const getByCalls: { campaignId: string; sessionNumber: number }[] = []
    const repo = fakeRepo({ session: null, getByCalls })
    mockVetOnce({ mode: 'invent', text: 'You half-remember a rumor.', tier: 'discoverable' })

    const result = buildLookupDeps(deps(repo), args)
    await result.vet(vetInput())

    // sessionNumber === 0 → the prep read is SKIPPED entirely…
    expect(getByCalls).toEqual([])
    // …and the playbook defaults to empty.
    expect(mockRunStLookupVet.mock.calls[0]?.[0]?.sdPlaybook).toBe('')
  })

  it('defaults sdPlaybook to "" when the prep row is null (no session_prep yet)', async () => {
    const repo = fakeRepo({ session: { sessionNumber: 2 }, prep: null })
    mockVetOnce({ mode: 'relay', text: 'A faint memory.', tier: 'known' })

    const result = buildLookupDeps(deps(repo), args)
    await result.vet(vetInput())

    expect(mockRunStLookupVet.mock.calls[0]?.[0]?.sdPlaybook).toBe('')
  })
})

describe('buildLookupDeps — enforced ignorance (structural)', () => {
  it('the returned object has NO sdPlaybook key (the secret is captured only inside the vet closure)', () => {
    const result = buildLookupDeps(deps(fakeRepo()), args)
    // The secret never lands on the returned LookupDeps — it lives only inside the
    // vet closure's scope. A spread of `result` into FtToolDeps can never reach it.
    expect('sdPlaybook' in result).toBe(false)
    // Sanity: the public lookup surface IS present (and is exactly these keys).
    expect(Object.keys(result).sort()).toEqual(
      [
        'askerSummary',
        'graph',
        'recentNarrative',
        'recordInjection',
        'resolveEntityId',
        'search',
        'vet',
        'worldId',
      ].sort(),
    )
    expect(result.worldId).toBe(WORLD_ID)
    expect(typeof result.vet).toBe('function')
    expect(typeof result.askerSummary).toBe('function')
    expect(typeof result.resolveEntityId).toBe('function')
    expect(typeof result.recentNarrative).toBe('function')
  })
})

describe('buildLookupDeps — resolveEntityId & recentNarrative', () => {
  it('resolveEntityId passes the worldId + name to the repo and returns its result', async () => {
    const findIdCalls: { worldId: string; name: string }[] = []
    const repo = fakeRepo({ entityId: 'e-42', findIdCalls })
    const result = buildLookupDeps(deps(repo), args)

    const id = await result.resolveEntityId('The Spymaster')

    expect(id).toBe('e-42')
    expect(findIdCalls).toEqual([{ worldId: WORLD_ID, name: 'The Spymaster' }])
  })

  it('resolveEntityId relays a null (no such entity) without throwing', async () => {
    const repo = fakeRepo({ entityId: null })
    const result = buildLookupDeps(deps(repo), args)
    await expect(result.resolveEntityId('Nobody')).resolves.toBeNull()
  })

  it('recentNarrative is a thunk returning the threaded narration string', () => {
    const result = buildLookupDeps(deps(fakeRepo()), args)
    expect(result.recentNarrative()).toBe(RECENT)
  })

  it('recordInjection is threaded straight through from the args (MYT-73 sink)', () => {
    const sink = vi.fn<(p: WorkingSetProposal) => void>()
    const result = buildLookupDeps(deps(fakeRepo()), { ...args, recordInjection: sink })

    // The wiring forwards the exact sink — no wrapping — so the FT tool layer
    // calls the real turn-scoped working-set sink.
    expect(result.recordInjection).toBe(sink)
    const proposal: WorkingSetProposal = {
      kind: 'fact',
      content: 'The docks answer to the Harbormaster.',
      subjectName: 'the docks',
      tier: 'known',
      provenance: { kind: 'objective' },
      source: 'st_injection',
    }
    result.recordInjection(proposal)
    expect(sink).toHaveBeenCalledWith(proposal)
  })
})

describe('buildLookupDeps — search logger forwarder', () => {
  it('a TOTAL searchLore failure routes the warn through to the worker logger', async () => {
    // searchLore is TOTAL (swallows the embed throw → returns []). The swallow
    // path calls the internal searchLogger forwarder, which normalizes the object
    // payload and forwards to the worker MinimalLogger — proving the wiring's
    // logger is reachable through the real search channel.
    const warn = vi.fn<(obj: Record<string, unknown> | string, msg?: string) => void>()
    const wiringDeps: LookupWiringDeps = {
      repo: fakeRepo(),
      embedder: fakeEmbedder(new Error('voyage down')),
      logger: { warn },
    }
    const result = buildLookupDeps(wiringDeps, args)

    const { hits } = await result.search.searchLore(WORLD_ID, 'the docks', {})

    // TOTAL: degraded to [] rather than throwing into the FT…
    expect(hits).toEqual([])
    // …and the failure was forwarded to the worker logger as an object payload
    // carrying the worldId (proving the searchLogger forwarder normalized + routed
    // it through to the worker MinimalLogger).
    expect(warn).toHaveBeenCalledTimes(1)
    expect(warn).toHaveBeenCalledWith(
      expect.objectContaining({ worldId: WORLD_ID }),
      expect.any(String),
    )
  })
})
