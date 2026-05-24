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

import { JSDOM } from 'jsdom'

import { BACKEND_ROUTES } from '../../src/contract/backend-routes.js'
import {
  EXEMPT_ROUTES,
  PAGE_REGISTRY,
  PANEL_EXERCISES,
  type PageRegistration,
} from '../verify-registry.js'
import { setCurrentDevSub } from '../src/identity.js'

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

export async function sanityCheckInfra(): Promise<boolean> {
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
export async function bootstrapIdentity(): Promise<BootstrapResult> {
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

interface MountContext {
  readonly cleanup: () => void
  readonly parent: HTMLDivElement
  readonly consoleErrors: string[]
}

// Installs a fresh JSDOM window + document + localStorage + performance on
// globalThis so panel modules' bare `window`/`document`/`localStorage`/
// `performance` references resolve. Also wraps `fetch` so panel-relative
// paths (`/api/...`) hit the backend at BACKEND_URL — mirroring Vite's
// in-browser proxy behavior. Returns a cleanup that restores the pre-call
// globals + closes the JSDOM window.
function setupJsdomContext(): MountContext {
  const dom = new JSDOM('<!DOCTYPE html><html><body></body></html>', {
    url: DEV_TOOL_URL,
    pretendToBeVisual: true,
  })
  const w = dom.window as unknown as Window & typeof globalThis
  // Panel modules read these as bare globals (no DI), so JSDOM's
  // window/document/localStorage/performance have to be installed on
  // globalThis before any mount call runs. Cast through a Record so the
  // assignments don't trip @typescript-eslint/no-unsafe-member-access.
  // Save any prior values so cleanup restores them — Node ships its own
  // `globalThis.performance` (perf hooks) and a default `fetch`; wiping
  // those between panels breaks the next JSDOM construction.
  const g = globalThis as unknown as Record<string, unknown>
  const prior: Record<string, unknown> = {
    window: g.window,
    document: g.document,
    localStorage: g.localStorage,
    CustomEvent: g.CustomEvent,
    Event: g.Event,
    HTMLElement: g.HTMLElement,
    Node: g.Node,
  }
  g.window = w
  g.document = w.document
  g.localStorage = w.localStorage
  // Deliberately NOT overriding `globalThis.performance`. JSDOM reads
  // Node's native `performance` during construction to build its own
  // `window.performance`; if we install JSDOM's Performance onto
  // globalThis between panels, the next JSDOM construction reads it
  // back and recurses (PerformanceImpl.now calls performance.now which
  // is itself).
  // Constructors must be the JSDOM ones so events created in panel code
  // (e.g., `new CustomEvent(...)` inside identity.ts) pass JSDOM's brand
  // checks in dispatchEvent. Without this, Node's built-in CustomEvent
  // gets used and dispatchEvent rejects it as "not of type Event".
  g.CustomEvent = w.CustomEvent
  g.Event = w.Event
  g.HTMLElement = w.HTMLElement
  g.Node = w.Node

  // fetch wrapper: relative paths get prepended with BACKEND_URL so panel
  // code written for the in-browser Vite proxy talks to the real backend.
  const originalFetch = globalThis.fetch
  globalThis.fetch = (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    let url: string
    if (typeof input === 'string') {
      url = input
    } else if (input instanceof URL) {
      url = input.toString()
    } else {
      url = input.url
    }
    if (url.startsWith('/')) {
      return originalFetch(`${BACKEND_URL}${url}`, init)
    }
    return originalFetch(input, init)
  }

  // Capture console.error so we can surface unexpected logging as a
  // verification failure (filtered via the panel's errorAllowlist).
  const consoleErrors: string[] = []
  const originalConsoleError = console.error
  console.error = (...args: unknown[]): void => {
    consoleErrors.push(args.map((a) => String(a)).join(' '))
  }

  const parent = w.document.createElement('div')
  w.document.body.appendChild(parent)

  return {
    parent,
    consoleErrors,
    cleanup: () => {
      console.error = originalConsoleError
      globalThis.fetch = originalFetch
      // Restore each prior global; delete if the slot was empty before
      // (avoids wiping Node's built-in perf hooks / etc. between panels).
      for (const key of [
        'window',
        'document',
        'localStorage',
        'CustomEvent',
        'Event',
        'HTMLElement',
        'Node',
      ] as const) {
        if (prior[key] === undefined) {
          // eslint-disable-next-line @typescript-eslint/no-dynamic-delete
          delete g[key]
        } else {
          g[key] = prior[key]
        }
      }
      dom.window.close()
    },
  }
}

// Polls every 50ms up to `timeoutMs` for either selector to match a
// descendant of `parent`. ready takes precedence on tie. Returns
// 'timeout' if neither matches by the deadline.
export async function pollForSelector(
  parent: HTMLElement,
  readySelector: string,
  errorSelector: string,
  timeoutMs: number,
): Promise<'ready' | 'error' | 'timeout'> {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    if (parent.querySelector(readySelector)) return 'ready'
    if (parent.querySelector(errorSelector)) return 'error'
    await new Promise((r) => setTimeout(r, 50))
  }
  return 'timeout'
}

// Mounts a single panel in a fresh JSDOM context, polls for its
// declared ready/error markers, applies the pattern-aware verdict, and
// captures console.error noise. Always tears down the JSDOM context so
// globals don't leak between panels.
export async function verifyPanel(name: string): Promise<PanelResult> {
  const reg = (PAGE_REGISTRY as Readonly<Record<string, PageRegistration>>)[name]
  if (!reg) {
    return { panel: name, status: 'boot-error', details: 'not in PAGE_REGISTRY' }
  }
  const ctx = setupJsdomContext()
  try {
    setCurrentDevSub(DEV_SUB)
    await reg.mount(ctx.parent)
    const outcome = await pollForSelector(
      ctx.parent,
      reg.readySelector,
      reg.errorSelector,
      reg.readyTimeoutMs ?? 2000,
    )
    // Pattern-aware verdict. All three patterns currently use the same
    // verdict logic — pattern field is structural metadata for future
    // divergence (e.g., event-driven panels may eventually skip
    // console.error checks during their event-bind phase).
    if (outcome === 'error') {
      const errText = ctx.parent.querySelector(reg.errorSelector)?.textContent ?? ''
      return { panel: name, status: 'error', details: errText.trim().slice(0, 200) }
    }
    if (outcome === 'timeout') {
      return {
        panel: name,
        status: 'marker-missing',
        details: `neither ${reg.readySelector} nor ${reg.errorSelector} appeared within ${String(reg.readyTimeoutMs ?? 2000)}ms`,
      }
    }
    // outcome === 'ready'; check console.error.
    const filtered = ctx.consoleErrors.filter((msg: string) => {
      if (!reg.errorAllowlist) return true
      return !reg.errorAllowlist.some((allow: string) => msg.includes(allow))
    })
    if (filtered.length > 0) {
      return {
        panel: name,
        status: 'console-error',
        details: filtered.join(' | ').slice(0, 200),
      }
    }
    return { panel: name, status: 'ok' }
  } catch (err) {
    return { panel: name, status: 'boot-error', details: String(err).slice(0, 200) }
  } finally {
    ctx.cleanup()
  }
}

// Route-exhaustion second pass. Builds the union of every panel's declared
// `exercises` routes PLUS the EXEMPT_ROUTES list (routes that intentionally
// have no UI panel — Stripe webhook, register-via-bootstrap) and returns
// the BACKEND_ROUTES entries (as `"METHOD /path"` keys) that nothing
// covers. Redundant with the `verify-registry.test.ts` route-exhaustion
// invariant by design — the test gates CI on drift; this runtime audit
// surfaces it on every `pnpm dev-tool:verify` invocation so the human
// sees it without re-running the test suite.
export function routeAudit(): string[] {
  const covered = new Set<string>()
  // myth-0smu: route exhaustion now unions PANEL_EXERCISES across every
  // panel id referenced by every workflow page in PAGE_REGISTRY. The
  // page is the structural unit but routes belong to panels.
  const reachablePanelIds = new Set<string>()
  for (const page of Object.values(PAGE_REGISTRY)) {
    for (const pid of page.panels) reachablePanelIds.add(pid)
  }
  for (const pid of reachablePanelIds) {
    const routes = PANEL_EXERCISES[pid]
    if (routes === undefined) continue
    for (const r of routes) {
      covered.add(`${r.method} ${r.path}`)
    }
  }
  for (const r of EXEMPT_ROUTES) {
    covered.add(`${r.method} ${r.path}`)
  }
  const uncovered: string[] = []
  for (const route of BACKEND_ROUTES) {
    const key = `${route.method} ${route.path}`
    if (!covered.has(key)) uncovered.push(key)
  }
  return uncovered
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

  const panelNames = Object.keys(PAGE_REGISTRY)
  const results: PanelResult[] = []
  for (const name of panelNames) {
    const result = await verifyPanel(name)
    results.push(result)
    const tag = result.status === 'ok' ? '✓' : '✗'
    console.log(
      `[panel:${name}] ${tag} ${result.status}${result.details ? ` — ${result.details}` : ''}`,
    )
  }

  const uncovered = routeAudit()
  for (const key of uncovered) {
    console.log(`[coverage] ✗ route ${key} not exercised by any panel`)
  }

  const failed = results.filter((r) => r.status !== 'ok')
  const ok = failed.length === 0 && uncovered.length === 0
  if (!ok) {
    console.log(
      `\n${String(failed.length)} panel(s) failed; ${String(uncovered.length)} route(s) uncovered.`,
    )
    process.exit(1)
  }
  console.log('\nAll panels ok; all routes covered.')
  process.exit(0)
}

// Entry-point guard: only run main() when this module is invoked directly
// as a script (e.g., `tsx scripts/verify.ts`). When imported by tests (or
// any other consumer of the exported helpers), `main()` must NOT fire —
// it talks to a real backend + dev-tool and would crash the test process.
const entryPath = process.argv[1] ?? ''
const isEntryPoint = import.meta.url === `file://${entryPath}`
if (isEntryPoint) {
  main().catch((err: unknown) => {
    console.error('[verify] unexpected error:', err)
    process.exit(1)
  })
}
