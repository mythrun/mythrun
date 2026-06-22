import { describe, it, expect } from 'vitest'
import * as contract from './index.ts'

describe('contract barrel', () => {
  it('is importable and exports types only (no runtime values)', () => {
    expect(Object.keys(contract)).toHaveLength(0)
  })
})
