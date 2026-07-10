// myth-umggn: unit tests for the one-shot synthesize-preview stream client.
// A hand-driven StreamingFetch fake (push interface) plays the server: the
// tests assert the open handshake (POST + JSON body + auth headers), the
// non-200 → HttpError mirror of defineEndpoint, the store's progressive text
// accumulation, every terminal arm (complete / rejected / error), and the
// honesty of an interrupted stream. No real network.

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { renderHook, waitFor as rtlWaitFor } from '@testing-library/react'
import {
  configureStreamingFetch,
  resetStreamingFetch,
  type StreamingFetch,
} from '../platform/streaming-fetch.ts'
import { resetTokenManager } from '../auth/token-manager.ts'
import { HttpError, ContractValidationError, NetworkError } from './errors.ts'
import type { ApiContext } from './endpoint.ts'
import {
  startSynthesisStream,
  useSynthesisState,
  type SynthesisStreamState,
} from './synthesize-stream.ts'

const BASE_URL = 'http://api.test'
const ctx: ApiContext = {
  baseUrl: BASE_URL,
  getAuthHeaders: () => Promise.resolve({ authorization: 'Bearer t' }),
}

const VALID_BODY = {
  picks: [
    { title: 'A', whyILikeIt: 'a' },
    { title: 'B', whyILikeIt: 'b' },
    { title: 'C', whyILikeIt: 'c' },
  ],
}

/** A push-driven chunk stream the test scripts frame-by-frame. */
function pushChunks(): {
  chunks: AsyncIterable<string>
  push: (chunk: string) => void
  end: () => void
  fail: (err: Error) => void
} {
  const queue: string[] = []
  let done = false
  let error: Error | undefined
  let wake: (() => void) | null = null
  const notify = (): void => {
    wake?.()
    wake = null
  }
  return {
    chunks: {
      async *[Symbol.asyncIterator]() {
        for (;;) {
          for (let next = queue.shift(); next !== undefined; next = queue.shift()) yield next
          if (error !== undefined) throw error
          if (done) return
          await new Promise<void>((resolve) => {
            wake = resolve
          })
        }
      },
    },
    push: (chunk) => {
      queue.push(chunk)
      notify()
    },
    end: () => {
      done = true
      notify()
    },
    fail: (err) => {
      error = err
      notify()
    },
  }
}

interface FakeOpen {
  url: string
  init: Parameters<StreamingFetch>[1]
}

function installFake(status: number, chunks: AsyncIterable<string>): { opens: FakeOpen[] } {
  const opens: FakeOpen[] = []
  configureStreamingFetch((url, init) => {
    opens.push({ url, init })
    return Promise.resolve({ status, chunks })
  })
  return { opens }
}

const frame = (payload: unknown): string => `data: ${JSON.stringify(payload)}\n\n`

/** Wait until the store leaves a given status (bounded, event-driven). */
function waitForState(
  stream: { state: { getState: () => SynthesisStreamState; subscribe: (cb: () => void) => () => void } },
  pred: (s: SynthesisStreamState) => boolean,
): Promise<SynthesisStreamState> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      unsub()
      reject(new Error(`state never matched; last: ${JSON.stringify(stream.state.getState())}`))
    }, 1000)
    const check = (): void => {
      const s = stream.state.getState()
      if (pred(s)) {
        clearTimeout(timer)
        unsub()
        resolve(s)
      }
    }
    const unsub = stream.state.subscribe(check)
    check()
  })
}

beforeEach(() => {
  resetTokenManager()
})

afterEach(() => {
  resetStreamingFetch()
})

describe('startSynthesisStream', () => {
  it('opens a POST with the JSON body + auth headers and resolves on a 200 head', async () => {
    const { chunks, end } = pushChunks()
    const { opens } = installFake(200, chunks)

    const stream = await startSynthesisStream(ctx, VALID_BODY)

    expect(opens).toHaveLength(1)
    expect(opens[0]?.url).toBe(`${BASE_URL}/api/campaigns/synthesize-preview/stream`)
    expect(opens[0]?.init.method).toBe('POST')
    expect(opens[0]?.init.headers).toMatchObject({
      authorization: 'Bearer t',
      'Content-Type': 'application/json',
    })
    expect(JSON.parse(opens[0]?.init.body ?? '')).toEqual(VALID_BODY)
    expect(stream.state.getState()).toEqual({ status: 'streaming', text: '' })
    end()
    stream.close()
  })

  it('rejects with ContractValidationError before any network when the body fails the contract', async () => {
    const { opens } = installFake(200, pushChunks().chunks)

    await expect(
      startSynthesisStream(ctx, { picks: [{ title: 'only-one', whyILikeIt: 'x' }] }),
    ).rejects.toBeInstanceOf(ContractValidationError)
    expect(opens).toHaveLength(0)
  })

  it('rejects with an HttpError carrying status/code/body on a non-200 open (guard trips)', async () => {
    const { chunks, push, end } = pushChunks()
    installFake(403, chunks)
    push(JSON.stringify({ code: 'insufficient_credits', creditType: 'world_gen' }))
    end()

    const err = await startSynthesisStream(ctx, VALID_BODY).catch((e: unknown) => e)

    expect(err).toBeInstanceOf(HttpError)
    const httpErr = err as HttpError
    expect(httpErr.status).toBe(403)
    expect(httpErr.code).toBe('insufficient_credits')
    expect(httpErr.body).toEqual({ code: 'insufficient_credits', creditType: 'world_gen' })
  })

  it('accumulates delta frames into streaming text, then resolves complete', async () => {
    const { chunks, push, end } = pushChunks()
    installFake(200, chunks)

    const stream = await startSynthesisStream(ctx, VALID_BODY)
    push(frame({ type: 'delta', text: 'A quiet ' }))
    const mid = await waitForState(stream, (s) => s.status === 'streaming' && s.text.length > 0)
    expect(mid).toEqual({ status: 'streaming', text: 'A quiet ' })

    // A frame split across two chunks reassembles.
    const second = frame({ type: 'delta', text: 'valley.' })
    push(second.slice(0, 10))
    push(second.slice(10))
    const grown = await waitForState(
      stream,
      (s) => s.status === 'streaming' && s.text === 'A quiet valley.',
    )
    expect(grown.status).toBe('streaming')

    push(frame({ type: 'complete', previewId: 'p-1', concept: 'A quiet valley, revised.' }))
    end()
    const done = await waitForState(stream, (s) => s.status === 'complete')
    // The terminal concept is authoritative (a post-stream repair may diverge).
    expect(done).toEqual({
      status: 'complete',
      previewId: 'p-1',
      concept: 'A quiet valley, revised.',
    })
  })

  it('resolves the rejected terminal into a ConceptRejection', async () => {
    const { chunks, push, end } = pushChunks()
    installFake(200, chunks)

    const stream = await startSynthesisStream(ctx, VALID_BODY)
    push(frame({ type: 'delta', text: 'A judged concept.' }))
    push(
      frame({
        type: 'rejected',
        code: 'concept_rejected',
        reason: 'clone_intent',
        rejectionMessage: 'Too close to an existing work.',
        synthesizedConcept: 'A judged concept.',
      }),
    )
    end()

    const done = await waitForState(stream, (s) => s.status === 'rejected')
    expect(done).toEqual({
      status: 'rejected',
      rejection: {
        code: 'concept_rejected',
        reason: 'clone_intent',
        rejectionMessage: 'Too close to an existing work.',
        synthesizedConcept: 'A judged concept.',
      },
    })
  })

  it('resolves a terminal error frame into failed with the wire code', async () => {
    const { chunks, push, end } = pushChunks()
    installFake(200, chunks)

    const stream = await startSynthesisStream(ctx, VALID_BODY)
    push(frame({ type: 'delta', text: 'Half a br' }))
    push(frame({ type: 'error', code: 'content_filtered' }))
    end()

    const done = await waitForState(stream, (s) => s.status === 'failed')
    expect(done).toEqual({ status: 'failed', code: 'content_filtered', text: 'Half a br' })
  })

  it('a stream that ends without a terminal frame fails honest: stream_interrupted', async () => {
    const { chunks, push, end } = pushChunks()
    installFake(200, chunks)

    const stream = await startSynthesisStream(ctx, VALID_BODY)
    push(frame({ type: 'delta', text: 'Half a br' }))
    end() // wifi drop / server crash — no terminal frame

    const done = await waitForState(stream, (s) => s.status === 'failed')
    expect(done).toEqual({ status: 'failed', code: 'stream_interrupted', text: 'Half a br' })
  })

  it('a mid-read transport error fails honest: stream_interrupted', async () => {
    const { chunks, push, fail } = pushChunks()
    installFake(200, chunks)

    const stream = await startSynthesisStream(ctx, VALID_BODY)
    push(frame({ type: 'delta', text: 'Half' }))
    fail(new Error('socket reset'))

    const done = await waitForState(stream, (s) => s.status === 'failed')
    expect(done).toEqual({ status: 'failed', code: 'stream_interrupted', text: 'Half' })
  })

  it('an event: close frame without a terminal data frame fails honest: stream_interrupted', async () => {
    const { chunks, push } = pushChunks()
    installFake(200, chunks)

    const stream = await startSynthesisStream(ctx, VALID_BODY)
    push('event: close\ndata: {"reason":"idle-timeout"}\n\n')

    const done = await waitForState(stream, (s) => s.status === 'failed')
    expect(done).toEqual({ status: 'failed', code: 'stream_interrupted', text: '' })
  })

  it('close() aborts the read and does NOT mark the stream failed (an intentional back-out)', async () => {
    const { chunks, push } = pushChunks()
    const { opens } = installFake(200, chunks)

    const stream = await startSynthesisStream(ctx, VALID_BODY)
    push(frame({ type: 'delta', text: 'Half' }))
    await waitForState(stream, (s) => s.status === 'streaming' && s.text === 'Half')

    stream.close()
    // The abort signal handed to the transport must have fired.
    expect(opens[0]?.init.signal.aborted).toBe(true)
    // The state stays as it was — no dishonest failed/complete transition.
    expect(stream.state.getState()).toEqual({ status: 'streaming', text: 'Half' })
  })

  it('rejects with NetworkError when the transport itself throws at open', async () => {
    configureStreamingFetch(() => Promise.reject(new Error('dns failed')))

    const err = await startSynthesisStream(ctx, VALID_BODY).catch((e: unknown) => e)

    expect(err).toBeInstanceOf(NetworkError)
    expect((err as NetworkError).message).toBe('dns failed')
  })

  it('a non-Error transport rejection still maps to NetworkError', async () => {
    // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors -- exercising the non-Error rejection arm
    configureStreamingFetch(() => Promise.reject('wire fell over'))

    const err = await startSynthesisStream(ctx, VALID_BODY).catch((e: unknown) => e)

    expect(err).toBeInstanceOf(NetworkError)
    expect((err as NetworkError).message).toBe('request failed')
  })

  it('non-200 error bodies without a string code still carry status + body', async () => {
    const { chunks, push, end } = pushChunks()
    installFake(429, chunks)
    push(JSON.stringify({ code: 429, detail: 'numeric code' }))
    end()

    const err = (await startSynthesisStream(ctx, VALID_BODY).catch((e: unknown) => e)) as HttpError
    expect(err.status).toBe(429)
    expect(err.code).toBeUndefined()
    expect(err.body).toEqual({ code: 429, detail: 'numeric code' })
  })

  it('a JSON error body with no code key carries body only', async () => {
    const { chunks, push, end } = pushChunks()
    installFake(500, chunks)
    push(JSON.stringify({ message: 'no code field at all' }))
    end()

    const err = (await startSynthesisStream(ctx, VALID_BODY).catch((e: unknown) => e)) as HttpError
    expect(err.status).toBe(500)
    expect(err.code).toBeUndefined()
    expect(err.body).toEqual({ message: 'no code field at all' })
  })

  it('a non-JSON (or empty) error body yields a bare HttpError with just the status', async () => {
    const { chunks, end } = pushChunks()
    installFake(502, chunks)
    end() // empty body — JSON.parse fails

    const err = (await startSynthesisStream(ctx, VALID_BODY).catch((e: unknown) => e)) as HttpError
    expect(err).toBeInstanceOf(HttpError)
    expect(err.status).toBe(502)
    expect(err.code).toBeUndefined()
    expect(err.body).toBeUndefined()
  })

  it('skips keepalive comments and bare named events without disturbing the state', async () => {
    const { chunks, push, end } = pushChunks()
    installFake(200, chunks)

    const stream = await startSynthesisStream(ctx, VALID_BODY)
    push(':keepalive\n\n') // comment frame — parseSseFrame yields null
    push('event: ping\n\n') // a named event with no data — nothing to fold
    push(frame({ type: 'delta', text: 'Alive.' }))
    push(frame({ type: 'complete', previewId: 'p-9', concept: 'Alive.' }))
    end()

    const done = await waitForState(stream, (s) => s.status === 'complete')
    expect(done).toEqual({ status: 'complete', previewId: 'p-9', concept: 'Alive.' })
  })

  it('close() is idempotent', async () => {
    const { chunks } = pushChunks()
    installFake(200, chunks)

    const stream = await startSynthesisStream(ctx, VALID_BODY)
    stream.close()
    stream.close() // second call is a no-op, not a crash
    expect(stream.state.getState()).toEqual({ status: 'streaming', text: '' })
  })

  it('useSynthesisState subscribes a component to the stream store', async () => {
    const { chunks, push, end } = pushChunks()
    installFake(200, chunks)
    const stream = await startSynthesisStream(ctx, VALID_BODY)

    const { result } = renderHook(() => useSynthesisState(stream))
    expect(result.current).toEqual({ status: 'streaming', text: '' })

    push(frame({ type: 'delta', text: 'Rendered live.' }))
    end()
    await rtlWaitFor(() => {
      expect(result.current).toEqual({
        status: 'failed',
        code: 'stream_interrupted',
        text: 'Rendered live.',
      })
    })
  })

  it('a terminal frame after close() is ignored (no late mutation)', async () => {
    const { chunks, push, end } = pushChunks()
    installFake(200, chunks)

    const stream = await startSynthesisStream(ctx, VALID_BODY)
    stream.close()
    push(frame({ type: 'complete', previewId: 'p-1', concept: 'late' }))
    end()

    // Give the (stale) read loop a tick to observe the pushed frame.
    await new Promise((r) => setTimeout(r, 10))
    expect(stream.state.getState()).toEqual({ status: 'streaming', text: '' })
  })
})
