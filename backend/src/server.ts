import { buildApp, createShutdown } from './app.js'

const app = buildApp()
const port = Number(process.env.PORT ?? 3000)
await app.listen({ port, host: '0.0.0.0' })

const handleShutdown = createShutdown(app)
for (const signal of ['SIGTERM', 'SIGINT'] as const) {
  process.on(signal, () => void handleShutdown(signal))
}
