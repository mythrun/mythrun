import { useSyncExternalStore } from 'react'
import { useTranslation } from 'react-i18next'
import { SAMPLE_VARS, entriesByKey, useEntryState } from './store.ts'

// ── Active-key highlight store ───────────────────────────────────────────────
// The focused/hovered editor sets the active key; every exhibit node carrying that
// key (a <T>, or a whole scene frame) marks itself hot. Kept in a tiny external
// store so only the affected nodes re-render on hover — never the whole tree.
let activeKey: string | null = null
const listeners = new Set<() => void>()

export function setActiveKey(key: string | null): void {
  if (key === activeKey) return
  activeKey = key
  for (const fn of listeners) fn()
}

function subscribe(fn: () => void): () => void {
  listeners.add(fn)
  return () => {
    listeners.delete(fn)
  }
}

export function useActiveKey(): string | null {
  return useSyncExternalStore(
    subscribe,
    () => activeKey,
    () => null,
  )
}

/** True when `key` (or any key in the set) is the active one. */
export function useIsHot(key: string): boolean {
  return useActiveKey() === key
}

/** Live-translated text node used inside composed exhibits + context cards. Reads
 *  the shared i18n instance (so overrides repaint it), passes sample interpolation
 *  vars, tags itself with `data-key`, and outlines itself when its key is active. */
export function T({ k, as }: { k: string; as?: 'span' | 'div' }): React.JSX.Element {
  const { t } = useTranslation()
  const st = useEntryState(k)
  const hot = useIsHot(k)
  const Tag = as ?? 'span'
  const entry = entriesByKey[k]
  // ds:* constants aren't i18n keys (t() would mis-parse the ':' namespace sep) —
  // render their store override or original constant directly.
  const text = entry?.hardcoded ? (st.value.trim() !== '' ? st.value : entry.current) : t(k, SAMPLE_VARS)
  return (
    <Tag data-key={k} className={hot ? 'wb-hot' : undefined}>
      {text}
    </Tag>
  )
}

/** Imperative sibling of <T>: resolve a key to a string (for real-component props
 *  that take strings, not nodes). Must be called inside a component that subscribes
 *  to i18n (i.e. under useTranslation) so overrides repaint. */
export function useCopy(): (k: string) => string {
  const { t } = useTranslation()
  return (k: string) => t(k, SAMPLE_VARS)
}
