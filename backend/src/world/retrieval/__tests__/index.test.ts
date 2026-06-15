// backend/src/world/retrieval/__tests__/index.test.ts
//
// MYT-71 — barrel smoke. Asserts the world/retrieval surface re-exports the four
// runtime entry points MYT-72/73 consume (createSearchResolvers, charactersKnownTo,
// factionTree, embedWorld). The result/dep types are compile-time only — `tsc`
// validates their re-exports; this test guards the value surface.

import { describe, it, expect } from 'vitest'
import * as retrieval from '../index.js'

describe('world/retrieval barrel (MYT-71)', () => {
  it('re-exports the resolver surface MYT-72/73 import', () => {
    expect(typeof retrieval.createSearchResolvers).toBe('function')
    expect(typeof retrieval.charactersKnownTo).toBe('function')
    expect(typeof retrieval.factionTree).toBe('function')
    expect(typeof retrieval.embedWorld).toBe('function')
  })
})
