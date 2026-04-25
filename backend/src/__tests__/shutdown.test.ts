import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { createShutdown, buildApp } from '../app.js'
import type { AppDeps } from '../app-deps.js'

type ExitFn = (code?: string | number | null) => never

describe('createShutdown', () => {
  let exitSpy: ReturnType<typeof vi.fn<ExitFn>>
  const originalExit: ExitFn = process.exit.bind(process)

  beforeEach(() => {
    exitSpy = vi.fn<ExitFn>(() => undefined as never)
    process.exit = exitSpy
  })

  afterEach(() => {
    process.exit = originalExit
  })

  it('calls app.close before process.exit(0) on clean shutdown', async () => {
    const app = buildApp({} as AppDeps)
    const callOrder: string[] = []

    vi.spyOn(app, 'close').mockImplementation(
      (() => {
        callOrder.push('close')
        return Promise.resolve()
      }) as unknown as typeof app.close,
    )
    exitSpy.mockImplementation((code) => {
      callOrder.push(`exit:${String(code)}`)
      return undefined as never
    })

    const handler = createShutdown(app)
    await handler('SIGTERM')

    expect(callOrder).toEqual(['close', 'exit:0'])
  })

  it('exits with code 1 if app.close throws', async () => {
    const app = buildApp({} as AppDeps)
    vi.spyOn(app, 'close').mockImplementation(
      (() => Promise.reject(new Error('boom'))) as unknown as typeof app.close,
    )

    const handler = createShutdown(app)
    await handler('SIGTERM')

    expect(exitSpy).toHaveBeenCalledWith(1)
  })
})
