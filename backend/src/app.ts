import Fastify, { type FastifyInstance } from 'fastify'

export const buildApp = (): FastifyInstance => {
  const app = Fastify({ logger: true })
  app.get('/health', () => ({ status: 'ok' }))
  return app
}
