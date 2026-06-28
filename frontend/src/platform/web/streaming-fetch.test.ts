import { afterEach, describe, expect, it, vi } from 'vitest'
import { createWebStreamingFetch } from './streaming-fetch.ts'

// The web `StreamingFetch` impl (MYT-85 T8): fetch + ReadableStream + TextDecoder.
// The native-fetch jsdom env (test/jsdom-native-fetch.ts) keeps Node's REAL
// fetch/Response/ReadableStream/TextDecoder/AbortController, so these tests build
// real `Response`s over real streams and drive the impl end-to-end. Only `fetch`
// is stubbed (we control the body + status); everything else is native.

const enc = new TextEncoder()

afterEach(() => {
  vi.unstubAllGlobals()
})

type FetchImpl = (
  url: string,
  init: { headers: Record<string, string>; signal: AbortSignal },
) => Promise<Response>

function stubFetch(impl: FetchImpl): void {
  vi.stubGlobal('fetch', vi.fn(impl))
}

describe('createWebStreamingFetch', () => {
  it('surfaces the response status and forwards headers + signal to fetch', async () => {
    const body = new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(enc.encode('data: {"x":1}\n\n'))
        c.close()
      },
    })
    const fetchSpy = vi.fn<FetchImpl>(() => Promise.resolve(new Response(body, { status: 200 })))
    vi.stubGlobal('fetch', fetchSpy)
    const signal = new AbortController().signal

    const sf = createWebStreamingFetch()
    const { status } = await sf('http://api.test/stream', {
      headers: { authorization: 'Bearer t' },
      signal,
    })

    expect(status).toBe(200)
    expect(fetchSpy).toHaveBeenCalledWith('http://api.test/stream', {
      headers: { authorization: 'Bearer t' },
      signal,
    })
  })

  it('decodes the body across multiple reads (streaming TextDecoder reassembles a split char)', async () => {
    // A 3-byte UTF-8 char (✓ = E2 9C 93) split across two enqueued reads proves
    // the decoder STREAMS: read 1 yields '' (incomplete), read 2 completes the
    // char — only a `{ stream: true }` decode reconstructs it across the boundary.
    const check = enc.encode('✓') // [0xE2, 0x9C, 0x93]
    const body = new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(check.slice(0, 2))
        c.enqueue(check.slice(2))
        c.enqueue(enc.encode('!\n\n'))
        c.close()
      },
    })
    stubFetch(() => Promise.resolve(new Response(body, { status: 200 })))

    const sf = createWebStreamingFetch()
    const { chunks } = await sf('http://x', { headers: {}, signal: new AbortController().signal })
    const out: string[] = []
    for await (const chunk of chunks) out.push(chunk)

    expect(out.join('')).toBe('✓!\n\n')
    expect(out.length).toBeGreaterThanOrEqual(2) // genuinely decoded across reads
    expect(out.join('')).not.toContain('�') // never a replacement char
  })

  it('still resolves {status, chunks} on a non-OK status (no throw); a null body yields nothing', async () => {
    // The SSE client routes on status BEFORE reading the body, so a 403 must
    // RESOLVE (not throw) and its (null) body must iterate to an empty stream.
    stubFetch(() => Promise.resolve(new Response(null, { status: 403 })))

    const sf = createWebStreamingFetch()
    const { status, chunks } = await sf('http://x', {
      headers: {},
      signal: new AbortController().signal,
    })

    expect(status).toBe(403)
    const out: string[] = []
    for await (const chunk of chunks) out.push(chunk)
    expect(out).toEqual([])
  })

  it('aborts the read when the signal fires', async () => {
    const controller = new AbortController()
    const body = new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(enc.encode('first'))
        // A real aborted fetch errors its body stream; mirror that here so the
        // in-flight read rejects when the signal fires.
        controller.signal.addEventListener('abort', () => {
          c.error(new DOMException('aborted', 'AbortError'))
        })
      },
    })
    stubFetch(() => Promise.resolve(new Response(body, { status: 200 })))

    const sf = createWebStreamingFetch()
    const { chunks } = await sf('http://x', { headers: {}, signal: controller.signal })
    const iter = chunks[Symbol.asyncIterator]()

    expect((await iter.next()).value).toBe('first')
    controller.abort()
    await expect(iter.next()).rejects.toThrow()
  })
})
