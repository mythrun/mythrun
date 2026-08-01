// backend/scripts/cost/__tests__/run-state.test.ts
//
// Cross-invocation run state: S-2 re-asserts S-1's saved window, so the
// save/load round-trip and the loud failure modes (missing file, mangled
// JSON, wrong shape) are what make `cost-smoke s2` trustworthy.

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { loadRun, saveRun, type CapturedRun } from '../run-state.js'

const dir = mkdtempSync(join(tmpdir(), 'cost-run-state-'))
afterAll(() => {
  rmSync(dir, { recursive: true, force: true })
})

const RUN: CapturedRun = {
  scenario: 's1',
  window: { fromMs: 1_785_545_062_086, toMs: 1_785_545_195_954 },
  campaignId: 'camp-1',
  sessionId: 'sess-1',
  turns: 12,
  completedAt: '2026-07-31T18:00:00.000Z',
}

describe('saveRun / loadRun', () => {
  it('round-trips a captured run, creating the state dir', () => {
    const nested = join(dir, 'created', 'by-save')
    const path = saveRun(nested, RUN)
    expect(path).toBe(join(nested, 'last-s1.json'))
    expect(loadRun(nested, 's1')).toEqual(RUN)
  })

  it('round-trips without the optional fields (s4/s5 have no sessionId/turns)', () => {
    const run: CapturedRun = {
      scenario: 's5',
      window: { fromMs: 1, toMs: 2 },
      campaignId: 'camp-2',
      completedAt: '2026-07-31T18:00:00.000Z',
    }
    saveRun(dir, run)
    expect(loadRun(dir, 's5')).toEqual(run)
  })

  it('fails loudly when no run was saved, naming the prerequisite', () => {
    expect(() => loadRun(dir, 's2')).toThrow(/run `cost-smoke s2` after the scenario/)
  })

  it('rejects mangled JSON and wrong shapes', () => {
    writeFileSync(join(dir, 'last-bad.json'), '{ not json')
    expect(() => loadRun(dir, 'bad')).toThrow(/not valid JSON/)
    writeFileSync(join(dir, 'last-shape.json'), JSON.stringify({ scenario: 'shape' }))
    expect(() => loadRun(dir, 'shape')).toThrow(/failed validation/)
  })
})
