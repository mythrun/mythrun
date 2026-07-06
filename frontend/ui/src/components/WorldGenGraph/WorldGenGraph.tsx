import { forwardRef, useRef } from 'react'
import type { WorldGenGraphProps } from '@mythrun/client-core/contract'
import { cn } from '../../lib/cn.ts'
import { WorldGenFogField } from '../WorldGenFog/WorldGenFogField.tsx'
import { WorldGenStatusCard } from '../WorldGenStatusCard/WorldGenStatusCard.tsx'
import { EntityList } from './entity-list.tsx'
import { useGraphCanvas } from './use-graph-canvas.ts'

// WorldGenGraph (MYT-89 Phase C, C5) — the live streaming graph shown during world
// generation, the world-gen loading experience. The graph pane stacks THREE surfaces
// in one shared 900×470 VIRTUAL coordinate space (§3.6):
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
    'data-testid': dataTestId,
  },
  ref,
) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const { getFogEntities } = useGraphCanvas({
    canvasRef,
    nodes,
    edges,
    selectedKey,
    onSelect,
    reducedMotion,
    interactive,
    showLabels,
  })

  const shown = shownEntities ?? nodes.length
  const total = totalEntities ?? 0

  return (
    <div
      ref={ref}
      {...(dataTestId !== undefined ? { 'data-testid': dataTestId } : {})}
      className={cn('flex min-w-0 flex-col gap-[var(--space-4)]', interactive && 'sm:flex-row')}
    >
      {/* The graph pane: fog behind + graph canvas on top + the status-card overlay, all
          in one positioned box at the fog's native 900×470 aspect so the fixed virtual
          render CSS-scales uniformly (both canvases share the box → the fog-holes line up
          with the glyphs). The canvas is aria-hidden — its meaning is carried by the list
          (reveal) / the aria-live surface (generation, E1). */}
      <div className="relative aspect-[90/47] min-w-0 flex-1 overflow-hidden">
        <WorldGenFogField
          entitiesSource={getFogEntities}
          shownEntities={shown}
          totalEntities={total}
          reducedMotion={reducedMotion}
        />
        <canvas ref={canvasRef} aria-hidden="true" className="absolute inset-0 block h-full w-full" />
        {status !== undefined && <WorldGenStatusCard {...status} />}
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
