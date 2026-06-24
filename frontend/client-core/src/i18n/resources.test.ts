import { describe, it, expect } from 'vitest'
import { resources, defaultNS } from './resources.ts'

// The i18n catalog lives in the client brain (R1): @mythrun/client-core owns
// the resources + the typed-keys augmentation; @mythrun/web owns only the
// runtime init binding. This test pins the contract web's config.ts consumes.

describe('client-core i18n resources', () => {
  it('exposes the common namespace with real chrome strings', () => {
    expect(resources.en.common.back).toBe('Back')
  })

  it('declares common as the default namespace', () => {
    expect(defaultNS).toBe('common')
  })
})
