// backend/src/llm/__tests__/embed.test.ts
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createVoyageEmbedder } from '../embed.js'
import { EMBED_DIM, VOYAGE_EMBED_MODEL } from '../../world/retrieval/config.js'

const vec = (fill: number): number[] => Array.from({ length: EMBED_DIM }, () => fill)

function okResponse(vectors: number[][]): Response {
  return new Response(
    JSON.stringify({
      data: vectors.map((embedding, index) => ({ embedding, index })),
      usage: { total_tokens: 7 },
    }),
    { status: 200, headers: { 'content-type': 'application/json' } },
  )
}

describe('embed.ts', () => {
  let fetchMock: ReturnType<typeof vi.fn>
  beforeEach(() => {
    fetchMock = vi.fn()
  })

  it('embedQuery sends input_type=query, output_dimension=512, Bearer auth, and the model', async () => {
    fetchMock.mockResolvedValue(okResponse([vec(0.1)]))
    const e = createVoyageEmbedder({ apiKey: 'k', fetchImpl: fetchMock as unknown as typeof fetch })
    const out = await e.embedQuery('hello')
    expect(out).toHaveLength(EMBED_DIM)
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect(url).toBe('https://api.voyageai.com/v1/embeddings')
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer k')
    const body = JSON.parse(init.body as string)
    expect(body).toMatchObject({ model: VOYAGE_EMBED_MODEL, input_type: 'query', output_dimension: EMBED_DIM })
    expect(body.input).toEqual(['hello'])
  })

  it('embedDocuments uses input_type=document and returns one vector per text', async () => {
    fetchMock.mockResolvedValue(okResponse([vec(0.1), vec(0.2)]))
    const e = createVoyageEmbedder({ apiKey: 'k', fetchImpl: fetchMock as unknown as typeof fetch })
    const out = await e.embedDocuments(['a', 'b'])
    expect(out).toHaveLength(2)
    const body = JSON.parse((fetchMock.mock.calls[0] as [string, RequestInit])[1].body as string)
    expect(body.input_type).toBe('document')
  })

  it('chunks a large document batch by BOTH the input-count cap and the token estimate (>1 request)', async () => {
    fetchMock.mockResolvedValue(okResponse([vec(0.1)]))
    const e = createVoyageEmbedder({ apiKey: 'k', fetchImpl: fetchMock as unknown as typeof fetch })
    const many = Array.from({ length: 1500 }, (_, i) => `doc-${String(i)}`)
    fetchMock.mockImplementation(async (_u, init: RequestInit) => {
      const b = JSON.parse(init.body as string) as { input: string[] }
      return okResponse(b.input.map(() => vec(0.1)))
    })
    await e.embedDocuments(many)
    expect(fetchMock.mock.calls.length).toBeGreaterThan(1)
  })

  it('THROWS when a returned vector length != EMBED_DIM (dim drift guard)', async () => {
    fetchMock.mockResolvedValue(okResponse([[0.1, 0.2, 0.3]]))
    const e = createVoyageEmbedder({ apiKey: 'k', fetchImpl: fetchMock as unknown as typeof fetch })
    await expect(e.embedQuery('x')).rejects.toThrow(/dimension|EMBED_DIM|512/i)
  })

  it('retries with backoff on HTTP 429 then succeeds', async () => {
    fetchMock
      .mockResolvedValueOnce(new Response('rate limited', { status: 429 }))
      .mockResolvedValueOnce(okResponse([vec(0.1)]))
    const e = createVoyageEmbedder({
      apiKey: 'k',
      fetchImpl: fetchMock as unknown as typeof fetch,
      sleepImpl: async () => undefined,
    })
    const out = await e.embedQuery('x')
    expect(out).toHaveLength(EMBED_DIM)
    expect(fetchMock.mock.calls.length).toBe(2)
  })

  it('throws a typed error on a non-429 non-200 (e.g. 401)', async () => {
    fetchMock.mockResolvedValue(new Response('unauthorized', { status: 401 }))
    const e = createVoyageEmbedder({ apiKey: 'k', fetchImpl: fetchMock as unknown as typeof fetch })
    await expect(e.embedQuery('x')).rejects.toThrow()
  })

  it('gives up after VOYAGE_MAX_RETRIES_429 exhausted 429s and throws', async () => {
    fetchMock.mockResolvedValue(new Response('rate limited', { status: 429 }))
    const e = createVoyageEmbedder({
      apiKey: 'k',
      fetchImpl: fetchMock as unknown as typeof fetch,
      sleepImpl: async () => undefined,
    })
    await expect(e.embedQuery('x')).rejects.toThrow(/429/)
  })

  it('embedDocuments([]) makes no request and returns []', async () => {
    const e = createVoyageEmbedder({ apiKey: 'k', fetchImpl: fetchMock as unknown as typeof fetch })
    const out = await e.embedDocuments([])
    expect(out).toEqual([])
    expect(fetchMock.mock.calls.length).toBe(0)
  })

  it('splits a batch when the token estimate alone exceeds the cap (few large inputs)', async () => {
    // Two inputs each estimated > half the token cap → must split into 2 requests
    // even though the count is well under VOYAGE_BATCH_MAX_INPUTS.
    const big = 'x'.repeat(400_000) // ~100k tokens each (char/4)
    fetchMock.mockImplementation(async (_u, init: RequestInit) => {
      const b = JSON.parse(init.body as string) as { input: string[] }
      return okResponse(b.input.map(() => vec(0.1)))
    })
    const e = createVoyageEmbedder({ apiKey: 'k', fetchImpl: fetchMock as unknown as typeof fetch })
    await e.embedDocuments([big, big])
    expect(fetchMock.mock.calls.length).toBe(2)
  })
})
