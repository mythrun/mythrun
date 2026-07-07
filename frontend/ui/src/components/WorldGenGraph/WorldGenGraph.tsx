import { forwardRef, useRef } from 'react'
import { growthFrom } from '@mythrun/client-core/worldgen'
import type { WorldGenGraphProps } from '@mythrun/client-core/contract'
import { cn } from '../../lib/cn.ts'
import { WorldGenFogField } from '../WorldGenFog/WorldGenFogField.tsx'
import { WorldGenStatusCard } from '../WorldGenStatusCard/WorldGenStatusCard.tsx'
import { EntityList } from './entity-list.tsx'
import { useGraphCanvas } from './use-graph-canvas.ts'

// WorldGenGraph (MYT-89 Phase C, C5) — the live streaming graph shown during world
// generation, the world-gen loading experience. The graph pane stacks THREE surfaces
// in one shared PANE-ADAPTIVE virtual coordinate space (§3.6 + the MYT-89 responsive
// fix, `virtualDims`: sized from the pane box, 1:1 with CSS px on narrow panes so the
// graph is legible at 375px, the reference 900-wide space CSS-upscaled on wide panes):
//   1. a FOG canvas BEHIND (WorldGenFogField, C3) — rolling clouds that part around the
//      streaming labels and FADE as the graph fills. Fed LIVE obstacles derived from the
//      force-sim (`getFogEntities`) so a node's fog-hole tracks its glyph exactly.
//   2. a decorative graph Canvas on top (aria-hidden) — mono-ink square glyphs by kind,
//      hand-drawn ink links, a render-only buoy bob; driven by a rAF loop over the
//      persistent force-sim (BUG 2.2 containment lives in the sim, in virtual units).
//   3. a status-card DOM overlay top-left (WorldGenStatusCard, C4) — progress, so the
//      pre-entity stretch reads as work, not a hang.
//
// The GENERATION graph (default) has no entity list and no click-to-select — but the
// glyphs ARE named (MYT-89 audit #3, `showLabels` default true) and CAN be dragged through
// the fog (audit #5). The REVEAL opts in with `interactive`, which adds the accessible +
// selectable entity list and Canvas tap-to-select (§3.4); labels + drag are live in both.
//
// The FOLD never runs here: nodes/edges arrive as PROPS (the parent folds each SSE
// event); a change re-syncs the physics WITHOUT resetting the layout. All the imperative
// Canvas work lives in useGraphCanvas; this component is thin composition.

export const WorldGenGraph = forwardRef<HTMLDivElement, WorldGenGraphProps>(function WorldGenGraph(
  {
    nodes,
    edges,
    selectedKey,
    onSelect,
    reducedMotion = false,
    interactive = false,
    showLabels = true,
    status,
    shownEntities,
    totalEntities,
    listLabel,
    emptyLabel,
    forceParams,
    densityParams,
    'data-testid': dataTestId,
  },
  ref,
) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  // The status card's element — its footprint becomes a sim KEEP-OUT (density
  // redesign): nodes are shoved out from under the card, so no entity name spends the
  // generation occluded (on a phone the card spans ~70% of the pane width).
  const cardRef = useRef<HTMLDivElement>(null)
  const { getFogEntities } = useGraphCanvas({
    canvasRef,
    nodes,
    edges,
    selectedKey,
    onSelect,
    reducedMotion,
    interactive,
    showLabels,
    forceParams,
    densityParams,
    keepOutRef: cardRef,
  })

  const shown = shownEntities ?? nodes.length
  const total = totalEntities ?? 0
  // Density-aware virtual-space growth (MYT-89 density redesign): the ONE growth
  // derivation BOTH layers size their shared virtual space from — the graph hook
  // re-derives it internally from the same inputs, and the fog receives it here — so
  // the C5 fog↔glyph alignment holds while the space grows with the node count.
  const growth = growthFrom(nodes.length, densityParams)

  return (
    <div
      ref={ref}
      {...(dataTestId !== undefined ? { 'data-testid': dataTestId } : {})}
      className={cn('flex min-w-0 flex-col gap-[var(--space-4)]', interactive && 'sm:flex-row')}
    >
      {/* CSS-style outer margin (MYT-89 follow-up): the pane sits INSET from its container
          with page-background breathing room all around — the whole graph view is held in
          an inset band. Padding on this (transparent) wrapper is the margin; the pane box
          inside pulls in, so the fog + nodes both inset together. */}
      <div className="min-w-0 flex-1 p-[var(--space-4)]">
        {/* The graph pane: fog behind + graph canvas on top + the status-card overlay, all
            in one positioned box (both canvases share the box → the fog-holes line up with
            the glyphs). RESPONSIVE (MYT-89): no aspect lock — the width fills the container
            and the HEIGHT tracks the viewport (clamped), so the pane is tall on a phone,
            wide on a desktop, and never overflows the fold; the shared virtual space adapts
            to the pane's own aspect (`virtualDims` — 1:1 CSS px below the reference width,
            so labels stay legible at 375px). The canvas is aria-hidden — its meaning is
            carried by the list (reveal) / the aria-live surface (generation, E1). */}
        <div className="relative h-[clamp(18rem,62dvh,46rem)] w-full overflow-hidden">
          <WorldGenFogField
            entitiesSource={getFogEntities}
            shownEntities={shown}
            totalEntities={total}
            reducedMotion={reducedMotion}
            growth={growth}
          />
          <canvas
            ref={canvasRef}
            aria-hidden="true"
            className="absolute inset-0 block h-full w-full"
          />
          {status !== undefined && <WorldGenStatusCard ref={cardRef} {...status} />}
        </div>
      </div>
      {/* The accessible + selectable surface — the REVEAL only (§3.4 gate). */}
      {interactive && (
        <div className="min-w-0 sm:w-64 sm:shrink-0">
          <EntityList
            nodes={nodes}
            selectedKey={selectedKey}
            onSelect={onSelect}
            listLabel={listLabel ?? ''}
            emptyLabel={emptyLabel ?? ''}
          />
        </div>
      )}
    </div>
  )
})
