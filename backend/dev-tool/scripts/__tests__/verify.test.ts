// backend/dev-tool/scripts/__tests__/verify.test.ts
//
// Unit tests for verify.ts helpers (myth-e5mn Task 12). We do NOT boot a
// real backend here — the end-to-end harness execution lives in the
// `pnpm dev-tool:verify` CLI invocation and the pre-push gate. These
// tests only verify the helpers work in isolation against JSDOM stubs.
//
// Importing `../verify.js` is safe because verify.ts gates its `main()`
// call behind an `import.meta.url === file://${process.argv[1]}` check,
// so test imports do NOT trigger the harness end-to-end.

import { describe, it, expect } from 'vitest'
import { JSDOM } from 'jsdom'

import { pollForSelector, routeAudit } from '../verify.js'

describe('pollForSelector', () => {
  it('returns "ready" when readySelector appears within timeout', async () => {
    // `pollForSelector` uses `parent.querySelector(...)`, which only
    // matches descendants — mirror the real harness shape by mounting a
    // child element with the marker rather than putting it on `root`
    // itself.
    const dom = new JSDOM('<!DOCTYPE html><body><div id="root"></div></body>')
    const root = dom.window.document.getElementById('root')
    if (!root) throw new Error('test setup: #root not found')
    setTimeout(() => {
      const child = dom.window.document.createElement('div')
      child.setAttribute('data-state', 'loaded')
      root.appendChild(child)
    }, 50)
    const outcome = await pollForSelector(
      root,
      '[data-state="loaded"]',
      '[data-state="error"]',
      1000,
    )
    expect(outcome).toBe('ready')
  })

  it('returns "error" when errorSelector appears first', async () => {
    const dom = new JSDOM('<!DOCTYPE html><body><div id="root"></div></body>')
    const root = dom.window.document.getElementById('root')
    if (!root) throw new Error('test setup: #root not found')
    setTimeout(() => {
      const child = dom.window.document.createElement('div')
      child.setAttribute('data-state', 'error')
      root.appendChild(child)
    }, 50)
    const outcome = await pollForSelector(
      root,
      '[data-state="loaded"]',
      '[data-state="error"]',
      1000,
    )
    expect(outcome).toBe('error')
  })

  it('returns "timeout" when neither appears within the deadline', async () => {
    const dom = new JSDOM('<!DOCTYPE html><body><div id="root"></div></body>')
    const root = dom.window.document.getElementById('root')
    if (!root) throw new Error('test setup: #root not found')
    const outcome = await pollForSelector(
      root,
      '[data-state="loaded"]',
      '[data-state="error"]',
      100,
    )
    expect(outcome).toBe('timeout')
  })
})

describe('routeAudit', () => {
  it('returns a string[] shape (uncovered route list)', () => {
    // routeAudit reads PANEL_REGISTRY + BACKEND_ROUTES directly; this
    // test asserts only the return shape. The actual coverage invariant
    // is verify-registry.test.ts invariant 3's job.
    const uncovered = routeAudit()
    expect(Array.isArray(uncovered)).toBe(true)
    for (const entry of uncovered) {
      expect(typeof entry).toBe('string')
    }
  })
})
