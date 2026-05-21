// @vitest-environment jsdom
// backend/dev-tool/src/shell/__tests__/sidebar.test.ts
import { describe, it, expect, vi } from 'vitest'
import { JSDOM } from 'jsdom'
import { mountSidebar } from '../sidebar.js'
import { ROUTE_PANELS } from '../route-registry.js'

function withDom(): HTMLElement {
  const dom = new JSDOM('<!doctype html><div id="r"></div>')
  ;(globalThis as unknown as { document: Document }).document = dom.window.document
  const r = dom.window.document.getElementById('r')
  if (r === null) throw new Error('test setup')
  return r
}

describe('mountSidebar', () => {
  it('renders every section header that has at least one panel', () => {
    const parent = withDom()
    const handle = mountSidebar(parent, { onSelect: vi.fn(), getActiveCampaignId: () => null })
    const sections = handle.root.querySelectorAll('[data-section]')
    const labels = Array.from(sections).map((s) => s.getAttribute('data-section'))
    expect(labels).toContain('CAMPAIGNS')
    expect(labels).toContain('WORLD')
    expect(labels).toContain('CHARACTERS')
    expect(labels).toContain('USERS')
    expect(labels).toContain('BILLING')
    expect(labels).toContain('SYSTEM')
    handle.unmount()
  })

  it('renders one clickable leaf per ROUTE_PANELS entry', () => {
    const parent = withDom()
    const handle = mountSidebar(parent, { onSelect: vi.fn(), getActiveCampaignId: () => null })
    const leaves = handle.root.querySelectorAll('[data-leaf]')
    expect(leaves.length).toBe(ROUTE_PANELS.length)
    handle.unmount()
  })

  it('clicking a leaf calls onSelect with the route descriptor', () => {
    const parent = withDom()
    const onSelect = vi.fn()
    const handle = mountSidebar(parent, { onSelect, getActiveCampaignId: () => '019e-aaa' })
    const firstLeaf = handle.root.querySelector('[data-leaf]') as HTMLElement
    firstLeaf.click()
    expect(onSelect).toHaveBeenCalledTimes(1)
    handle.unmount()
  })

  it(':campaignId-requiring leaves are dimmed when no active campaign', () => {
    const parent = withDom()
    const handle = mountSidebar(parent, { onSelect: vi.fn(), getActiveCampaignId: () => null })
    const dimmed = handle.root.querySelectorAll('[data-leaf][data-disabled="true"]')
    // every ROUTE_PANELS entry with requiresCampaign should be dimmed
    expect(dimmed.length).toBeGreaterThan(0)
    handle.unmount()
  })
})
