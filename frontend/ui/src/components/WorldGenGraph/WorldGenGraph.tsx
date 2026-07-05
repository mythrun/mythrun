import { forwardRef, useRef } from 'react'
import type { WorldGenGraphProps } from '@mythrun/client-core/contract'
import { cn } from '../../lib/cn.ts'
import { EntityList } from './entity-list.tsx'
import { useGraphCanvas } from './use-graph-canvas.ts'

// WorldGenGraph (MYT-89 Phase C, C4) — the live streaming graph shown during world
// generation, the world-gen loading experience. Two coordinated surfaces:
//   1. a decorative force-directed Canvas (aria-hidden) — square ink glyphs by kind,
//      hand-drawn ink links, ambient ghost-bloom churn between arrivals, fine-pointer
//      hover-raise + drag-to-pin; driven by a rAF loop over the persistent physics.
//   2. an ACCESSIBLE entity list — the a11y/keyboard/touch surface (and the testable
//      one; jsdom has no Canvas). Selection flows through it on every platform.
//
// The FOLD never runs here: nodes/edges arrive as PROPS (the parent folds each SSE
// event); a change re-syncs the physics WITHOUT resetting the layout. Reduced motion
// swaps the rAF churn for a settle-to-convergence static redraw per change. All the
// imperative Canvas work lives in useGraphCanvas; this component is thin composition.

export const WorldGenGraph = forwardRef<HTMLDivElement, WorldGenGraphProps>(function WorldGenGraph(
  {
    nodes,
    edges,
    selectedKey,
    onSelect,
    reducedMotion = false,
    listLabel,
    emptyLabel,
    'data-testid': dataTestId,
  },
  ref,
) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  useGraphCanvas({ canvasRef, nodes, edges, selectedKey, onSelect, reducedMotion })

  return (
    <div
      ref={ref}
      {...(dataTestId !== undefined ? { 'data-testid': dataTestId } : {})}
      className={cn('flex min-w-0 flex-col gap-[var(--space-4)] sm:flex-row')}
    >
      {/* The decorative graph. aria-hidden — its meaning is carried by the list; a
          raw Canvas is the one surface Tailwind/tokens can't reach, so the render
          loop resolves the theme ink itself (see canvas-util.resolveInk). */}
      <div className="relative aspect-[4/3] min-w-0 flex-1">
        <canvas ref={canvasRef} aria-hidden="true" className="absolute inset-0 block h-full w-full" />
      </div>
      {/* The accessible + selectable surface. */}
      <div className="min-w-0 sm:w-64 sm:shrink-0">
        <EntityList
          nodes={nodes}
          selectedKey={selectedKey}
          onSelect={onSelect}
          listLabel={listLabel}
          emptyLabel={emptyLabel}
        />
      </div>
    </div>
  )
})
