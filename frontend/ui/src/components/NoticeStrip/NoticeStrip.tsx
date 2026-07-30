import { forwardRef } from 'react'
import type { NoticeStripProps } from '@mythrun/client-core/contract'
import { TYPE_ROLE_CLASS } from '../../lib/typography.ts'
import { cn } from '../../lib/cn.ts'

// NoticeStrip — the sitewide outage notice (outage-resilience design §4.2): a
// slim full-width quiet prose strip under the sticky bar. Chrome type role,
// secondary ink (quiet, never a status color), hairline --border top edge over
// the frame's --surface ground; no icons/dots/chips, no dismiss — the state is
// prose.
//
// The host is a PERMANENTLY-MOUNTED role="status" live region: a status node
// inserted already populated is unreliably announced, so the host always
// renders and `message` toggles its content. Collapse = the text and its
// edge/inset classes drop (intrinsic zero height) — NEVER display:none or an
// unmount, either of which would evict the live region from the accessibility
// tree and lose the ok→degraded announcement.
export const NoticeStrip = forwardRef<HTMLDivElement, NoticeStripProps>(function NoticeStrip(
  { message, 'data-testid': dataTestId },
  ref,
) {
  const populated = message !== null && message !== ''
  return (
    <div
      ref={ref}
      role="status"
      {...(dataTestId !== undefined ? { 'data-testid': dataTestId } : {})}
      className={cn(
        'w-full bg-surface text-ink-secondary',
        TYPE_ROLE_CLASS.chrome,
        // Gutter-aligned with StickyBar's --space-6; the edge + inset classes
        // ride WITH the message so the collapsed host holds zero height (an
        // always-on border-t would paint a stray hairline under the bar).
        populated && 'border-t border-border px-[var(--space-6)] py-[var(--space-2)]',
      )}
    >
      {populated ? message : null}
    </div>
  )
})
