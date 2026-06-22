import type { IconName } from '@mythrun/client-core/contract'

// The GLYPH SOURCE — the one file that swaps when we change icon sets (today
// Pixelarticons MIT; a future Pixelarticons-Pro / Nucleo-Pixel swap touches only
// this map, per §5). Each glyph is the set of `<path d="…">` strings from the
// Pixelarticons 24-grid SVG (all are `viewBox="0 0 24 24"`), copied VERBATIM
// from `pixelarticons/svg/<name>.svg`. We store the raw path data rather than
// importing the package's per-icon React components because those hardcode
// `width/height="24"` and a fixed structure — owning the path data lets the
// `Icon` impl control sizing (token classes) and a11y (`fill`/`aria-*`) cleanly,
// while keeping the glyph SOURCE isolated to this single swappable module.
//
// The keys are exactly the closed `IconName` union — `Record<IconName, …>` makes
// adding an IconName without a glyph (or vice versa) a compile error.

/** Each glyph: the `viewBox` and the ordered `<path d>` data of its 24-grid SVG. */
export interface Glyph {
  readonly viewBox: string
  readonly paths: readonly string[]
}

const VIEWBOX_24 = '0 0 24 24'

export const GLYPHS: Record<IconName, Glyph> = {
  close: {
    viewBox: VIEWBOX_24,
    paths: [
      'M7 19H5V17H7V19ZM19 19H17V17H19V19ZM9 15V17H7V15H9ZM17 17H15V15H17V17ZM11 15H9V13H11V15ZM15 15H13V13H15V15ZM13 13H11V11H13V13ZM11 11H9V9H11V11ZM15 11H13V9H15V11ZM9 9H7V7H9V9ZM17 9H15V7H17V9ZM7 7H5V5H7V7ZM19 7H17V5H19V7Z',
    ],
  },
  'chevron-right': {
    viewBox: VIEWBOX_24,
    paths: ['M16 13v-2h-2v2h2Zm-2-2V9h-2v2h2Zm0 4v-2h-2v2h2Zm-2-6V7h-2v2h2Zm0 8v-2h-2v2h2ZM10 7V5H8v2h2Zm0 12v-2H8v2h2Z'],
  },
  'chevron-left': {
    viewBox: VIEWBOX_24,
    paths: ['M8 13v-2h2v2H8Zm2-2V9h2v2h-2Zm0 4v-2h2v2h-2Zm2-6V7h2v2h-2Zm0 8v-2h2v2h-2Zm2-10V5h2v2h-2Zm0 12v-2h2v2h-2Z'],
  },
  'chevron-down': {
    viewBox: VIEWBOX_24,
    paths: ['M13 16h-2v-2h2v2Zm-2-2H9v-2h2v2Zm4 0h-2v-2h2v2Zm-6-2H7v-2h2v2Zm8 0h-2v-2h2v2ZM7 10H5V8h2v2Zm12 0h-2V8h2v2Z'],
  },
  'arrow-left': {
    viewBox: VIEWBOX_24,
    paths: [
      'M20 11v2H4v-2zM8 13v2H6v-2zm2 2v2H8v-2zm2 2v2h-2v-2zm-4-6V9H6v2z',
      'M10 15V7H8v8zm2 2V5h-2v12z',
    ],
  },
  'arrow-right': {
    viewBox: VIEWBOX_24,
    paths: [
      'M4 11v2h16v-2zm12 2v2h2v-2zm-2 2v2h2v-2zm-2 2v2h2v-2zm4-6V9h2v2z',
      'M14 15V7h2v8zm-2 2V5h2v12z',
    ],
  },
  plus: {
    viewBox: VIEWBOX_24,
    paths: ['M13 11h7v2h-7v7h-2v-7H4v-2h7V4h2v7Z'],
  },
  minus: {
    viewBox: VIEWBOX_24,
    paths: ['M4 11h16v2H4z'],
  },
  check: {
    viewBox: VIEWBOX_24,
    paths: ['M10 18H8v-2h2v2Zm-2-2H6v-2h2v2Zm4-2v2h-2v-2h2Zm-6 0H4v-2h2v2Zm8 0h-2v-2h2v2Zm2-2h-2v-2h2v2Zm2-2h-2V8h2v2Zm2-2h-2V6h2v2Z'],
  },
  menu: {
    viewBox: VIEWBOX_24,
    paths: ['M20 18H4v-2h16v2Zm0-5H4v-2h16v2Zm0-5H4V6h16v2Z'],
  },
  search: {
    viewBox: VIEWBOX_24,
    paths: ['M22 22h-2v-2h2v2Zm-2-2h-2v-2h2v2Zm-6-2H6v-2h8v2Zm4 0h-2v-2h2v2ZM6 16H4v-2h2v2Zm10 0h-2v-2h2v2ZM4 14H2V6h2v8Zm14 0h-2V6h2v8ZM6 6H4V4h2v2Zm10 0h-2V4h2v2Zm-2-2H6V2h8v2Z'],
  },
  'external-link': {
    viewBox: VIEWBOX_24,
    paths: [
      'M11 5H5v2h6V5ZM5 7H3v12h2V7Zm12 12H5v2h12v-2Zm2-6h-2v6h2v-6Zm-8 0H9v2h2v-2Zm2-2h-2v2h2v-2Zm2-2h-2v2h2V9Zm2-2h-2v2h2V7Zm2-2h-2v2h2V5Zm2-2h-2v8h2V3Z',
      'M21 3h-8v2h8V3Z',
    ],
  },
  // Status-intent severity glyphs (MYT-82 W3c). `info` = info-box, `warning-diamond`
  // = warning, `square-alert` = danger. Success reuses `check` (above). Path data
  // copied VERBATIM from pixelarticons/svg/<name>.svg (all viewBox="0 0 24 24").
  info: {
    viewBox: VIEWBOX_24,
    paths: ['M4 2h16v2H4zm0 18h16v2H4zM2 4h2v16H2zm18 0h2v16h-2zm-9 5h2V7h-2zm0 8h2v-6h-2z'],
  },
  'warning-diamond': {
    viewBox: VIEWBOX_24,
    paths: [
      'M2 10h2v2H2zm0 4h2v-2H2zm20-4h-2v2h2zm0 4h-2v-2h2zM4 8h2v2H4zm0 8h2v-2H4zm16-8h-2v2h2zm0 8h-2v-2h2zM6 6h2v2H6zm0 12h2v-2H6zM18 6h-2v2h2zm0 12h-2v-2h2zM8 4h2v2H8zm0 16h2v-2H8zm8-16h-2v2h2zm0 16h-2v-2h2zM10 2h2v2h-2zm0 20h2v-2h-2zm4-20h-2v2h2zm0 20h-2v-2h2zm-3-5h2v-2h-2zm0-4h2V7h-2z',
    ],
  },
  'square-alert': {
    viewBox: VIEWBOX_24,
    paths: ['M4 2h16v2H4zm0 18h16v2H4zM20 4h2v16h-2zM2 4h2v16H2zm9 2h2v8h-2zm0 10h2v2h-2z'],
  },
}
