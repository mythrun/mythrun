// backend/scripts/cost/lib/__tests__/manifest.test.ts
//
// The expected-costs manifest loader (cost-wave1 spec §1.2) + the band
// predicate the runner asserts with. The loader is strict on shape: an entry
// with a typo'd key or a missing tolerancePct must fail the load, not
// silently weaken an assertion.

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { loadManifest, withinBand, type CostEntry } from '../manifest.js'

const dir = mkdtempSync(join(tmpdir(), 'cost-manifest-'))
afterAll(() => {
  rmSync(dir, { recursive: true, force: true })
})

function writeManifest(name: string, content: string): string {
  const path = join(dir, name)
  writeFileSync(path, content)
  return path
}

describe('loadManifest', () => {
  it('loads a valid manifest with every field shape the spec uses', () => {
    const path = writeManifest(
      'valid.json',
      JSON.stringify({
        's1.ft_turn_mean': { usd: 0.39, tolerancePct: 20 },
        's1.st_eval_mean': { usd: 0.11, tokensIn: 159_000, tokensOut: 2_200, tolerancePct: 25 },
        's2.tripwire_span': { spanTokens: 5_200, cacheReadMin: 4_096, tolerancePct: 0 },
        's5.locations_and_npcs': { usd: 1.1, tolerancePct: 20 },
      }),
    )
    const expected: Record<string, CostEntry> = {
      's1.ft_turn_mean': { usd: 0.39, tolerancePct: 20 },
      's1.st_eval_mean': { usd: 0.11, tokensIn: 159_000, tokensOut: 2_200, tolerancePct: 25 },
      's2.tripwire_span': { spanTokens: 5_200, cacheReadMin: 4_096, tolerancePct: 0 },
      's5.locations_and_npcs': { usd: 1.1, tolerancePct: 20 },
    }
    expect(loadManifest(path)).toEqual(expected)
  })

  it('rejects an entry missing tolerancePct', () => {
    const path = writeManifest('no-tol.json', JSON.stringify({ ft: { usd: 0.39 } }))
    expect(() => loadManifest(path)).toThrow(/failed validation/)
  })

  it('rejects an entry with an unknown key (typo defense)', () => {
    const path = writeManifest(
      'typo.json',
      JSON.stringify({ tripwire: { tolerancePct: 20, cacheReadmin: 4_096 } }),
    )
    expect(() => loadManifest(path)).toThrow(/failed validation/)
  })

  it('rejects non-numeric and negative values', () => {
    const stringUsd = writeManifest(
      'string-usd.json',
      JSON.stringify({ ft: { usd: '0.39', tolerancePct: 20 } }),
    )
    expect(() => loadManifest(stringUsd)).toThrow(/failed validation/)
    const negativeTol = writeManifest(
      'neg-tol.json',
      JSON.stringify({ ft: { usd: 0.39, tolerancePct: -5 } }),
    )
    expect(() => loadManifest(negativeTol)).toThrow(/failed validation/)
  })

  it('rejects a file that is not valid JSON, naming the path', () => {
    const path = writeManifest('broken.json', '{ not json')
    expect(() => loadManifest(path)).toThrow(/broken\.json is not valid JSON/)
  })

  it('rejects a missing file, naming the path', () => {
    expect(() => loadManifest(join(dir, 'absent.json'))).toThrow(/cannot read .*absent\.json/)
  })
})

describe('withinBand', () => {
  it('accepts values inside the band and on the boundary (inclusive)', () => {
    expect(withinBand(100, 100, 20)).toBe(true)
    expect(withinBand(120, 100, 20)).toBe(true)
    expect(withinBand(80, 100, 20)).toBe(true)
  })

  it('rejects values outside the band', () => {
    expect(withinBand(120.01, 100, 20)).toBe(false)
    expect(withinBand(79.99, 100, 20)).toBe(false)
  })

  it('tolerancePct 0 means exact match', () => {
    expect(withinBand(100, 100, 0)).toBe(true)
    expect(withinBand(100.0001, 100, 0)).toBe(false)
  })

  it('expected 0 admits only 0', () => {
    expect(withinBand(0, 0, 20)).toBe(true)
    expect(withinBand(0.01, 0, 20)).toBe(false)
  })

  it('throws on non-finite or negative inputs (fail loud, never a silent PASS)', () => {
    expect(() => withinBand(Number.NaN, 100, 20)).toThrow(/withinBand/)
    expect(() => withinBand(100, Number.POSITIVE_INFINITY, 20)).toThrow(/withinBand/)
    expect(() => withinBand(100, 100, Number.NaN)).toThrow(/withinBand/)
    expect(() => withinBand(100, -1, 20)).toThrow(/withinBand/)
    expect(() => withinBand(100, 100, -20)).toThrow(/withinBand/)
  })
})
