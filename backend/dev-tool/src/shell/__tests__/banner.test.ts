// @vitest-environment jsdom
// backend/dev-tool/src/shell/__tests__/banner.test.ts
import { describe, it, expect } from 'vitest'
import { JSDOM } from 'jsdom'
import { mountBanner } from '../banner.js'

function withDom(): HTMLElement {
  const dom = new JSDOM('<!doctype html><div id="r"></div>')
  ;(globalThis as unknown as { document: Document }).document = dom.window.document
  const r = dom.window.document.getElementById('r')
  if (r === null) throw new Error('test setup')
  return r
}

describe('mountBanner', () => {
  it('renders "no active campaign" empty state', () => {
    const parent = withDom()
    const handle = mountBanner(parent, { getActiveCampaignId: () => null })
    expect(handle.root.textContent).toContain('no active campaign')
    handle.unmount()
  })

  it('updates content when setCampaign is called', () => {
    const parent = withDom()
    const handle = mountBanner(parent, { getActiveCampaignId: () => '019e-aaa' })
    handle.setCampaign({ id: '019e-aaa', name: 'Skybound', stage: 'entity_relationships' })
    expect(handle.root.textContent).toContain('Skybound')
    expect(handle.root.textContent).toContain('entity_relationships')
    handle.unmount()
  })
})
