import { beforeEach, describe, expect, it } from 'vitest'
import { addCostUsd, getTotalUsd, _resetDevCostForTests } from '../dev-cost-tracker.js'

describe('dev-cost-tracker', () => {
  beforeEach(() => {
    _resetDevCostForTests()
  })

  it('starts at 0', () => {
    expect(getTotalUsd()).toBe(0)
  })

  it('accumulates successive costs', () => {
    addCostUsd(0.5)
    addCostUsd(0.25)
    addCostUsd(1.125)
    expect(getTotalUsd()).toBeCloseTo(1.875, 10)
  })

  it('ignores non-positive and non-finite inputs (never corrupts the counter)', () => {
    addCostUsd(1)
    addCostUsd(0)
    addCostUsd(-5)
    addCostUsd(Number.NaN)
    addCostUsd(Number.POSITIVE_INFINITY)
    expect(getTotalUsd()).toBe(1)
  })

  it('_resetDevCostForTests returns to 0', () => {
    addCostUsd(3.3)
    expect(getTotalUsd()).toBeCloseTo(3.3, 10)
    _resetDevCostForTests()
    expect(getTotalUsd()).toBe(0)
  })
})
