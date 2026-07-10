import { forwardRef, useRef } from 'react'
import { growthFrom, REVEAL_FORCE_PARAMS, seatFrom } from '@mythrun/client-core/worldgen'
import type { ForceParams } from '@mythrun/client-core/worldgen'
import type { WorldGenGraphProps } from '@mythrun/client-core/contract'
import { cn } from '../../lib/cn.ts'
import { useViewportNarrow } from '../../lib/use-viewport-narrow.ts'
import { WorldGenFogField } from '../WorldGenFog/WorldGenFogField.tsx'
import { WorldGenStatusCard } from '../WorldGenStatusCard/WorldGenStatusCard.tsx'
import { GenerationAnnouncer } from './GenerationAnnouncer.tsx'
import { GraphNodeList } from './GraphNodeList.tsx'
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
// The GENERATION graph (default) has no click-to-select — but the glyphs ARE named
// (MYT-89 audit #3, `showLabels` default true) and CAN be dragged through the fog
// (audit #5). The REVEAL opts in with `interactive`, which wires Canvas tap-to-select
// (§3.4); labels + drag are live in both. There is NO entity list on either surface
// (MYT-89 audit v3 — the wiki is the reveal's browse surface).
//
// The FOLD never runs here: nodes/edges arrive as PROPS (the parent folds each SSE
// event); a change re-syncs the physics WITHOUT resetting the layout. All the imperative
// Canvas work lives in useGraphCanvas; this component is thin composition.

// The three layout boxes' classes, derived from the narrow/footer regime (MYT-89
// audit v2) + the host-fill regime (audit v3). Module-scoped so the component
// stays thin composition. `fill` = the host provides the height (the narrow
// status-footer stage, or the desktop reveal's `fillHost` half): the column
// chains h-full → flex → flex-1 so the pane stretches to it.
//
// ROOT: a column; fill mode takes the host's height (footer mode also zeroes the
// gap so the footer sits flush under the pane).
function rootClass(statusFooter: boolean, fill: boolean): string {
  return cn(
    'flex min-w-0 flex-col gap-[var(--space-4)]',
    fill && 'h-full',
    statusFooter && 'gap-0',
  )
}
// BAND (the CSS-style outer margin, MYT-89 follow-up): the pane sits INSET from
// its container with page-background breathing room all around — padding on this
// (transparent) wrapper is the margin; the pane box inside pulls in, so the fog +
// nodes both inset together. On NARROW viewports the band is dropped (audit v2):
// the pane goes edge-to-edge. Fill mode also makes it a flex column so the pane
// can fill the host-provided height.
function bandClass(narrow: boolean, fill: boolean): string {
  return cn(
    'min-w-0 flex-1',
    !narrow && 'p-[var(--space-4)]',
    fill && 'flex min-h-0 flex-col',
  )
}
// PANE (the positioned box both canvases + the overlay share). RESPONSIVE
// (MYT-89): no aspect lock — the width fills the container and the HEIGHT tracks
// the viewport (clamped), so the pane is tall on a phone, wide on a desktop, and
// never overflows the fold; the shared virtual space adapts to the pane's own
// aspect (`virtualDims` — 1:1 CSS px below the reference width, so labels stay
// legible at 375px). In FILL mode the pane flexes to fill the host-provided
// height instead (footer: nav + pane + footer = the screen; desktop reveal: the
// pane fills its RevealPanes half).
function paneClass(fill: boolean): string {
  return cn(
    'relative w-full overflow-hidden',
    fill ? 'min-h-0 flex-1' : 'h-[clamp(18rem,62dvh,46rem)]',
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
    pannable = true,
    fillHost = false,
    forcefulSettle = false,
    status,
    shownEntities,
    totalEntities,
    forceParams,
    densityParams,
    generationA11y,
    nodeListLabel,
    'data-testid': dataTestId,
  },
  ref,
) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  // The status card's element — its footprint becomes a sim KEEP-OUT (density
  // redesign): nodes are shoved out from under the card, so no entity name spends the
  // generation occluded (on a phone the card spans ~70% of the pane width).
  const cardRef = useRef<HTMLDivElement>(null)
  // The FORCEFUL settle regime (MYT-89 audit v4): the reveal's force profile rides
  // the existing forceParams seam — the preset under any explicit overrides (so the
  // tuning harness dials the regime live). Value-stable across renders (the hook's
  // re-seed keys on the serialised params, not the object identity); regime off
  // passes the caller's params through untouched — the generating path unchanged.
  const effectiveForceParams: Partial<ForceParams> | undefined = forcefulSettle
    ? { ...REVEAL_FORCE_PARAMS, ...forceParams }
    : forceParams
  const { getFogEntities, camera } = useGraphCanvas({
    canvasRef,
    nodes,
    edges,
    selectedKey,
    onSelect,
    reducedMotion,
    interactive,
    showLabels,
    pannable,
    forcefulSettle,
    forceParams: effectiveForceParams,
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
  // Fill regime (audit v3): the host provides the height — either the narrow
  // status-footer stage (audit v2) or an explicit `fillHost` consumer (the
  // desktop reveal's half). One boolean drives all three layout boxes.
  const fill = statusFooter || fillHost
  // Density-aware virtual-space growth (MYT-89 density redesign) + the camera-world
  // SEAT (T1b): the ONE pair of derivations BOTH layers size their shared spaces from
  // — the graph hook re-derives them internally from the same inputs, and the fog
  // receives them here — so the C5 fog↔glyph alignment holds while the space grows
  // with the node count AND while the world outgrows the pane (the pannable camera).
  // `pannable={false}` (audit v3) ZEROES the seat — `cameraWorldDims` then never
  // engages, world === view, and the graph fills its pane at every density. The
  // same gated derivation feeds the hook (its own `seatFrom` gate) and the fog
  // here, so the C5 shared-space invariant holds through the gate.
  const growth = growthFrom(nodes.length, densityParams)
  const seat = seatFrom(pannable ? nodes.length : 0, densityParams)

  return (
    <div
      ref={ref}
      {...(dataTestId !== undefined ? { 'data-testid': dataTestId } : {})}
      className={rootClass(statusFooter, fill)}
    >
      {/* E1 (Phase E): the GENERATION graph's SR model — a VisuallyHidden aria-live
          announcer + entities-so-far list, so the aria-hidden canvases don't cut a
          screen-reader user off. Presence of `generationA11y` gates it (the reveal
          omits it), so it never renders on the interactive reveal surface. */}
      {generationA11y !== undefined && <GenerationAnnouncer nodes={nodes} a11y={generationA11y} />}
      {/* E2 (Phase E): the REVEAL graph's roving hidden node list — the keyboard
          path to select a node when the canvas is aria-hidden. Rendered only on the
          interactive reveal, and only when the consumer supplies a resolved label. */}
      {interactive && nodeListLabel !== undefined && (
        <GraphNodeList nodes={nodes} selectedKey={selectedKey} onSelect={onSelect} label={nodeListLabel} />
      )}
      <div className={bandClass(narrow, fill)}>
        {/* The graph pane: fog behind + graph canvas on top + the status-card overlay,
            all in one positioned box (both canvases share the box → the fog-holes line
            up with the glyphs; see `paneClass` for the responsive shape). The canvases
            are aria-hidden — decorative on every surface (the wiki is the reveal's
            accessible browse surface; the aria-live generation surface is E1's). */}
        <div className={paneClass(fill)}>
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
    </div>
  )
})
