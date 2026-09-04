import { describe, expect, it } from 'vitest'
import {
  ST_MODEL, ST_GATE_MODEL, ST_EVAL_FLOOR_TURNS, ST_GATE_CONFIDENCE_FLOOR,
  ST_GATE_EXCHANGE_WINDOW, ST_EVAL_EXCHANGE_WINDOW,
  WIND_DOWN_FRACTION, ST_EVAL_TIMEOUT_MS, ST_GATE_TIMEOUT_MS,
  ST_EVAL_MAX_OUTPUT_TOKENS, ST_SUMMARY_TARGET_WORDS,
  CONVERGE_MECHANICAL_FLOOR, CONVERGE_LAG_MARGIN, ST_PROGRESS_MODEL,
  ST_PROGRESS_TIMEOUT_MS,
} from '../st-config.js'
import { OPUS, HAIKU } from '../../llm/models.js'

describe('st-config', () => {
  it('pins the §11 tier assignment + knobs', () => {
    expect(ST_MODEL).toBe(OPUS)
    expect(ST_GATE_MODEL).toBe(HAIKU)
    expect(ST_EVAL_FLOOR_TURNS).toBe(5)
    expect(ST_GATE_CONFIDENCE_FLOOR).toBe(0.8)
    expect(WIND_DOWN_FRACTION).toBe(0.9)
  })
  it('background-tolerant timeouts exceed the worker close grace (deploy re-run accepted)', () => {
    expect(ST_EVAL_TIMEOUT_MS).toBe(120_000)
    expect(ST_GATE_TIMEOUT_MS).toBe(30_000)
  })
  it('exposes the slice windows, output ceiling, summary target', () => {
    expect(ST_GATE_EXCHANGE_WINDOW).toBeGreaterThan(0)
    expect(ST_EVAL_EXCHANGE_WINDOW).toBeGreaterThanOrEqual(ST_GATE_EXCHANGE_WINDOW)
    expect(ST_EVAL_MAX_OUTPUT_TOKENS).toBeGreaterThan(0)
    expect(ST_SUMMARY_TARGET_WORDS).toBeGreaterThan(0)
  })
  it('myth-3jna1: the convergence stage sits BEFORE wind-down, on the cheap tier', () => {
    expect(CONVERGE_MECHANICAL_FLOOR).toBe(0.75)
    expect(CONVERGE_LAG_MARGIN).toBe(0.1)
    // The probe window is [floor, wind-down) — a converge steer must have room
    // to land before wind-down starts closing the session.
    expect(CONVERGE_MECHANICAL_FLOOR).toBeLessThan(WIND_DOWN_FRACTION)
    // The margin must be non-zero (it absorbs a coarse 0-1 judgment) and
    // smaller than the floor, or the steer would be unreachable — at the floor
    // it needs narrative < floor - margin, which has to leave a real range.
    expect(CONVERGE_LAG_MARGIN).toBeGreaterThan(0)
    expect(CONVERGE_LAG_MARGIN).toBeLessThan(CONVERGE_MECHANICAL_FLOOR)
    expect(ST_PROGRESS_MODEL).toBe(HAIKU)
    expect(ST_PROGRESS_TIMEOUT_MS).toBe(30_000)
  })
})
