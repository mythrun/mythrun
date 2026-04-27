import { describe, it, expect } from 'vitest'
import { LOCK_KEY } from '../lock-key.js'

describe('LOCK_KEY', () => {
  it('is the pinned literal from hashtextextended("mythrun_migrate", 0)', () => {
    // DO NOT REGENERATE THIS VALUE. See lock-key.ts comment for why.
    // If this assertion fails, somebody changed LOCK_KEY in source —
    // that is a bug, not a fix.
    expect(LOCK_KEY).toBe(-4399791952761660515n)
  })

  it('is a bigint that fits signed 64-bit', () => {
    const min = -(2n ** 63n)
    const max = 2n ** 63n - 1n
    expect(LOCK_KEY >= min && LOCK_KEY <= max).toBe(true)
  })
})
