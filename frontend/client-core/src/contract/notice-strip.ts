import type { BaseProps } from './index.ts'

/**
 * The sitewide outage notice strip (outage-resilience design §4.2): a slim,
 * full-width quiet prose line under the sticky bar — paper register, `chrome`
 * type role, hairline `--border` top edge, no icons/dots/chips, no dismiss.
 *
 * The host is a PERMANENTLY-MOUNTED `role="status"` live region: a status node
 * inserted into the DOM already populated is unreliably announced, so the
 * consumer (AppFrame) always renders the strip and `message` toggles its
 * CONTENT. `null`/empty collapses it visually (the text and its edge + inset
 * classes drop, leaving zero height) WITHOUT display:none on the host — the
 * live region never leaves the DOM or the accessibility tree.
 */
export interface NoticeStripProps extends Omit<BaseProps, 'children'> {
  /** The notice line (consumer-resolved i18n copy). `null`/empty = collapsed. */
  message: string | null
}
