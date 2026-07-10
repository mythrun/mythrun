// SSE frame primitives (myth-umggn extraction): the `\n\n`-delimited frame
// parser + the chunk-reassembling read loop, moved VERBATIM out of
// sse-status-client.ts so the one-shot synthesize-preview stream client and
// the reconnecting status client share one copy. Pure functions — no
// connection state, no listeners; each consumer supplies its own `emit`.

export interface ParsedFrame {
  event: string
  data: string
}

/** Parse one `\n\n`-delimited SSE frame into its `event:`/`data:` fields. Returns
 *  `null` for a pure comment frame (`:keepalive`) — nothing to route. A single
 *  leading space after the field colon is stripped (SSE spec); multi-`data:`
 *  lines join with `\n`. */
export function parseSseFrame(raw: string): ParsedFrame | null {
  let event = 'message'
  let data = ''
  let sawField = false
  for (const line of raw.split('\n')) {
    if (line.length === 0 || line.startsWith(':')) continue
    const colon = line.indexOf(':')
    const name = colon === -1 ? line : line.slice(0, colon)
    const valueRaw = colon === -1 ? '' : line.slice(colon + 1)
    const value = valueRaw.startsWith(' ') ? valueRaw.slice(1) : valueRaw
    if (name === 'event') {
      event = value
      sawField = true
    } else if (name === 'data') {
      data = data === '' ? value : `${data}\n${value}`
      sawField = true
    }
  }
  return sawField ? { event, data } : null
}

/** Read the injected chunk stream, reassembling `\n\n`-delimited frames across
 *  chunk boundaries and routing each via `emit`. Returns when the stream ends,
 *  `emit` answers `'close'` (an `event: close` frame — or, for a one-shot
 *  consumer, its terminal data event), or the attempt goes `stale`
 *  (close/re-open). */
export async function readStream(
  chunks: AsyncIterable<string>,
  stale: () => boolean,
  emit: (raw: string) => 'close' | 'ok',
): Promise<void> {
  let buffer = ''
  for await (const chunk of chunks) {
    if (stale()) return
    buffer += chunk
    let sep = buffer.indexOf('\n\n')
    while (sep !== -1) {
      const raw = buffer.slice(0, sep)
      buffer = buffer.slice(sep + 2)
      if (emit(raw) === 'close') return
      sep = buffer.indexOf('\n\n')
    }
  }
}
