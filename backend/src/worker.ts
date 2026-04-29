import { pathToFileURL } from 'node:url'
import { loadEnv } from './config/env.js'
import { createRedisClient } from './redis/client.js'

export async function main(): Promise<void> {
  const env = loadEnv()
  const redis = createRedisClient(env.redisBatchUrl)
  // Force the connection so failures surface at startup, not at first job.
  await redis.ping()
  console.log('worker started')

  let shuttingDown = false
  const shutdown = async (signal: NodeJS.Signals): Promise<void> => {
    if (shuttingDown) return
    shuttingDown = true
    console.log(`worker stopping (${signal})`)
    await redis.quit().catch(() => undefined)
    process.exit(0)
  }
  for (const signal of ['SIGTERM', 'SIGINT'] as const) {
    process.on(signal, () => void shutdown(signal))
  }

  // Block forever — keep the event loop alive. Everything below this line
  // is unreachable; shutdown only happens via signal handler.
  await new Promise<never>(() => undefined)
}

// PRODUCTION INVOCATION: this file runs ONLY via `node dist/worker.js` in
// the worker container. Not run via `tsx` (no `dev:worker` script today)
// — the entry-point guard would return false under `tsx watch` because
// process.argv[1] points at the tsx loader, not at this file.
const isEntryPoint =
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(process.argv[1]).href
if (isEntryPoint) {
  await main()
}
