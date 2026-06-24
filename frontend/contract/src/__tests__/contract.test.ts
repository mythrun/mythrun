import { describe, it, expect } from 'vitest'
import { CONTRACT_PACKAGE } from '../index.js'

describe('@mythrun/contract', () => {
  it('exposes a stable package marker', () => {
    expect(CONTRACT_PACKAGE).toBe('mythrun-contract')
  })
})
