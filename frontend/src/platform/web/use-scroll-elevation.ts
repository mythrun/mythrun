import { useCallback, useEffect, useRef, useState } from 'react'

export interface ScrollElevation {
  /** True once the sentinel has left the viewport (content scrolled beneath the bar). */
  readonly elevated: boolean
  /** Attach to a 1px absolutely-positioned sentinel at the TOP of the document. */
  readonly sentinelRef: (node: HTMLElement | null) => void
}

// The elevation signal for the sticky frame bar (spec 2026-07-30 §Scroll
// mechanics, normative). The sentinel MUST sit at the TOP of the scrolled
// document, absolutely positioned (occupying no flow space): a sentinel BELOW
// a sticky bar slides under it and IntersectionObserver does not model
// occlusion — it would fire a full bar-height (~88px) late. Top-of-document
// placement fires within ~1px of scroll and is decoupled from the fluid bar
// height. Lives in platform/web, NOT client-core: IntersectionObserver is a
// web API and client-core stays platform-neutral.
//
// `forceElevated` pins the state for stories/tests (the Storybook elevated
// story cannot scroll deterministically under the CI gate's double-resize).
export function useScrollElevation(forceElevated?: boolean): ScrollElevation {
  const [elevated, setElevated] = useState(false)
  const observerRef = useRef<IntersectionObserver | null>(null)
  const sentinelRef = useCallback((node: HTMLElement | null) => {
    observerRef.current?.disconnect()
    observerRef.current = null
    if (node === null) return
    const observer = new IntersectionObserver(([entry]) => {
      if (entry !== undefined) setElevated(!entry.isIntersecting)
    })
    observer.observe(node)
    observerRef.current = observer
  }, [])
  // Unmount safety net: React 19 detaches callback refs with `null` when the
  // sentinel element unmounts, but the hook can unmount while the ref is still
  // held outside React's render (as the tests do).
  useEffect(
    () => () => {
      observerRef.current?.disconnect()
    },
    [],
  )
  return { elevated: forceElevated ?? elevated, sentinelRef }
}
