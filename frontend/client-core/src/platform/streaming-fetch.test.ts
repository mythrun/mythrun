import { afterEach, describe, expect, it } from 'vitest'
import {
  configureStreamingFetch,
  getStreamingFetch,
  resetStreamingFetch,
  type StreamingFetch,
} from './streaming-fetch.ts'

afterEach(() => {
  resetStreamingFetch()
})

async function* streamOf(...parts: string[]): AsyncIterable<string> {
  for (const part of parts) yield await Promise.resolve(part)
}

// A scripted impl with the exact production shape: open status + raw text chunks.
const fakeFetch: StreamingFetch = () =>
  Promise.resolve({ status: 200, chunks: streamOf('data: x\n\n') })

describe('streaming-fetch seam', () => {
  it('throws when read before configuration', () => {
    expect(() => getStreamingFetch()).toThrow()
  })

  it('returns the configured impl after configureStreamingFetch', () => {
    configureStreamingFetch(fakeFetch)
    expect(getStreamingFetch()).toBe(fakeFetch)
  })

  it('last writer wins (reconfigure replaces the impl)', () => {
    const second: StreamingFetch = () => Promise.resolve({ status: 204, chunks: streamOf() })
    configureStreamingFetch(fakeFetch)
    configureStreamingFetch(second)
    expect(getStreamingFetch()).toBe(second)
  })

  it('resetStreamingFetch clears the impl back to the unconfigured state', () => {
    configureStreamingFetch(fakeFetch)
    resetStreamingFetch()
    expect(() => getStreamingFetch()).toThrow()
  })

  it('the configured impl surfaces { status, chunks } usable by core', async () => {
    configureStreamingFetch(fakeFetch)
    const res = await getStreamingFetch()('/api/x/stream', {
      headers: { Authorization: 'Bearer t' },
      signal: new AbortController().signal,
    })
    expect(res.status).toBe(200)
    const received: string[] = []
    for await (const chunk of res.chunks) received.push(chunk)
    expect(received).toEqual(['data: x\n\n'])
  })
})
