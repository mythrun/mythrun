import { useEffect, useRef, useState } from 'react'
import { Dialog as RadixDialog } from 'radix-ui'
import type { DrawerProps } from '@mythrun/client-core/contract'
import { cn } from '../../lib/cn.ts'
import { Icon } from '../Icon/Icon.tsx'

// Drawer — the edge-handle side sheet (MYT-89 Phase D). A full-width paper
// sheet that slides in from the right, summoned/dismissed by a HANDLE pinned at
// the right edge of the viewport (same spot in both states: ‹ summon, › dismiss).
//
// MOUNT-PERSISTENCE is the headline contract: children keep their React state
// (and their DOM — scroll positions, canvas bitmaps) across close→open. The
// wiki inside the mobile reveal (D3/D5) rides on this. So the sheet NEVER
// unmounts — `Portal forceMount` keeps it in the DOM and the open/close motion
// is a pure transform (`data-[state=closed]:translate-x-full`), with `inert`
// removing the closed sheet from the a11y tree and the tab order. Under
// reduced motion the base.css reset collapses the transition to its end states.
//
// Radix Dialog supplies the skeleton like Modal, but forceMount changes which
// of its behaviors still fire, so this component fills the gaps deliberately:
//   • `modal={false}` is REQUIRED, not a choice. Radix's modal variant runs
//     `hideOthers` + scroll-lock on MOUNT (not on open) — under forceMount that
//     would aria-hide and pointer-block the whole app while the drawer is
//     closed. Non-modal skips both; Tab containment while open comes from
//     FocusScope's `loop` (wraps at the sheet's edges), and the full-width
//     sheet + scrim covers the pointer path.
//   • FocusScope's mount-autofocus fires at page load (mount ≠ open), so it is
//     suppressed (`onOpenAutoFocus` preventDefault) and focus-IN is driven by
//     an effect on the open edge; focus-RESTORE (never fired — no unmount)
//     is driven by the close edge, returning focus to the handle.
//   • DismissableLayer stays mounted while closed, so its Esc/outside-click
//     dismissal is suppressed there — no spurious onOpenChange(false).
//   • The closed sheet keeps `role="dialog"` off the a11y tree: `role="none"`
//     while closed (belt to inert's braces), Radix's `dialog` while open.
//
// The handle is Radix `Dialog.Trigger` (asChild): native toggle, aria-expanded/
// aria-controls wiring, and Radix's trigger-exemption from outside-dismiss (a
// click on it while open closes ONCE instead of dismiss-then-reopen). Visuals
// follow the flat 1-bit register: square paper tab, 1px `--border-strong` edge,
// 0px radius, no shadow; sheet on `--surface-overlay` at `--z-modal` over the
// `--scrim` veil at `--z-overlay`, exactly Modal's layering.
// Focus choreography on the open/close EDGES — the pieces Radix ties to
// mount/unmount, re-driven from the resolved open state (under forceMount the
// content never mounts/unmounts, so Radix's own never fire).
function useEdgeFocus(
  open: boolean,
  contentRef: React.RefObject<HTMLDivElement | null>,
  handleRef: React.RefObject<HTMLButtonElement | null>,
) {
  const prevOpenRef = useRef(open)
  useEffect(() => {
    const prev = prevOpenRef.current
    prevOpenRef.current = open
    if (open === prev) return
    if (open) {
      // Focus IN: the content div carries FocusScope's tabIndex=-1. Focusing
      // the sheet itself (not its first control) announces the dialog + title.
      contentRef.current?.focus()
    } else {
      // Focus RESTORE: only when close stranded focus inside the now-inert
      // sheet (Esc) or the browser already dropped it to body (inert applied
      // before this effect ran). A close whose interaction focused something
      // else (clicking the handle) keeps that focus.
      const active = document.activeElement
      if (active === null || active === document.body || contentRef.current?.contains(active) === true) {
        handleRef.current?.focus()
      }
    }
  }, [open, contentRef, handleRef])
}

// The sheet: full-width paper at the modal tier, hidden by a pure transform
// (never display/unmount — the mount-persistence contract) with a hard 1px
// left edge. base.css collapses the transition under reduced motion.
const SHEET_CLASS = cn(
  'fixed inset-y-0 right-0 z-[var(--z-modal)] w-full',
  'flex flex-col',
  'rounded-none border-l border-border-strong bg-surface-overlay text-ink font-ui',
  'transition-transform duration-[var(--duration-base)] ease-out',
  'data-[state=open]:translate-x-0 data-[state=closed]:translate-x-full',
  'focus:outline-none',
)

// The handle: a square paper tab pinned at the right edge, vertically centered
// — border on the three exposed sides (the viewport edge is the fourth), inset
// focus ring (an offset ring would clip at the viewport edge). ≥44px hit-target
// (§4) on touch only, like IconButton — height (64px) already clears it, width
// floors up on coarse pointers.
const HANDLE_CLASS = cn(
  'fixed right-0 top-1/2 z-[var(--z-modal)] -translate-y-1/2',
  'flex items-center justify-center',
  'h-[var(--space-9)] w-[var(--space-6)] pointer-coarse:min-w-[44px]',
  'rounded-none border-y border-l border-border-strong bg-surface-overlay text-ink',
  'cursor-pointer select-none hover:bg-surface-hover active:bg-surface-active',
  'focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-accent-fg',
)

export function Drawer({
  title,
  description,
  openLabel,
  closeLabel,
  open,
  defaultOpen,
  onOpenChange,
  children,
  'data-testid': dataTestId,
}: DrawerProps) {
  // Mirror the open state (controlled or uncontrolled) because the handle
  // glyph/label, inert, and the focus effects all need the RESOLVED value —
  // Radix keeps its own resolution internal. Root is then always controlled.
  const isControlled = open !== undefined
  const [uncontrolledOpen, setUncontrolledOpen] = useState(defaultOpen ?? false)
  const resolvedOpen = isControlled ? open : uncontrolledOpen
  const handleOpenChange = (next: boolean) => {
    if (!isControlled) setUncontrolledOpen(next)
    onOpenChange?.(next)
  }

  const contentRef = useRef<HTMLDivElement>(null)
  const handleRef = useRef<HTMLButtonElement>(null)
  useEdgeFocus(resolvedOpen, contentRef, handleRef)

  return (
    <RadixDialog.Root modal={false} open={resolvedOpen} onOpenChange={handleOpenChange}>
      {/* forceMount on the Portal keeps every layer mounted across open/close —
          the mount-persistence contract. Children inherit it. */}
      <RadixDialog.Portal forceMount>
        {/* Scrim — the dimming veil while open (Modal's convention; flat, no
            fade). A click on it is an outside-pointerdown → Radix dismisses.
            Stateless, so plain display-toggling is fine. */}
        <div
          data-mythrun-scrim=""
          aria-hidden="true"
          className={cn('fixed inset-0 z-[var(--z-overlay)] bg-scrim', !resolvedOpen && 'hidden')}
        />
        <RadixDialog.Content
          ref={contentRef}
          {...(dataTestId !== undefined ? { 'data-testid': dataTestId } : {})}
          {...(resolvedOpen ? {} : { role: 'none' })}
          inert={!resolvedOpen}
          onOpenAutoFocus={(e: Event) => {
            // Fires on MOUNT (page load, under forceMount), not on open —
            // suppressed; the effect above owns focus-in.
            e.preventDefault()
          }}
          onEscapeKeyDown={(e: KeyboardEvent) => {
            if (!resolvedOpen) e.preventDefault()
          }}
          onInteractOutside={(e: Event) => {
            if (!resolvedOpen) e.preventDefault()
          }}
          className={SHEET_CLASS}
        >
          <div className="flex shrink-0 flex-col gap-[var(--space-1)] border-b border-border-strong p-[var(--space-4)]">
            <RadixDialog.Title className="font-body text-lg font-semibold leading-[1.4] text-ink">
              {title}
            </RadixDialog.Title>
            {description !== undefined ? (
              <RadixDialog.Description className="text-sm text-ink-secondary">
                {description}
              </RadixDialog.Description>
            ) : null}
          </div>
          {/* The body owns the scrolling (not the sheet), so the header stays
              put and the children's scroll position survives close→open. */}
          <div className="min-h-0 flex-1 overflow-y-auto p-[var(--space-4)]">{children}</div>
        </RadixDialog.Content>
        {/* The handle — AFTER the sheet in DOM order so it paints on top at the
            same z tier. Pinned at the right edge, vertically centered, in BOTH
            states. */}
        <RadixDialog.Trigger asChild>
          <button
            ref={handleRef}
            type="button"
            aria-label={resolvedOpen ? closeLabel : openLabel}
            className={HANDLE_CLASS}
          >
            <Icon name={resolvedOpen ? 'chevron-right' : 'chevron-left'} size="sm" decorative />
          </button>
        </RadixDialog.Trigger>
      </RadixDialog.Portal>
    </RadixDialog.Root>
  )
}
