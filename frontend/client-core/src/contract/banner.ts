import type { BaseProps } from './index.ts'

/**
 * The four status intents shared by Banner and Toast (§4 status-intent). Each
 * maps to a `--surface-{severity}` / `--border-{severity}` / `--text-{severity}`
 * token triad and a severity glyph. The SEVERITY COLOR carries the icon + accent
 * only — body text always uses `--ink` (the §4 rule that keeps body copy AA on
 * the tinted panel).
 */
export type Severity = 'success' | 'warning' | 'danger' | 'info'

/**
 * Banner — an INLINE, PERSISTENT status message that sits in the document flow
 * (not a portal, not transient): a form-level error, a degraded-mode notice, a
 * success confirmation that stays until the user moves on. For TRANSIENT,
 * app-global notifications use {@link ToastOptions Toast} instead.
 *
 * a11y: success/info announce POLITELY (`role="status"`), warning/danger
 * ASSERTIVELY (`role="alert"`) — the severity drives the announcement urgency.
 * The severity glyph is decorative (the role + text carry the meaning).
 *
 * Platform-neutral (§9): `title`/`children` are i18n content, `onDismiss` is a
 * neutral callback — no className/style/raw DOM events.
 */
export interface BannerProps extends BaseProps {
  /** Status intent — drives the token triad, the glyph, and the ARIA role. */
  severity: Severity
  /** Optional bold lead line (an i18n key). Omit for a single-line banner. */
  title?: string
  /** Body content (i18n) — inherited from {@link BaseProps} as `children`. */
  children?: BaseProps['children']
  /** When true, render a labelled close control that calls `onDismiss`. */
  dismissible?: boolean
  /** Accessible name (an i18n key) for the dismiss control. Required when
   * `dismissible` so the close button is never nameless. */
  dismissLabel?: string
  /** Neutral activation callback fired when the dismiss control is pressed. */
  onDismiss?: () => void
}
