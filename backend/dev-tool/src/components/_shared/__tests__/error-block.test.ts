// @vitest-environment jsdom
//
// backend/dev-tool/src/components/_shared/__tests__/error-block.test.ts
import { describe, it, expect } from 'vitest'
import { JSDOM } from 'jsdom'
import { renderErrorBlock } from '../error-block.js'

function makeContainer(): HTMLElement {
  const dom = new JSDOM('<!doctype html><div id="x"></div>')
  const c = dom.window.document.getElementById('x')
  if (c === null) throw new Error('test setup')
  return c
}

describe('error-block.renderErrorBlock', () => {
  it('renders status + code + message + optional raw disclosure', () => {
    const c = makeContainer()
    renderErrorBlock(c, {
      status: 403,
      code: 'forbidden',
      message: 'not a member of this campaign',
      raw: { detail: 'x' },
    })
    expect(c.textContent).toContain('403')
    expect(c.textContent).toContain('forbidden')
    expect(c.textContent).toContain('not a member of this campaign')
    const details = c.querySelector('details')
    expect(details).not.toBeNull()
  })

  it('omits the raw disclosure when raw is undefined', () => {
    const c = makeContainer()
    renderErrorBlock(c, { status: 500, code: 'internal', message: 'x' })
    expect(c.querySelector('details')).toBeNull()
  })
})
