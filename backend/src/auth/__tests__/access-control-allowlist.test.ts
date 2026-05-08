import Fastify, { type FastifyInstance } from 'fastify'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { accessControlAllowlist } from '../access-control-allowlist.js'
import { requireCampaignMember, requireWorldCreator } from '../access-control.js'
import type { Repo } from '../../repo/index.js'

const fakeRepo = {
  campaigns: { getMembership: vi.fn() },
  worlds: { getById: vi.fn() },
} as unknown as Repo

describe('accessControlAllowlist', () => {
  let app: FastifyInstance | undefined

  afterEach(async () => {
    if (app) await app.close()
    app = undefined
  })

  it('app.ready() throws when requireCampaignMember + auth: public', async () => {
    app = Fastify({ logger: false })
    await app.register(accessControlAllowlist)
    app.post(
      '/c/:campaignId/x',
      { config: { auth: 'public' }, preHandler: requireCampaignMember(fakeRepo) },
      () => ({ ok: true }),
    )
    let err: Error | undefined
    try {
      await app.ready()
    } catch (e) {
      err = e as Error
    }
    expect(err?.message).toMatch(/access-control-allowlist/i)
  })

  it('app.ready() throws when requireWorldCreator + auth: jwt-no-db', async () => {
    app = Fastify({ logger: false })
    await app.register(accessControlAllowlist)
    app.get(
      '/w/:worldId',
      { config: { auth: 'jwt-no-db' }, preHandler: requireWorldCreator(fakeRepo) },
      () => ({ ok: true }),
    )
    let err: Error | undefined
    try {
      await app.ready()
    } catch (e) {
      err = e as Error
    }
    expect(err?.message).toMatch(/access-control-allowlist/i)
  })

  it('app.ready() succeeds with default-auth + requireCampaignMember', async () => {
    app = Fastify({ logger: false })
    await app.register(accessControlAllowlist)
    app.post(
      '/c/:campaignId/x',
      { preHandler: requireCampaignMember(fakeRepo) },
      () => ({ ok: true }),
    )
    await expect(app.ready()).resolves.toBeDefined()
  })

  it('app.ready() succeeds for unrelated public route (no access-control middleware)', async () => {
    app = Fastify({ logger: false })
    await app.register(accessControlAllowlist)
    app.get('/health', { config: { auth: 'public' } }, () => ({ ok: true }))
    await expect(app.ready()).resolves.toBeDefined()
  })

  it('lists offenders in the thrown error message', async () => {
    app = Fastify({ logger: false })
    await app.register(accessControlAllowlist)
    app.post(
      '/c/:campaignId/x',
      { config: { auth: 'public' }, preHandler: requireCampaignMember(fakeRepo) },
      () => ({ ok: true }),
    )
    let err: Error | undefined
    try {
      await app.ready()
    } catch (e) {
      err = e as Error
    }
    expect(err?.message).toMatch(/POST \/c\/:campaignId\/x/)
  })
})
