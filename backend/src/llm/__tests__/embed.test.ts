// backend/src/llm/__tests__/embed.test.ts
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createVoyageEmbedder, VoyageEmbedError, isVoyageConfigError } from '../embed.js'
import { EMBED_DIM, VOYAGE_EMBED_MODEL } from '../../world/retrieval/config.js'

const vec = (fill: number): number[] => Array.from({ length: EMBED_DIM }, () => fill)

/** The Voyage embeddings request-body shape these tests assert against. */
interface VoyageReqBody {
  readonly model: string
  readonly input: string[]
  readonly input_type: string
  readonly output_dimension: number
}

function okResponse(vectors: number[][]): Response {
  return new Response(
    JSON.stringify({
      data: vectors.map((embedding, index) => ({ embedding, index })),
      usage: { total_tokens: 7 },
    }),
    { status: 200, headers: { 'content-type': 'application/json' } },
  )
}

/** Parse a captured fetch call's request body into the typed Voyage shape. */
function parseBody(init: RequestInit): VoyageReqBody {
  return JSON.parse(init.body as string) as VoyageReqBody
}

describe('embed.ts', () => {
  let fetchMock: ReturnType<typeof vi.fn>
  beforeEach(() => {
    fetchMock = vi.fn()
  })
  afterEach(() => {
    // Defensive: the timeout-abort test installs fake timers; ensure no test
    // leaks them to the next even if it throws mid-assertion.
    vi.useRealTimers()
  })

  it('embedQuery sends input_type=query, output_dimension=512, Bearer auth, and the model', async () => {
    fetchMock.mockResolvedValue(okResponse([vec(0.1)]))
    const e = createVoyageEmbedder({ apiKey: 'k', fetchImpl: fetchMock })
    const out = await e.embedQuery('hello')
    expect(out).toHaveLength(EMBED_DIM)
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect(url).toBe('https://api.voyageai.com/v1/embeddings')
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer k')
    const body = parseBody(init)
    expect(body).toMatchObject({ model: VOYAGE_EMBED_MODEL, input_type: 'query', output_dimension: EMBED_DIM })
    expect(body.input).toEqual(['hello'])
  })

  it('embedDocuments uses input_type=document and returns one vector per text', async () => {
    fetchMock.mockResolvedValue(okResponse([vec(0.1), vec(0.2)]))
    const e = createVoyageEmbedder({ apiKey: 'k', fetchImpl: fetchMock })
    const out = await e.embedDocuments(['a', 'b'])
    expect(out).toHaveLength(2)
    const body = parseBody((fetchMock.mock.calls[0] as [string, RequestInit])[1])
    expect(body.input_type).toBe('document')
  })

  it('chunks a large document batch by BOTH the input-count cap and the token estimate (>1 request)', async () => {
    fetchMock.mockResolvedValue(okResponse([vec(0.1)]))
    const e = createVoyageEmbedder({ apiKey: 'k', fetchImpl: fetchMock })
    const many = Array.from({ length: 1500 }, (_, i) => `doc-${String(i)}`)
    fetchMock.mockImplementation((_u, init: RequestInit) =>
      Promise.resolve(okResponse(parseBody(init).input.map(() => vec(0.1)))),
    )
    await e.embedDocuments(many)
    expect(fetchMock.mock.calls.length).toBeGreaterThan(1)
  })

  it('THROWS when a returned vector length != EMBED_DIM (dim drift guard)', async () => {
    // Fresh Response per call — a Response body can only be .json()'d once, and
    // this test embeds twice (message assertion + field assertion).
    fetchMock.mockImplementation(() => Promise.resolve(okResponse([[0.1, 0.2, 0.3]])))
    const e = createVoyageEmbedder({ apiKey: 'k', fetchImpl: fetchMock })
    await expect(e.embedQuery('x')).rejects.toThrow(/dimension|EMBED_DIM|512/i)
    const err = await e.embedQuery('x').catch((x: unknown) => x)
    expect(err).toBeInstanceOf(VoyageEmbedError)
    expect((err as VoyageEmbedError).kind).toBe('dim_mismatch')
    expect(isVoyageConfigError(err)).toBe(true)
  })

  it('retries with backoff on HTTP 429 then succeeds', async () => {
    fetchMock
      .mockResolvedValueOnce(new Response('rate limited', { status: 429 }))
      .mockResolvedValueOnce(okResponse([vec(0.1)]))
    const e = createVoyageEmbedder({
      apiKey: 'k',
      fetchImpl: fetchMock,
      sleepImpl: () => Promise.resolve(),
    })
    const out = await e.embedQuery('x')
    expect(out).toHaveLength(EMBED_DIM)
    expect(fetchMock.mock.calls.length).toBe(2)
  })

  it('throws a typed error on a non-429 non-200 (e.g. 401)', async () => {
    fetchMock.mockResolvedValue(new Response('unauthorized', { status: 401 }))
    const e = createVoyageEmbedder({ apiKey: 'k', fetchImpl: fetchMock })
    await expect(e.embedQuery('x')).rejects.toThrow()
  })

  it('classifies HTTP 401 as a CONFIG error (kind=auth, status=401)', async () => {
    fetchMock.mockResolvedValue(new Response('unauthorized', { status: 401 }))
    const e = createVoyageEmbedder({ apiKey: 'k', fetchImpl: fetchMock })
    const err = await e.embedQuery('x').catch((x: unknown) => x)
    expect(err).toBeInstanceOf(VoyageEmbedError)
    expect((err as VoyageEmbedError).kind).toBe('auth')
    expect((err as VoyageEmbedError).status).toBe(401)
    expect(isVoyageConfigError(err)).toBe(true)
  })

  it('classifies HTTP 403 as a CONFIG error (kind=auth, status=403)', async () => {
    fetchMock.mockResolvedValue(new Response('forbidden', { status: 403 }))
    const e = createVoyageEmbedder({ apiKey: 'k', fetchImpl: fetchMock })
    const err = await e.embedQuery('x').catch((x: unknown) => x)
    expect(err).toBeInstanceOf(VoyageEmbedError)
    expect((err as VoyageEmbedError).kind).toBe('auth')
    expect((err as VoyageEmbedError).status).toBe(403)
    expect(isVoyageConfigError(err)).toBe(true)
  })

  it('classifies HTTP 400 as a CONFIG error (kind=bad_request, status=400)', async () => {
    fetchMock.mockResolvedValue(new Response('bad request', { status: 400 }))
    const e = createVoyageEmbedder({ apiKey: 'k', fetchImpl: fetchMock })
    const err = await e.embedQuery('x').catch((x: unknown) => x)
    expect(err).toBeInstanceOf(VoyageEmbedError)
    expect((err as VoyageEmbedError).kind).toBe('bad_request')
    expect((err as VoyageEmbedError).status).toBe(400)
    expect(isVoyageConfigError(err)).toBe(true)
  })

  it('classifies HTTP 500 as a TRANSIENT error (kind=transient, not config)', async () => {
    fetchMock.mockResolvedValue(new Response('server error', { status: 500 }))
    const e = createVoyageEmbedder({ apiKey: 'k', fetchImpl: fetchMock })
    const err = await e.embedQuery('x').catch((x: unknown) => x)
    expect(err).toBeInstanceOf(VoyageEmbedError)
    expect((err as VoyageEmbedError).kind).toBe('transient')
    expect((err as VoyageEmbedError).status).toBe(500)
    expect(isVoyageConfigError(err)).toBe(false)
  })

  it('classifies an exhausted-429 as TRANSIENT (kind=rate_limited, not config)', async () => {
    fetchMock.mockResolvedValue(new Response('rate limited', { status: 429 }))
    const e = createVoyageEmbedder({
      apiKey: 'k',
      fetchImpl: fetchMock,
      sleepImpl: () => Promise.resolve(),
    })
    const err = await e.embedQuery('x').catch((x: unknown) => x)
    expect(err).toBeInstanceOf(VoyageEmbedError)
    expect((err as VoyageEmbedError).kind).toBe('rate_limited')
    expect((err as VoyageEmbedError).status).toBe(429)
    expect(isVoyageConfigError(err)).toBe(false)
  })

  it('wraps a fetch-level rejection (network/timeout) as TRANSIENT', async () => {
    fetchMock.mockRejectedValue(new TypeError('network down'))
    const e = createVoyageEmbedder({ apiKey: 'k', fetchImpl: fetchMock })
    const err = await e.embedQuery('x').catch((x: unknown) => x)
    expect(err).toBeInstanceOf(VoyageEmbedError)
    expect((err as VoyageEmbedError).kind).toBe('transient')
    expect(isVoyageConfigError(err)).toBe(false)
  })

  it('wraps a non-Error fetch rejection as TRANSIENT (String(err) arm)', async () => {
    fetchMock.mockRejectedValue('boom') // a bare string, not an Error
    const e = createVoyageEmbedder({ apiKey: 'k', fetchImpl: fetchMock })
    const err = await e.embedQuery('x').catch((x: unknown) => x)
    expect(err).toBeInstanceOf(VoyageEmbedError)
    expect((err as VoyageEmbedError).kind).toBe('transient')
    expect((err as VoyageEmbedError).message).toContain('boom')
  })

  it('gives up after VOYAGE_MAX_RETRIES_429 exhausted 429s and throws', async () => {
    fetchMock.mockResolvedValue(new Response('rate limited', { status: 429 }))
    const e = createVoyageEmbedder({
      apiKey: 'k',
      fetchImpl: fetchMock,
      sleepImpl: () => Promise.resolve(),
    })
    await expect(e.embedQuery('x')).rejects.toThrow(/429/)
  })

  it('embedQuery classifies an empty-data response as kind=empty', async () => {
    // Fresh Response per call — embeds twice, and a body is single-use.
    fetchMock.mockImplementation(() => Promise.resolve(okResponse([])))
    const e = createVoyageEmbedder({ apiKey: 'k', fetchImpl: fetchMock })
    const err = await e.embedQuery('x').catch((x: unknown) => x)
    expect(err).toBeInstanceOf(VoyageEmbedError)
    expect((err as VoyageEmbedError).kind).toBe('empty')
    expect(isVoyageConfigError(err)).toBe(false)
  })

  it('embedDocuments([]) makes no request and returns []', async () => {
    const e = createVoyageEmbedder({ apiKey: 'k', fetchImpl: fetchMock })
    const out = await e.embedDocuments([])
    expect(out).toEqual([])
    expect(fetchMock.mock.calls.length).toBe(0)
  })

  it('splits a batch when the token estimate alone exceeds the cap (few large inputs)', async () => {
    // Two inputs each estimated > half the token cap → must split into 2 requests
    // even though the count is well under VOYAGE_BATCH_MAX_INPUTS.
    const big = 'x'.repeat(400_000) // ~100k tokens each (char/4)
    fetchMock.mockImplementation((_u, init: RequestInit) =>
      Promise.resolve(okResponse(parseBody(init).input.map(() => vec(0.1)))),
    )
    const e = createVoyageEmbedder({ apiKey: 'k', fetchImpl: fetchMock })
    await e.embedDocuments([big, big])
    expect(fetchMock.mock.calls.length).toBe(2)
  })

  it('aborts the in-flight request when it exceeds the per-call timeout', async () => {
    vi.useFakeTimers()
    // A fetch that never resolves on its own — it only settles when its
    // AbortSignal fires (the real fetch contract). The embedder's setTimeout
    // fires ac.abort() once the query timeout elapses, which rejects this.
    fetchMock.mockImplementation(
      (_u, init: RequestInit) =>
        new Promise((_resolve, reject) => {
          init.signal?.addEventListener('abort', () => {
            reject(new DOMException('aborted', 'AbortError'))
          })
        }),
    )
    const e = createVoyageEmbedder({ apiKey: 'k', fetchImpl: fetchMock })
    const pending = e.embedQuery('x')
    const assertion = expect(pending).rejects.toThrow()
    // Advance past VOYAGE_QUERY_TIMEOUT_MS so the abort timer fires.
    await vi.advanceTimersByTimeAsync(10_000)
    await assertion
  })
})
