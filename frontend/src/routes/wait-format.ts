import type { TFunction } from 'i18next'
import type { WaitBucket } from '@mythrun/client-core'

// The web-layer copy resolver for the shared waiting display (MYT-102 loading
// revamp). The client-core brain (`waitDisplay` / `coarseWaitBucket`) owns the
// timing + the coarse bucket; this owns the ONE piece it can't (the localized
// {{time}} fill), so both waiting surfaces — the world-gen loading screen /
// status card and the character-creation beat — read the same coarse copy. Each
// surface still wraps the fill in its OWN "{{time}} remaining" key (worldGen.
// countdown / characterCreate.loading.countdown), keeping those literal keys at
// the call site for the typed catalog.

/**
 * Resolve a coarse remaining-wait bucket to its localized `{{time}}` fill:
 * `minutes` → "N min" (`shared.wait.minutes`), `under-minute` → "under a minute"
 * (`shared.wait.underMinute`). Deliberately minute-granular — a ticking `0:24`
 * reads as false precision; a coarse label that changes about once a minute reads
 * as an honest expectation.
 */
export function coarseWaitTime(bucket: WaitBucket, t: TFunction): string {
  return bucket.kind === 'minutes'
    ? t('shared.wait.minutes', { count: bucket.count })
    : t('shared.wait.underMinute')
}
