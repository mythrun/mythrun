// backend/src/sse/__tests__/sse-connection.test.ts
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import { EventEmitter } from 'node:events'
import pino from 'pino'
import { openSseConnection } from '../sse-connection.js'

interface MockRaw extends EventEmitter {
  headersSent: boolean
  written: string[]
  ended: boolean
  writeHead: (status: number, headers: Record<string, string>) => MockRaw
  write: (chunk: string) => boolean
  end: () => void
  // Test-only: control the next write's return value.
  __nextWriteReturns: boolean
}

function makeRaw(): MockRaw {
  const raw = new EventEmitter() as MockRaw
  raw.headersSent = false
  raw.written = []
  raw.ended = false
  raw.__nextWriteReturns = true
  raw.writeHead = (): MockRaw => {
    raw.headersSent = true
    return raw
  }
  raw.write = (chunk: string): boolean => {
    if (raw.ended) throw new Error('write after end')
    raw.written.push(chunk)
    return raw.__nextWriteReturns
  }
  raw.end = (): void => {
    raw.ended = true
  }
  return raw
}

interface MockReply {
  hijacked: boolean
  raw: MockRaw
  hijack: () => void
}

function makeReply(): MockReply {
  return {
    hijacked: false,
    raw: makeRaw(),
    hijack(): void {
      this.hijacked = true
    },
  }
}

function makeRequest(): { raw: EventEmitter } {
  return { raw: new EventEmitter() }
}

describe('sse-connection', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('calls reply.hijack() before writing headers', () => {
    const reply = makeReply()
    const request = makeRequest()
    const onClose = vi.fn()
    openSseConnection({
      request: request as never,
      reply: reply as never,
      logger: pino({ level: 'silent' }),
      onClose,
    })
    expect(reply.hijacked).toBe(true)
    expect(reply.raw.headersSent).toBe(true)
  })

  it('writes SSE response headers (no Connection: keep-alive)', () => {
    const reply = makeReply()
    let capturedHeaders: Record<string, string> = {}
    reply.raw.writeHead = (_: number, headers: Record<string, string>): MockRaw => {
      capturedHeaders = headers
      reply.raw.headersSent = true
      return reply.raw
    }
    const request = makeRequest()
    openSseConnection({
      request: request as never,
      reply: reply as never,
      logger: pino({ level: 'silent' }),
      onClose: () => undefined,
    })
    expect(capturedHeaders['Content-Type']).toBe('text/event-stream; charset=utf-8')
    expect(capturedHeaders['Cache-Control']).toBe('no-cache, no-transform')
    expect(capturedHeaders['X-Accel-Buffering']).toBe('no')
    expect(capturedHeaders.Connection).toBeUndefined()
  })

  it('write returns boolean from underlying raw.write', () => {
    const reply = makeReply()
    const request = makeRequest()
    const sink = openSseConnection({
      request: request as never,
      reply: reply as never,
      logger: pino({ level: 'silent' }),
      onClose: () => undefined,
    })
    reply.raw.__nextWriteReturns = true
    expect(sink.write('data: hi\n\n')).toBe(true)
    reply.raw.__nextWriteReturns = false
    expect(sink.write('data: bye\n\n')).toBe(false)
  })

  it('emits keepalive comment frame every 25 seconds when no events flow', () => {
    const reply = makeReply()
    const request = makeRequest()
    openSseConnection({
      request: request as never,
      reply: reply as never,
      logger: pino({ level: 'silent' }),
      onClose: () => undefined,
    })
    vi.advanceTimersByTime(25_000)
    expect(reply.raw.written.some((w) => w.startsWith(':keepalive'))).toBe(true)
  })

  it('keepalive timer re-arms after each event-write (no double-emit on busy stream)', () => {
    const reply = makeReply()
    const request = makeRequest()
    const sink = openSseConnection({
      request: request as never,
      reply: reply as never,
      logger: pino({ level: 'silent' }),
      onClose: () => undefined,
    })
    vi.advanceTimersByTime(20_000)
    sink.write('event: phase\ndata: {"phase":"world_gen"}\n\n')
    vi.advanceTimersByTime(20_000) // total 40s of wall, but the timer reset after the write
    const keepalives = reply.raw.written.filter((w) => w.startsWith(':keepalive')).length
    expect(keepalives).toBe(0)
  })

  it('closes with idle-timeout reason after 30 min no event', () => {
    const reply = makeReply()
    const request = makeRequest()
    const onClose = vi.fn()
    openSseConnection({
      request: request as never,
      reply: reply as never,
      logger: pino({ level: 'silent' }),
      onClose,
    })
    vi.advanceTimersByTime(30 * 60_000)
    const closeFrame = reply.raw.written.find((w) => w.includes('event: close'))
    expect(closeFrame).toContain('idle-timeout')
    expect(reply.raw.ended).toBe(true)
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('runs onClose exactly once when request.raw fires close', () => {
    const reply = makeReply()
    const request = makeRequest()
    const onClose = vi.fn()
    openSseConnection({
      request: request as never,
      reply: reply as never,
      logger: pino({ level: 'silent' }),
      onClose,
    })
    request.raw.emit('close')
    request.raw.emit('close') // idempotent
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('runs onClose exactly once when reply.raw fires close (dual listener)', () => {
    const reply = makeReply()
    const request = makeRequest()
    const onClose = vi.fn()
    openSseConnection({
      request: request as never,
      reply: reply as never,
      logger: pino({ level: 'silent' }),
      onClose,
    })
    reply.raw.emit('close')
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('sink.close(reason) writes close frame + ends response + runs onClose', () => {
    const reply = makeReply()
    const request = makeRequest()
    const onClose = vi.fn()
    const sink = openSseConnection({
      request: request as never,
      reply: reply as never,
      logger: pino({ level: 'silent' }),
      onClose,
    })
    sink.close('server-shutdown')
    expect(reply.raw.written.some((w) => w.includes('server-shutdown'))).toBe(true)
    expect(reply.raw.ended).toBe(true)
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('sink.close is idempotent (does not re-write or re-fire onClose)', () => {
    const reply = makeReply()
    const request = makeRequest()
    const onClose = vi.fn()
    const sink = openSseConnection({
      request: request as never,
      reply: reply as never,
      logger: pino({ level: 'silent' }),
      onClose,
    })
    sink.close('idle-timeout')
    const writeCount = reply.raw.written.length
    sink.close('server-shutdown')
    expect(reply.raw.written.length).toBe(writeCount)
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('closes with back-pressure when write returns false and drain does not fire in 5s', () => {
    const reply = makeReply()
    const request = makeRequest()
    const onClose = vi.fn()
    const sink = openSseConnection({
      request: request as never,
      reply: reply as never,
      logger: pino({ level: 'silent' }),
      onClose,
    })
    reply.raw.__nextWriteReturns = false
    sink.write('data: slow\n\n')
    vi.advanceTimersByTime(5_000)
    const closeFrame = reply.raw.written.find((w) => w.includes('event: close'))
    expect(closeFrame).toContain('back-pressure')
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('logs a warning when onClose handler itself throws (idempotent close)', () => {
    // Exercises sse-connection.ts:107-111 — the inner try/catch around
    // the user-supplied onClose. If it throws, we log + continue rather
    // than letting the exception escape close().
    const reply = makeReply()
    const request = makeRequest()
    const logger = pino({ level: 'silent' })
    const warnSpy = vi.spyOn(logger, 'warn')
    const sink = openSseConnection({
      request: request as never,
      reply: reply as never,
      logger,
      onClose: () => {
        throw new Error('handler-boom')
      },
    })
    expect(() => sink.close('server-shutdown')).not.toThrow()
    expect(warnSpy).toHaveBeenCalled()
  })

  it('write that throws closes the connection with reason=unknown', () => {
    // Exercises sse-connection.ts:130-134 — raw.write itself rejects /
    // throws (e.g., socket was forcibly torn). The wrapper logs, closes
    // with 'unknown', and returns false. Subsequent writes are no-ops.
    const reply = makeReply()
    const request = makeRequest()
    const onClose = vi.fn()
    const logger = pino({ level: 'silent' })
    const warnSpy = vi.spyOn(logger, 'warn')
    const sink = openSseConnection({
      request: request as never,
      reply: reply as never,
      logger,
      onClose,
    })
    // First write — flip raw.write to throw synchronously.
    reply.raw.write = (): boolean => {
      throw new Error('socket-gone')
    }
    expect(sink.write('data: dropped\n\n')).toBe(false)
    expect(warnSpy).toHaveBeenCalled()
    expect(onClose).toHaveBeenCalledTimes(1)
    // Sink is closed; subsequent writes short-circuit (the closed guard).
    expect(sink.write('data: ignored\n\n')).toBe(false)
  })

  it('drain event before timeout clears the back-pressure close', () => {
    const reply = makeReply()
    const request = makeRequest()
    const onClose = vi.fn()
    const sink = openSseConnection({
      request: request as never,
      reply: reply as never,
      logger: pino({ level: 'silent' }),
      onClose,
    })
    reply.raw.__nextWriteReturns = false
    sink.write('data: slow\n\n')
    vi.advanceTimersByTime(2_000)
    reply.raw.emit('drain')
    vi.advanceTimersByTime(5_000)
    expect(onClose).not.toHaveBeenCalled()
  })
})
