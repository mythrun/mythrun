import { describe, it, expect } from 'vitest'
import { resources, defaultNS } from './resources.ts'
import { descriptions } from './descriptions.ts'

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

interface CatalogNode {
  readonly [key: string]: string | CatalogNode
}

// Flatten the catalog to its dotted leaf-key paths (frame.credits, …).
function leafKeys(node: CatalogNode, prefix = ''): string[] {
  return Object.entries(node).flatMap(([key, value]) => {
    const path = prefix ? `${prefix}.${key}` : key
    return typeof value === 'string' ? [path] : leafKeys(value, path)
  })
}

describe('i18n key descriptions', () => {
  // descriptions.ts is authoring context (not shipped) — this asserts it stays
  // in lockstep with the catalog so every key is documented and none dangles.
  it('documents every catalog key exactly once — no missing, no orphans', () => {
    const catalogKeys = leafKeys(resources.en.common).sort()
    const describedKeys = Object.keys(descriptions).sort()
    expect(describedKeys).toEqual(catalogKeys)
  })

  it('includes the landing keys with descriptions', () => {
    const described = new Set(Object.keys(descriptions))
    for (const k of [
      'landing.title',
      'landing.tagline',
      'landing.cta',
      'landing.pricing',
      'landing.legal',
      'landing.signin',
      'landing.wordmark',
      'theme.toLight',
      'theme.toDark',
    ]) {
      expect(described.has(k)).toBe(true)
    }
  })
})
