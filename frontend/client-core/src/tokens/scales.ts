/**
 * Platform-neutral token scale DATA — the SINGLE SOURCE for the static
 * (non-theme-aware) design tokens from MYT-82 spec §4. The web design system
 * (@mythrun/ui) emits these into Tailwind's `@theme` (theme.css); the future
 * native impl emits the same values into NativeWind. Theme-AWARE semantic
 * tokens (focus/border-strong/surface tiers/status-intent) are NOT static
 * scales — they flip per theme and live in @mythrun/ui's semantic.css.
 *
 * Zero DOM, zero CSS: just typed data. theme.css hand-authors matching CSS
 * vars; a drift-guard test asserts the two never diverge.
 */

/** Spacing scale, 4px base. `--space-1..9`. */
export const SPACING = {
  1: '4px',
  2: '8px',
  3: '12px',
  4: '16px',
  5: '24px',
  6: '32px',
  7: '40px',
  8: '48px',
  9: '64px',
} as const

/** Corner radius — flat 1-bit register: sharp everywhere. `--radius`. */
export const RADIUS = {
  DEFAULT: '0px',
} as const

/** Control heights. md is the default; ≥44px hit-target padded on all controls. */
export const CONTROL = {
  sm: '32px',
  md: '40px',
  lg: '48px',
} as const

/** Icon sizes. Pixelarticons are vector (anti-aliased); crispest at 24/48. */
export const ICON = {
  sm: '16px',
  md: '20px',
  lg: '24px',
} as const

/** Semantic z-index scale. */
export const ZINDEX = {
  base: 0,
  nav: 10,
  dropdown: 1000,
  popover: 1100,
  overlay: 1200,
  modal: 1300,
  toast: 1400,
  tooltip: 1500,
} as const

/** Motion — durations + easings. Only opacity/fades animate; nothing slides. */
export const MOTION = {
  duration: {
    fast: '120ms',
    base: '200ms',
    slow: '360ms',
  },
  easing: {
    out: 'cubic-bezier(0.2, 0, 0, 1)',
    linear: 'linear',
  },
} as const

/**
 * Typography roles — the brand's narrative-serif / machine-mono split.
 * `font`: 'serif' → --font-body, 'mono' → --font-ui. Values reference the
 * type-size / weight / tracking scales below.
 */
export const TYPE_ROLES = {
  display: { font: 'serif', size: '2.25rem', weight: 600, lineHeight: 1.2 },
  heading: { font: 'serif', size: '1.25rem', weight: 600, lineHeight: 1.3 },
  title: { font: 'serif', size: '1.125rem', weight: 600, lineHeight: 1.4 },
  'prose-body': { font: 'serif', size: '1rem', weight: 400, lineHeight: 1.6 },
  'ui-label': { font: 'mono', size: '0.875rem', weight: 500, transform: 'uppercase', tracking: '0.5px' },
  'ui-caption': { font: 'mono', size: '0.75rem', weight: 500 },
  data: { font: 'mono', size: '0.875rem', weight: 400 },
} as const

/** Font weights. `--weight-normal/medium/semibold`. */
export const WEIGHTS = {
  normal: 400,
  medium: 500,
  semibold: 600,
} as const

/** Letter-spacing. `--tracking-normal/wide`. */
export const TRACKING = {
  normal: '0',
  wide: '0.5px',
} as const

/** Serif prose column width. `--measure`. */
export const MEASURE = {
  DEFAULT: '64ch',
} as const

/** Tailwind default breakpoints — RTL/responsive layout via logical properties. */
export const BREAKPOINTS = {
  sm: '640px',
  md: '768px',
  lg: '1024px',
  xl: '1280px',
  '2xl': '1536px',
} as const
