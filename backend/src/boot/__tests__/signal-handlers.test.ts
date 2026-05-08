import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { installSignalHandlers } from '../signal-handlers.js'

describe('installSignalHandlers', () => {
  let listeners: { signal: NodeJS.Signals; fn: NodeJS.SignalsListener }[]

  beforeEach(() => {
    listeners = []
    vi.spyOn(process, 'on').mockImplementation(((
      sig: NodeJS.Signals,
      fn: NodeJS.SignalsListener,
    ) => {
      listeners.push({ signal: sig, fn })
      return process
    }) as unknown as typeof process.on)
  })
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('calls controller.abort when SIGINT fires', () => {
    const controller = new AbortController()
    installSignalHandlers(controller)
    const sigint = listeners.find((l) => l.signal === 'SIGINT')
    expect(sigint).toBeDefined()
    sigint?.fn('SIGINT')
    expect(controller.signal.aborted).toBe(true)
  })

  it('calls controller.abort when SIGTERM fires', () => {
    const controller = new AbortController()
    installSignalHandlers(controller)
    const sigterm = listeners.find((l) => l.signal === 'SIGTERM')
    expect(sigterm).toBeDefined()
    sigterm?.fn('SIGTERM')
    expect(controller.signal.aborted).toBe(true)
  })

  it('is idempotent on multiple signals (does not throw on second abort)', () => {
    const controller = new AbortController()
    installSignalHandlers(controller)
    const sigint = listeners.find((l) => l.signal === 'SIGINT')
    expect(() => {
      sigint?.fn('SIGINT')
      sigint?.fn('SIGINT')
    }).not.toThrow()
    expect(controller.signal.aborted).toBe(true)
  })
})
