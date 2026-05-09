import { describe, expect, it } from 'vitest'
import {
  MODEL_DISPLAY_NAMES,
  MODEL_PRICING,
  computeCostUsd,
} from '../model-pricing.js'

describe('MODEL_PRICING', () => {
  it('contains the three Mythrun-known model slugs', () => {
    expect(MODEL_PRICING).toHaveProperty('claude-opus-4-7')
    expect(MODEL_PRICING).toHaveProperty('claude-sonnet-4-6')
    expect(MODEL_PRICING).toHaveProperty('claude-haiku-4-5-20251001')
  })

  it('every model has 4 positive rates: input / output / cacheWrite / cacheRead', () => {
    for (const rates of Object.values(MODEL_PRICING)) {
      expect(rates.input).toBeGreaterThan(0)
      expect(rates.output).toBeGreaterThan(0)
      expect(rates.cacheWrite).toBeGreaterThan(0)
      expect(rates.cacheRead).toBeGreaterThan(0)
    }
  })

  it('cacheWrite is approximately 1.25× input for every model', () => {
    for (const rates of Object.values(MODEL_PRICING)) {
      const ratio = rates.cacheWrite / rates.input
      expect(ratio).toBeCloseTo(1.25, 2)
    }
  })

  it('cacheRead is approximately 0.10× input for every model', () => {
    for (const rates of Object.values(MODEL_PRICING)) {
      const ratio = rates.cacheRead / rates.input
      expect(ratio).toBeCloseTo(0.1, 2)
    }
  })
})

describe('MODEL_DISPLAY_NAMES', () => {
  it('every display name maps to a known slug', () => {
    for (const slug of Object.values(MODEL_DISPLAY_NAMES)) {
      expect(MODEL_PRICING).toHaveProperty(slug)
    }
  })
})

describe('computeCostUsd', () => {
  it('haiku 1M input + 1M output: $1 input + $5 output = $6.00', () => {
    const cost = computeCostUsd('claude-haiku-4-5-20251001', {
      inputTokens: 1_000_000,
      outputTokens: 1_000_000,
    })
    expect(cost).toBe(6.0)
  })

  it('sonnet 100K cacheWrite + 1M cacheRead: 0.375 + 0.30 = 0.675', () => {
    const cost = computeCostUsd('claude-sonnet-4-6', {
      inputTokens: 0,
      outputTokens: 0,
      cacheWriteTokens: 100_000,
      cacheReadTokens: 1_000_000,
    })
    expect(cost).toBeCloseTo(0.675, 6)
  })

  it('opus mixed: weighted sum of contributions', () => {
    const cost = computeCostUsd('claude-opus-4-7', {
      inputTokens: 10_000,
      outputTokens: 5_000,
      cacheWriteTokens: 2_000,
      cacheReadTokens: 50_000,
    })
    // 10K * 5 + 5K * 25 + 2K * 6.25 + 50K * 0.50 = 212,500
    // / 1M = 0.2125
    expect(cost).toBeCloseTo(0.2125, 6)
  })

  it('undefined cacheWriteTokens / cacheReadTokens default to 0', () => {
    const cost = computeCostUsd('claude-haiku-4-5-20251001', {
      inputTokens: 1_000_000,
      outputTokens: 0,
    })
    expect(cost).toBe(1.0)
  })

  it('throws when 1-hour cache tokens are passed in', () => {
    expect(() =>
      computeCostUsd('claude-sonnet-4-6', {
        inputTokens: 100,
        outputTokens: 100,
        cacheWrite1hTokens: 1,
      }),
    ).toThrow(/1-hour cache/)
  })
})
