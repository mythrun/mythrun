// Shared route constants for the frame + billing surfaces. Module consts so
// paths are never JSX-attribute string literals (the i18n rule) and never
// drift across their three consumers (app-frame, checkout-return,
// checkout-cancelled — the 2026-07-30 spec's enumerated /settings callers).
export const HOME_PATH = '/home'
export const BILLING_PATH = '/billing'
export const BUY_ANCHOR = '#buy'
