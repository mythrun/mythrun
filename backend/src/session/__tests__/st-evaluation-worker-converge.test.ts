// myth-3jna1 — the convergence steer's WIRING inside `processStEvalJob`.
//
// Today a session runs at full throttle until cumulative spend crosses
// SESSION_TOKEN_BUDGET and a farewell is stapled onto whatever scene happened
// to be running. The steer adds a stage before that cliff: from
// CONVERGE_MECHANICAL_FLOOR onward the worker spends one Haiku call asking how
// far through the prep's arc the table actually is, and when the story is
// behind the spend it forces an evaluation with `converge:true` so the ST folds
// a "start drawing toward a resting point" steer into its standing directive.
//
// The three arms in order: converge (0.75, only if the arc lags) → wind-down
// (0.9) → farewell (1.0, the turn worker's auto-end).
//
// The enforced-ignorance proof (nothing secret-side crosses to the FT) lives in
// the sibling converge-leak.test.ts; this file owns the decision tree.

import { describe, expect, it } from 'vitest'
import {
  CONVERGE_MECHANICAL_FLOOR,
  SESSION_TOKEN_BUDGET,
  ST_EVAL_FLOOR_TURNS,
  WIND_DOWN_FRACTION,
} from '../st-config.js'
import { processStEvalJob } from '../st-evaluation-worker.js'
import { job, makeHarness, progress, usage } from './st-evaluation-worker-harness.js'

/** Cumulative spend that lands mechanical progress exactly on the floor. */
const AT_FLOOR = CONVERGE_MECHANICAL_FLOOR * SESSION_TOKEN_BUDGET
const BELOW_FLOOR = AT_FLOOR - 1
const AT_WIND_DOWN = Math.ceil(WIND_DOWN_FRACTION * SESSION_TOKEN_BUDGET)

describe('processStEvalJob — the convergence probe window', () => {
  it('case C1: below the floor → NO probe call at all (three quarters of a session cost nothing extra)', async () => {
    const { deps, rec } = makeHarness({ totalUsed: BELOW_FLOOR })
    await processStEvalJob(deps, job)
    expect(rec.progressInputs).toHaveLength(0)
    expect(rec.directorInputs[0]?.converge).toBe(false)
  })

  it('case C2: at the floor → the probe runs', async () => {
    const { deps, rec } = makeHarness({ totalUsed: AT_FLOOR })
    await processStEvalJob(deps, job)
    expect(rec.progressInputs).toHaveLength(1)
  })

  it('case C3: wind-down active → NO probe (that arm already steers to close)', async () => {
    const { deps, rec } = makeHarness({ totalUsed: AT_WIND_DOWN })
    await processStEvalJob(deps, job)
    expect(rec.progressInputs).toHaveLength(0)
    expect(rec.directorInputs[0]?.windDown).toBe(true)
    expect(rec.directorInputs[0]?.converge).toBe(false)
  })

  it('case C4: converge and windDown are never both true', async () => {
    for (const totalUsed of [BELOW_FLOOR, AT_FLOOR, AT_WIND_DOWN, SESSION_TOKEN_BUDGET]) {
      const { deps, rec } = makeHarness({
        totalUsed,
        narrativeProgress: progress(0),
      })
      await processStEvalJob(deps, job)
      const input = rec.directorInputs[0]
      expect(input).toBeDefined()
      expect([input?.windDown, input?.converge]).not.toEqual([true, true])
    }
  })
})

describe('processStEvalJob — the converge verdict', () => {
  it('case C5: narrative lags mechanical → director called with converge:true', async () => {
    const { deps, rec } = makeHarness({
      totalUsed: AT_FLOOR,
      narrativeProgress: progress(0.3),
    })
    await processStEvalJob(deps, job)
    expect(rec.directorInputs).toHaveLength(1)
    expect(rec.directorInputs[0]?.converge).toBe(true)
  })

  it('case C6: narrative on pace → converge:false even inside the window', async () => {
    const { deps, rec } = makeHarness({
      totalUsed: AT_FLOOR,
      narrativeProgress: progress(CONVERGE_MECHANICAL_FLOOR),
    })
    await processStEvalJob(deps, job)
    expect(rec.progressInputs).toHaveLength(1)
    expect(rec.directorInputs[0]?.converge).toBe(false)
  })

  it('case C7: narrative AHEAD of the spend → no steer (the party is early, let them play)', async () => {
    const { deps, rec } = makeHarness({
      totalUsed: AT_FLOOR,
      narrativeProgress: progress(0.95),
    })
    await processStEvalJob(deps, job)
    expect(rec.directorInputs[0]?.converge).toBe(false)
  })
})

describe('processStEvalJob — converge forces the evaluation', () => {
  it('case C8: converge → the Haiku gate is SKIPPED and the director runs (same arm as wind-down)', async () => {
    const { deps, rec } = makeHarness({
      totalUsed: AT_FLOOR,
      turnsSinceSt: 1,
      narrativeProgress: progress(0.2),
      // A confident "no" the gate would otherwise skip on — proving the force
      // is what got us here, not the gate.
      gate: { result: { needed: false, confidence: 0.99, reason: 'quiet' }, usage: usage(10) },
    })
    await processStEvalJob(deps, job)
    expect(rec.gateCalls).toBe(0)
    expect(rec.directorInputs).toHaveLength(1)
    expect(rec.directorInputs[0]?.converge).toBe(true)
  })

  it('case C9: in-window but NOT converging → the gate still owns the decision', async () => {
    const { deps, rec } = makeHarness({
      totalUsed: AT_FLOOR,
      turnsSinceSt: 1,
      narrativeProgress: progress(0.8),
      gate: { result: { needed: false, confidence: 0.99, reason: 'quiet' }, usage: usage(10) },
    })
    await processStEvalJob(deps, job)
    expect(rec.gateCalls).toBe(1)
    expect(rec.directorInputs).toHaveLength(0)
  })

  it('case C10: the floor arm still forces independently of the probe', async () => {
    const { deps, rec } = makeHarness({
      totalUsed: BELOW_FLOOR,
      turnsSinceSt: ST_EVAL_FLOOR_TURNS,
    })
    await processStEvalJob(deps, job)
    expect(rec.progressInputs).toHaveLength(0)
    expect(rec.gateCalls).toBe(0)
    expect(rec.directorInputs).toHaveLength(1)
  })
})

describe('processStEvalJob — probe accounting + failure posture', () => {
  it('case C11: probe usage is accumulated into the :usage:st INCRBY', async () => {
    const { deps, rec } = makeHarness({
      totalUsed: AT_FLOOR,
      narrativeProgress: progress(0.2, 25),
    })
    await processStEvalJob(deps, job)
    // probe(25) + director(100); the gate was skipped by the converge force.
    expect(rec.incrUsage).toEqual([125])
  })

  it('case C12: probe throws → caught, no steer, the cycle continues normally', async () => {
    const { deps, rec } = makeHarness({
      totalUsed: AT_FLOOR,
      progressThrows: true,
      gate: { result: { needed: true, confidence: 0.5, reason: 'fire' }, usage: usage(10) },
    })
    await expect(processStEvalJob(deps, job)).resolves.toBeUndefined()
    // Degrades to EXACTLY today's behaviour: the gate decides, no converge, and
    // the wind-down arm at 0.9 remains the backstop.
    expect(rec.gateCalls).toBe(1)
    expect(rec.directorInputs[0]?.converge).toBe(false)
    expect(deps.logger.warn).toHaveBeenCalled()
  })

  it('case C13: a failed probe accounts no tokens', async () => {
    const { deps, rec } = makeHarness({
      totalUsed: AT_FLOOR,
      progressThrows: true,
      gate: { result: { needed: false, confidence: 0.99, reason: 'quiet' }, usage: usage(10) },
    })
    await processStEvalJob(deps, job)
    expect(rec.incrUsage).toEqual([10])
  })

  it('case C14: the probe reads the same session context the gate does', async () => {
    const { deps, rec } = makeHarness({ totalUsed: AT_FLOOR })
    await processStEvalJob(deps, job)
    const input = rec.progressInputs[0]
    expect(input?.sdPlaybook).toBe('PLAYBOOK SECRETS')
    expect(input?.runningSummary).toBe('running summary')
  })
})
