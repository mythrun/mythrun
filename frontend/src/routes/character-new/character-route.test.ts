import { describe, expect, it } from 'vitest'
import { deriveCharacterRoute, type CharacterRouteSignals } from './character-route.ts'

// The pure routing decision (spec §3.3) — exhaustive over the table. Split from the
// mounted-surface tests so the pure decision has its own colocated coverage.

describe('deriveCharacterRoute — the §3.3 table', () => {
  const base: CharacterRouteSignals = {
    campaignStatus: 'setup',
    isOwner: true,
    situationChosen: true,
    levelSet: true,
    conceptStatus: 'none',
    confirmed: false,
  }
  const r = (over: Partial<CharacterRouteSignals>): string => deriveCharacterRoute({ ...base, ...over })

  it('campaign failed → integration failure (terminal integration failure row)', () => {
    expect(r({ campaignStatus: 'failed' })).toBe('failure-integration')
  })
  it('campaign active OR concept integrated → play', () => {
    expect(r({ campaignStatus: 'active' })).toBe('play')
    expect(r({ conceptStatus: 'integrated' })).toBe('play')
  })
  it('situation not chosen → owner situation pick / member hold', () => {
    expect(r({ situationChosen: false, isOwner: true })).toBe('situation')
    expect(r({ situationChosen: false, isOwner: false })).toBe('hold')
  })
  it('situation set, level not set → owner level pick / member hold', () => {
    expect(r({ levelSet: false, isOwner: true })).toBe('level')
    expect(r({ levelSet: false, isOwner: false })).toBe('hold')
  })
  it('both set, no concept OR submitted OR unknown → create', () => {
    expect(r({ conceptStatus: 'none' })).toBe('create')
    expect(r({ conceptStatus: 'submitted' })).toBe('create')
    expect(r({ conceptStatus: 'weird' })).toBe('create')
  })
  it('concept failed → concept failure', () => {
    expect(r({ conceptStatus: 'failed' })).toBe('failure-concept')
  })
  it('concept processing → loading', () => {
    expect(r({ conceptStatus: 'processing' })).toBe('loading')
  })
  it('concept completed → reveal (unconfirmed) / staging (confirmed)', () => {
    expect(r({ conceptStatus: 'completed', confirmed: false })).toBe('reveal')
    expect(r({ conceptStatus: 'completed', confirmed: true })).toBe('staging')
  })
})
