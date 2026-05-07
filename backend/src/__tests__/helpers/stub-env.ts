// backend/src/__tests__/helpers/stub-env.ts
//
// Frozen Env fixture for buildApp() callers in tests. Mirrors the shape
// loadEnv() returns; values are stub-safe defaults (rk_test_* + PLACEHOLDER
// webhook secret) that the webhook + billing plugins never actually call
// in unit tests — buildApp registers the plugins, but no test in this file
// drives a real Stripe call.
//
// Tests that DO need a custom env (e.g. routes/__tests__/webhook.test.ts
// signing real test events) build their own fixture inline.

import type { Env } from '../../config/env.js'

export function makeStubEnv(overrides: Partial<Env> = {}): Env {
  return Object.freeze({
    databaseUrl: 'postgresql://stub/db',
    redisRealtimeUrl: 'redis://stub:6379',
    redisBatchUrl: 'redis://stub:6379',
    port: 0,
    authMode: 'bypass' as const,
    frontendBaseUrl: 'http://localhost:5173',
    stripeSecretKey: 'rk_test_stub_secret_key',
    stripeWebhookSecret: 'PLACEHOLDER',
    anthropicApiKey: 'sk-ant-stub-test-key',
    ...overrides,
  })
}
