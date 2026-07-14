// backend/src/llm/prep/stages/__tests__/world-color.test.ts
//
// MYT-87 T8 (reworked 2026-07-01): world-gen colour stage. A single SONNET
// generateObject call (through the canonical ai.ts wrapper) proposes the
// world's two-stop `WorldColor` dither identity, structurally constrained to
// the widened per-hue ramp palette by `WorldColorPairSchema`. The stage
// RUNG-guards the pair (`rungsApart(from, to) >= 6`) and RE-ROLLS on a miss —
// feeding the rejected pair back into the prompt — keeping the aesthetic
// choice with the LLM per ZFC (no luminance snap). A passing pair persists via
// `repo.worlds.setColorPair`.
//
// Mock target: `'ai'` (the Vercel SDK) — the same upstream-mock pattern every
// peer stage test uses. The wrapper's internal `sdkGenerateText` is what
// produces the response, so mocking `generateText` and reading `result.output`
// exercises the stage end-to-end.

import { beforeEach, describe, expect, it, vi } from 'vitest'
import * as ai from 'ai'
import { WorldColorPairSchema } from '@mythrun/contract'
import { runWorldColorStage } from '../world-color.js'
import type { Repo } from '../../../../repo/index.js'

vi.mock('ai', async () => {
  const actual = await vi.importActual<typeof import('ai')>('ai')
  return { ...actual, generateText: vi.fn() }
})

const mockGenerateText = vi.mocked(ai.generateText)

// A minimal recording fake repo: the stage only touches
// `repo.transaction(tx => tx.worlds.setColorPair(...))`. Built inline (not via
// the shared makeFakeRepo helper) so this test owns its own surface and stays
// off a file other T-tasks may edit.
function makeColorRepo(): {
  worlds: { setColorPair: ReturnType<typeof vi.fn> }
  transaction: ReturnType<typeof vi.fn>
} {
  const self = {
    worlds: { setColorPair: vi.fn().mockResolvedValue(undefined) },
    transaction: vi.fn(),
  }
  self.transaction.mockImplementation((fn: (tx: typeof self) => Promise<unknown>) => fn(self))
  return self
}

function persistedPair(repo: ReturnType<typeof makeColorRepo>): unknown {
  const call = repo.worlds.setColorPair.mock.calls[0] as [string, unknown] | undefined
  if (call === undefined) throw new Error('setColorPair was not called')
  return call[1]
}

const ARGS = {
  worldId: 'w1',
  worldName: 'The Salt Verses',
  concept: 'A drowned coast where tide-priests barter memory for safe passage.',
  tone: 'melancholy, hushed',
  themes: 'debt, tide, forgetting',
}

const SONNET_USAGE = { inputTokens: 800, outputTokens: 40, totalTokens: 840 }

// sienna-200 → ochre-400: steps 2 rungs apart — below the 6-rung floor.
const LOW_RUNGS = { from: 'sienna-200', to: 'ochre-400' }
// paper-100 → ember-900: steps 8 rungs apart — clears the floor.
const PASSING = { from: 'paper-100', to: 'ember-900' }

function mockPair(pair: { from: string; to: string }, usage = SONNET_USAGE): void {
  mockGenerateText.mockResolvedValueOnce({
    output: pair,
    finishReason: 'stop',
    usage,
  } as never)
}

describe('runWorldColorStage', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('re-rolls on a sub-floor pair and persists the passing pair', async () => {
    mockPair(LOW_RUNGS)
    mockPair(PASSING)

    const repo = makeColorRepo()
    await runWorldColorStage(repo as unknown as Repo, ARGS)

    // Two LLM calls: the rejected too-close pair, then the passing re-roll.
    expect(mockGenerateText).toHaveBeenCalledTimes(2)
    // Persisted exactly the passing pair, inside one transaction.
    expect(repo.transaction).toHaveBeenCalledTimes(1)
    expect(repo.worlds.setColorPair).toHaveBeenCalledTimes(1)
    expect(repo.worlds.setColorPair).toHaveBeenCalledWith('w1', PASSING)
    expect(persistedPair(repo)).toEqual(PASSING)
  })

  it('feeds the rejected pair back into the re-roll prompt', async () => {
    mockPair(LOW_RUNGS)
    mockPair(PASSING)

    const repo = makeColorRepo()
    await runWorldColorStage(repo as unknown as Repo, ARGS)

    const first = mockGenerateText.mock.calls[0]?.[0] as unknown as { prompt: string }
    const second = mockGenerateText.mock.calls[1]?.[0] as unknown as { prompt: string }
    // The first attempt has no rejection feedback; the re-roll lists the
    // rejected pair verbatim so the model avoids repeating it.
    expect(first.prompt).not.toContain('from=sienna-200, to=ochre-400')
    expect(second.prompt).toContain('from=sienna-200, to=ochre-400')
  })

  it('persists on the first attempt when the pair already clears the floor', async () => {
    mockPair(PASSING)

    const repo = makeColorRepo()
    await runWorldColorStage(repo as unknown as Repo, ARGS)

    expect(mockGenerateText).toHaveBeenCalledTimes(1)
    expect(repo.worlds.setColorPair).toHaveBeenCalledWith('w1', PASSING)
  })

  it('uses the Sonnet model and Sonnet rates, accumulating cost across re-rolls', async () => {
    mockPair(LOW_RUNGS)
    mockPair(PASSING)

    const repo = makeColorRepo()
    const result = await runWorldColorStage(repo as unknown as Repo, ARGS)

    // The stage calls Sonnet (not Haiku) — a wrapLanguageModel result whose
    // inner provider carries the sonnet model id.
    const opts = mockGenerateText.mock.calls[0]?.[0] as unknown as { model: { modelId?: string } }
    expect(opts.model.modelId).toContain('sonnet')

    // Two Sonnet calls at $3/MTok in, $15/MTok out — summed across attempts.
    const expected = ((800 * 2) / 1_000_000) * 3 + ((40 * 2) / 1_000_000) * 15
    expect(result.costUsd).toBeCloseTo(expected, 9)
    expect(result.inputTokens).toBe(1600)
    expect(result.outputTokens).toBe(80)
  })

  it('treats undefined usage tokens as 0 (cost = 0, both counters = 0)', async () => {
    mockGenerateText.mockResolvedValueOnce({
      output: PASSING,
      finishReason: 'stop',
      usage: {},
    } as never)

    const repo = makeColorRepo()
    const result = await runWorldColorStage(repo as unknown as Repo, ARGS)

    expect(result.costUsd).toBe(0)
    expect(result.inputTokens).toBe(0)
    expect(result.outputTokens).toBe(0)
  })

  it('substitutes the world vibe placeholders into the prompt', async () => {
    mockPair(PASSING)

    const repo = makeColorRepo()
    await runWorldColorStage(repo as unknown as Repo, ARGS)

    const opts = mockGenerateText.mock.calls[0]?.[0] as unknown as { prompt: string }
    expect(opts.prompt).toContain('The Salt Verses')
    expect(opts.prompt).toContain('tide-priests barter memory')
    expect(opts.prompt).toContain('melancholy, hushed')
    expect(opts.prompt).toContain('debt, tide, forgetting')
    expect(opts.prompt).not.toContain('{{worldName}}')
    expect(opts.prompt).not.toContain('{{tone}}')
    expect(opts.prompt).not.toContain('{{rejectedFeedback}}')
  })

  // Regression (myth-8rtvl): a vibe field containing `$&`/`$'`-style sequences
  // must land in the prompt verbatim. Plain String.replace would interpret them
  // as replacement patterns, so the dynamic substitutions use a function replacer.
  it('inserts vibe fields containing $-replacement sequences verbatim', async () => {
    mockPair(PASSING)

    const repo = makeColorRepo()
    await runWorldColorStage(repo as unknown as Repo, {
      ...ARGS,
      concept: "a market where $& costs $$ and $' is the coin of the tide",
    })

    const opts = mockGenerateText.mock.calls[0]?.[0] as unknown as { prompt: string }
    expect(opts.prompt).toContain("a market where $& costs $$ and $' is the coin of the tide")
  })

  it('falls back to the widest-separation proposal when every attempt misses the floor', async () => {
    // Three sub-floor pairs (none clears 6 rungs). The widest-separation pair
    // sits in the MIDDLE position, so this assertion can only pass if the stage
    // selects by rung distance — not by first- or last-seen position. The stage
    // must NOT fail the world; it persists the most-separated proposal the model
    // produced (mechanical selection among the LLM's own choices, not a snap).
    mockPair({ from: 'moss-300', to: 'moss-500' }) // 2 rungs — first
    mockPair({ from: 'pine-200', to: 'pine-600' }) // 4 rungs — middle, the max
    mockPair({ from: 'sienna-400', to: 'sienna-500' }) // 1 rung — last, the min

    const repo = makeColorRepo()
    await runWorldColorStage(repo as unknown as Repo, ARGS)

    expect(mockGenerateText).toHaveBeenCalledTimes(3)
    expect(repo.worlds.setColorPair).toHaveBeenCalledTimes(1)
    expect(persistedPair(repo)).toEqual({ from: 'pine-200', to: 'pine-600' })
  })

  it('rethrows LLM call errors so retry classification fires', async () => {
    mockGenerateText.mockRejectedValueOnce(new Error('overloaded'))

    const repo = makeColorRepo()
    await expect(runWorldColorStage(repo as unknown as Repo, ARGS)).rejects.toThrow(/overloaded/)
    expect(repo.worlds.setColorPair).not.toHaveBeenCalled()
  })

  it('the schema rejects an off-palette colour (off-brand is structurally impossible)', () => {
    // The generateObject schema is WorldColorPairSchema — a closed z.enum over
    // the widened set. A colour outside it fails the parse, so the LLM can
    // never emit an off-brand pair through the structured-output constraint.
    expect(WorldColorPairSchema.safeParse(PASSING).success).toBe(true)
    // A bare pigment (no step) is no longer a member; an invented name fails too.
    expect(WorldColorPairSchema.safeParse({ from: 'sienna', to: 'ember-900' }).success).toBe(false)
    expect(WorldColorPairSchema.safeParse({ from: 'ember-900', to: '#abcdef' }).success).toBe(false)
  })
})
