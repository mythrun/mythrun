import common from './locales/en/common.json'

// The i18n catalog lives in the client brain (R1, MYT-83): client-core owns the
// resources + the typed-keys augmentation (i18next.d.ts in @mythrun/web imports
// these for CustomTypeOptions). @mythrun/web owns only the runtime init binding
// (react-i18next + i18n.init). `as const` is load-bearing: it narrows the keys
// to literals so the augmentation can type i18n.t().
export const resources = { en: { common } } as const
export const defaultNS = 'common'
