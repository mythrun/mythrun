import type { ToastOptions } from '@mythrun/client-core/contract'

// The imperative Toast STORE — a tiny module-level pub/sub the <ToastProvider>
// subscribes to via `useSyncExternalStore`. `toast(options)` is the public
// imperative API (a RUNTIME value — that is why it ships from the UI package, not
// the type-only contract barrel). The store owns the subsystem invariants the
// provider renders: a DEDUPE window (identical title+severity collapse), a
// MAX-VISIBLE cap (the oldest drops off), and stable id generation.

/** A queued toast: its id, its dedupe key, the caller options, and when it was added. */
export interface ToastEntry {
  readonly id: string
  readonly key: string
  readonly options: ToastOptions
  readonly createdAt: number
}

type Listener = () => void

// Tunables the provider sets at mount (so they track the ToastProviderProps).
const DEFAULTS = { maxVisible: 3, dedupeWindowMs: 4000 }

let config = { ...DEFAULTS }
let entries: readonly ToastEntry[] = []
const listeners = new Set<Listener>()
let idCounter = 0

const emit = (): void => {
  for (const l of listeners) l()
}

// The dedupe key — same severity + same title collapse. `severity` defaults to
// `info` (matching the impl default) so an omitted severity dedupes consistently.
const keyFor = (options: ToastOptions): string => `${options.severity ?? 'info'}::${options.title}`

/**
 * Push a toast. If an identical (severity+title) toast is already queued within
 * the dedupe window, this is a NO-OP and returns the existing toast's id.
 * Otherwise it appends a new toast, trims to `maxVisible` (oldest off), and
 * notifies subscribers. Returns the toast's id.
 */
export const toast = (options: ToastOptions): string => {
  const key = keyFor(options)
  const now = Date.now()
  const existing = entries.find((e) => e.key === key && now - e.createdAt < config.dedupeWindowMs)
  if (existing) return existing.id

  idCounter += 1
  const entry: ToastEntry = { id: `toast-${String(idCounter)}`, key, options, createdAt: now }
  // Append, then keep only the most-recent `maxVisible` (the oldest drop off).
  const next = [...entries, entry]
  entries = next.length > config.maxVisible ? next.slice(next.length - config.maxVisible) : next
  emit()
  return entry.id
}

/** Remove a toast by id (the provider calls this when Radix reports it closed). */
export const dismissToast = (id: string): void => {
  const next = entries.filter((e) => e.id !== id)
  if (next.length === entries.length) return
  entries = next
  emit()
}

/** Apply provider tunables (max-visible + dedupe window). Called once at mount. */
export const configureToasts = (next: Partial<typeof DEFAULTS>): void => {
  config = { ...config, ...next }
}

// The external-store contract for `useSyncExternalStore`. `getSnapshot` returns
// the SAME array reference between mutations so React does not re-render in a loop.
export const toastStore = {
  subscribe(listener: Listener): () => void {
    listeners.add(listener)
    return () => {
      listeners.delete(listener)
    }
  },
  getSnapshot(): readonly ToastEntry[] {
    return entries
  },
}

/** TEST-ONLY: reset the store + config to a clean slate between tests. */
export const __resetToastStore = (): void => {
  entries = []
  listeners.clear()
  idCounter = 0
  config = { ...DEFAULTS }
}
