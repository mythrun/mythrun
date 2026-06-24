import 'i18next'
import type { defaultNS, resources } from '@mythrun/client-core/i18n'

declare module 'i18next' {
  interface CustomTypeOptions {
    defaultNS: typeof defaultNS
    resources: (typeof resources)['en']
    returnNull: false
  }
}
