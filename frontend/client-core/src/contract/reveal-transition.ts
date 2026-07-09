import type { ReactNode } from 'react'
import type { BaseProps } from './index.ts'

/**
 * The reveal-moment phases (MYT-89 §3.8, Task D6) — the gen→reveal transition
 * played ONCE for the player who watched their world generate, the instant
 * connection-weaving completes (the mid-gen reveal swap). In order:
 *
 *  - `hold` — the swap breath (~¼s): the settled web stands alone on cleared
 *    paper; nothing new is shown.
 *  - `gust` — the fog-lift beat (~1.2s). The §3.8 hard invariant (fog totally
 *    gone) is enforced from the SWAP: the reveal's fog is born drained (the
 *    consumer passes a fully-arrived drain numerator). The wind cannot clear a
 *    residual haze in a beat (~20s crossing) and a remounted sim's cold
 *    low-pass would fade the haze back IN first, so the drain's real exodus
 *    belongs to the generating act; this beat holds the cleared world.
 *  - `settle` — the world settles (~1.2s): the title fades in, understated;
 *    the graph keeps easing into rest through its own force-sim.
 *  - `resolve` — the layout arrives (~0.8s): desktop, the graph re-seats to
 *    the left 50% as the wiki pane slides in from the right; narrow, the
 *    graph stays fullscreen and the wiki drawer (its edge handle) arrives.
 *  - `done` — the steady state: identical to a reveal that never played.
 *
 * Reduced motion collapses the walk: the layout is final and the fog cleared
 * from the first frame (`done` immediately) and the whole surface fades in
 * over ~300ms — the completion is still marked, just not animated.
 */
export type RevealPhase = 'hold' | 'gust' | 'settle' | 'resolve' | 'done'

/**
 * The moment as consumers receive it each render: the current phase plus
 * whether the end state was reached WITHOUT the choreography (a never-played
 * mount — the late arriver — or a hard skip). When `instant` is true a
 * consumer renders its final state with transitions off, so a skip lands
 * cleanly instead of animating its tail.
 */
export interface RevealMoment {
  readonly phase: RevealPhase
  readonly instant: boolean
}

/**
 * The reveal-moment orchestrator (MYT-89 §3.8) — owns the timeline and hands
 * the current {@link RevealMoment} to its children, who stage their own
 * presentation off it ({@link RevealPanesProps RevealPanes} for the desktop
 * layout arrival, {@link RevealFadeProps RevealFade} for the title/chrome
 * fades, drawer mount timing, the fog's drain denominator).
 *
 * PLAYS ONCE: the walk begins on the first render where `play` is true and
 * latches — later flips of `play` (the route's mid-gen signal going false at
 * the world_ready flip; a tail-stage re-render) never restart or reverse it.
 * A mount that never sees `play` renders the final state immediately
 * (`done` + `instant`) — the moment is for the player who watched, never the
 * late arriver.
 *
 * SKIPPABLE by construction: while the moment is playing, any pointer-down or
 * key-down lands the consumer in the final state (`done` + `instant`); the
 * interaction itself still reaches its target, so a mid-moment node tap both
 * ends the moment and does what it would do in the final state.
 */
export interface RevealTransitionProps extends Omit<BaseProps, 'children'> {
  /** Begin the moment (first true wins — latched). False forever = the final
   *  state immediately (the late arriver / an already-settled world). */
  play: boolean
  /** The user's reduced-motion preference: the walk collapses to the final
   *  layout with a ~300ms surface fade (the §3.8 reduced path). */
  reducedMotion?: boolean
  /** Fired ONCE when the moment ends (walk complete, reduced fade complete, or
   *  skip). Never fired for a mount that never played. */
  onDone?: () => void
  /** Render-prop: the subtree the moment stages, re-rendered per phase. */
  children: (moment: RevealMoment) => ReactNode
}

/**
 * The desktop reveal-layout frame (MYT-89 §3.8 phase 3) — the two-pane
 * arrangement ARRIVING IN MOTION. Before `resolve` the stage (the graph) owns
 * the full width; at `resolve` the cells re-seat in one step (the graph's
 * force-sim visibly re-flows the world into its half — a width-eased canvas
 * would repaint-then-clear every frame and blank the world instead) while the
 * panel (the wiki) slides in from the right edge over the resolve window,
 * landing on the §4.1 true 50/50 (two equal min-width-0 halves, a `--space-4`
 * gutter). The panel content is laid out at its FINAL width throughout (no
 * re-wrap during the slide — it moves, clipped, into place). At `done` the
 * frame IS the steady 50/50; an `instant` moment renders it with no
 * transition.
 */
export interface RevealPanesProps extends Omit<BaseProps, 'children'> {
  moment: RevealMoment
  /** The world pane (the graph) — full width before `resolve`, the left half after. */
  stage: ReactNode
  /** The arriving pane (the wiki) — hidden before `resolve`, slides in at it. */
  panel: ReactNode
}

/**
 * A phase-keyed fade block (MYT-89 §3.8) — wraps chrome that ARRIVES at a
 * phase (the title at `settle`, the explore prompt at `resolve`) in the
 * brand's one sanctioned motion: a whole-block opacity fade. Space is reserved
 * from the first frame (opacity only — the layout never shifts mid-moment),
 * and the content stays in the accessibility tree throughout. An `instant`
 * moment renders the final opacity with no transition.
 */
export interface RevealFadeProps extends BaseProps {
  moment: RevealMoment
  /** The first phase at which the content is visible. */
  visibleFrom: RevealPhase
}
