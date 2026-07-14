import { describe, it, expect } from 'vitest'
import { LookupKeySchema } from '@mythrun/contract/rest'
import { LOOKUP_KEYS } from '../lookup-keys.js'

// MYT-95 drift pin (controller decision, plan ambiguity 6). The frontend billing
// screens key their SKU/tier logic off `@mythrun/contract` LookupKeySchema; the
// backend keys its Stripe wiring off billing/lookup-keys.ts LOOKUP_KEYS. These
// are two hand-maintained lists of the SAME closed set. This test couples them:
// a key added on EITHER side (a new tier/pack) fails HERE instead of drifting
// silently into a runtime mismatch (a contract enum that rejects a real backend
// lookup_key, or vice-versa).
//
// `.options` is the ZodEnum's value array; `Object.keys(LOOKUP_KEYS)` is the
// backend set (every LOOKUP_KEYS map key equals its own `.lookupKey`, pinned by
// lookup-keys.test.ts).
describe('LookupKeySchema mirrors the backend LOOKUP_KEYS set (drift pin)', () => {
  it('contract enum options === backend lookup keys (set equality, both directions)', () => {
    const contractKeys = new Set<string>(LookupKeySchema.options)
    const backendKeys = new Set<string>(Object.keys(LOOKUP_KEYS))
    expect(contractKeys).toEqual(backendKeys)
  })
})
