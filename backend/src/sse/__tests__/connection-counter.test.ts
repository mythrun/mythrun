// backend/src/sse/__tests__/connection-counter.test.ts
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import pino from 'pino'
import { createConnectionCounter } from '../connection-counter.js'

describe('connection-counter', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('starts at zero', () => {
    const logger = pino({ level: 'silent' })
    const counter = createConnectionCounter(logger)
    expect(counter.current()).toBe(0)
  })

  it('increments and decrements', () => {
    const logger = pino({ level: 'silent' })
    const counter = createConnectionCounter(logger)
    counter.increment()
    counter.increment()
    counter.decrement()
    expect(counter.current()).toBe(1)
  })

  it('tracks wasted messages independently', () => {
    const logger = pino({ level: 'silent' })
    const counter = createConnectionCounter(logger)
    counter.incrementWasted()
    counter.incrementWasted()
    counter.incrementWasted()
    counter.increment()
    expect(counter.current()).toBe(1)
  })

  it('logs every 60 seconds with count + max_since_last + wasted_msgs', () => {
    const logs: Record<string, unknown>[] = []
    const logger = pino(
      { level: 'info' },
      {
        write(msg: string): void {
          logs.push(JSON.parse(msg) as Record<string, unknown>)
        },
      },
    )
    const counter = createConnectionCounter(logger)
    counter.increment()
    counter.increment()
    counter.increment()
    counter.decrement()
    counter.incrementWasted()
    const stop = counter.startPeriodicLog()

    vi.advanceTimersByTime(60_000)

    const line = logs.find((l) => l.event === 'sse.connections.active')
    expect(line).toBeDefined()
    expect(line?.count).toBe(2)
    expect(line?.max_since_last).toBe(3)
    expect(line?.wasted_msgs).toBe(1)

    stop()
  })

  it('resets max_since_last and wasted_msgs after each log emission', () => {
    const logs: Record<string, unknown>[] = []
    const logger = pino(
      { level: 'info' },
      {
        write(msg: string): void {
          logs.push(JSON.parse(msg) as Record<string, unknown>)
        },
      },
    )
    const counter = createConnectionCounter(logger)
    counter.increment()
    counter.incrementWasted()
    const stop = counter.startPeriodicLog()

    vi.advanceTimersByTime(60_000)
    vi.advanceTimersByTime(60_000)

    const lines = logs.filter((l) => l.event === 'sse.connections.active')
    expect(lines.length).toBeGreaterThanOrEqual(2)
    const second = lines[1]
    expect(second?.max_since_last).toBe(1) // current after first emission resets to current
    expect(second?.wasted_msgs).toBe(0)    // reset after emission

    stop()
  })

  it('stopPeriodicLog clears the interval', () => {
    const logs: Record<string, unknown>[] = []
    const logger = pino(
      { level: 'info' },
      {
        write(msg: string): void {
          logs.push(JSON.parse(msg) as Record<string, unknown>)
        },
      },
    )
    const counter = createConnectionCounter(logger)
    counter.increment()
    const stop = counter.startPeriodicLog()
    stop()
    vi.advanceTimersByTime(60_000)
    const lines = logs.filter((l) => l.event === 'sse.connections.active')
    expect(lines).toHaveLength(0)
  })
})
