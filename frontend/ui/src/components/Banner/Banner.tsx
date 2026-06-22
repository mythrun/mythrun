import { forwardRef } from 'react'
import type { BannerProps, Severity, IconName } from '@mythrun/client-core/contract'
import { cn } from '../../lib/cn.ts'
import { Icon } from '../Icon/Icon.tsx'
import { IconButton } from '../IconButton/IconButton.tsx'

// Banner — an INLINE, PERSISTENT status message that sits in the document flow.
// Flat 1-bit register (§3): `rounded-none`, a 1px `--border-{severity}` edge over
// a faint `--surface-{severity}` tint, NO shadow — the intent rides the border +
// the tinted panel, not elevation.
//
// §4 status-intent (the load-bearing rule): the SEVERITY COLOR carries the ICON
// only (`text-text-{severity}`). BODY TEXT is always `--ink` — coloring body copy
// with the status token fails AA on the light tint, the exact thing §4 avoids.
//
// a11y: the severity drives the ANNOUNCEMENT urgency — success/info are advisory
// (`role="status"`, a polite live region), warning/danger are urgent
// (`role="alert"`, assertive). The glyph is DECORATIVE (the role + text carry the
// meaning). `dismissible` renders a labelled IconButton (never a nameless close).

// Per-severity token classes (full literals so Tailwind v4's source scanner
// generates them). `icon` is the glyph name; `tint` the status text token the
// icon is colored with; `border`/`surface` the panel edge + faint fill.
interface SeverityStyle {
  readonly role: 'status' | 'alert'
  readonly icon: IconName
  readonly tint: string
  readonly border: string
  readonly surface: string
}

const SEVERITY: Record<Severity, SeverityStyle> = {
  success: {
    role: 'status',
    icon: 'check',
    tint: 'text-text-success',
    border: 'border-border-success',
    surface: 'bg-surface-success',
  },
  info: {
    role: 'status',
    icon: 'info',
    tint: 'text-text-info',
    border: 'border-border-info',
    surface: 'bg-surface-info',
  },
  warning: {
    role: 'alert',
    icon: 'warning-diamond',
    tint: 'text-text-warning',
    border: 'border-border-warning',
    surface: 'bg-surface-warning',
  },
  danger: {
    role: 'alert',
    icon: 'square-alert',
    tint: 'text-text-danger',
    border: 'border-border-danger',
    surface: 'bg-surface-danger',
  },
}

export const Banner = forwardRef<HTMLDivElement, BannerProps>(function Banner(
  { severity, title, children, dismissible = false, dismissLabel, onDismiss, 'data-testid': dataTestId },
  ref,
) {
  const s = SEVERITY[severity]
  return (
    <div
      ref={ref}
      role={s.role}
      {...(dataTestId !== undefined ? { 'data-testid': dataTestId } : {})}
      className={cn(
        'flex items-start gap-[var(--space-3)] p-[var(--space-3)]',
        'rounded-none border font-ui text-sm',
        s.border,
        s.surface,
      )}
    >
      {/* The severity glyph — the ONLY element tinted with the status color. */}
      <span className={cn('mt-[2px] inline-flex shrink-0', s.tint)}>
        <Icon name={s.icon} size="sm" decorative />
      </span>

      {/* Title + body. Body text is --ink (NOT the status token), per §4. */}
      <div className="flex min-w-0 flex-1 flex-col gap-[var(--space-1)]">
        {title !== undefined ? <p className="font-semibold text-ink">{title}</p> : null}
        <div className="text-ink">{children}</div>
      </div>

      {dismissible ? (
        <IconButton
          icon="close"
          label={dismissLabel ?? ''}
          variant="ghost"
          size="sm"
          {...(onDismiss ? { onPress: onDismiss } : {})}
        />
      ) : null}
    </div>
  )
})
