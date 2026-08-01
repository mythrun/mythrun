/* eslint-disable @typescript-eslint/require-await, @typescript-eslint/prefer-promise-reject-errors -- test fixture file: fake async-generator stream shapes (no awaits) + unknown-typed rejection reasons, mirroring ai.test.ts */
// myth-umggn: unit tests for `streamSynthesizeConcept` — the streaming twin of
// `synthesizeConcept` that feeds the guided create flow's live world brief.
// Mocks the canonical `../ai.js` wrapper (the module boundary the stream
// function calls through); asserts the concept-delta derivation from
// `partialObjectStream` partials, the pass-through `output` promise, and the
// abortSignal/timeout threading. No real LLM.

import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { DeepPartial } from 'ai'

vi.mock('../../ai.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../ai.js')>()
  return { ...actual, streamObject: vi.fn() }
})

import { streamObject } from '../../ai.js'
import {
  streamSynthesizeConcept,
  streamSynthesizeFromConcept,
  type SynthesizerOutput,
} from '../synthesize-concept.js'

const mockStreamObject = vi.mocked(streamObject)

const PICKS = [
  { title: 'Pick A', whyILikeIt: 'reason A' },
  { title: 'Pick B', whyILikeIt: 'reason B' },
  { title: 'Pick C', whyILikeIt: 'reason C' },
] as const

const FINAL: SynthesizerOutput = {
  title: 'The Tidebound Archive',
  concept: 'A tidebound archive-city.',
  intentSummary: {
    aesthetics: ['salt'],
    themes: ['memory'],
    sourcesInternal: ['a'],
  },
}

function fakeStream(opts: {
  partials: readonly DeepPartial<SynthesizerOutput>[]
  final?: SynthesizerOutput
  objectError?: unknown
}): ReturnType<typeof streamObject<SynthesizerOutput>> {
  async function* gen(): AsyncGenerator<DeepPartial<SynthesizerOutput>> {
    for (const p of opts.partials) yield p
  }
  return {
    partialObjectStream: gen(),
    object:
      opts.objectError !== undefined
        ? Promise.reject(opts.objectError)
        : Promise.resolve(opts.final ?? FINAL),
  } as unknown as ReturnType<typeof streamObject<SynthesizerOutput>>
}

async function collect(iter: AsyncIterable<string>): Promise<string[]> {
  const out: string[] = []
  for await (const d of iter) out.push(d)
  return out
}

describe('streamSynthesizeConcept', () => {
  beforeEach(() => {
    mockStreamObject.mockReset()
  })

  it('yields concept-growth deltas and resolves output with the validated tree', async () => {
    mockStreamObject.mockReturnValueOnce(
      fakeStream({
        partials: [
          {},
          { concept: 'A tide' },
          { concept: 'A tidebound archive' },
          { concept: 'A tidebound archive-city.' },
          // Post-concept partials (intentSummary filling in) grow nothing.
          { concept: 'A tidebound archive-city.', intentSummary: { aesthetics: ['salt'] } },
        ],
        final: FINAL,
      }),
    )

    const stream = streamSynthesizeConcept(PICKS)
    const deltas = await collect(stream.deltas)
    expect(deltas).toEqual(['A tide', 'bound archive', '-city.'])
    expect(deltas.join('')).toBe(FINAL.concept)
    await expect(stream.output).resolves.toEqual(FINAL)
    const streamCallOpts = mockStreamObject.mock.calls[0]?.[0] as unknown as {
      providerOptions?: unknown
    }
    expect(streamCallOpts.providerOptions).toMatchObject({ mythrun: { stage: 'concept_intake' } })
  })

  it('skips non-growing / non-string concept partials without emitting', async () => {
    mockStreamObject.mockReturnValueOnce(
      fakeStream({
        partials: [
          { intentSummary: {} },
          { concept: 'Full text' },
          { concept: 'Full' }, // shrink (defensive) — never re-emit
          { concept: 'Full text' }, // regrow to the already-sent length
        ],
        final: FINAL,
      }),
    )

    const deltas = await collect(streamSynthesizeConcept(PICKS).deltas)
    expect(deltas).toEqual(['Full text'])
  })

  it('output rejects with the wrapper error (deltas end without throwing)', async () => {
    const boom = new Error('terminal stream failure')
    mockStreamObject.mockReturnValueOnce(
      fakeStream({ partials: [{ concept: 'Half a br' }], objectError: boom }),
    )

    const stream = streamSynthesizeConcept(PICKS)
    // Pre-attach the rejection expectation so the reject is never unhandled.
    const outcome = expect(stream.output).rejects.toBe(boom)
    await expect(collect(stream.deltas)).resolves.toEqual(['Half a br'])
    await outcome
  })

  it('threads prompt, schema opts, timeout, and the external abortSignal to the wrapper', () => {
    mockStreamObject.mockReturnValueOnce(fakeStream({ partials: [], final: FINAL }))
    const ac = new AbortController()

    streamSynthesizeConcept(PICKS, { abortSignal: ac.signal })

    const call = mockStreamObject.mock.calls[0]?.[0]
    expect(call).toMatchObject({
      callSite: 'synthesize-concept-stream',
      schemaName: 'SynthesizerOutput',
      abortSignal: ac.signal,
    })
    expect(call?.timeoutMs).toBeGreaterThan(0)
    expect(call?.prompt).toContain('Pick A')
    expect(call?.prompt).toContain('reason B')
  })

  it('omits abortSignal from the wrapper call when none is supplied', () => {
    mockStreamObject.mockReturnValueOnce(fakeStream({ partials: [], final: FINAL }))

    streamSynthesizeConcept(PICKS)

    expect(mockStreamObject.mock.calls[0]?.[0]).not.toHaveProperty('abortSignal')
  })
})

// myth-6t06f: the FREEFORM twin streams the player's own concept through the
// identical machinery — same schema, same delta derivation, same abort
// threading — so the proposal screen never learns which path opened it.
describe('streamSynthesizeFromConcept', () => {
  beforeEach(() => {
    mockStreamObject.mockReset()
  })

  it('yields concept-growth deltas from the freeform prompt and resolves the validated tree', async () => {
    mockStreamObject.mockReturnValueOnce(
      fakeStream({
        partials: [{}, { concept: 'A tide' }, { concept: 'A tidebound archive-city.' }],
        final: FINAL,
      }),
    )

    const stream = streamSynthesizeFromConcept('a drowned harbour town of salvage guilds')
    const deltas = await collect(stream.deltas)
    expect(deltas.join('')).toBe(FINAL.concept)
    await expect(stream.output).resolves.toEqual(FINAL)
  })

  it('threads the player concept, its own callSite, and the abortSignal to the wrapper', () => {
    mockStreamObject.mockReturnValueOnce(fakeStream({ partials: [], final: FINAL }))
    const ac = new AbortController()

    streamSynthesizeFromConcept('UNIQUE_PLAYER_CONCEPT_Z', { abortSignal: ac.signal })

    const call = mockStreamObject.mock.calls[0]?.[0]
    expect(call).toMatchObject({
      // A distinct callSite so the cost/diagnostic logs can tell the two funnel
      // paths apart without a second schema.
      callSite: 'synthesize-freeform-stream',
      schemaName: 'SynthesizerOutput',
      abortSignal: ac.signal,
    })
    expect(call?.prompt).toContain('UNIQUE_PLAYER_CONCEPT_Z')
    expect(call?.prompt).toContain("PLAYER'S DESCRIPTION")
  })

  it('omits abortSignal from the wrapper call when none is supplied', () => {
    mockStreamObject.mockReturnValueOnce(fakeStream({ partials: [], final: FINAL }))

    streamSynthesizeFromConcept('a drowned harbour town of salvage guilds')

    expect(mockStreamObject.mock.calls[0]?.[0]).not.toHaveProperty('abortSignal')
  })
})
