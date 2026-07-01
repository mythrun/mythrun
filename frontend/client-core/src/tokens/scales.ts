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
  // Italic, muted serif sub-line beneath a title (a work's subtitle / a card's
  // "world · creator"). `italic` + `tone: secondary` set the narrative-caption look.
  subtitle: { font: 'serif', size: '0.875rem', weight: 400, lineHeight: 1.4, italic: true, tone: 'secondary' },
  'ui-label': { font: 'mono', size: '0.875rem', weight: 500, transform: 'uppercase', tracking: '0.5px' },
  'ui-caption': { font: 'mono', size: '0.75rem', weight: 500 },
  data: { font: 'mono', size: '0.875rem', weight: 400 },
  // Quiet mono meta — a muted record/status line, smaller than `data` (the ink
  // ledger value). The card's foot record line, a timestamp, a count caption.
  meta: { font: 'mono', size: '0.75rem', weight: 400, tone: 'secondary' },
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

/**
 * The 12 curated avatar pigments — the "scribe's pigments". A HAND-CURATED brand
 * set (NOT generated from the OKLCH ramp like the semantic ramps), but still the
 * SINGLE token source: @mythrun/ui emits each as `--color-avatar-<name>` in the
 * web `@theme` (theme.css), which makes Tailwind generate the `bg-avatar-<name>`
 * utility the Avatar initials chip uses; a drift-guard test asserts theme.css ==
 * this record so the two can never diverge.
 *
 * Each pigment is muted + parchment-compatible, stays distinguishable from its
 * neighbors, does NOT collide with the status colors, and carries paper-50
 * (#F8F4EA) 16px-bold initials at ≥4.5:1 (WCAG AA, normal-size text). Contrast
 * ratios below are MEASURED with culori's `wcagContrast` against paper-50 and
 * cited inline so a future hue tweak can't silently regress below AA.
 *
 * `ochre` was DEEPENED from the proposed #8C7339 (only 4.13:1) to #82682E
 * (4.82:1, same ~86° hue) to clear the 4.5:1 floor; the rest cleared as proposed.
 */
export const AVATAR_COLORS = {
  ember: '#8A5A3C',     /* 5.30:1 on paper-50 */
  sienna: '#A05A45',    /* 4.73:1 on paper-50 */
  ochre: '#82682E',     /* 4.82:1 on paper-50 (deepened from #8C7339 = 4.13:1) */
  moss: '#62703C',      /* 4.90:1 on paper-50 */
  pine: '#41714D',      /* 5.18:1 on paper-50 */
  verdigris: '#3D6B60', /* 5.51:1 on paper-50 */
  lapis: '#46647E',     /* 5.65:1 on paper-50 */
  iris: '#5E5A86',      /* 5.82:1 on paper-50 */
  heather: '#6E4C62',   /* 6.65:1 on paper-50 */
  rose: '#9E4F64',      /* 5.09:1 on paper-50 */
  umber: '#5A4636',     /* 8.09:1 on paper-50 */
  slate: '#586470',     /* 5.51:1 on paper-50 */
} as const
