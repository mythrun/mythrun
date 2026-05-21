// @vitest-environment jsdom
//
// backend/dev-tool/src/components/_shared/__tests__/progress-strip.test.ts
import { describe, it, expect } from 'vitest'
import { JSDOM } from 'jsdom'
import { createProgressStrip } from '../progress-strip.js'

function makeC(): HTMLElement {
  const dom = new JSDOM('<!doctype html><div id="x"></div>')
  const c = dom.window.document.getElementById('x')
  if (c === null) throw new Error('test setup')
  return c
}

describe('progress-strip', () => {
  it('renders an empty (zero progress) strip on create', () => {
    const c = makeC()
    const strip = createProgressStrip(c, { total: 9 })
    expect(c.textContent).toContain('0/9')
    expect(strip.root.getAttribute('data-progress')).toBe('0')
  })

  it('update advances the rendered progress', () => {
    const c = makeC()
    const strip = createProgressStrip(c, { total: 9 })
    strip.update({ current: 4, label: 'entity_relationships' })
    expect(c.textContent).toContain('4/9')
    expect(c.textContent).toContain('entity_relationships')
    expect(strip.root.getAttribute('data-progress')).toBe('44')
  })
})
