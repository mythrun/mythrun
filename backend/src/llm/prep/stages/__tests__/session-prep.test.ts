/* eslint-disable @typescript-eslint/no-deprecated -- mirrors source: Vercel SDK
 * flags streamObject deprecated but design §D1 mandates it. */
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
})

vi.mock('ai', async () => {
  const actual = await vi.importActual<typeof import('ai')>('ai')
  return { ...actual, streamObject: vi.fn(), generateText: vi.fn(), Output: { object: vi.fn((o: unknown) => o) } }
})
vi.mock('../../serialize-world-state-for-prep.js', () => ({
  serializeWorldStateForPrep: vi.fn(() => Promise.resolve('SERIALIZED WORLD STATE')),
}))
import { streamObject as sdkStreamObject } from 'ai'
import { generateSessionPrep } from '../session-prep.js'
import { OPUS } from '../../../models.js'
function makeStream(tree: unknown) {
  return {
    partialObjectStream: (function* () { yield tree })(),
    object: Promise.resolve(tree),
    usage: Promise.resolve({ inputTokens: 5000, outputTokens: 9000, totalTokens: 14000 }),
  } as never
}
describe('generateSessionPrep', () => {
  it('returns the two docs + usage and calls streamObject with the right contract', async () => {
    vi.mocked(sdkStreamObject).mockReturnValueOnce(makeStream({ ft_context: 'FT DOC', sd_playbook: 'SD DOC' }))
    const repo = {} as never
    const result = await generateSessionPrep(repo, { campaignId: 'camp1', worldId: 'w1', sessionNumber: 1 })
    expect(result.ft_context).toBe('FT DOC')
    expect(result.sd_playbook).toBe('SD DOC')
    expect(result.usage.outputTokens).toBe(9000)
    const call = vi.mocked(sdkStreamObject).mock.calls[0]?.[0] as Record<string, unknown>
    expect(call.model).toBe(OPUS)
    expect(call.maxOutputTokens as number).toBeGreaterThanOrEqual(16384)
    expect(call.prompt as string).toContain('SERIALIZED WORLD STATE')
    const po = call.providerOptions as { mythrun: { stage: string } }
    expect(po.mythrun.stage).toBe('session_prep')
  })
})
