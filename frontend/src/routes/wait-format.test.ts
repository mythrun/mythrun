import { describe, expect, it, beforeAll } from 'vitest'
import i18next, { type TFunction } from 'i18next'
import { resources, defaultNS } from '@mythrun/client-core/i18n'
import { coarseWaitTime } from './wait-format.ts'

// coarseWaitTime — the localized {{time}} fill for the shared waiting countdowns.
// Driven against a REAL i18next instance (the catalog is the contract) so a
// missing/renamed shared.wait.* key fails here, not silently in the UI.

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
  it('renders whole-minute buckets as "N min" (no ticking seconds)', () => {
    expect(coarseWaitTime({ kind: 'minutes', count: 1 }, t)).toBe('1 min')
    expect(coarseWaitTime({ kind: 'minutes', count: 2 }, t)).toBe('2 min')
    expect(coarseWaitTime({ kind: 'minutes', count: 9 }, t)).toBe('9 min')
  })

  it('renders the sub-minute bucket sentence-case as "Under a minute" (it leads the string)', () => {
    expect(coarseWaitTime({ kind: 'under-minute' }, t)).toBe('Under a minute')
  })

  it('drops into the surfaces\' "{{time}} remaining" wrappers coherently (sentence-case / digit-led)', () => {
    expect(t('worldGen.countdown', { time: coarseWaitTime({ kind: 'minutes', count: 2 }, t) })).toBe(
      '2 min remaining',
    )
    expect(
      t('characterCreate.loading.countdown', {
        time: coarseWaitTime({ kind: 'under-minute' }, t),
      }),
    ).toBe('Under a minute remaining')
  })
})
