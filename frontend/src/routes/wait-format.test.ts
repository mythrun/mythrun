import { describe, expect, it, beforeAll } from 'vitest'
import i18next, { type TFunction } from 'i18next'
import { resources, defaultNS } from '@mythrun/client-core/i18n'
import { coarseWaitTime } from './wait-format.ts'

// coarseWaitTime — the localized {{time}} fill for the shared waiting countdowns.
// Driven against a REAL i18next instance (the catalog is the contract) so a
// missing/renamed shared.wait.* key fails here, not silently in the UI.
//
// ux-run2 (myth-uz1bn): the countdown wrapper is "Ready in {{time}}", so the
// buckets are deliberately lowercase mid-sentence fragments ("about 2 min",
// "under a minute") — they never lead a string anymore.

let t: TFunction

beforeAll(async () => {
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
  t = i18n.t.bind(i18n)
})

describe('coarseWaitTime', () => {
  it('renders whole-minute buckets as "about N min" (no ticking seconds)', () => {
    expect(coarseWaitTime({ kind: 'minutes', count: 1 }, t)).toBe('about 1 min')
    expect(coarseWaitTime({ kind: 'minutes', count: 2 }, t)).toBe('about 2 min')
    expect(coarseWaitTime({ kind: 'minutes', count: 9 }, t)).toBe('about 9 min')
  })

  it('renders the sub-minute bucket as a lowercase mid-sentence fragment', () => {
    expect(coarseWaitTime({ kind: 'under-minute' }, t)).toBe('under a minute')
  })

  it('drops into the surfaces\' "Ready in {{time}}" wrappers coherently', () => {
    expect(t('worldGen.countdown', { time: coarseWaitTime({ kind: 'minutes', count: 2 }, t) })).toBe(
      'Ready in about 2 min',
    )
    expect(
      t('characterCreate.loading.countdown', {
        time: coarseWaitTime({ kind: 'under-minute' }, t),
      }),
    ).toBe('Ready in under a minute')
  })
})
