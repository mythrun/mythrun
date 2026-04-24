import { describe, it, expect, afterEach } from 'vitest'
import { buildApp } from '../app.js'

describe('buildApp', () => {
  let app: ReturnType<typeof buildApp> | undefined
  afterEach(async () => {
    if (app) {
      await app.close()
      app = undefined
    }
  })

  it('builds a Fastify instance with no side effects on import', () => {
    app = buildApp()
    expect(app).toBeDefined()
  })

  it('/health returns {status:"ok"}', async () => {
    app = buildApp()
    const res = await app.inject({ method: 'GET', url: '/health' })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ status: 'ok' })
  })
})
