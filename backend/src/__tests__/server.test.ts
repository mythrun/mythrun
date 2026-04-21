import { describe, it, expect } from 'vitest'
import { buildApp } from '../server.js'

describe('GET /health', () => {
  it('returns {status: "ok"}', async () => {
    const app = buildApp()
    const res = await app.inject({ method: 'GET', url: '/health' })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ status: 'ok' })
  })
})
