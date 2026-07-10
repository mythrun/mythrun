import type { StreamingFetch } from '@mythrun/client-core'

// The web realization of client-core's `StreamingFetch` seam (MYT-85) — the SSE
// status client's one platform-divergent dependency. It lives under
// `src/platform/web/**` (the sanctioned web-globals carve-out): `fetch` +
// `ReadableStream` + `TextDecoder` are web/RN-universal, but `EventSource` is
// banned in the brain (R1), so the byte stream reaches core through THIS port.
//
// It is `ctx`-free: core computes auth (`ctx.getAuthHeaders()`) and hands over the
// mode-correct `headers`; this impl just applies them. It resolves once the
// response HEAD is available (NOT once the body completes), surfacing `status` so
// core's non-200 routing is observable, and yields raw decoded text chunks (core
// owns the `\n\n` framing). A non-OK status STILL resolves `{status, chunks}` — it
// never throws; core routes on the status. `signal` aborts the in-flight read.
export function createWebStreamingFetch(): StreamingFetch {
  return async (url, init) => {
    const response = await fetch(url, {
      headers: init.headers,
      signal: init.signal,
      // myth-umggn: a streamed POST (the synthesize-preview brief) carries a
      // method + JSON body; a bare GET (the status stream) carries neither —
      // conditional spread keeps the GET init byte-identical to before.
      ...(init.method !== undefined ? { method: init.method } : {}),
      ...(init.body !== undefined ? { body: init.body } : {}),
    })
    return { status: response.status, chunks: decodeBody(response.body) }
  }
}

/** Decode a fetch body stream to raw text chunks. A streaming `TextDecoder`
 *  reassembles a multi-byte UTF-8 sequence split across reads. A bodyless response
 *  (`null` body — a 204/304, or a non-200 core routes on before reading) yields an
 *  empty stream. */
async function* decodeBody(body: ReadableStream<Uint8Array> | null): AsyncGenerator<string> {
  if (body === null) return
  const reader = body.getReader()
  const decoder = new TextDecoder()
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      yield decoder.decode(value, { stream: true })
    }
  } finally {
    reader.releaseLock()
  }
}
