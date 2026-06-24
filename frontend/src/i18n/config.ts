import i18n from 'i18next'
import { initReactI18next } from 'react-i18next'
import { resources, defaultNS } from '@mythrun/client-core/i18n'

// Synchronous init — load-bearing on TWO conditions: NO init callback (a
// callback re-triggers i18next's constructor setTimeout deferral) and inline
// `resources` (so init runs load() synchronously and sets isInitialized before
// returning). Together → useTranslation()'s `ready` is true on first render, so
// the useSuspense:true default never throws and there is no flash-of-keys. DO
// NOT add an init callback or an async backend without a <Suspense> boundary.
void i18n.use(initReactI18next).init({
  lng: 'en',
  fallbackLng: 'en',
  ns: ['common'],
  defaultNS,
  resources,
  returnNull: false,
  returnEmptyString: false,
  interpolation: { escapeValue: false },
})

export { i18n }
