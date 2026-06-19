import { i18n } from './config.ts'

// Compile-time typed-keys guard. With the i18next CustomTypeOptions
// augmentation engaged, an unknown key is a type error, so @ts-expect-error
// consumes it and `pnpm typecheck` passes. If typed keys regress (keys widen to
// `string`), the call is valid → the directive is UNUSED → ts(2578) →
// typecheck FAILS loudly. This file is typechecked (under src/**) but never
// imported, so it has no runtime effect.
// @ts-expect-error -- unknown i18n key must be rejected by the typed-keys augmentation
void i18n.t('definitely.not.a.key')
void i18n.t('back')
