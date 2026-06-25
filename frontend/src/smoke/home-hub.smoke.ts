// frontend/src/smoke/home-hub.smoke.ts
//
// W4a — home-hub wire smoke (MYT-83 done-when #3 proof).
//
// A DRIVEN node/tsx script (NOT a vitest test, NOT coverage-gated). It runs
// against the LIVE local backend and proves the typed home-hub data path
// round-trips end-to-end against real Postgres + the real REST handlers:
//
//   1. POST /api/users/register  — idempotent bootstrap of the dev identity
//      (200 created-row-this-call equiv / 201 created / 409 already under a
//      different username all accepted).
//   2. GET  /api/users/me        — 200 + body parses against MeResponseSchema
//      AND carries NO `stripeCustomerId` / `cognitoSub` key (the public
//      projection no-leak guarantee — the omitted fields can never reach the
//      wire).
//   3. GET  /api/campaigns/mine  — 200 + body parses against
//      MyCampaignsResponseSchema (an empty `campaigns` array is fine; N>0 needs
//      world-gen, out of scope — the point is the typed call + contract
//      round-trip against the real backend).
//
// Auth: AUTH_MODE=bypass dev identity, selected per-request via the
// `x-mythrun-dev-sub: dev-user-1` header (see backend/src/auth/bypass-plugin.ts).
//
// Exit 0 on success (prints the one-line result); non-zero with the specific
// mismatch on any failure. Fail-loud — never swallow.

import process from 'node:process'

import { MeResponseSchema, MyCampaignsResponseSchema } from '@mythrun/contract/rest'

const BACKEND_URL = process.env.SMOKE_BACKEND_URL ?? 'http://localhost:3030'
const DEV_SUB = 'dev-user-1'

const DEV_HEADERS = {
  'Content-Type': 'application/json',
  'x-mythrun-dev-sub': DEV_SUB,
} as const

// Fail-loud helper: print the specific mismatch and exit non-zero.
function fail(message: string): never {
  console.error(`✗ ${message}`)
  process.exit(1)
}

// Step 1 — idempotent dev-identity registration. 200/201/409 all mean "the
// identity exists going forward"; anything else is a real wire failure.
async function register(): Promise<number> {
  const res = await fetch(`${BACKEND_URL}/api/users/register`, {
    method: 'POST',
    headers: DEV_HEADERS,
    body: JSON.stringify({ username: 'homehubsmoke', displayName: 'Home Hub Smoke' }),
  })
  if (![200, 201, 409].includes(res.status)) {
    const text = await res.text().catch(() => '<unreadable body>')
    fail(`register: expected 200|201|409, got ${String(res.status)} — ${text.slice(0, 300)}`)
  }
  return res.status
}

// Step 2 — GET /me. Assert 200, parse against the contract, and prove the
// public-projection no-leak guarantee at the wire level: the parsed body
// carries neither `stripeCustomerId` nor `cognitoSub` anywhere in `user`.
async function checkMe(): Promise<void> {
  const res = await fetch(`${BACKEND_URL}/api/users/me`, { method: 'GET', headers: DEV_HEADERS })
  if (res.status !== 200) {
    const text = await res.text().catch(() => '<unreadable body>')
    fail(`/me: expected 200, got ${String(res.status)} — ${text.slice(0, 300)}`)
  }
  const body: unknown = await res.json()
  const parsed = MeResponseSchema.safeParse(body)
  if (!parsed.success) {
    fail(`/me: MeResponseSchema.parse failed — ${JSON.stringify(parsed.error.issues)}`)
  }
  // No-leak guarantee. The projection is built explicitly on the backend, so a
  // leak would mean a regression that re-widened the shape. Inspect the raw
  // wire body (not just the parsed projection) so an EXTRA key is caught.
  const userObj = (body as { user?: Record<string, unknown> }).user ?? {}
  for (const banned of ['stripeCustomerId', 'cognitoSub'] as const) {
    if (banned in userObj) {
      fail(`/me: PROJECTION LEAK — body.user contains "${banned}" (must never reach the wire)`)
    }
  }
}

// Step 3 — GET /campaigns/mine. Assert 200, parse against the contract, return
// the row count for the success line. An empty list is a valid pass.
async function checkCampaignsMine(): Promise<number> {
  const res = await fetch(`${BACKEND_URL}/api/campaigns/mine`, {
    method: 'GET',
    headers: DEV_HEADERS,
  })
  if (res.status !== 200) {
    const text = await res.text().catch(() => '<unreadable body>')
    fail(`/campaigns/mine: expected 200, got ${String(res.status)} — ${text.slice(0, 300)}`)
  }
  const body: unknown = await res.json()
  const parsed = MyCampaignsResponseSchema.safeParse(body)
  if (!parsed.success) {
    fail(`/campaigns/mine: MyCampaignsResponseSchema.parse failed — ${JSON.stringify(parsed.error.issues)}`)
  }
  return parsed.data.campaigns.length
}

async function main(): Promise<void> {
  console.log(`[smoke] backend=${BACKEND_URL} dev-sub=${DEV_SUB}`)

  const registerStatus = await register()
  console.log(`[register] ${String(registerStatus)} (accepted: 200|201|409)`)

  await checkMe()
  const campaignCount = await checkCampaignsMine()

  console.log(`me OK (projection clean) · campaigns/mine OK (${String(campaignCount)} rows)`)
  process.exit(0)
}

main().catch((err: unknown) => {
  console.error('✗ [smoke] unexpected error:', err)
  process.exit(1)
})
