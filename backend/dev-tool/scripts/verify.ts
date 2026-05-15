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

async function main(): Promise<void> {
  const infraUp = await sanityCheckInfra()
  if (!infraUp) {
    process.exit(2)
  }

  // Identity bootstrap, panel mounts, and route audit land in Tasks 6, 7, 8.
  // For now we just report "infra up; harness pending."
  console.log('[infra] backend + dev-tool reachable')
  const panelCount = Object.keys(PANEL_REGISTRY).length
  const routeCount = BACKEND_ROUTES.length
  console.log(`[harness] ${String(panelCount)} panels registered; ${String(routeCount)} routes in contract`)
  console.log('[status] harness implementation pending (Tasks 6-8)')
  process.exit(0)
}

void main().catch((err: unknown) => {
  console.error('[verify] unexpected error:', err)
  process.exit(1)
})
