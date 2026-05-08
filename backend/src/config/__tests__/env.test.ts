import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { loadEnv } from '../env.js'

const URL_FORM = {
  DATABASE_URL: 'postgresql://u:p@h:5432/d',
  REDIS_REALTIME_URL: 'redis://h:6379',
  REDIS_BATCH_URL: 'redis://h:6380',
  PORT: '3000',
  MYTHRUN_ENV: 'development',
  REGION_PREFIX: 'use1',
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
  MYTHRUN_ENV: 'staging',
  REGION_PREFIX: 'use1',
} as const

const ORIGINAL_ENV = { ...process.env }

function clearAll(): void {
  delete process.env.MIGRATE_DATABASE_URL
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
  delete process.env.MYTHRUN_ENV
  delete process.env.REGION_PREFIX
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

describe('loadEnv (MIGRATE_DATABASE_URL precedence)', () => {
  beforeEach(() => {
    clearAll()
  })
  afterEach(() => {
    process.env = { ...ORIGINAL_ENV }
  })

  it('uses MIGRATE_DATABASE_URL when set and non-empty', () => {
    Object.assign(process.env, URL_FORM)
    process.env.MIGRATE_DATABASE_URL = 'postgresql://m:m@m:5432/migrate'
    const env = loadEnv()
    expect(env.databaseUrl).toBe('postgresql://m:m@m:5432/migrate')
  })

  it('falls through to DATABASE_URL when MIGRATE_DATABASE_URL is empty string', () => {
    Object.assign(process.env, URL_FORM)
    process.env.MIGRATE_DATABASE_URL = ''
    const env = loadEnv()
    expect(env.databaseUrl).toBe(URL_FORM.DATABASE_URL)
  })

  it('falls through to DATABASE_URL when MIGRATE_DATABASE_URL is whitespace only', () => {
    Object.assign(process.env, URL_FORM)
    process.env.MIGRATE_DATABASE_URL = '   '
    const env = loadEnv()
    expect(env.databaseUrl).toBe(URL_FORM.DATABASE_URL)
  })

  it('falls through to DATABASE_URL when MIGRATE_DATABASE_URL is unset', () => {
    Object.assign(process.env, URL_FORM)
    const env = loadEnv()
    expect(env.databaseUrl).toBe(URL_FORM.DATABASE_URL)
  })

  it('empty MIGRATE_DATABASE_URL falls through to component form (no DATABASE_URL)', () => {
    Object.assign(process.env, COMPONENT_FORM)
    process.env.MIGRATE_DATABASE_URL = ''
    const env = loadEnv()
    expect(env.databaseUrl).toBe(
      'postgresql://mythrun_staging:secret-pw@rds.example.com:5432/mythrun_staging?sslmode=require',
    )
  })

  it('MIGRATE_DATABASE_URL wins over component-form vars', () => {
    Object.assign(process.env, COMPONENT_FORM)
    process.env.MIGRATE_DATABASE_URL = 'postgresql://m:m@m:5432/migrate'
    expect(loadEnv().databaseUrl).toBe('postgresql://m:m@m:5432/migrate')
  })
})

const SAFE_BASE = (): void => {
  vi.stubEnv('PORT', '3000')
  vi.stubEnv('DATABASE_URL', 'postgresql://x:y@localhost:5432/test')
  vi.stubEnv('REDIS_REALTIME_URL', 'redis://localhost:6379')
  vi.stubEnv('REDIS_BATCH_URL', 'redis://localhost:6380')
  vi.stubEnv('MYTHRUN_ENV', 'development')
  vi.stubEnv('REGION_PREFIX', 'use1')
}

describe('loadEnv auth-mode parsing', () => {
  beforeEach(() => {
    SAFE_BASE()
  })
  afterEach(() => {
    vi.unstubAllEnvs()
  })

  it('throws when AUTH_MODE is unset', () => {
    vi.stubEnv('AUTH_MODE', '')
    expect(() => loadEnv()).toThrow(/AUTH_MODE must be exactly/)
  })

  it("throws on AUTH_MODE='Real' (case-mismatch)", () => {
    vi.stubEnv('AUTH_MODE', 'Real')
    vi.stubEnv('NODE_ENV', 'development')
    expect(() => loadEnv()).toThrow(/AUTH_MODE must be exactly/)
  })

  it('parses bypass mode in NODE_ENV=development', () => {
    vi.stubEnv('AUTH_MODE', 'bypass')
    vi.stubEnv('NODE_ENV', 'development')
    const env = loadEnv()
    expect(env.authMode).toBe('bypass')
    expect(env.cognitoUserPoolId).toBeUndefined()
  })

  it('throws bypass + NODE_ENV=production', () => {
    vi.stubEnv('AUTH_MODE', 'bypass')
    vi.stubEnv('NODE_ENV', 'production')
    expect(() => loadEnv()).toThrow(/AUTH_MODE=bypass requires NODE_ENV/)
  })

  it('throws real + production without BOOT_GATE_ENABLED', () => {
    vi.stubEnv('AUTH_MODE', 'real')
    vi.stubEnv('NODE_ENV', 'production')
    // .env.development sets BOOT_GATE_ENABLED=1 — clear it so this test
    // can exercise the missing-boot-gate path.
    vi.stubEnv('BOOT_GATE_ENABLED', '')
    vi.stubEnv('COGNITO_USER_POOL_ID', 'x')
    vi.stubEnv('COGNITO_APP_CLIENT_ID', 'y')
    vi.stubEnv('COGNITO_ISSUER_URL', 'https://cognito-idp.us-east-1.amazonaws.com/x')
    vi.stubEnv('COGNITO_HOSTED_UI_DOMAIN', 'x.auth.us-east-1.amazoncognito.com')
    expect(() => loadEnv()).toThrow(/BOOT_GATE_ENABLED=1/)
  })

  it('parses real mode with all Cognito vars', () => {
    vi.stubEnv('AUTH_MODE', 'real')
    vi.stubEnv('NODE_ENV', 'production')
    vi.stubEnv('BOOT_GATE_ENABLED', '1')
    vi.stubEnv('COGNITO_USER_POOL_ID', 'us-east-1_test')
    vi.stubEnv('COGNITO_APP_CLIENT_ID', 'cli')
    vi.stubEnv('COGNITO_ISSUER_URL', 'https://cognito-idp.us-east-1.amazonaws.com/us-east-1_test')
    vi.stubEnv('COGNITO_HOSTED_UI_DOMAIN', 'mythrun.auth.us-east-1.amazoncognito.com')
    vi.stubEnv('FRONTEND_BASE_URL', 'https://mythrun.com')
    const env = loadEnv()
    expect(env.authMode).toBe('real')
    expect(env.cognitoUserPoolId).toBe('us-east-1_test')
  })

  it('throws real mode missing COGNITO_USER_POOL_ID', () => {
    vi.stubEnv('AUTH_MODE', 'real')
    vi.stubEnv('NODE_ENV', 'development')
    vi.stubEnv('COGNITO_APP_CLIENT_ID', 'c')
    vi.stubEnv('COGNITO_ISSUER_URL', 'https://x.example.com')
    vi.stubEnv('COGNITO_HOSTED_UI_DOMAIN', 'd.example.com')
    expect(() => loadEnv()).toThrow(/AUTH_MODE=real requires/)
  })
})

// Staging requires AUTH_MODE=real with all Cognito vars (bypass is forbidden
// outside development/test). Tests that exercise NODE_ENV=staging or
// production must stub these so the auth-mode cross-checks pass before
// reaching the frontendBaseUrl validator.
const STAGING_AUTH = (): void => {
  vi.stubEnv('AUTH_MODE', 'real')
  vi.stubEnv('BOOT_GATE_ENABLED', '1')
  vi.stubEnv('COGNITO_USER_POOL_ID', 'us-east-1_test')
  vi.stubEnv('COGNITO_APP_CLIENT_ID', 'cli')
  vi.stubEnv('COGNITO_ISSUER_URL', 'https://cognito-idp.us-east-1.amazonaws.com/us-east-1_test')
  vi.stubEnv('COGNITO_HOSTED_UI_DOMAIN', 'mythrun.auth.us-east-1.amazoncognito.com')
}

describe('frontendBaseUrl', () => {
  beforeEach(() => {
    SAFE_BASE()
  })
  afterEach(() => {
    vi.unstubAllEnvs()
  })

  it('passes when set to https://staging.mythrun.com in staging', () => {
    STAGING_AUTH()
    vi.stubEnv('NODE_ENV', 'staging')
    vi.stubEnv('FRONTEND_BASE_URL', 'https://staging.mythrun.com')
    const env = loadEnv()
    expect(env.frontendBaseUrl).toBe('https://staging.mythrun.com')
  })

  it('passes when set to http://localhost:5173 in development', () => {
    vi.stubEnv('NODE_ENV', 'development')
    vi.stubEnv('FRONTEND_BASE_URL', 'http://localhost:5173')
    const env = loadEnv()
    expect(env.frontendBaseUrl).toBe('http://localhost:5173')
  })

  it('throws when host is not in the allowlist', () => {
    STAGING_AUTH()
    vi.stubEnv('NODE_ENV', 'staging')
    vi.stubEnv('FRONTEND_BASE_URL', 'https://attacker.example.com')
    expect(() => loadEnv()).toThrow(/frontendBaseUrl host/i)
  })

  it('throws when localhost in production', () => {
    STAGING_AUTH()
    vi.stubEnv('NODE_ENV', 'production')
    vi.stubEnv('FRONTEND_BASE_URL', 'http://localhost:5173')
    expect(() => loadEnv()).toThrow(/frontendBaseUrl host/i)
  })

  it('throws when unset in staging', () => {
    STAGING_AUTH()
    vi.stubEnv('NODE_ENV', 'staging')
    vi.stubEnv('FRONTEND_BASE_URL', '')
    expect(() => loadEnv()).toThrow(/FRONTEND_BASE_URL is required/i)
  })

  it('throws on path component', () => {
    STAGING_AUTH()
    vi.stubEnv('NODE_ENV', 'staging')
    vi.stubEnv('FRONTEND_BASE_URL', 'https://staging.mythrun.com/redirect')
    expect(() => loadEnv()).toThrow(/pathname/i)
  })

  it('throws on query string', () => {
    STAGING_AUTH()
    vi.stubEnv('NODE_ENV', 'staging')
    vi.stubEnv('FRONTEND_BASE_URL', 'https://staging.mythrun.com/?next=foo')
    expect(() => loadEnv()).toThrow(/query string|pathname/i)
  })

  it('throws on hash fragment', () => {
    STAGING_AUTH()
    vi.stubEnv('NODE_ENV', 'staging')
    vi.stubEnv('FRONTEND_BASE_URL', 'https://staging.mythrun.com/#bar')
    expect(() => loadEnv()).toThrow(/hash|pathname/i)
  })

  it('throws on invalid URL', () => {
    STAGING_AUTH()
    vi.stubEnv('NODE_ENV', 'staging')
    vi.stubEnv('FRONTEND_BASE_URL', 'not-a-url')
    expect(() => loadEnv()).toThrow(/valid URL/i)
  })
})

describe('loadEnv — Stripe fields', () => {
  beforeEach(() => {
    SAFE_BASE()
  })
  afterEach(() => {
    vi.unstubAllEnvs()
  })

  it('accepts a restricted-key (rk_) prefix and exposes stripeSecretKey + stripeWebhookSecret', () => {
    vi.stubEnv('STRIPE_SECRET_KEY', 'rk_test_abc123')
    vi.stubEnv('STRIPE_WEBHOOK_SECRET', 'whsec_real_value')
    const env = loadEnv()
    expect(env.stripeSecretKey).toBe('rk_test_abc123')
    expect(env.stripeWebhookSecret).toBe('whsec_real_value')
  })

  it('rejects a full-permission (sk_) secret key', () => {
    vi.stubEnv('STRIPE_SECRET_KEY', 'sk_test_full_permission')
    expect(() => loadEnv()).toThrow(/STRIPE_SECRET_KEY must be a Stripe restricted key/)
  })

  it("accepts 'PLACEHOLDER' as the webhook secret (pre-MYT-42 window)", () => {
    vi.stubEnv('STRIPE_SECRET_KEY', 'rk_test_abc123')
    vi.stubEnv('STRIPE_WEBHOOK_SECRET', 'PLACEHOLDER')
    const env = loadEnv()
    expect(env.stripeWebhookSecret).toBe('PLACEHOLDER')
  })

  it('rejects an empty STRIPE_SECRET_KEY', () => {
    vi.stubEnv('STRIPE_SECRET_KEY', '')
    expect(() => loadEnv()).toThrow(/STRIPE_SECRET_KEY/)
  })

  it('rejects an empty STRIPE_WEBHOOK_SECRET', () => {
    vi.stubEnv('STRIPE_SECRET_KEY', 'rk_test_abc123')
    vi.stubEnv('STRIPE_WEBHOOK_SECRET', '')
    expect(() => loadEnv()).toThrow(/STRIPE_WEBHOOK_SECRET/)
  })
})

describe('loadEnv — ANTHROPIC_API_KEY', () => {
  beforeEach(() => {
    SAFE_BASE()
  })
  afterEach(() => {
    vi.unstubAllEnvs()
  })

  it('throws when ANTHROPIC_API_KEY is missing', () => {
    vi.stubEnv('ANTHROPIC_API_KEY', '')
    expect(() => loadEnv()).toThrow('ANTHROPIC_API_KEY is required')
  })

  it('throws when ANTHROPIC_API_KEY does not have sk-ant- prefix', () => {
    vi.stubEnv('ANTHROPIC_API_KEY', 'wrong-prefix-abc')
    expect(() => loadEnv()).toThrow(/ANTHROPIC_API_KEY must have sk-ant- prefix/)
  })

  it('accepts a key with sk-ant- prefix and exposes anthropicApiKey', () => {
    vi.stubEnv('ANTHROPIC_API_KEY', 'sk-ant-test-key')
    const env = loadEnv()
    expect(env.anthropicApiKey).toBe('sk-ant-test-key')
  })
})

describe('redisKeyPrefix', () => {
  beforeEach(() => {
    SAFE_BASE()
  })
  afterEach(() => {
    vi.unstubAllEnvs()
  })

  it('derives from MYTHRUN_ENV + REGION_PREFIX', () => {
    vi.stubEnv('MYTHRUN_ENV', 'production')
    vi.stubEnv('REGION_PREFIX', 'use1')
    const env = loadEnv()
    expect(env.redisKeyPrefix).toBe('production:use1:')
  })

  it('rejects missing MYTHRUN_ENV', () => {
    vi.stubEnv('MYTHRUN_ENV', '')
    vi.stubEnv('REGION_PREFIX', 'use1')
    expect(() => loadEnv()).toThrow(/MYTHRUN_ENV/)
  })

  it('rejects missing REGION_PREFIX', () => {
    vi.stubEnv('MYTHRUN_ENV', 'production')
    vi.stubEnv('REGION_PREFIX', '')
    expect(() => loadEnv()).toThrow(/REGION_PREFIX/)
  })

  it('rejects invalid MYTHRUN_ENV value', () => {
    vi.stubEnv('MYTHRUN_ENV', 'prod')
    vi.stubEnv('REGION_PREFIX', 'use1')
    expect(() => loadEnv()).toThrow(/MYTHRUN_ENV must be one of/)
  })
})
