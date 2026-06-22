import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { render, screen, act } from '@testing-library/react'
import { axe } from 'jest-axe'
import { ToastProvider } from './Toast.tsx'
import { toast, toastStore, dismissToast, __resetToastStore } from './toast-store.ts'

// The Toast subsystem is IMPERATIVE: `toast(options)` pushes onto a module store;
// a single root <ToastProvider> renders the queue in a Radix live-region viewport.
// Driving it needs the provider mounted + act()/fake timers (the store update +
// the auto-dismiss timer both run outside React's event loop).

beforeEach(() => {
  __resetToastStore()
  vi.useFakeTimers()
})

afterEach(() => {
  // Flush any pending FAKE timers (no-op if a test already switched to real
  // timers), then restore real timers for the next test.
  if (vi.isFakeTimers()) {
    act(() => {
      vi.runOnlyPendingTimers()
    })
  }
  vi.useRealTimers()
})

// Render the provider; the viewport live region must exist BEFORE any toast.
function renderProvider(props?: { maxVisible?: number; defaultDuration?: number }) {
  return render(<ToastProvider closeLabel="action.dismiss" {...props} />)
}

describe('ToastProvider', () => {
  it('mounts a live region (aria-live) BEFORE any content — the #1 toast a11y bug', () => {
    renderProvider()
    // Radix renders an announcer live region as soon as the Provider mounts, even
    // with zero toasts. A toast appended later announces into THIS pre-existing
    // region. Assert at least one element carries aria-live up front.
    const live = document.querySelectorAll('[aria-live]')
    expect(live.length).toBeGreaterThan(0)
  })

  it('renders a toast appended via the imperative toast() call', () => {
    renderProvider()
    act(() => {
      toast({ severity: 'success', title: 'toast.saved', description: 'toast.saved.detail' })
    })
    expect(screen.getByText('toast.saved')).toBeInTheDocument()
    expect(screen.getByText('toast.saved.detail')).toBeInTheDocument()
    // The severity glyph is rendered (an svg inside the toast).
    const status = screen.getByText('toast.saved').closest('[role="status"], li')
    expect(status?.querySelector('svg')).not.toBeNull()
  })
})

describe('Toast subsystem requirements', () => {
  it('DEDUPE: identical title+severity within the window collapses to one toast', () => {
    renderProvider()
    act(() => {
      toast({ severity: 'info', title: 'toast.dupe' })
      toast({ severity: 'info', title: 'toast.dupe' })
      toast({ severity: 'info', title: 'toast.dupe' })
    })
    expect(screen.getAllByText('toast.dupe')).toHaveLength(1)
  })

  it('DEDUPE does not collapse a different severity with the same title', () => {
    renderProvider()
    act(() => {
      toast({ severity: 'info', title: 'toast.same' })
      toast({ severity: 'danger', title: 'toast.same' })
    })
    expect(screen.getAllByText('toast.same')).toHaveLength(2)
  })

  it('AUTO-DISMISS: a toast is removed after its duration (fake timers)', () => {
    renderProvider({ defaultDuration: 4000 })
    act(() => {
      toast({ severity: 'success', title: 'toast.ephemeral', duration: 3000 })
    })
    expect(screen.getByText('toast.ephemeral')).toBeInTheDocument()
    act(() => {
      vi.advanceTimersByTime(3500)
    })
    // Radix runs a short close animation after duration; flush remaining timers.
    act(() => {
      vi.runOnlyPendingTimers()
    })
    expect(screen.queryByText('toast.ephemeral')).not.toBeInTheDocument()
  })

  it('MAX-VISIBLE: only the configured number of toasts render at once', () => {
    renderProvider({ maxVisible: 2 })
    act(() => {
      toast({ severity: 'info', title: 'toast.a' })
      toast({ severity: 'info', title: 'toast.b' })
      toast({ severity: 'info', title: 'toast.c' })
    })
    // The cap is honored — the oldest drops off, newest kept.
    const items = screen.queryAllByRole('listitem')
    expect(items.length).toBeLessThanOrEqual(2)
    // The most-recent two are the ones kept.
    expect(screen.getByText('toast.c')).toBeInTheDocument()
    expect(screen.getByText('toast.b')).toBeInTheDocument()
    expect(screen.queryByText('toast.a')).not.toBeInTheDocument()
  })

  it('has no axe violations with a toast rendered', async () => {
    // axe awaits real microtask/timer ticks; fake timers would deadlock it. Run
    // this one assertion on real timers (the toast is appended synchronously).
    vi.useRealTimers()
    renderProvider()
    act(() => {
      toast({ severity: 'warning', title: 'toast.warn', description: 'toast.warn.detail' })
    })
    expect(await axe(document.body)).toHaveNoViolations()
  })
})

describe('toast-store (unit, no React)', () => {
  it('returns an id and dedupes the same title+severity', () => {
    // The pub/sub fires on every change — record each snapshot's title list.
    const seen: string[][] = []
    const unsub = toastStore.subscribe(() => {
      seen.push(toastStore.getSnapshot().map((t) => t.options.title))
    })
    const id1 = toast({ severity: 'info', title: 'k.x' })
    const id2 = toast({ severity: 'info', title: 'k.x' })
    expect(typeof id1).toBe('string')
    // Same key collapses — the second call returns the SAME id (no new toast).
    expect(id2).toBe(id1)
    // Exactly one entry in the store.
    expect(toastStore.getSnapshot().map((t) => t.options.title)).toEqual(['k.x'])
    // The first push notified subscribers; the deduped second did not change state.
    expect(seen.length).toBeGreaterThanOrEqual(1)
    unsub()
  })

  it('dedupes on title alone when severity is omitted (defaults to info)', () => {
    // An omitted severity must dedupe consistently against another omitted one
    // AND against an explicit `info` (the default key).
    const id1 = toast({ title: 'k.default' })
    const id2 = toast({ title: 'k.default' })
    const id3 = toast({ severity: 'info', title: 'k.default' })
    expect(id2).toBe(id1)
    expect(id3).toBe(id1)
    expect(toastStore.getSnapshot()).toHaveLength(1)
  })

  it('dismissToast removes a queued toast and is a no-op for an unknown id', () => {
    const id = toast({ severity: 'warning', title: 'k.gone' })
    expect(toastStore.getSnapshot()).toHaveLength(1)
    // Unknown id → no state change (the early-return arm).
    dismissToast('toast-does-not-exist')
    expect(toastStore.getSnapshot()).toHaveLength(1)
    // Real id → removed.
    dismissToast(id)
    expect(toastStore.getSnapshot()).toHaveLength(0)
  })
})
