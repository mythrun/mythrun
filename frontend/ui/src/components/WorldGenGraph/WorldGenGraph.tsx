import { forwardRef, useRef } from 'react'
import { growthFrom, seatFrom } from '@mythrun/client-core/worldgen'
import type { WorldGenGraphProps } from '@mythrun/client-core/contract'
import { cn } from '../../lib/cn.ts'
import { useViewportNarrow } from '../../lib/use-viewport-narrow.ts'
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
//      streaming labels and CLEAR by spawn drain as the graph fills (the fog never dims its
//      paint: the sim's respawn population scales toward zero as the entity count approaches
//      the expected total, and the wind carries the last particles away). Fed LIVE obstacles
//      derived from the force-sim (`getFogEntities`) so a node's fog-hole tracks its glyph exactly.
//   2. a decorative graph Canvas on top (aria-hidden) — mono-ink square glyphs by kind,
//      hand-drawn ink links, a render-only buoy bob; driven by a rAF loop over the
//      persistent force-sim (BUG 2.2 containment lives in the sim, in virtual units).
//   3. a status-card DOM surface (WorldGenStatusCard, C4) — progress, so the
//      pre-entity stretch reads as work, not a hang. On wide viewports an overlay
//      pinned top-left INSIDE the pane (with a sim keep-out under it); on narrow
//      (phone-class) viewports a compact FOOTER bar below the full-bleed pane
//      (MYT-89 audit v2 — no overlay, no keep-out; the graph owns the screen).
//
// The GENERATION graph (default) has no entity list and no click-to-select — but the
// glyphs ARE named (MYT-89 audit #3, `showLabels` default true) and CAN be dragged through
// the fog (audit #5). The REVEAL opts in with `interactive`, which adds the accessible +
// selectable entity list and Canvas tap-to-select (§3.4); labels + drag are live in both.
//
// The FOLD never runs here: nodes/edges arrive as PROPS (the parent folds each SSE
// event); a change re-syncs the physics WITHOUT resetting the layout. All the imperative
// Canvas work lives in useGraphCanvas; this component is thin composition.

// The three layout boxes' classes, derived from the narrow/footer regime (MYT-89
// audit v2). Module-scoped so the component stays thin composition.
//
// ROOT: a column (row beside the reveal's list at sm+); footer mode fills the
// host's height and sits the footer flush under the pane (no gap).
function rootClass(interactive: boolean, statusFooter: boolean): string {
  return cn(
    'flex min-w-0 flex-col gap-[var(--space-4)]',
    interactive && 'sm:flex-row',
    statusFooter && 'h-full gap-0',
  )
}
// BAND (the CSS-style outer margin, MYT-89 follow-up): the pane sits INSET from
// its container with page-background breathing room all around — padding on this
// (transparent) wrapper is the margin; the pane box inside pulls in, so the fog +
// nodes both inset together. On NARROW viewports the band is dropped (audit v2):
// the pane goes edge-to-edge. Footer mode also makes it a flex column so the pane
// can fill the host-provided height.
function bandClass(narrow: boolean, statusFooter: boolean): string {
  return cn(
    'min-w-0 flex-1',
    !narrow && 'p-[var(--space-4)]',
    statusFooter && 'flex min-h-0 flex-col',
  )
}
// PANE (the positioned box both canvases + the overlay share). RESPONSIVE
// (MYT-89): no aspect lock — the width fills the container and the HEIGHT tracks
// the viewport (clamped), so the pane is tall on a phone, wide on a desktop, and
// never overflows the fold; the shared virtual space adapts to the pane's own
// aspect (`virtualDims` — 1:1 CSS px below the reference width, so labels stay
// legible at 375px). In FOOTER mode the pane flexes to fill the host-provided
// height instead (nav + pane + footer = the screen).
function paneClass(statusFooter: boolean): string {
  return cn(
    'relative w-full overflow-hidden',
    statusFooter ? 'min-h-0 flex-1' : 'h-[clamp(18rem,62dvh,46rem)]',
  )
}

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
  const { getFogEntities, camera } = useGraphCanvas({
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
  // NARROW-VIEWPORT layout (MYT-89 audit v2 — the mobile full-bleed fix). On a
  // phone-class viewport (< 640px, the DS's one narrow regime) the band is
  // dropped — the pane goes EDGE-TO-EDGE (this reaches every consumer, the
  // reveal included). With a status card the layout additionally goes FOOTER
  // mode: the card leaves the canvas for a compact bar BELOW the pane (never
  // hovering over the world), and the pane flexes to fill whatever height the
  // host provides (the generating route wraps this in a viewport-filling
  // FullBleedStage) instead of the viewport clamp. Form-factor-driven ONLY —
  // the flip is a media condition, never the camera engaging mid-generation.
  // With no overlay there is nothing to keep out: `cardRef` stays unattached,
  // so `syncCardKeepOut` clears any sim keep-out on the next sync.
  const narrow = useViewportNarrow()
  const statusFooter = narrow && status !== undefined
  // Density-aware virtual-space growth (MYT-89 density redesign) + the camera-world
  // SEAT (T1b): the ONE pair of derivations BOTH layers size their shared spaces from
  // — the graph hook re-derives them internally from the same inputs, and the fog
  // receives them here — so the C5 fog↔glyph alignment holds while the space grows
  // with the node count AND while the world outgrows the pane (the pannable camera).
  const growth = growthFrom(nodes.length, densityParams)
  const seat = seatFrom(nodes.length, densityParams)

  return (
    <div
      ref={ref}
      {...(dataTestId !== undefined ? { 'data-testid': dataTestId } : {})}
      className={rootClass(interactive, statusFooter)}
    >
      <div className={bandClass(narrow, statusFooter)}>
        {/* The graph pane: fog behind + graph canvas on top + the status-card overlay,
            all in one positioned box (both canvases share the box → the fog-holes line
            up with the glyphs; see `paneClass` for the responsive shape). The canvas is
            aria-hidden — its meaning is carried by the list (reveal) / the aria-live
            surface (generation, E1). */}
        <div className={paneClass(statusFooter)}>
          <WorldGenFogField
            entitiesSource={getFogEntities}
            shownEntities={shown}
            totalEntities={total}
            reducedMotion={reducedMotion}
            growth={growth}
            seat={seat}
            camera={camera}
          />
          <canvas
            ref={canvasRef}
            aria-hidden="true"
            className="absolute inset-0 block h-full w-full"
          />
          {status !== undefined && !statusFooter && (
            <WorldGenStatusCard ref={cardRef} {...status} />
          )}
        </div>
      </div>
      {/* FOOTER mode: the status as a compact bottom bar — page chrome below the
          full-bleed pane, never occluding the world (and never a sim keep-out). */}
      {narrow && status !== undefined && <WorldGenStatusCard variant="footer" {...status} />}
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
