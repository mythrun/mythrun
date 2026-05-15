// backend/dev-tool/scripts/verify.ts
//
// JSDOM-based panel verification harness (myth-e5mn Component 3).
// Pattern-aware: each panel declares its pattern in verify-registry.ts;
// this script applies pattern-appropriate assertions.
//
// Exit codes:
//   0 — every panel passed + route exhaustion passed
//   1 — at least one panel failed
//   2 — infra not up (backend or dev-tool unreachable) and auto-boot failed

import { PANEL_REGISTRY } from '../verify-registry.js'
import { BACKEND_ROUTES } from '../../src/contract/backend-routes.js'

const BACKEND_URL = 'http://localhost:3030'
const DEV_TOOL_URL = 'http://127.0.0.1:5273'
const DEV_SUB = 'dev-user-1'

export interface PanelResult {
  readonly panel: string
  readonly status: 'ok' | 'placeholder' | 'marker-missing' | 'error' | 'console-error' | 'boot-error'
  readonly details?: string
}

async function probeReachable(url: string): Promise<boolean> {
  try {
    const res = await fetch(url, { method: 'GET' })
    return res.ok || res.status < 500
  } catch {
    return false
  }
}

async function sanityCheckInfra(): Promise<boolean> {
  const backendUp = await probeReachable(`${BACKEND_URL}/health`)
  const devToolUp = await probeReachable(`${DEV_TOOL_URL}/`)
  if (backendUp && devToolUp) return true
  // Auto-boot scaffolding lands in Task 6; for now report not-up.
  if (!backendUp) {
    console.error(`✗ backend not reachable at ${BACKEND_URL}/health`)
    console.error(`  start with: cd backend && NODE_ENV=development pnpm dev`)
  }
  if (!devToolUp) {
    console.error(`✗ dev-tool not reachable at ${DEV_TOOL_URL}/`)
    console.error(`  start with: cd backend/dev-tool && pnpm dev`)
  }
  return false
}

interface BootstrapResult {
  readonly userRegistered: boolean
  readonly creditsGranted: boolean
}

// Bootstraps the dev identity the harness mounts panels as. Two POSTs,
// both carrying `x-mythrun-dev-sub: dev-user-1` so the bypass-auth
// plugin attaches the override sub to the request:
//
//   1. POST /api/users/register — idempotent. First call returns 201
//      (created); subsequent calls return 200 (already_onboarded_same,
//      because the (sub, username) pair matches the existing row). 409
//      only fires when the SAME sub re-registers under a DIFFERENT
//      username — defensive accept here in case a prior test run left a
//      mismatched username on dev-user-1.
//   2. POST /api/dev/credits/grant — adds `world_gen` credits to the
//      ledger. The route returns 201 on success.
async function bootstrapIdentity(): Promise<BootstrapResult> {
  const registerRes = await fetch(`${BACKEND_URL}/api/users/register`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-mythrun-dev-sub': DEV_SUB,
    },
    body: JSON.stringify({ username: 'verifyharness', displayName: 'Verify Harness' }),
  })
  if (![200, 201, 409].includes(registerRes.status)) {
    throw new Error(`identity bootstrap: register returned ${String(registerRes.status)}`)
  }
  // userRegistered=true means "we just created the row on this call". A
  // 200 means the row already existed (already_onboarded_same); a 409
  // means a mismatched username already exists for this sub. Both
  // collapse to `pre-existing` in the log line.
  const userRegistered = registerRes.status === 201

  const grantRes = await fetch(`${BACKEND_URL}/api/dev/credits/grant`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-mythrun-dev-sub': DEV_SUB,
    },
    body: JSON.stringify({ creditType: 'world_gen', amount: 5 }),
  })
  if (grantRes.status !== 201) {
    throw new Error(`identity bootstrap: credit grant returned ${String(grantRes.status)}`)
  }
  return { userRegistered, creditsGranted: true }
}

async function main(): Promise<void> {
  const infraUp = await sanityCheckInfra()
  if (!infraUp) {
    process.exit(2)
  }
  console.log('[infra] backend + dev-tool reachable')

  const bootstrap = await bootstrapIdentity()
  console.log(
    `[bootstrap] ${DEV_SUB} ${bootstrap.userRegistered ? 'registered' : 'pre-existing'}; credits granted`,
  )

  // Panel mounts and route audit land in Tasks 7, 8.
  const panelCount = Object.keys(PANEL_REGISTRY).length
  const routeCount = BACKEND_ROUTES.length
  console.log(`[harness] ${String(panelCount)} panels registered; ${String(routeCount)} routes in contract`)
  console.log('[status] panel-mount loop pending (Task 7)')
  process.exit(0)
}

void main().catch((err: unknown) => {
  console.error('[verify] unexpected error:', err)
  process.exit(1)
})
