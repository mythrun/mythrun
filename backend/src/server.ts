import Fastify from 'fastify'

export const buildApp = () => {
  const app = Fastify({ logger: true })
  // eslint-disable-next-line @typescript-eslint/require-await -- Fastify handlers are idiomatically async; future handlers will await.
  app.get('/health', async () => ({ status: 'ok' }))
  return app
}

const app = buildApp()
const port = Number(process.env.PORT ?? 3000)
await app.listen({ port, host: '0.0.0.0' })
