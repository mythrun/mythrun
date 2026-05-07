import { describe, it, expect, vi, beforeEach } from 'vitest'
import { ProfanitySchema } from '../schemas/profanity.js'

vi.mock('ai', async () => {
  const actual = await vi.importActual<typeof import('ai')>('ai')
  return {
    ...actual,
    generateText: vi.fn(),
  }
})

describe('ProfanitySchema', () => {
  it('parses {profane: false}', () => {
    expect(ProfanitySchema.parse({ profane: false })).toEqual({ profane: false })
  })
  it('parses {profane: true, reason: "offensive"}', () => {
    expect(ProfanitySchema.parse({ profane: true, reason: 'offensive' })).toEqual({
      profane: true, reason: 'offensive',
    })
  })
  it('parses {profane: true, reason: "impersonation"}', () => {
    expect(ProfanitySchema.parse({ profane: true, reason: 'impersonation' })).toEqual({
      profane: true, reason: 'impersonation',
    })
  })
  it('rejects unknown reason values', () => {
    expect(() => ProfanitySchema.parse({ profane: true, reason: 'reserved' })).toThrow()
  })
})

describe('classifyProfanity', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('calls generateText with HAIKU + Output.object(ProfanitySchema) + system prompt', async () => {
    const { generateText } = await import('ai')
    const generateTextMock = vi.mocked(generateText)
    generateTextMock.mockResolvedValue({
      output: { profane: false },
      usage: { inputTokens: 50, outputTokens: 5, totalTokens: 55 },
      finishReason: 'stop',
    } as never)

    const { classifyProfanity } = await import('../profanity.js')
    const result = await classifyProfanity('gandalf')

    expect(result).toEqual({ profane: false })
    expect(generateTextMock).toHaveBeenCalledOnce()
    // generateText's first-arg type is broad; introspect the mock call via
    // an index-signature view rather than fight the discriminated union.
    const callArgs = generateTextMock.mock.calls[0]?.[0] as unknown as Record<string, unknown>
    expect(callArgs.prompt).toBe('gandalf')
    expect(typeof callArgs.system).toBe('string')
    expect(callArgs.system as string).toContain('Reject the username')
    expect(callArgs.maxRetries).toBe(3)
    expect(callArgs.output).toBeDefined()
  })

  it('returns the output verbatim from generateText', async () => {
    const { generateText } = await import('ai')
    vi.mocked(generateText).mockResolvedValue({
      output: { profane: true, reason: 'offensive' },
      usage: { inputTokens: 50, outputTokens: 8, totalTokens: 58 },
      finishReason: 'stop',
    } as never)

    const { classifyProfanity } = await import('../profanity.js')
    const result = await classifyProfanity('a-bad-word')
    expect(result).toEqual({ profane: true, reason: 'offensive' })
  })

  it('returns impersonation result when model classifies as such', async () => {
    const { generateText } = await import('ai')
    vi.mocked(generateText).mockResolvedValue({
      output: { profane: true, reason: 'impersonation' },
      usage: { inputTokens: 50, outputTokens: 9, totalTokens: 59 },
      finishReason: 'stop',
    } as never)

    const { classifyProfanity } = await import('../profanity.js')
    const result = await classifyProfanity('admin')
    expect(result).toEqual({ profane: true, reason: 'impersonation' })
  })

  it('propagates errors from generateText', async () => {
    const { generateText } = await import('ai')
    vi.mocked(generateText).mockRejectedValue(new Error('boom'))

    const { classifyProfanity } = await import('../profanity.js')
    await expect(classifyProfanity('something')).rejects.toThrow('boom')
  })
})
