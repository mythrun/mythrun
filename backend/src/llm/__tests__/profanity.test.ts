import { describe, it, expect, vi, beforeEach } from 'vitest'
import { ProfanitySchema } from '../schemas/profanity.js'

vi.mock('ai', async () => {
  const actual = await vi.importActual<typeof import('ai')>('ai')
  return {
    ...actual,
    generateObject: vi.fn(),
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

  it('calls generateObject with HAIKU + ProfanitySchema + system prompt', async () => {
    const { generateObject } = await import('ai')
    const generateObjectMock = vi.mocked(generateObject)
    generateObjectMock.mockResolvedValue({
      object: { profane: false },
      usage: { inputTokens: 50, outputTokens: 5, totalTokens: 55 },
      finishReason: 'stop',
    } as never)

    const { classifyProfanity } = await import('../profanity.js')
    const result = await classifyProfanity('gandalf')

    expect(result).toEqual({ profane: false })
    expect(generateObjectMock).toHaveBeenCalledOnce()
    // generateObject's first-arg type is a discriminated union (schema vs
    // output:'no-schema' branches), which TS can't narrow from an introspected
    // mock call. We assert the runtime shape via an index-signature view.
    const callArgs = generateObjectMock.mock.calls[0]![0]! as unknown as Record<string, unknown>
    expect(callArgs.schema).toBe(ProfanitySchema)
    expect(callArgs.prompt).toBe('gandalf')
    expect(typeof callArgs.system).toBe('string')
    expect(callArgs.system as string).toContain('Reject the username')
    expect(callArgs.maxRetries).toBe(3)
  })

  it('returns the parsed object verbatim from generateObject', async () => {
    const { generateObject } = await import('ai')
    vi.mocked(generateObject).mockResolvedValue({
      object: { profane: true, reason: 'offensive' },
      usage: { inputTokens: 50, outputTokens: 8, totalTokens: 58 },
      finishReason: 'stop',
    } as never)

    const { classifyProfanity } = await import('../profanity.js')
    const result = await classifyProfanity('a-bad-word')
    expect(result).toEqual({ profane: true, reason: 'offensive' })
  })

  it('returns impersonation result when model classifies as such', async () => {
    const { generateObject } = await import('ai')
    vi.mocked(generateObject).mockResolvedValue({
      object: { profane: true, reason: 'impersonation' },
      usage: { inputTokens: 50, outputTokens: 9, totalTokens: 59 },
      finishReason: 'stop',
    } as never)

    const { classifyProfanity } = await import('../profanity.js')
    const result = await classifyProfanity('admin')
    expect(result).toEqual({ profane: true, reason: 'impersonation' })
  })

  it('propagates errors from generateObject', async () => {
    const { generateObject } = await import('ai')
    vi.mocked(generateObject).mockRejectedValue(new Error('boom'))

    const { classifyProfanity } = await import('../profanity.js')
    await expect(classifyProfanity('something')).rejects.toThrow('boom')
  })
})
