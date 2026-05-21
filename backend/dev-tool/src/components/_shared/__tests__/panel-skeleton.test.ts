// @vitest-environment jsdom
//
// myth-iy6f P2.1 — DOM tests for buildSplitView. Runs under jsdom so
// the implementation's global `document.createElement` resolves; the
// pragma scopes the env to this file so the rest of the suite keeps
// using the default node environment.

import { describe, it, expect } from 'vitest'
import { JSDOM } from 'jsdom'
import { buildSplitView } from '../panel-skeleton.js'

function makeParent(): HTMLElement {
  const dom = new JSDOM('<!doctype html><div id="root"></div>')
  const parent = dom.window.document.getElementById('root')
  if (parent === null) throw new Error('test setup: missing root')
  return parent
}

describe('panel-skeleton.buildSplitView', () => {
  it('builds a root element with title, action, and feedback regions', () => {
    const parent = makeParent()
    const { root, actionEl, feedbackEl } = buildSplitView({
      parent,
      title: 'POST /api/campaigns',
    })
    expect(root.getAttribute('data-state')).toBe('idle')
    expect(root.querySelector('h1')?.textContent).toBe('POST /api/campaigns')
    expect(actionEl.getAttribute('data-region')).toBe('action')
    expect(feedbackEl.getAttribute('data-region')).toBe('feedback')
    expect(parent.contains(root)).toBe(true)
  })

  it('setState updates the root data-state attribute', () => {
    const parent = makeParent()
    const { root, setState } = buildSplitView({ parent, title: 't' })
    setState('loading')
    expect(root.getAttribute('data-state')).toBe('loading')
    setState('ready')
    expect(root.getAttribute('data-state')).toBe('ready')
    setState('error')
    expect(root.getAttribute('data-state')).toBe('error')
  })
})
