import { useEffect, useRef, useState } from 'react'
import type { GraphNode } from '@mythrun/client-core/contract'
import { VisuallyHidden } from '../VisuallyHidden/VisuallyHidden.tsx'

// GraphNodeList (MYT-89 Phase E, E2) — the REVEAL graph's roving hidden node list.
// The node canvas is `aria-hidden` decoration, so a keyboard user has no way to
// reach or select a graph node through it. This renders, entirely inside
// `VisuallyHidden` (nothing paints), a `role="listbox"` of the nodes with ROVING
// TABINDEX: arrow keys move the active option, Enter/Space selects it, and selection
// calls the SAME `onSelect(displayId)` the canvas tap fires — so a keyboard user
// drives the identical wiki-navigation path a mouse user does.
//
// SELECTION MIRRORS BOTH WAYS. Outward: activating an option calls `onSelect`, which
// the reveal turns into the graph highlight + wiki push. Inward: a `selectedKey`
// change — a canvas tap, or a pick made in the wiki — moves the roving position onto
// that node, so the keyboard entry point tracks whatever the world last selected.
//
// ROVING TABINDEX (the WAI-ARIA listbox keyboard pattern): exactly one option is in
// the tab order (`tabindex=0`, the active one); the rest are `tabindex=-1`. Tab
// reaches the list once; arrows walk it. Programmatic `.focus()` moves focus to the
// newly-active option regardless of its (about-to-update) tabindex.

interface GraphNodeListProps {
  nodes: GraphNode[]
  /** The externally-selected node (a canvas tap / a wiki pick) — mirrored into the
   *  roving position. */
  selectedKey: string | undefined
  /** Fires the chosen node's `displayId` — the same callback the canvas tap uses. */
  onSelect: (displayId: string) => void
  /** Resolved aria-label for the listbox (the DS owns no copy). */
  label: string
}

export function GraphNodeList({ nodes, selectedKey, onSelect, label }: GraphNodeListProps): React.JSX.Element {
  const listRef = useRef<HTMLUListElement>(null)
  const [activeIndex, setActiveIndex] = useState(0)
  // Clamp against a shrunk node set (a silent refetch can consolidate a node away)
  // so the active option is always addressable.
  const active = nodes.length === 0 ? 0 : Math.min(activeIndex, nodes.length - 1)

  // Mirror the external selection into the roving position — the keyboard entry
  // point follows a canvas tap / a wiki pick onto the same node.
  useEffect(() => {
    if (selectedKey === undefined) return
    const idx = nodes.findIndex((n) => n.displayId === selectedKey)
    if (idx >= 0) setActiveIndex(idx)
  }, [selectedKey, nodes])

  const focusOption = (index: number): void => {
    listRef.current?.querySelector<HTMLElement>(`[data-option-index="${String(index)}"]`)?.focus()
  }

  const handleKeyDown = (event: React.KeyboardEvent<HTMLUListElement>): void => {
    const count = nodes.length
    if (count === 0) return
    let next = active
    switch (event.key) {
      case 'ArrowDown':
      case 'ArrowRight':
        next = (active + 1) % count
        break
      case 'ArrowUp':
      case 'ArrowLeft':
        next = (active - 1 + count) % count
        break
      case 'Home':
        next = 0
        break
      case 'End':
        next = count - 1
        break
      case 'Enter':
      case ' ': {
        event.preventDefault()
        const node = nodes[active]
        if (node !== undefined) onSelect(node.displayId)
        return
      }
      default:
        return
    }
    event.preventDefault()
    setActiveIndex(next)
    focusOption(next)
  }

  return (
    <VisuallyHidden>
      <ul ref={listRef} role="listbox" aria-label={label} onKeyDown={handleKeyDown}>
        {nodes.map((node, index) => {
          const selected = node.displayId === selectedKey
          return (
            // Roving-tabindex option: keyboard activation is owned by the listbox's
            // onKeyDown (Enter/Space on the focused option bubbles up). The list is
            // VisuallyHidden, so there is no pointer affordance to wire here.
            <li
              key={node.displayId}
              role="option"
              aria-selected={selected}
              tabIndex={index === active ? 0 : -1}
              data-option-index={index}
              data-display-id={node.displayId}
            >
              {node.name}
            </li>
          )
        })}
      </ul>
    </VisuallyHidden>
  )
}
