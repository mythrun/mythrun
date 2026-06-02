// @vitest-environment jsdom
//
// MYT-62 T7: tests for the session-prep prose view. Two layers:
//   1. The pure reducer (emptyProseState / applyProseDelta) — no DOM.
//   2. The minimal DOM mount (mountProseView) — JSDOM, mirrors the
//      drawer.test.ts MapStorage + withDom idiom. Asserts that fed
//      `prep-delta` events accumulate into the right pane and that
//      reset() clears both panes.

import { describe, it, expect } from 'vitest'
import { JSDOM } from 'jsdom'
import {
  emptyProseState,
  applyProseDelta,
  mountProseView,
  type ProseState,
} from '../prose-view.js'

function withDom(): HTMLElement {
  const dom = new JSDOM('<!doctype html><div id="r"></div>')
  ;(globalThis as unknown as { document: Document }).document = dom.window.document
  ;(globalThis as unknown as { window: Window }).window = dom.window as unknown as Window
  const r = dom.window.document.getElementById('r')
  if (r === null) throw new Error('test setup')
  return r
}

describe('prose-view reducer', () => {
  it('emptyProseState starts both fields empty', () => {
    const s = emptyProseState()
    expect(s.ft_context).toBe('')
    expect(s.sd_playbook).toBe('')
  })

  it('applyProseDelta appends to ft_context', () => {
    let s: ProseState = emptyProseState()
    s = applyProseDelta(s, { field: 'ft_context', text: 'The market ' })
    s = applyProseDelta(s, { field: 'ft_context', text: 'is quiet.' })
    expect(s.ft_context).toBe('The market is quiet.')
    expect(s.sd_playbook).toBe('')
  })

  it('applyProseDelta appends to sd_playbook independently of ft_context', () => {
    let s: ProseState = emptyProseState()
    s = applyProseDelta(s, { field: 'sd_playbook', text: 'Beat 1. ' })
    s = applyProseDelta(s, { field: 'ft_context', text: 'Public fact. ' })
    s = applyProseDelta(s, { field: 'sd_playbook', text: 'Beat 2.' })
    expect(s.sd_playbook).toBe('Beat 1. Beat 2.')
    expect(s.ft_context).toBe('Public fact. ')
  })

  it('applyProseDelta does not mutate the input state (returns a new object)', () => {
    const s0 = emptyProseState()
    const s1 = applyProseDelta(s0, { field: 'ft_context', text: 'x' })
    expect(s0.ft_context).toBe('')
    expect(s1).not.toBe(s0)
  })
})

describe('prose-view mount', () => {
  it('mounts two labeled panes (ft_context + sd_playbook) starting empty', () => {
    const parent = withDom()
    const view = mountProseView(parent)
    const ft = parent.querySelector('[data-prose-field="ft_context"]')
    const sd = parent.querySelector('[data-prose-field="sd_playbook"]')
    expect(ft).not.toBeNull()
    expect(sd).not.toBeNull()
    // Labels present so an operator can tell the panes apart.
    expect(parent.textContent).toContain('ft_context')
    expect(parent.textContent).toContain('sd_playbook')
    view.reset()
  })

  it('feeding two prep-delta events renders accumulated text in the right pane', () => {
    const parent = withDom()
    const view = mountProseView(parent)
    view.onEvent({
      campaignId: 'c01234567',
      type: 'prep-delta',
      data: { field: 'ft_context', text: 'A cold ' },
      receivedAt: 0,
    })
    view.onEvent({
      campaignId: 'c01234567',
      type: 'prep-delta',
      data: { field: 'ft_context', text: 'morning.' },
      receivedAt: 1,
    })
    const ft = parent.querySelector<HTMLElement>('[data-prose-text="ft_context"]')
    expect(ft?.textContent).toBe('A cold morning.')
    view.reset()
  })

  it('routes sd_playbook deltas to the sd_playbook pane only', () => {
    const parent = withDom()
    const view = mountProseView(parent)
    view.onEvent({
      campaignId: 'c',
      type: 'prep-delta',
      data: { field: 'sd_playbook', text: 'Secret beat.' },
      receivedAt: 0,
    })
    const sd = parent.querySelector<HTMLElement>('[data-prose-text="sd_playbook"]')
    const ft = parent.querySelector<HTMLElement>('[data-prose-text="ft_context"]')
    expect(sd?.textContent).toBe('Secret beat.')
    expect(ft?.textContent).toBe('')
    view.reset()
  })

  it('ignores non prep-delta events', () => {
    const parent = withDom()
    const view = mountProseView(parent)
    view.onEvent({
      campaignId: 'c',
      type: 'stage-completed',
      data: { stage: 'world_and_factions' },
      receivedAt: 0,
    })
    const ft = parent.querySelector<HTMLElement>('[data-prose-text="ft_context"]')
    const sd = parent.querySelector<HTMLElement>('[data-prose-text="sd_playbook"]')
    expect(ft?.textContent).toBe('')
    expect(sd?.textContent).toBe('')
    view.reset()
  })

  it('ignores prep-delta events with a missing/invalid field', () => {
    const parent = withDom()
    const view = mountProseView(parent)
    view.onEvent({
      campaignId: 'c',
      type: 'prep-delta',
      data: { field: 'not_a_field', text: 'x' },
      receivedAt: 0,
    })
    view.onEvent({
      campaignId: 'c',
      type: 'prep-delta',
      data: { text: 'no field at all' },
      receivedAt: 0,
    })
    const ft = parent.querySelector<HTMLElement>('[data-prose-text="ft_context"]')
    const sd = parent.querySelector<HTMLElement>('[data-prose-text="sd_playbook"]')
    expect(ft?.textContent).toBe('')
    expect(sd?.textContent).toBe('')
    view.reset()
  })

  it('ignores prep-delta events whose text is not a string', () => {
    const parent = withDom()
    const view = mountProseView(parent)
    view.onEvent({
      campaignId: 'c',
      type: 'prep-delta',
      data: { field: 'ft_context', text: 42 },
      receivedAt: 0,
    })
    const ft = parent.querySelector<HTMLElement>('[data-prose-text="ft_context"]')
    expect(ft?.textContent).toBe('')
    view.reset()
  })

  it('reset clears accumulated text in both panes', () => {
    const parent = withDom()
    const view = mountProseView(parent)
    view.onEvent({
      campaignId: 'c',
      type: 'prep-delta',
      data: { field: 'ft_context', text: 'ft' },
      receivedAt: 0,
    })
    view.onEvent({
      campaignId: 'c',
      type: 'prep-delta',
      data: { field: 'sd_playbook', text: 'sd' },
      receivedAt: 0,
    })
    view.reset()
    const ft = parent.querySelector<HTMLElement>('[data-prose-text="ft_context"]')
    const sd = parent.querySelector<HTMLElement>('[data-prose-text="sd_playbook"]')
    expect(ft?.textContent).toBe('')
    expect(sd?.textContent).toBe('')
  })
})
