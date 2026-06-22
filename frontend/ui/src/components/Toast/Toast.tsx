import { useSyncExternalStore } from 'react'
import { Toast as RadixToast } from 'radix-ui'
import type { ToastProviderProps, Severity, IconName } from '@mythrun/client-core/contract'
import { cn } from '../../lib/cn.ts'
import { Icon } from '../Icon/Icon.tsx'
import { IconButton } from '../IconButton/IconButton.tsx'
import { toastStore, dismissToast, configureToasts, type ToastEntry } from './toast-store.ts'

// Toast subsystem — a TRANSIENT, app-global notification surface. The web impl
// wraps Radix `Toast`: the Provider renders an off-screen ANNOUNCER live region
// the instant it mounts (so a toast appended later announces into a region that
// ALREADY EXISTS — the #1 toast a11y bug avoided), and a positioned `Toast.Viewport`
// (`--z-toast`) holds the visible stack. Radix owns per-toast auto-dismiss
// (`duration` → `onOpenChange(false)`), keyboard focus (F8 to the viewport), and
// swipe-to-dismiss; OUR store owns the imperative `toast()` API, the dedupe
// window, and the max-visible cap.
//
// Motion (§4): the enter/leave is OPACITY-ONLY (`data-[state]` opacity classes),
// never slide/scale. Under `prefers-reduced-motion` the base.css reset neutralizes
// the transition; because the resting state is opacity-100 the toast still appears,
// and Radix still removes it on close — so reduced motion never strands a toast.
//
// Flat 1-bit register (§3): each toast sits on the `--surface-raised` tier with a
// 1px `--border-{severity}` edge, 0px radius, NO shadow — depth on the border, not
// elevation. §4 status-intent: the SEVERITY COLOR carries the ICON only
// (`text-text-{severity}`); the title + description are `--ink`.

interface SeverityStyle {
  readonly icon: IconName
  readonly tint: string
  readonly border: string
}

const SEVERITY: Record<Severity, SeverityStyle> = {
  success: { icon: 'check', tint: 'text-text-success', border: 'border-border-success' },
  info: { icon: 'info', tint: 'text-text-info', border: 'border-border-info' },
  warning: { icon: 'warning-diamond', tint: 'text-text-warning', border: 'border-border-warning' },
  danger: { icon: 'square-alert', tint: 'text-text-danger', border: 'border-border-danger' },
}

// One queued toast as a Radix `Toast.Root`. `onOpenChange(false)` (auto-dismiss,
// swipe, or the close button) removes it from the store. `type` maps severity to
// the announcement urgency: warning/danger → foreground (assertive), the rest →
// background (polite).
function ToastRow({ entry, closeLabel }: { entry: ToastEntry; closeLabel: string | undefined }): React.JSX.Element {
  const { severity = 'info', title, description, duration } = entry.options
  const s = SEVERITY[severity]
  const urgent = severity === 'warning' || severity === 'danger'
  return (
    <RadixToast.Root
      type={urgent ? 'foreground' : 'background'}
      {...(duration !== undefined ? { duration } : {})}
      onOpenChange={(open) => {
        if (!open) dismissToast(entry.id)
      }}
      className={cn(
        'flex items-start gap-[var(--space-3)] p-[var(--space-3)]',
        'rounded-none border bg-surface-raised font-ui text-sm',
        // Opacity-only enter/leave (§4 motion rule) — no slide/scale.
        'transition-opacity data-[state=open]:opacity-100 data-[state=closed]:opacity-0',
        s.border,
      )}
    >
      {/* The severity glyph — the ONLY element tinted with the status color. */}
      <span className={cn('mt-[2px] inline-flex shrink-0', s.tint)}>
        <Icon name={s.icon} size="sm" decorative />
      </span>

      {/* Title + optional description, both --ink (NOT the status token), per §4. */}
      <div className="flex min-w-0 flex-1 flex-col gap-[var(--space-1)]">
        <RadixToast.Title className="font-semibold text-ink">{title}</RadixToast.Title>
        {description !== undefined ? (
          <RadixToast.Description className="text-ink">{description}</RadixToast.Description>
        ) : null}
      </div>

      {closeLabel !== undefined ? (
        <RadixToast.Close asChild>
          <IconButton icon="close" label={closeLabel} variant="ghost" size="sm" />
        </RadixToast.Close>
      ) : null}
    </RadixToast.Root>
  )
}

// Subscribe to the imperative store; React 18's `useSyncExternalStore` keeps the
// snapshot consistent (and tearing-free) across concurrent renders.
const subscribe = (cb: () => void): (() => void) => toastStore.subscribe(cb)
const getSnapshot = (): readonly ToastEntry[] => toastStore.getSnapshot()

/**
 * Mount ONCE near the app ROOT. Renders the Radix toast announcer + viewport and
 * the queued toasts. `closeLabel` (an i18n key) names each toast's close control;
 * `maxVisible` / `defaultDuration` tune the store + Radix timing.
 */
export function ToastProvider({
  closeLabel,
  maxVisible = 3,
  defaultDuration = 5000,
}: ToastProviderProps): React.JSX.Element {
  // Apply the cap to the store on the first render (idempotent — same values).
  configureToasts({ maxVisible })
  const entries = useSyncExternalStore(subscribe, getSnapshot)
  return (
    <RadixToast.Provider duration={defaultDuration} swipeDirection="right">
      {entries.map((entry) => (
        <ToastRow key={entry.id} entry={entry} closeLabel={closeLabel} />
      ))}
      {/* The viewport is the STANDING live region — it exists the moment the
          provider mounts, BEFORE any toast, so an appended toast announces into a
          region that already exists (the #1 toast a11y bug, avoided). `polite`
          here is the floor; Radix layers an `assertive` per-toast announcer on
          top for `foreground` (warning/danger) toasts. */}
      <RadixToast.Viewport
        aria-live="polite"
        aria-relevant="additions"
        className={cn(
          'fixed bottom-0 right-0 z-[var(--z-toast)] m-0 flex w-[min(92vw,24rem)] list-none flex-col',
          'gap-[var(--space-2)] p-[var(--space-4)] outline-none',
        )}
      />
    </RadixToast.Provider>
  )
}
