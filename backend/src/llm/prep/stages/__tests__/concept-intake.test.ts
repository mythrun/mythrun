// backend/src/llm/prep/stages/__tests__/concept-intake.test.ts
//
// Per MYT-51 T6: stage handler integrates the paint-job-validator loop
// (generator + judge) and persists the validated draft. The validator's
// internals are covered by paint-job-validator.test.ts — here we only
// assert the stage's contract: generator + judge get called, the UPDATE
// SQL fires with the right bindings, and the returned StageCostResult
// reflects the summed Sonnet usage from both calls.

import { beforeEach, describe, expect, it, vi } from 'vitest'
import { runConceptIntakeStage } from '../concept-intake.js'
import * as ai from 'ai'
import { makeFakeRepo } from './_helpers/fake-repo.js'
import type { Repo } from '../../../../repo/index.js'
import { OPUS, SONNET } from '../../../models.js'
import { computeCostUsd } from '../../../../billing/model-pricing.js'

vi.mock('ai', async () => {
  const actual = await vi.importActual<typeof import('ai')>('ai')
  return { ...actual, generateText: vi.fn() }
})

const DRAFT = {
  name: 'Aelmoor',
  tone: 'misted, melancholy, watchful',
  themes: 'guardianship, secrets, weather over still water',
  geography_summary:
    'A windswept highland archipelago on the edge of an older, drowned power — long causeways between black islands.',
  political_summary:
    'Three rival lighthouse-houses, each binding storm-spirits into their lamps; the queen rules from a fourth that has gone dark.',
  era: 'a lantern-age before steam, after the last great storm-pact failed',
  key_tensions:
    'The spirits chafe in the lanterns. One house has gone silent for a year. The drowned power below has begun to dream again, and its dreams smell of salt and copper.',
  follow_up_questions:
    'Who lit the silent house? Why is the queen no longer in residence? What watches from the cliffs at the spring tides?',
}

describe('runConceptIntakeStage', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('runs the validator, persists to worlds columns, and returns aggregated cost', async () => {
    // Generator call:
    vi.mocked(ai.generateText).mockResolvedValueOnce({
      output: DRAFT,
      finishReason: 'stop',
      usage: { inputTokens: 800, outputTokens: 600, totalTokens: 1400 },
    } as never)
    // Judge call — clean:
    vi.mocked(ai.generateText).mockResolvedValueOnce({
      output: { flagged: false, confidence: 0.95, mirroredWork: null, specificDriftAxes: [] },
      finishReason: 'stop',
      usage: { inputTokens: 200, outputTokens: 100, totalTokens: 300 },
    } as never)

    const repo = makeFakeRepo()
    const result = await runConceptIntakeStage(repo as unknown as Repo, {
      worldId: 'wld-1',
      campaignId: 'camp-1',
      conceptText: 'lighthouse-keepers tending storm spirits',
      intentSummary: null,
      acceptedTitle: null,
    })

    // myth-4lhr: concept_intake now issues TWO writes inside one
    // repo.transaction — worlds.applyConcept (the LLM-synthesized concept
    // columns), then campaigns.setNameFromUntitled (the name propagation so
    // campaigns.name stops being 'Untitled'). Post data-layer-unification the
    // writes go through the repo binders; the binders' SQL is covered by the
    // repo integration tests. Here we assert the persistence contract at the
    // binder-call level + that both run inside the same transaction callback.
    expect(repo.transaction).toHaveBeenCalledTimes(1)
    expect(repo.worlds.applyConcept).toHaveBeenCalledTimes(1)
    expect(repo.worlds.applyConcept).toHaveBeenCalledWith('wld-1', {
      name: 'Aelmoor',
      tone: DRAFT.tone,
      themes: DRAFT.themes,
      geographySummary: DRAFT.geography_summary,
      politicalSummary: DRAFT.political_summary,
      era: DRAFT.era,
      keyTensions: DRAFT.key_tensions,
      followUpQuestions: DRAFT.follow_up_questions,
    })
    expect(repo.campaigns.setNameFromUntitled).toHaveBeenCalledTimes(1)
    expect(repo.campaigns.setNameFromUntitled).toHaveBeenCalledWith('wld-1', 'Aelmoor')

    // myth-rg09: cost is now mixed-tier — the generator runs on Opus, the
    // judge stays on Sonnet, priced per-tier by the validator. The stage
    // forwards result.costUsd verbatim (it no longer prices anything itself).
    // Opus generator (800 in / 600 out) + Sonnet judge (200 in / 100 out):
    //   (800*5 + 600*25)/1M + (200*3 + 100*15)/1M = 0.019 + 0.0021 = 0.0211
    const expectedCost =
      computeCostUsd('claude-opus-5', { inputTokens: 800, outputTokens: 600 }) +
      computeCostUsd('claude-sonnet-5', { inputTokens: 200, outputTokens: 100 })
    expect(result.costUsd).toBeCloseTo(expectedCost, 10)
    expect(result.costUsd).toBeCloseTo(0.0211, 10)
    expect(result.inputTokens).toBe(1000)
    expect(result.outputTokens).toBe(700)
  })

  it('keeps a human-ACCEPTED title: deterministic name override + prompt directive (myth walk 2026-07-29)', async () => {
    // The guided flow shows the player a titled preview; Begin is acceptance.
    // Renaming after acceptance is a continuity break (the player accepted
    // "The Delta of Three Turtles" and got "The Dreaming Shell"). With an
    // acceptedTitle the stage (a) tells the model the canonical title so tone/
    // themes prose aligns with it, and (b) deterministically applies it as the
    // name regardless of what the model echoes — pass-through of a human
    // decision, not code judgment (ZFC-clean).
    vi.mocked(ai.generateText).mockResolvedValueOnce({
      output: DRAFT, // model still answers name 'Aelmoor' — it must NOT win
      finishReason: 'stop',
      usage: { inputTokens: 800, outputTokens: 600, totalTokens: 1400 },
    } as never)
    vi.mocked(ai.generateText).mockResolvedValueOnce({
      output: { flagged: false, confidence: 0.95, mirroredWork: null, specificDriftAxes: [] },
      finishReason: 'stop',
      usage: { inputTokens: 200, outputTokens: 100, totalTokens: 300 },
    } as never)

    const repo = makeFakeRepo()
    await runConceptIntakeStage(repo as unknown as Repo, {
      worldId: 'wld-1',
      campaignId: 'camp-1',
      conceptText: 'turtle city',
      intentSummary: null,
      acceptedTitle: 'The Delta of Three Turtles',
    })

    const genPrompt = (vi.mocked(ai.generateText).mock.calls[0]?.[0] as { prompt: string }).prompt
    expect(genPrompt).toContain('The Delta of Three Turtles')
    expect(genPrompt).toContain('already accepted')

    expect(repo.worlds.applyConcept).toHaveBeenCalledWith(
      'wld-1',
      expect.objectContaining({ name: 'The Delta of Three Turtles' }),
    )
    // The campaign-name propagation still runs; its binder is a no-op when the
    // campaign already carries the accepted title (WHERE name = 'Untitled').
    expect(repo.campaigns.setNameFromUntitled).toHaveBeenCalledWith(
      'wld-1',
      'The Delta of Three Turtles',
    )
  })

  it('with NO accepted title the model names the world (freeform arm unchanged)', async () => {
    vi.mocked(ai.generateText).mockResolvedValueOnce({
      output: DRAFT,
      finishReason: 'stop',
      usage: { inputTokens: 800, outputTokens: 600, totalTokens: 1400 },
    } as never)
    vi.mocked(ai.generateText).mockResolvedValueOnce({
      output: { flagged: false, confidence: 0.95, mirroredWork: null, specificDriftAxes: [] },
      finishReason: 'stop',
      usage: { inputTokens: 200, outputTokens: 100, totalTokens: 300 },
    } as never)

    const repo = makeFakeRepo()
    await runConceptIntakeStage(repo as unknown as Repo, {
      worldId: 'wld-1',
      campaignId: 'camp-1',
      conceptText: 'turtle city',
      intentSummary: null,
      acceptedTitle: null,
    })

    const genPrompt = (vi.mocked(ai.generateText).mock.calls[0]?.[0] as { prompt: string }).prompt
    expect(genPrompt).toContain('none — name the world yourself')
    expect(repo.worlds.applyConcept).toHaveBeenCalledWith(
      'wld-1',
      expect.objectContaining({ name: 'Aelmoor' }),
    )
  })

  it('synthesizes the concept on OPUS (the foundational-synthesis generator)', async () => {
    vi.mocked(ai.generateText).mockResolvedValueOnce({
      output: DRAFT,
      finishReason: 'stop',
      usage: { inputTokens: 800, outputTokens: 600, totalTokens: 1400 },
    } as never)
    vi.mocked(ai.generateText).mockResolvedValueOnce({
      output: { flagged: false, confidence: 0.95, mirroredWork: null, specificDriftAxes: [] },
      finishReason: 'stop',
      usage: { inputTokens: 200, outputTokens: 100, totalTokens: 300 },
    } as never)

    const repo = makeFakeRepo()
    await runConceptIntakeStage(repo as unknown as Repo, {
      worldId: 'wld-3',
      campaignId: 'camp-1',
      conceptText: 'lighthouse-keepers tending storm spirits',
      intentSummary: null,
      acceptedTitle: null,
    })

    const genCall = vi.mocked(ai.generateText).mock.calls.at(0)?.[0] as unknown as { model: unknown }
    const judgeCall = vi.mocked(ai.generateText).mock.calls.at(1)?.[0] as unknown as {
      model: unknown
    }
    expect(genCall.model).toBe(OPUS)
    expect(judgeCall.model).toBe(SONNET)
  })

  it('renders intentSummary into the generator prompt when present (guided mode)', async () => {
    vi.mocked(ai.generateText).mockResolvedValueOnce({
      output: DRAFT,
      finishReason: 'stop',
      usage: { inputTokens: 800, outputTokens: 600, totalTokens: 1400 },
    } as never)
    vi.mocked(ai.generateText).mockResolvedValueOnce({
      output: { flagged: false, confidence: 0.95, mirroredWork: null, specificDriftAxes: [] },
      finishReason: 'stop',
      usage: { inputTokens: 200, outputTokens: 100, totalTokens: 300 },
    } as never)

    const repo = makeFakeRepo()
    await runConceptIntakeStage(repo as unknown as Repo, {
      worldId: 'wld-2',
      campaignId: 'camp-1',
      conceptText: 'storm-pact world',
      intentSummary: {
        aesthetics: ['salt-stained', 'lantern-lit'],
        themes: ['guardianship', 'inheritance'],
        sourcesInternal: ['private'],
      },
      acceptedTitle: null,
    })

    const genCall = vi.mocked(ai.generateText).mock.calls.at(0)?.[0] as unknown as Record<
      string,
      unknown
    >
    expect(genCall.prompt).toContain('salt-stained')
    expect(genCall.prompt).toContain('inheritance')
  })
})
