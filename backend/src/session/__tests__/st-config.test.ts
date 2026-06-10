import { describe, expect, it } from 'vitest'
import {
  ST_MODEL, ST_GATE_MODEL, ST_EVAL_FLOOR_TURNS, ST_GATE_CONFIDENCE_FLOOR,
  ST_GATE_EXCHANGE_WINDOW, ST_EVAL_EXCHANGE_WINDOW, SESSION_TOKEN_BUDGET,
  WIND_DOWN_FRACTION, ST_EVAL_TIMEOUT_MS, ST_GATE_TIMEOUT_MS,
  ST_EVAL_MAX_OUTPUT_TOKENS, ST_SUMMARY_TARGET_WORDS,
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
  it('exposes the slice windows, budget, output ceiling, summary target', () => {
    expect(ST_GATE_EXCHANGE_WINDOW).toBeGreaterThan(0)
    expect(ST_EVAL_EXCHANGE_WINDOW).toBeGreaterThanOrEqual(ST_GATE_EXCHANGE_WINDOW)
    expect(SESSION_TOKEN_BUDGET).toBeGreaterThan(0)
    expect(ST_EVAL_MAX_OUTPUT_TOKENS).toBeGreaterThan(0)
    expect(ST_SUMMARY_TARGET_WORDS).toBeGreaterThan(0)
  })
})
