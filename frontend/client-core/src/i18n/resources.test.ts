import { describe, it, expect } from 'vitest'
import i18next from 'i18next'
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

// Collect every string leaf VALUE (not key) in the catalog.
function leafValues(node: CatalogNode): string[] {
  return Object.values(node).flatMap((value) =>
    typeof value === 'string' ? [value] : leafValues(value),
  )
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

describe('i18n catalog copy completeness', () => {
  // The placeholder era is over (MYT-100): every authorable key now carries real
  // copy. This is the durable guarantee that replaces the old unwritten-copy
  // stub convention — any leaf value still opening with the bracketed marker
  // prefix below fails the build.
  it('holds no placeholder values anywhere in the catalog', () => {
    const offenders = leafValues(resources.en.common).filter((v) => v.startsWith('[ph'))
    expect(offenders).toEqual([])
  })
})

describe('i18n shared consolidation aliases', () => {
  // The shared.* subtree collapses the site's repeated strings (retry, low
  // credits, entity group/type labels, wiki chrome) into one source each; the
  // old call-site keys survive as i18next `$t(shared.…)` nesting aliases so no
  // component changed. This asserts the nesting syntax actually resolves at
  // runtime (not just that the JSON looks right).
  it('resolves $t() aliases to their shared source strings', async () => {
    const i18n = i18next.createInstance()
    await i18n.init({
      lng: 'en',
      fallbackLng: 'en',
      ns: ['common'],
      defaultNS,
      resources,
      returnNull: false,
      returnEmptyString: false,
      interpolation: { escapeValue: false },
    })

    // A flat alias resolves to (and equals) its shared source.
    expect(i18n.t('shared.lowCredits')).toBe('Low on session credits. Top up to dive back in.')
    expect(i18n.t('home.card.lowCredits')).toBe(i18n.t('shared.lowCredits'))
    expect(i18n.t('campaignNew.guided.credits')).toBe(i18n.t('shared.lowCredits'))

    // A nested-subtree alias (entityGroup) resolves — proves keySeparator + the
    // shared.* nesting depth both work.
    expect(i18n.t('shared.entityGroup.faction')).toBe('Factions')
    expect(i18n.t('worldReveal.group.faction')).toBe(i18n.t('shared.entityGroup.faction'))
    expect(i18n.t('play.knowledge.wiki.group.faction')).toBe(i18n.t('shared.entityGroup.faction'))

    // The root `back` alias.
    expect(i18n.t('play.knowledge.wiki.back')).toBe(i18n.t('back'))
    expect(i18n.t('worldReveal.wikiBack')).toBe('Back')
  })
})
