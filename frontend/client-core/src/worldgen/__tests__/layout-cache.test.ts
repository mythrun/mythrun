import { afterEach, describe, expect, it } from 'vitest'
import { mulberry32, resetWorldgenLayouts, terrainSeedFor, worldgenLayout } from '../layout-cache.ts'

// The session-scoped world-gen layout cache (ux-run3 myth-aftau). The live map
// unmounts whenever the player toggles back to the calm wait (and on route
// leave); before this cache the settled node positions and the fog's random
// field died with the component — every re-entry re-rolled the whole world
// (pixel evidence: The Spice Quarter migrated ~200px between visits). The cache
// is the world-state home for what the player has SEEN PLACED: pinned
// placements + the one-per-world terrain seed, keyed by the worldgen run
// (campaign id). Session-scoped by design — a refresh restarts the stream and
// re-snapshots anyway; within a session, stage 2 must read as stage 1 plus
// accretion, never a re-roll.

afterEach(() => {
  resetWorldgenLayouts()
})

describe('worldgenLayout — get-or-create per run key', () => {
  it('returns the SAME layout object for the same key (the persistence identity)', () => {
    const first = worldgenLayout('campaign-1')
    first.placements.set('s1/reach', { displayId: 's1/reach', x: 12, y: -30 })
    const again = worldgenLayout('campaign-1')
    expect(again).toBe(first)
    expect(again.placements.get('s1/reach')).toEqual({ displayId: 's1/reach', x: 12, y: -30 })
  })

  it('keeps distinct worlds distinct — one key never reads another key placements', () => {
    worldgenLayout('campaign-1').placements.set('s1/reach', { displayId: 's1/reach', x: 1, y: 2 })
    expect(worldgenLayout('campaign-2').placements.size).toBe(0)
  })

  it('derives the terrain seed from the KEY — one world, one coastline, even after a refresh', () => {
    const seed = worldgenLayout('campaign-1').terrainSeed
    expect(seed).toBe(terrainSeedFor('campaign-1'))
    expect(Number.isInteger(seed)).toBe(true)
    expect(seed).toBeGreaterThanOrEqual(0)
    // A dropped cache (the refresh) re-derives the SAME ground.
    resetWorldgenLayouts()
    expect(worldgenLayout('campaign-1').terrainSeed).toBe(seed)
  })

  it('gives distinct worlds distinct ground', () => {
    expect(terrainSeedFor('campaign-1')).not.toBe(terrainSeedFor('campaign-2'))
  })

  it('resetWorldgenLayouts drops every cached layout (test isolation)', () => {
    worldgenLayout('campaign-1').placements.set('s1/reach', { displayId: 's1/reach', x: 1, y: 2 })
    resetWorldgenLayouts()
    expect(worldgenLayout('campaign-1').placements.size).toBe(0)
  })
})

describe('mulberry32 — the deterministic terrain RNG', () => {
  it('is deterministic: the same seed replays the identical sequence', () => {
    const a = mulberry32(0xc0ffee)
    const b = mulberry32(0xc0ffee)
    const seqA = [a(), a(), a(), a(), a()]
    const seqB = [b(), b(), b(), b(), b()]
    expect(seqA).toEqual(seqB)
  })

  it('different seeds diverge (a re-keyed world is a different field)', () => {
    const a = mulberry32(1)
    const b = mulberry32(2)
    expect([a(), a(), a()]).not.toEqual([b(), b(), b()])
  })

  it('emits in [0, 1) — a drop-in for Math.random', () => {
    const next = mulberry32(42)
    for (let i = 0; i < 1000; i++) {
      const v = next()
      expect(v).toBeGreaterThanOrEqual(0)
      expect(v).toBeLessThan(1)
    }
  })
})
