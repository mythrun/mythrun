// backend/src/llm/__tests__/llm-fetch.stall-server.test.ts
//
// Integration pin of npm-undici timeout behavior (outage-resilience design
// §1.1/§1.2) against a real local node:http stall server. No mocks: real
// undici Agents with REDUCED timeouts injected via createDispatchers overrides
// so the tests assert the real error CODE paths (UND_ERR_HEADERS_TIMEOUT /
// UND_ERR_BODY_TIMEOUT) in a couple of seconds instead of the production
// 60s/120s. Elapsed-time assertions prove the injected numbers actually took
// effect — with a broken override path the production defaults would still
// produce the right codes, just 60s+ later.

import { createServer, type Server } from 'node:http'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { classifyLlmError } from '../classify-llm-error.js'
import { createDispatchers, createObservedFetch } from '../llm-fetch.js'

/** Read `.code` off an unknown error without type assertions. */
function errorCode(err: unknown): string | null {
  if (err instanceof Error && 'code' in err && typeof err.code === 'string') return err.code
  return null
}

/** Collect error codes through the `cause` chain (bounded, mirrors §1.2's walk). */
function collectCodes(err: unknown, depth = 0): string[] {
  if (depth > 5) return []
  const codes: string[] = []
  const code = errorCode(err)
  if (code !== null) codes.push(code)
  if (err instanceof Error && err.cause !== undefined) {
    codes.push(...collectCodes(err.cause, depth + 1))
  }
  return codes
}

async function rejectionOf(promise: Promise<unknown>): Promise<unknown> {
  return promise.then(
    () => {
      throw new Error('expected promise to reject')
    },
    (err: unknown) => err,
  )
}

describe('llm-fetch stall server (real undici)', { timeout: 90_000 }, () => {
  let server: Server
  let baseUrl: string

  // Sub-second timeouts on the streaming dispatcher; undici's internal timer
  // wheel has ~1s granularity, so observed firing is ~1-2s, still far below
  // the 30s elapsed ceiling asserted per test.
  const dispatchers = createDispatchers({
    streaming: { connectTimeoutMs: 1_000, headersTimeoutMs: 300, bodyTimeoutMs: 300 },
  })

  beforeAll(async () => {
    server = createServer((req, res) => {
      if (req.url === '/no-headers') {
        // Accept the request, never write status line or headers.
        return
      }
      // /stalled-body: send headers + one chunk, then idle forever.
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      res.write('data: hello\n\n')
    })
    await new Promise<void>((resolve) => {
      server.listen(0, '127.0.0.1', resolve)
    })
    const address = server.address()
    if (address === null || typeof address === 'string') throw new Error('expected AddressInfo')
    baseUrl = `http://127.0.0.1:${String(address.port)}`
  })

  afterAll(async () => {
    server.closeAllConnections()
    await new Promise<void>((resolve, reject) => {
      server.close((err) => {
        if (err) {
          reject(err)
        } else {
          resolve()
        }
      })
    })
    await Promise.all([dispatchers.streaming.destroy(), dispatchers.nonStreaming.destroy()])
  })

  it('never-sent headers reject with UND_ERR_HEADERS_TIMEOUT → connectivity, headersArrived=false', async () => {
    const { fetch, observation } = createObservedFetch(dispatchers)
    const startedAt = Date.now()

    const err = await rejectionOf(
      fetch(`${baseUrl}/no-headers`, { method: 'POST', body: '{"model":"m","stream":true}' }),
    )

    expect(Date.now() - startedAt).toBeLessThan(30_000)
    expect(collectCodes(err)).toContain('UND_ERR_HEADERS_TIMEOUT')
    expect(observation()).toEqual({ mode: 'streaming', headersArrived: false, invocationCount: 1 })

    const verdict = classifyLlmError(err, { mode: 'streaming', headersArrived: false })
    expect(verdict).toEqual({ retryWorthy: true, outageSignal: true, failureClass: 'connectivity' })
  })

  it('headers-then-idle body rejects with UND_ERR_BODY_TIMEOUT → connectivity, headersArrived=true', async () => {
    const { fetch, observation } = createObservedFetch(dispatchers)
    const startedAt = Date.now()

    const response = await fetch(`${baseUrl}/stalled-body`, {
      method: 'POST',
      body: '{"model":"m","stream":true}',
    })
    expect(response.status).toBe(200)
    expect(observation()).toEqual({ mode: 'streaming', headersArrived: true, invocationCount: 1 })

    const err = await rejectionOf(response.text())

    expect(Date.now() - startedAt).toBeLessThan(30_000)
    expect(collectCodes(err)).toContain('UND_ERR_BODY_TIMEOUT')

    const verdict = classifyLlmError(err, { mode: 'streaming', headersArrived: true })
    expect(verdict).toEqual({ retryWorthy: true, outageSignal: true, failureClass: 'connectivity' })
  })
})
