import Fastify, { type FastifyInstance } from 'fastify'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('aws-jwt-verify', () => ({
  CognitoJwtVerifier: {
    create: () => ({
      verify: vi.fn().mockResolvedValue({ sub: 's', username: 'u', scope: '' }),
      hydrate: vi.fn().mockResolvedValue(undefined),
    }),
  },
}))

import { registerAuth } from '../index.js'

beforeEach(() => {
  vi.stubEnv('NODE_ENV', 'development')
  vi.stubEnv('COGNITO_USER_POOL_ID', '')
  vi.stubEnv('COGNITO_APP_CLIENT_ID', '')
  vi.stubEnv('COGNITO_ISSUER_URL', '')
  vi.stubEnv('COGNITO_HOSTED_UI_DOMAIN', '')
  globalThis.fetch = () => Promise.reject(new Error('ECONNREFUSED'))
})

describe('registerAuth', () => {
  let app: FastifyInstance | undefined
  afterEach(async () => {
    if (app) await app.close()
    app = undefined
  })

  it('registers bypass plugin in bypass mode', async () => {
    app = Fastify({ logger: false })
    await registerAuth(app, { mode: 'bypass' })
    expect(app.hasDecorator('mythAuthRegistered')).toBe(true)
  })

  it('registers jwt plugin in real mode', async () => {
    app = Fastify({ logger: false })
    await registerAuth(app, {
      mode: 'real',
      userPoolId: 'us-east-1_x',
      appClientId: 'c',
    })
    expect(app.hasDecorator('jwtVerifier')).toBe(true)
  })

  it('throws if real mode without userPoolId', async () => {
    app = Fastify({ logger: false })
    await expect(registerAuth(app, { mode: 'real', appClientId: 'c' })).rejects.toThrow(
      /real mode requires userPoolId and appClientId/,
    )
  })

  it('throws if real mode without appClientId', async () => {
    app = Fastify({ logger: false })
    await expect(registerAuth(app, { mode: 'real', userPoolId: 'us-east-1_x' })).rejects.toThrow(
      /real mode requires userPoolId and appClientId/,
    )
  })

  it('passes Cognito values through to bypass plugin Layer 3', async () => {
    app = Fastify({ logger: false })
    await expect(
      registerAuth(app, {
        mode: 'bypass',
        userPoolId: 'us-east-1_xxx', // simulating misconfig
      }),
    ).rejects.toThrow(/Cognito config present/)
  })
})
