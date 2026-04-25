import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { loadEnv } from '../env.js'

const URL_FORM = {
  DATABASE_URL: 'postgresql://u:p@h:5432/d',
  REDIS_REALTIME_URL: 'redis://h:6379',
  REDIS_BATCH_URL: 'redis://h:6380',
  PORT: '3000',
} as const

const COMPONENT_FORM = {
  DB_HOST: 'rds.example.com',
  DB_PORT: '5432',
  DB_USER: 'mythrun_staging',
  DB_NAME: 'mythrun_staging',
  DB_PASSWORD: 'secret-pw',
  REDIS_HOST: 'cache.example.com',
  REDIS_PORT: '6379',
  REDIS_AUTH_TOKEN: 'redis-secret',
  PORT: '3000',
} as const

const ORIGINAL_ENV = { ...process.env }

function clearAll(): void {
  delete process.env.DATABASE_URL
  delete process.env.REDIS_REALTIME_URL
  delete process.env.REDIS_BATCH_URL
  delete process.env.PORT
  delete process.env.DB_HOST
  delete process.env.DB_PORT
  delete process.env.DB_USER
  delete process.env.DB_NAME
  delete process.env.DB_PASSWORD
  delete process.env.REDIS_HOST
  delete process.env.REDIS_PORT
  delete process.env.REDIS_AUTH_TOKEN
}

describe('loadEnv (URL form — dev)', () => {
  beforeEach(() => {
    clearAll()
  })
  afterEach(() => {
    process.env = { ...ORIGINAL_ENV }
  })

  it('returns a frozen Env object when all URL-form vars are present', () => {
    Object.assign(process.env, URL_FORM)
    const env = loadEnv()
    expect(env.databaseUrl).toBe('postgresql://u:p@h:5432/d')
    expect(env.redisRealtimeUrl).toBe('redis://h:6379')
    expect(env.redisBatchUrl).toBe('redis://h:6380')
    expect(env.port).toBe(3000)
    expect(Object.isFrozen(env)).toBe(true)
  })

  it('coerces PORT from string to number', () => {
    Object.assign(process.env, URL_FORM, { PORT: '8080' })
    expect(loadEnv().port).toBe(8080)
  })

  it('throws when PORT is not numeric', () => {
    Object.assign(process.env, URL_FORM, { PORT: 'abc' })
    expect(() => loadEnv()).toThrow(/PORT must be numeric/)
  })

  it('throws when PORT is missing', () => {
    Object.assign(process.env, URL_FORM)
    delete process.env.PORT
    expect(() => loadEnv()).toThrow('Missing required env var: PORT')
  })

  it('returned object cannot be mutated (strict mode)', () => {
    Object.assign(process.env, URL_FORM)
    const env = loadEnv() as { port: number }
    expect(() => {
      env.port = 9999
    }).toThrow(TypeError)
  })
})

describe('loadEnv (component form — prod)', () => {
  beforeEach(() => {
    clearAll()
  })
  afterEach(() => {
    process.env = { ...ORIGINAL_ENV }
  })

  it('constructs DATABASE_URL with sslmode=require from DB_* components', () => {
    Object.assign(process.env, COMPONENT_FORM)
    const env = loadEnv()
    expect(env.databaseUrl).toBe(
      'postgresql://mythrun_staging:secret-pw@rds.example.com:5432/mythrun_staging?sslmode=require',
    )
  })

  it('constructs rediss:// URLs with auth when REDIS_AUTH_TOKEN is set; same URL for both roles', () => {
    Object.assign(process.env, COMPONENT_FORM)
    const env = loadEnv()
    expect(env.redisRealtimeUrl).toBe('rediss://:redis-secret@cache.example.com:6379')
    expect(env.redisBatchUrl).toBe('rediss://:redis-secret@cache.example.com:6379')
  })

  it('constructs redis:// (no TLS) when REDIS_AUTH_TOKEN is absent', () => {
    Object.assign(process.env, COMPONENT_FORM)
    delete process.env.REDIS_AUTH_TOKEN
    const env = loadEnv()
    expect(env.redisRealtimeUrl).toBe('redis://cache.example.com:6379')
  })

  it('URL-encodes credentials with special characters', () => {
    Object.assign(process.env, COMPONENT_FORM, { DB_PASSWORD: 'p@ss/w:rd' })
    const env = loadEnv()
    expect(env.databaseUrl).toContain('p%40ss%2Fw%3Ard')
  })

  it('throws when DB_HOST is missing and DATABASE_URL is not set', () => {
    Object.assign(process.env, COMPONENT_FORM)
    delete process.env.DB_HOST
    expect(() => loadEnv()).toThrow(/Missing database config/)
  })

  it('throws when REDIS_HOST is missing and REDIS_REALTIME_URL is not set', () => {
    Object.assign(process.env, COMPONENT_FORM)
    delete process.env.REDIS_HOST
    expect(() => loadEnv()).toThrow(/Missing redis config/)
  })
})

describe('loadEnv (mixed)', () => {
  beforeEach(() => {
    clearAll()
  })
  afterEach(() => {
    process.env = { ...ORIGINAL_ENV }
  })

  it('explicit DATABASE_URL takes precedence over DB_* components', () => {
    Object.assign(process.env, COMPONENT_FORM, {
      DATABASE_URL: 'postgresql://override:override@override:5432/override',
    })
    expect(loadEnv().databaseUrl).toBe('postgresql://override:override@override:5432/override')
  })

  it('explicit REDIS_REALTIME_URL overrides only the realtime URL; batch still constructed', () => {
    Object.assign(process.env, COMPONENT_FORM, {
      REDIS_REALTIME_URL: 'redis://override:6379',
    })
    const env = loadEnv()
    expect(env.redisRealtimeUrl).toBe('redis://override:6379')
    expect(env.redisBatchUrl).toBe('rediss://:redis-secret@cache.example.com:6379')
  })
})
