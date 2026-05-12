// Fetch-based SSE reader. EventSource (the browser-native SSE client)
// can't set custom headers, so it can't carry `x-mythrun-dev-sub` to
// authenticate against the dev backend's bypass plugin. This helper does
// SSE over `fetch` instead: the response body is a ReadableStream we parse
// line-by-line into typed events. Identity is stamped on the request the
// same way `apiCall` does it.
//
// Format the backend emits (see backend/src/sse/sse-connection.ts +
// backend/src/sse/pipeline-subscriber.ts):
//   - Keepalive: `:keepalive\n\n`           (comment line, ignored)
//   - Snapshot: `event: snapshot\ndata: <json>\n\n`
//   - Live:     `data: <json>\n\n`          (no event field → 'message')
//   - Close:    `event: close\ndata: <json>\n\n`
//
// Same path-safety rules as api-client.ts: relative paths only, no
// protocol-relative URLs (would leak the identity header to a foreign
// origin).

import { getCurrentDevSub } from './identity.js'

export interface SseEvent {
  /** Event type from the `event:` field. Defaults to 'message' if absent. */
  readonly event: string
  /** Concatenated `data:` field value. JSON for our routes. */
  readonly data: string
}

export interface OpenSseOptions {
  readonly onEvent: (event: SseEvent) => void
  /** Called once on connect failure or stream error. */
  readonly onError?: (err: Error) => void
}

export interface SseConnection {
  /** Aborts the in-flight fetch and stops reading. Idempotent. */
  readonly close: () => void
}

export function openSse(path: string, opts: OpenSseOptions): SseConnection {
  if (!path.startsWith('/') || path.startsWith('//')) {
    throw new Error(
      `openSse: path must be relative and not protocol-relative (got ${JSON.stringify(path)})`,
    )
  }

  const controller = new AbortController()
  let closed = false
  const close = (): void => {
    if (closed) return
    closed = true
    controller.abort()
  }

  void runStream(path, controller.signal, opts).catch((err: unknown) => {
    if (closed) return
    if (err instanceof Error && err.name === 'AbortError') return
    const wrapped = err instanceof Error ? err : new Error(String(err))
    opts.onError?.(wrapped)
  })

  return { close }
}

async function runStream(
  path: string,
  signal: AbortSignal,
  opts: OpenSseOptions,
): Promise<void> {
  const res = await fetch(path, {
    headers: {
      'x-mythrun-dev-sub': getCurrentDevSub(),
      accept: 'text/event-stream',
    },
    signal,
  })
  if (!res.ok) {
    opts.onError?.(new Error(`SSE open failed: status ${String(res.status)}`))
    return
  }
  if (!res.body) {
    opts.onError?.(new Error('SSE open: response has no body'))
    return
  }
  const reader = res.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  // Loop until the server closes the stream or the caller aborts.
  for (;;) {
    const chunk = await reader.read()
    if (chunk.done) return
    buffer += decoder.decode(chunk.value, { stream: true })
    // Drain complete frames (separated by `\n\n`). Partial frames stay
    // in the buffer for the next chunk.
    let sep = buffer.indexOf('\n\n')
    while (sep !== -1) {
      const raw = buffer.slice(0, sep)
      buffer = buffer.slice(sep + 2)
      const parsed = parseFrame(raw)
      if (parsed) opts.onEvent(parsed)
      sep = buffer.indexOf('\n\n')
    }
  }
}

function parseFrame(raw: string): SseEvent | null {
  let eventName = 'message'
  let data = ''
  for (const line of raw.split('\n')) {
    // Comments are lines starting with ':' — used for keepalive. Skip.
    // Blank lines inside a buffer also skip (the spec lets implementations
    // ignore them; ours shouldn't see them mid-frame, but be defensive).
    if (line.length === 0 || line.startsWith(':')) continue
    const colon = line.indexOf(':')
    const name = colon === -1 ? line : line.slice(0, colon)
    const valueRaw = colon === -1 ? '' : line.slice(colon + 1)
    // SSE spec: a single leading space after the colon is ignored.
    const value = valueRaw.startsWith(' ') ? valueRaw.slice(1) : valueRaw
    if (name === 'event') {
      eventName = value
    } else if (name === 'data') {
      data = data === '' ? value : `${data}\n${value}`
    }
    // 'id' and 'retry' fields are ignored — we don't reconnect on the
    // client; the server's close-reason enum + a fresh user-driven
    // Watch click is the resync mechanism.
  }
  if (data === '' && eventName === 'message') return null
  return { event: eventName, data }
}
