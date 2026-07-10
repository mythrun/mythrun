import { useEffect, useRef, useState } from 'react'
import type { GenerationA11y, GraphNode } from '@mythrun/client-core/contract'
import { VisuallyHidden } from '../VisuallyHidden/VisuallyHidden.tsx'

// GenerationAnnouncer (MYT-89 Phase E, E1) — the GENERATION graph's screen-reader
// model. The fog + node canvases are `aria-hidden` decoration a SR user cannot
// perceive, so without this the entire ~10-minute generation act is silent to
// them. This renders, entirely inside `VisuallyHidden` (nothing paints):
//   1. an `aria-live="polite"` region carrying a COALESCED progress announcement,
//      and
//   2. a plain `<ul>` of the entities discovered so far — a navigable snapshot the
//      reader can step through at will (updated silently; it is NOT itself a live
//      region, so growing it never announces).
//
// COALESCING (the SR-machine-gun defence). Entities stream in bursts; a live region
// bound naively to the count would fire on every arrival. So:
//   • a STAGE/phase change flushes the region IMMEDIATELY (a transition is news the
//     reader should hear at once), and
//   • an entity-tally change is TRAILING-DEBOUNCED — during a burst the region is
//     rewritten only after a quiet gap, so twenty arrivals in a flurry yield a
//     single "…24 entities…" announcement.
// The determinate percentage stays the status card's `role="progressbar"` (E1's
// brief: don't duplicate it); this region carries only what the canvas HIDES —
// that entities are appearing, the current phase, and roughly how many.

/** The coalescing window (ms): how long the live region waits out an entity burst
 *  before committing the latest tally. Long enough that a rapid flurry settles to
 *  one announcement, short enough that a lone arrival is still timely. */
const COALESCE_MS = 1500

/** Compose the single announced sentence from the two resolved fragments. Both are
 *  already-localized copy (the DS owns none); the join is punctuation only. */
function compose(phaseLabel: string, entitiesLabel: string): string {
  return `${phaseLabel}. ${entitiesLabel}`
}

/** The coalesced live-region text. A `phaseLabel` change commits at once; an
 *  `entitiesLabel` change (same phase) commits only after `COALESCE_MS` of quiet —
 *  a fresh change during the window resets the timer, so a burst settles once. */
function useCoalescedAnnouncement(phaseLabel: string, entitiesLabel: string): string {
  const [announced, setAnnounced] = useState(() => compose(phaseLabel, entitiesLabel))
  const prevPhaseRef = useRef(phaseLabel)
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => {
    const next = compose(phaseLabel, entitiesLabel)
    const phaseChanged = phaseLabel !== prevPhaseRef.current
    prevPhaseRef.current = phaseLabel
    if (timerRef.current !== null) {
      clearTimeout(timerRef.current)
      timerRef.current = null
    }
    if (phaseChanged) {
      // Flush a stage transition immediately — never delayed behind the count debounce.
      setAnnounced(next)
      return
    }
    // Debounce entity-tally churn: commit the latest only after the burst quiets.
    timerRef.current = setTimeout(() => {
      timerRef.current = null
      setAnnounced(next)
    }, COALESCE_MS)
  }, [phaseLabel, entitiesLabel])

  useEffect(
    () => () => {
      if (timerRef.current !== null) clearTimeout(timerRef.current)
    },
    [],
  )

  return announced
}

interface GenerationAnnouncerProps {
  nodes: GraphNode[]
  a11y: GenerationA11y
}

export function GenerationAnnouncer({ nodes, a11y }: GenerationAnnouncerProps): React.JSX.Element {
  const announcement = useCoalescedAnnouncement(a11y.phaseLabel, a11y.entitiesLabel)
  return (
    <VisuallyHidden>
      {/* The polite live region — coalesced, atomic (the whole sentence is read as
          one unit, never a diff of the previous). */}
      <p aria-live="polite" aria-atomic="true" data-testid="worldgen-live">
        {announcement}
      </p>
      {/* The entities-so-far snapshot: a real list the reader can navigate. Keyed
          on the render id-space (`displayId`); names are DATA, rendered as-is. */}
      <ul aria-label={a11y.entityListLabel}>
        {nodes.map((node) => (
          <li key={node.displayId}>{node.name}</li>
        ))}
      </ul>
    </VisuallyHidden>
  )
}
