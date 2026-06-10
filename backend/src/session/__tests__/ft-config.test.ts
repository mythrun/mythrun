import { describe, expect, it } from 'vitest'

import { MAX_GOLD_TRANSACTION } from '../ft-config.js'

describe('ft-config', () => {
  it('caps a single gold credit/debit at the fat-finger shape guard', () => {
    expect(MAX_GOLD_TRANSACTION).toBe(100_000)
  })
})
