import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { loadEnv } from '../env.js'

const REQUIRED = {
  DATABASE_URL: 'postgresql://u:p@h:5432/d',
  REDIS_REALTIME_URL: 'redis://h:6379',
  REDIS_BATCH_URL: 'redis://h:6380',
  PORT: '3000',
} as const

const ORIGINAL_ENV = { ...process.env }

function clearRequired(): void {
  delete process.env.DATABASE_URL
  delete process.env.REDIS_REALTIME_URL
  delete process.env.REDIS_BATCH_URL
  delete process.env.PORT
}

describe('loadEnv', () => {
  beforeEach(() => {
    clearRequired()
  })
  afterEach(() => {
    process.env = { ...ORIGINAL_ENV }
  })

  it('returns a frozen Env object when all required vars are present', () => {
    Object.assign(process.env, REQUIRED)
    const env = loadEnv()
    expect(env.databaseUrl).toBe('postgresql://u:p@h:5432/d')
    expect(env.redisRealtimeUrl).toBe('redis://h:6379')
    expect(env.redisBatchUrl).toBe('redis://h:6380')
    expect(env.port).toBe(3000)
    expect(Object.isFrozen(env)).toBe(true)
  })

  it('throws "Missing required env var: DATABASE_URL" when DATABASE_URL is absent', () => {
    Object.assign(process.env, REQUIRED)
    delete process.env.DATABASE_URL
    expect(() => loadEnv()).toThrow('Missing required env var: DATABASE_URL')
  })

  it('throws when REDIS_REALTIME_URL is absent', () => {
    Object.assign(process.env, REQUIRED)
    delete process.env.REDIS_REALTIME_URL
    expect(() => loadEnv()).toThrow('Missing required env var: REDIS_REALTIME_URL')
  })

  it('throws when REDIS_BATCH_URL is absent', () => {
    Object.assign(process.env, REQUIRED)
    delete process.env.REDIS_BATCH_URL
    expect(() => loadEnv()).toThrow('Missing required env var: REDIS_BATCH_URL')
  })

  it('coerces PORT from string to number', () => {
    Object.assign(process.env, REQUIRED, { PORT: '8080' })
    expect(loadEnv().port).toBe(8080)
  })

  it('throws when PORT is not numeric', () => {
    Object.assign(process.env, REQUIRED, { PORT: 'abc' })
    expect(() => loadEnv()).toThrow(/PORT must be numeric/)
  })

  it('returned object cannot be mutated (strict mode)', () => {
    Object.assign(process.env, REQUIRED)
    const env = loadEnv() as { port: number }
    expect(() => {
      env.port = 9999
    }).toThrow(TypeError)
  })
})
