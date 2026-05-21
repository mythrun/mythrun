// @vitest-environment jsdom
//
// backend/dev-tool/src/components/_shared/__tests__/json-disclosure.test.ts
import { describe, it, expect } from 'vitest'
import { JSDOM } from 'jsdom'
import { appendJsonDisclosure } from '../json-disclosure.js'

function makeContainer(): HTMLElement {
  const dom = new JSDOM('<!doctype html><div id="x"></div>')
  const c = dom.window.document.getElementById('x')
  if (c === null) throw new Error('test setup')
  return c
}

describe('json-disclosure.appendJsonDisclosure', () => {
  it('appends a collapsed details element with the json string', () => {
    const c = makeContainer()
    appendJsonDisclosure(c, { foo: 'bar' })
    const d = c.querySelector('details')
    expect(d).not.toBeNull()
    expect(d?.hasAttribute('open')).toBe(false)
    expect(c.textContent).toContain('foo')
  })
})
