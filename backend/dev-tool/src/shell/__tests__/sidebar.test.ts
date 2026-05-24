// @vitest-environment jsdom
// backend/dev-tool/src/shell/__tests__/sidebar.test.ts
//
// myth-0smu: the sidebar now drives workflow-page selection (Campaigns /
// World / Characters / Users & Access / Billing / System) instead of one
// leaf per (endpoint × method). Tests pinned to the workflow registry.
import { describe, it, expect, vi } from 'vitest'
import { JSDOM } from 'jsdom'
import { mountSidebar } from '../sidebar.js'
import { WORKFLOWS } from '../workflow-registry.js'

function withDom(): HTMLElement {
  const dom = new JSDOM('<!doctype html><div id="r"></div>')
  ;(globalThis as unknown as { document: Document }).document = dom.window.document
  const r = dom.window.document.getElementById('r')
  if (r === null) throw new Error('test setup')
  return r
}

describe('mountSidebar', () => {
  it('renders one entry per workflow', () => {
    const parent = withDom()
    const handle = mountSidebar(parent, { onSelect: vi.fn(), getActiveCampaignId: () => null })
    const leaves = handle.root.querySelectorAll('[data-leaf]')
    expect(leaves.length).toBe(WORKFLOWS.length)
    handle.unmount()
  })

  it('clicking a leaf calls onSelect with the workflow descriptor', () => {
    const parent = withDom()
    const onSelect = vi.fn()
    const handle = mountSidebar(parent, { onSelect, getActiveCampaignId: () => '019e-aaa' })
    const firstLeaf = handle.root.querySelector<HTMLElement>('[data-leaf]')
    if (firstLeaf === null) throw new Error('firstLeaf missing')
    firstLeaf.click()
    expect(onSelect).toHaveBeenCalledTimes(1)
    handle.unmount()
  })

  it('campaign-required workflow leaves are dimmed when no active campaign', () => {
    const parent = withDom()
    const handle = mountSidebar(parent, { onSelect: vi.fn(), getActiveCampaignId: () => null })
    const dimmed = handle.root.querySelectorAll('[data-leaf][data-disabled="true"]')
    // World + Characters require an active campaign per workflow-registry.
    expect(dimmed.length).toBeGreaterThan(0)
    handle.unmount()
  })

  it('campaign-required workflow leaves are enabled when an active campaign exists', () => {
    const parent = withDom()
    const handle = mountSidebar(parent, { onSelect: vi.fn(), getActiveCampaignId: () => '019e-aaa' })
    const dimmed = handle.root.querySelectorAll('[data-leaf][data-disabled="true"]')
    expect(dimmed.length).toBe(0)
    handle.unmount()
  })
})
