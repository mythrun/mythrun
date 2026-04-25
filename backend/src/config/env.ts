export interface Env {
  readonly databaseUrl: string
  readonly redisRealtimeUrl: string
  readonly redisBatchUrl: string
  readonly port: number
}

const REQUIRED_KEYS = [
  'DATABASE_URL',
  'REDIS_REALTIME_URL',
  'REDIS_BATCH_URL',
  'PORT',
] as const

export function loadEnv(): Env {
  for (const key of REQUIRED_KEYS) {
    if (!process.env[key]) {
      throw new Error(`Missing required env var: ${key}`)
    }
  }
  const portRaw = process.env.PORT ?? ''
  const port = Number(portRaw)
  if (!Number.isFinite(port) || port <= 0) {
    throw new Error(`PORT must be numeric, got: ${portRaw}`)
  }
  return Object.freeze({
    databaseUrl: process.env.DATABASE_URL ?? '',
    redisRealtimeUrl: process.env.REDIS_REALTIME_URL ?? '',
    redisBatchUrl: process.env.REDIS_BATCH_URL ?? '',
    port,
  })
}
