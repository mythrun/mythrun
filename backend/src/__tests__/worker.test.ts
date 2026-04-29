import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../config/env.js', () => ({
  loadEnv: () => ({
    redisBatchUrl: 'redis://localhost:6379',
    // Other fields not consumed by main()
  }),
}))

const pingMock = vi.fn((): Promise<string> => Promise.resolve('PONG'))
const quitMock = vi.fn((): Promise<string> => Promise.resolve('OK'))

vi.mock('../redis/client.js', () => ({
  createRedisClient: () => ({
    ping: pingMock,
    quit: quitMock,
  }),
}))

describe('worker.main()', () => {
  beforeEach(() => {
    vi.useRealTimers()
    pingMock.mockClear()
    quitMock.mockClear()
  })

  afterEach(() => {
    process.removeAllListeners('SIGTERM')
    process.removeAllListeners('SIGINT')
    vi.restoreAllMocks()
  })

  it('logs "worker started" then exits cleanly on SIGTERM', async () => {
    const { main } = await import('../worker.js')
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => undefined as never)
    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined)

    void main() // never awaited — main blocks forever on Promise<never>

    await vi.waitFor(() => {
      expect(consoleSpy).toHaveBeenCalledWith('worker started')
    })
    expect(pingMock).toHaveBeenCalledTimes(1)

    process.emit('SIGTERM', 'SIGTERM' as NodeJS.Signals)

    await vi.waitFor(() => {
      expect(exitSpy).toHaveBeenCalledWith(0)
    })
    expect(quitMock).toHaveBeenCalledTimes(1)
  })
})
