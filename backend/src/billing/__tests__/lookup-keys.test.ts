import { describe, it, expect } from 'vitest'
import { LOOKUP_KEYS, type LookupKey } from '../lookup-keys.js'

describe('LOOKUP_KEYS contract', () => {
  it('every map key matches its lookupKey property (drift detection)', () => {
    for (const k of Object.keys(LOOKUP_KEYS) as LookupKey[]) {
      expect(LOOKUP_KEYS[k].lookupKey).toBe(k)
    }
  })

  it('tier_wayfarer: recurring, 4 sessions, 1 world, "Wayfarer"', () => {
    expect(LOOKUP_KEYS.tier_wayfarer).toEqual({
      lookupKey: 'tier_wayfarer',
      displayName: 'Wayfarer',
      type: 'recurring',
      sessionsGranted: 4,
      worldsGranted: 1,
    })
  })

  it('tier_sojourner: recurring, 8 sessions, 2 worlds, "Sojourner"', () => {
    expect(LOOKUP_KEYS.tier_sojourner).toEqual({
      lookupKey: 'tier_sojourner',
      displayName: 'Sojourner',
      type: 'recurring',
      sessionsGranted: 8,
      worldsGranted: 2,
    })
  })

  it('tier_mythwright: recurring, 16 sessions, 4 worlds, "Mythwright"', () => {
    expect(LOOKUP_KEYS.tier_mythwright).toEqual({
      lookupKey: 'tier_mythwright',
      displayName: 'Mythwright',
      type: 'recurring',
      sessionsGranted: 16,
      worldsGranted: 4,
    })
  })

  it('sku_session: one_time, 1 session, 0 worlds, "Session"', () => {
    expect(LOOKUP_KEYS.sku_session).toEqual({
      lookupKey: 'sku_session',
      displayName: 'Session',
      type: 'one_time',
      sessionsGranted: 1,
      worldsGranted: 0,
    })
  })

  it('sku_world: one_time, 1 session, 1 world, "World"', () => {
    expect(LOOKUP_KEYS.sku_world).toEqual({
      lookupKey: 'sku_world',
      displayName: 'World',
      type: 'one_time',
      sessionsGranted: 1,
      worldsGranted: 1,
    })
  })

  it('contract size <= 100 (Stripe prices.list lookup_keys filter ceiling)', () => {
    expect(Object.keys(LOOKUP_KEYS).length).toBeLessThanOrEqual(100)
  })

  it('exactly 5 entries', () => {
    expect(Object.keys(LOOKUP_KEYS)).toHaveLength(5)
  })
})
