// @vitest-environment jsdom
//
// myth-fn51 P6.C — DOM tests for mountCharacterViewPanel.

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { JSDOM } from 'jsdom'

vi.mock('../../api-client.js', () => ({
  apiCall: vi.fn(),
}))

import { apiCall } from '../../api-client.js'
import {
  setActiveCampaignId,
  setActiveCharacterId,
} from '../../shell/active-campaign.js'
import { mountCharacterViewPanel } from '../character-view-panel.js'

const apiCallMock = vi.mocked(apiCall)

interface GlobalDom {
  document?: Document | undefined
  window?: Window | undefined
  localStorage?: Storage | undefined
  HTMLElement?: typeof HTMLElement | undefined
  CustomEvent?: typeof CustomEvent | undefined
}

const g = globalThis as unknown as GlobalDom
let saved: GlobalDom = {}
let dom: JSDOM

beforeAll(() => {
  dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'http://localhost/' })
  saved = {
    document: g.document,
    window: g.window,
    localStorage: g.localStorage,
    HTMLElement: g.HTMLElement,
    CustomEvent: g.CustomEvent,
  }
  g.document = dom.window.document
  g.window = dom.window as unknown as Window
  g.localStorage = dom.window.localStorage
  g.HTMLElement = dom.window.HTMLElement
  g.CustomEvent = dom.window.CustomEvent
})

afterAll(() => {
  g.document = saved.document
  g.window = saved.window
  g.localStorage = saved.localStorage
  g.HTMLElement = saved.HTMLElement
  g.CustomEvent = saved.CustomEvent
})

function makeParent(): HTMLElement {
  const p = dom.window.document.createElement('div')
  dom.window.document.body.appendChild(p)
  return p
}

beforeEach(() => {
  dom.window.document.body.replaceChildren()
  apiCallMock.mockReset()
  dom.window.localStorage.clear()
})

afterEach(() => {
  setActiveCampaignId(null)
  setActiveCharacterId(null)
})

describe('mountCharacterViewPanel', () => {
  it('returns a PanelHandle whose root is in the parent', () => {
    const parent = makeParent()
    const handle = mountCharacterViewPanel(parent)
    expect(handle.root.getAttribute('data-state')).toBe('ready')
    expect(parent.contains(handle.root)).toBe(true)
  })

  it('unmount removes the panel from the parent', () => {
    const parent = makeParent()
    const handle = mountCharacterViewPanel(parent)
    handle.unmount()
    expect(parent.children.length).toBe(0)
  })

  it('transitions to ready on 200 with active campaign + character', async () => {
    setActiveCampaignId('camp-1')
    setActiveCharacterId('char-1')
    apiCallMock.mockResolvedValueOnce({
      status: 200,
      ok: true,
      body: { id: 'char-1', skills: [], features: [], equipment: [], spells: [] },
      latencyMs: 7,
    })
    const parent = makeParent()
    const handle = mountCharacterViewPanel(parent)
    const btn = handle.root.querySelector('button')
    if (btn === null) throw new Error('expected button')
    btn.click()
    await new Promise((r) => setTimeout(r, 0))
    expect(handle.root.getAttribute('data-state')).toBe('ready')
  })

  it('transitions to error on 404', async () => {
    setActiveCampaignId('camp-1')
    setActiveCharacterId('char-1')
    apiCallMock.mockResolvedValueOnce({
      status: 404,
      ok: false,
      body: { code: 'character_not_found' },
      latencyMs: 7,
    })
    const parent = makeParent()
    const handle = mountCharacterViewPanel(parent)
    const btn = handle.root.querySelector('button')
    if (btn === null) throw new Error('expected button')
    btn.click()
    await new Promise((r) => setTimeout(r, 0))
    expect(handle.root.getAttribute('data-state')).toBe('error')
  })

  // myth-94bu: domain-aware renderer asserts.
  it('renders the character sheet with name, class, abilities, and vitals', async () => {
    setActiveCampaignId('camp-1')
    setActiveCharacterId('char-1')
    apiCallMock.mockResolvedValueOnce({
      status: 200,
      ok: true,
      body: {
        character: {
          id: 'char-1',
          user_id: 'u-1',
          entity_id: null,
          name: 'Maren Stoneheart',
          level: 3,
          class: 'Fighter',
          species: 'Dwarf',
          background: 'Soldier',
          str: 16,
          dex: 12,
          con: 14,
          int: 10,
          wis: 11,
          cha: 8,
          hit_points: 24,
          max_hit_points: 28,
          armor_class: 17,
          proficiency_bonus: 2,
          created_at: '2026-05-01T00:00:00Z',
          updated_at: '2026-05-01T00:00:00Z',
        },
        skills: [],
        features: [
          { feature_name: 'Second Wind', feature_source: 'Fighter', description: 'Bonus action heal.' },
        ],
        equipment: [
          { item_name: 'Longsword', quantity: 1, equipped: true },
          { item_name: 'Rations', quantity: 5, equipped: false },
        ],
        spells: [],
      },
      latencyMs: 7,
    })
    const parent = makeParent()
    const handle = mountCharacterViewPanel(parent)
    const btn = handle.root.querySelector('button')
    if (btn === null) throw new Error('expected button')
    btn.click()
    await new Promise((r) => setTimeout(r, 0))
    const text = handle.root.textContent
    expect(text).toContain('Maren Stoneheart')
    expect(text).toContain('Fighter')
    expect(text).toContain('Dwarf')
    expect(text).toContain('level 3')
    expect(text).toContain('Soldier')
    // Ability scores + modifiers
    expect(text).toContain('STR')
    expect(text).toContain('16')
    expect(text).toContain('(+3)')
    expect(text).toContain('CHA')
    expect(text).toContain('(-1)')
    // Vitals
    expect(text).toContain('24 / 28')
    expect(text).toContain('AC')
    expect(text).toContain('17')
    // Features + equipment lists
    expect(text).toContain('Features (1)')
    expect(text).toContain('Second Wind')
    expect(text).toContain('Equipment (2)')
    expect(text).toContain('Longsword ×1 (equipped)')
    expect(text).toContain('Rations ×5')
    expect(text).toContain('Spells (0)')
    // Sheet card is a <section data-region="character-sheet">.
    expect(handle.root.querySelector('[data-region="character-sheet"]')).not.toBeNull()
    // Raw JSON disclosure preserved as footer.
    expect(handle.root.querySelector('details')).not.toBeNull()
  })

  it('falls back to a malformed-data message when character payload is missing', async () => {
    setActiveCampaignId('camp-1')
    setActiveCharacterId('char-1')
    apiCallMock.mockResolvedValueOnce({
      status: 200,
      ok: true,
      body: { features: [], equipment: [], spells: [] },
      latencyMs: 7,
    })
    const parent = makeParent()
    const handle = mountCharacterViewPanel(parent)
    const btn = handle.root.querySelector('button')
    if (btn === null) throw new Error('expected button')
    btn.click()
    await new Promise((r) => setTimeout(r, 0))
    expect(handle.root.textContent).toContain('(character data missing or malformed)')
  })
})
