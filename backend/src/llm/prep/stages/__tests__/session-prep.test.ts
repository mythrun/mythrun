import { describe, it, expect, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { resolve, dirname } from 'node:path'

const TEMPLATE = readFileSync(
  resolve(dirname(fileURLToPath(import.meta.url)), '../../../prompts/prep/session-prep.txt'),
  'utf8',
)

describe('session-prep template', () => {
  it('carries placeholders + fact/entity hard exclusions + party + length + session-N framing', () => {
    expect(TEMPLATE).toContain('{{world_state}}')
    expect(TEMPLATE).toContain('{{session_number}}')
    expect(TEMPLATE).toContain('ft_context')
    expect(TEMPLATE).toContain('sd_playbook')
    expect(TEMPLATE.toLowerCase()).toContain('discoverable')
    expect(TEMPLATE.toLowerCase()).toContain('secret')
    expect(TEMPLATE.toLowerCase()).toMatch(/never name|do not name|must not appear/)
    expect(TEMPLATE.toLowerCase()).toContain('party')
    // Guard the Length contract specifically (the playbook "always shorter"
    // rule or an explicit word-count) — not a bare "word"/"length" substring
    // that incidentally matches body prose.
    expect(TEMPLATE.toLowerCase()).toMatch(/always[\s\S]{0,40}shorter|\d,?\d00 words/)
  })

  it('MYT-69: FT instructions tell the narrator to play the moment now, not stall for a cue', () => {
    const lower = TEMPLATE.toLowerCase()
    // Post-hoc model: stage directions arrive one turn late, so the prep must
    // never tell the FT to wait/stall for a cue before narrating.
    expect(lower).toContain('do not stall for a cue')
    expect(lower).toContain('deeper moments develop over subsequent turns')
    expect(lower).toContain('surfaces on a later beat')
    // The old pre-FT-ST stall phrasings must be gone from the FT-facing text.
    expect(TEMPLATE).not.toContain('wait for stage directions')
    expect(TEMPLATE).not.toContain('wait for a stage direction before revealing')
    expect(TEMPLATE).not.toContain('Stage directions will guide deeper moments when the time comes')
    expect(TEMPLATE).not.toContain('stage directions will provide the specifics')
  })

  it('MYT-69: playbook authoring guidance marks entrusted-secret trust conditions', () => {
    const lower = TEMPLATE.toLowerCase()
    expect(lower).toContain('entrusted')
    expect(lower).toContain('trust conditions')
  })

  it('MYT-69: revelation list marks critical-path vs corroborating clues', () => {
    const lower = TEMPLATE.toLowerCase()
    expect(lower).toContain('critical-path')
    expect(lower).toContain('corroborating')
    // critical-path clues must never be gated behind a stall-risking check.
    expect(lower).toMatch(/never gate it behind a check/)
  })

  it('MYT-69: preserves the playbook [STAGE] authoring markup', () => {
    expect(TEMPLATE).toContain('[STAGE] ... [/STAGE]')
  })
})

// Mock the `../../ai.js` WRAPPER directly (not the underlying `ai` package):
// the new delta logic consumes `result.partialObjectStream` and then awaits
// `result.object` / `result.usage` exactly as the wrapper exposes them, so the
// wrapper is the right seam to script. The type is re-exported so the SUT's
// `import { streamObject, type LanguageModelUsage } from '../../ai.js'` resolves.
const streamObjectMock =
  vi.fn<(...args: unknown[]) => ReturnType<typeof import('../../../ai.js').streamObject>>()
vi.mock('../../../ai.js', async () => {
  const actual = await vi.importActual<typeof import('../../../ai.js')>('../../../ai.js')
  return { ...actual, streamObject: (...a: unknown[]) => streamObjectMock(...a) }
})
vi.mock('../../serialize-world-state-for-prep.js', () => ({
  serializeWorldStateForPrep: vi.fn(() => Promise.resolve('SERIALIZED WORLD STATE')),
}))

// import generateSessionPrep AFTER the mocks
import { generateSessionPrep } from '../session-prep.js'
import { OPUS } from '../../../models.js'

function scripted(
  partials: Record<string, string>[],
  object: { ft_context: string; sd_playbook: string },
) {
  function* gen(): Generator<Record<string, string>> {
    for (const p of partials) yield p
  }
  return {
    partialObjectStream: gen(),
    object: Promise.resolve(object),
    usage: Promise.resolve({ inputTokens: 10, outputTokens: 20, totalTokens: 30 }),
  } as unknown as ReturnType<typeof import('../../../ai.js').streamObject>
}

describe('generateSessionPrep', () => {
  it('returns the two docs + usage and calls streamObject with the right contract', async () => {
    streamObjectMock.mockReturnValueOnce(
      scripted(
        [{ ft_context: 'x'.repeat(200) }, { ft_context: 'x'.repeat(200), sd_playbook: 'y'.repeat(100) }],
        { ft_context: 'x'.repeat(200), sd_playbook: 'y'.repeat(100) },
      ),
    )
    const repo = {} as never
    const result = await generateSessionPrep(repo, { campaignId: 'camp1', worldId: 'w1', sessionNumber: 1 })
    expect(result.ft_context).toBe('x'.repeat(200))
    expect(result.sd_playbook).toBe('y'.repeat(100))
    expect(result.usage.outputTokens).toBe(20)
    const call = streamObjectMock.mock.calls[0]?.[0] as Record<string, unknown>
    expect(call.model).toBe(OPUS)
    expect(call.maxOutputTokens as number).toBeGreaterThanOrEqual(16384)
    expect(call.prompt as string).toContain('SERIALIZED WORLD STATE')
    const po = call.providerOptions as { mythrun: { stage: string } }
    expect(po.mythrun.stage).toBe('session_prep')
  })

  it('emits ordered per-field prose deltas with no overlap or loss', async () => {
    const deltas: { field: string; text: string }[] = []
    streamObjectMock.mockReturnValue(
      scripted(
        [{ ft_context: 'Hel' }, { ft_context: 'Hello' }, { ft_context: 'Hello', sd_playbook: 'SD' }],
        { ft_context: 'Hello', sd_playbook: 'SD' },
      ),
    )
    const r = await generateSessionPrep({} as never, {
      campaignId: 'c',
      worldId: 'w',
      sessionNumber: 1,
      onProseDelta: (field, text) => deltas.push({ field, text }),
    })
    expect(deltas).toEqual([
      { field: 'ft_context', text: 'Hel' },
      { field: 'ft_context', text: 'lo' },
      { field: 'sd_playbook', text: 'SD' },
    ])
    expect(r.ft_context).toBe('Hello')
    expect(r.sd_playbook).toBe('SD')
  })

  it('mid-escape truncation: resets without emitting when the new value is not a strict extension', async () => {
    const deltas: string[] = []
    streamObjectMock.mockReturnValue(
      scripted(
        // 'fo\' is an in-flight escape; the next tick is LONGER but its prefix
        // DIVERGES ('foobar'[2] === 'o', not the '\' we'd already buffered), so
        // the strict-extension check fails and we resync `prev` without
        // emitting. The following tick extends 'foobar' cleanly and emits only
        // the appended tail.
        [{ ft_context: 'fo\\' }, { ft_context: 'foobar' }, { ft_context: 'foobar baz' }],
        { ft_context: 'foobar baz', sd_playbook: 'x'.repeat(100) },
      ),
    )
    await generateSessionPrep({} as never, {
      campaignId: 'c',
      worldId: 'w',
      sessionNumber: 1,
      onProseDelta: (_f, t) => deltas.push(t),
    })
    // tick 1 emitted 'fo\' (prev was empty → strict extension); tick 2 diverged
    // and emitted NOTHING (reset branch); tick 3 emitted ' baz'. No throw, and
    // the divergent middle value never leaks a garbled slice into the stream.
    expect(deltas).toEqual(['fo\\', ' baz'])
  })

  it('a throwing onProseDelta does not abort generation', async () => {
    streamObjectMock.mockReturnValue(scripted([{ ft_context: 'a' }], { ft_context: 'a', sd_playbook: 'b' }))
    const r = await generateSessionPrep({} as never, {
      campaignId: 'c',
      worldId: 'w',
      sessionNumber: 1,
      onProseDelta: () => {
        throw new Error('boom')
      },
    })
    expect(r.ft_context).toBe('a')
  })

  it('drains cleanly with no callback', async () => {
    streamObjectMock.mockReturnValue(scripted([{ ft_context: 'a' }], { ft_context: 'a', sd_playbook: 'b' }))
    const r = await generateSessionPrep({} as never, {
      campaignId: 'c',
      worldId: 'w',
      sessionNumber: 1,
    })
    expect(r.sd_playbook).toBe('b')
  })

  it('skips a partial that has not yet produced a string for a field', async () => {
    const deltas: { field: string; text: string }[] = []
    streamObjectMock.mockReturnValue(
      scripted(
        // First partial: ft_context absent entirely (non-string skip), sd_playbook present.
        [{ sd_playbook: 'SD' }, { ft_context: 'FT', sd_playbook: 'SD' }],
        { ft_context: 'FT', sd_playbook: 'SD' },
      ),
    )
    await generateSessionPrep({} as never, {
      campaignId: 'c',
      worldId: 'w',
      sessionNumber: 1,
      onProseDelta: (field, text) => deltas.push({ field, text }),
    })
    expect(deltas).toEqual([
      { field: 'sd_playbook', text: 'SD' },
      { field: 'ft_context', text: 'FT' },
    ])
  })
})
