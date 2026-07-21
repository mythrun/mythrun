// backend/src/llm/prompts/__tests__/prep-tier-name-discipline.test.ts
//
// myth-6qgqy — NAME-referential tier discipline in the prep fact-tiering
// prompts. A `known`-tier fact/prose may NAME only `known`-tier entities; the
// NAME itself (not just a revealed truth) is a leak, because the known-tier
// slice feeds the player-facing introduction + wiki. These are prompt-CONTENT
// assertions (the behavior is LLM-shaped and covered end-to-end by the intro
// smoke); they pin that the rule text is present and did not silently drift.

import { describe, expect, it } from 'vitest'
import { loadPrompt } from '../../prompts.js'

// The two generation stages that emit tiered facts — the load-bearing fix,
// since world_introduction reads their known facts BEFORE coherence_pass runs.
describe.each([
  ['world-and-factions'],
  ['locations-and-npcs'],
])('prep/%s — name-referential discipline', (name) => {
  const render = (): string => loadPrompt('prep', name)

  it('states the NAME-referential discipline rule (name only own-tier-or-more-public)', () => {
    const p = render()
    expect(p).toMatch(/NAME-REFERENTIAL DISCIPLINE/i)
    // The NAME itself is the leak, not merely a revealed truth.
    expect(p).toMatch(/the (proper )?NAME itself is the leak/i)
    // A known fact/prose names only known entities.
    expect(p).toMatch(/`known`[^\n]*may name only[^\n]*`known`/i)
  })

  it('names the one-way ladder (only name UP the visibility scale, never down)', () => {
    const p = render()
    expect(p).toMatch(/name UP the visibility scale, never down/i)
    expect(p).toMatch(/`discoverable`[^\n]*may name[^\n]*`known`[^\n]*`discoverable`/i)
    expect(p).toMatch(/`secret`[^\n]*may name anything/i)
  })

  it('prescribes the oblique-reference remedy (drop the name, keep the texture)', () => {
    const p = render()
    expect(p).toMatch(/oblique/i)
    // Names the concrete leak the intro smoke found.
    expect(p).toMatch(/Drowned Reach/)
    expect(p).toMatch(/\bGOOD:/)
    expect(p).toMatch(/\bBAD:/)
  })
})

describe('prep/coherence-pass — tier-name-leak verify + repair', () => {
  const render = (): string => loadPrompt('prep', 'coherence-pass')

  it('lists tier-name leaks as a thing to look for, consulting the dump access tags', () => {
    const p = render()
    expect(p).toMatch(/Tier-name leaks/i)
    expect(p).toMatch(/access_level/i)
    // NAMES may only point UP the visibility scale, never down.
    expect(p).toMatch(/point UP the visibility scale[^.]*never down/i)
  })

  it('repairs via oblique rewrite through the existing fact/prose patch kinds — never delete/promote', () => {
    const p = render()
    expect(p).toMatch(/fix_fact_by_name/)
    expect(p).toMatch(/fix_prose_by_name/)
    expect(p).toMatch(/oblique/i)
    // The two wrong repairs are explicitly barred.
    expect(p).toMatch(/do NOT[^\n]*deleting the fact/i)
    expect(p).toMatch(/do NOT[^\n]*promoting/i)
  })
})
