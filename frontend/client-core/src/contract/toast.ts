import type { BaseProps } from './index.ts'
import type { Severity } from './banner.ts'

/**
 * Toast — a TRANSIENT, app-global notification that appears in a fixed viewport
 * and auto-dismisses. Use it for ephemeral feedback ("Saved", "Copy failed") that
 * the user does not need to act on. For PERSISTENT, in-flow status use
 * {@link BannerProps Banner} instead.
 *
 * The public surface is IMPERATIVE: the app calls a `toast(options)` function
 * (exported from the UI impl, since it is a runtime value — this contract is
 * type-only) and a single {@link ToastProviderProps ToastProvider} mounted at the
 * app root renders the queue. The provider's viewport is a LIVE REGION that
 * exists BEFORE any toast (so appended toasts are announced).
 *
 * Platform-neutral (§9): `title`/`description` are i18n content, `duration` is a
 * number — no className/style/raw DOM types.
 */
export interface ToastOptions {
  /** Status intent — drives the glyph + token accent. Default `info`. */
  severity?: Severity
  /** The toast headline (an i18n key). REQUIRED — a toast is never anonymous. */
  title: string
  /** Optional secondary line (an i18n key). */
  description?: string
  /**
   * Milliseconds the toast stays before auto-dismiss. Omit for the provider
   * default (5s). The enter/leave is opacity-only (§4); reduced motion is honored
   * by the base reset, so the toast still appears/disappears.
   */
  duration?: number
}

/**
 * Provider for the {@link ToastOptions Toast} subsystem. Mount ONCE near the app
 * ROOT. It renders the Radix toast viewport (a positioned, `--z-toast` live
 * region) and subscribes to the imperative `toast()` store, rendering each queued
 * toast as a token-styled row. It owns the max-visible queue, the title+severity
 * dedupe window, and per-toast auto-dismiss.
 *
 * Platform-neutral wrapper — no DOM props beyond the optional `closeLabel` i18n
 * key (the accessible name for each toast's close control).
 */
export interface ToastProviderProps extends BaseProps {
  /** Accessible name (an i18n key) for each toast's close control. */
  closeLabel?: string
  /** Max toasts rendered at once (older ones drop off). Default 3. */
  maxVisible?: number
  /** Default auto-dismiss duration (ms) when an option omits `duration`. Default 5000. */
  defaultDuration?: number
}
