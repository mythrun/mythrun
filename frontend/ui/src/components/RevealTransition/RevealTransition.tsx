import { useEffect, useRef, useState } from 'react'
import type {
  RevealFadeProps,
  RevealMoment,
  RevealPanesProps,
  RevealPhase,
  RevealTransitionProps,
} from '@mythrun/client-core/contract'
import { cn } from '../../lib/cn.ts'

// RevealTransition (MYT-89 §3.8, Task D6) — the gen→reveal REWARD MOMENT. The
// player has watched their world assemble for ~10 minutes; the instant
// connection-weaving completes, the route swaps generating → reveal and this
// component makes that swap a composed beat instead of a flash-cut:
//
//   hold (¼s)   the swap breath — the settled web stands alone, nothing new
//               moves.
//   gust (1.2s) the fog-lift beat. The fog's §3.8 hard invariant ("totally
//               gone") is enforced FROM THE SWAP: the reveal's fog is born
//               drained (the consumer passes a fully-arrived drain numerator —
//               `settlePopulation`'s mount path), because the sim's wind needs
//               ~20s to carry a residual haze off and its cold temporal
//               low-pass would first FADE THE HAZE BACK IN (both caught on the
//               D6 sequence capture) — a live 1s particle exodus isn't
//               composable from the locked physics. The beat holds the cleared
//               paper; the drain's real exodus was the generating act's.
//   settle (1.2s) the title fades in, understated; the graph keeps easing into
//               rest through its own force-sim (running since the swap).
//   resolve (0.8s) the layout arrives — desktop: RevealPanes re-seats the graph
//               to the left 50% while the wiki slides in from the right;
//               narrow: the wiki drawer (its edge handle) mounts.
//   done        the steady state — identical to a reveal that never played.
//
// This module owns the TIMELINE + the two presentation primitives the app's
// layout can't build itself (the DS bans consumer className/style):
// `RevealPanes` (the desktop arrival frame) and `RevealFade` (the phase-keyed
// opacity block — the brand's one sanctioned motion). The fog and graph are
// composed through their EXISTING surfaces by the consumer; their physics are
// untouchable here.
//
// PLAYS ONCE: the first `play` latches (playedRef); later flips never restart
// or reverse. SKIPPABLE: window-level pointer-down/key-down mid-moment jumps
// to done with `instant` set (consumers cut their transitions — a hard
// landing); the event is never swallowed, so the interaction also does what it
// would do in the final state. REDUCED MOTION: no walk — `done` from the first
// frame (layout final, fog denominator drained by the consumer's phase
// mapping) with a one-shot ~300ms surface fade; under a real OS-level
// preference base.css collapses even that to the end state, which still marks
// the completion.

/** §3.8 phase 0 — the swap breath before anything new moves. */
export const REVEAL_HOLD_MS = 250
/** §3.8 phase 1 — the fog-lift window (the drain denominator flips at its start). */
export const REVEAL_GUST_MS = 1200
/** §3.8 phase 2 — settle + title fade-in. */
export const REVEAL_SETTLE_MS = 1200
/** §3.8 phase 3 — the layout resolve (panes ease / drawer arrives). */
export const REVEAL_RESOLVE_MS = 800
/** §3.8 reduced-motion path — the one-shot surface fade. */
export const REVEAL_REDUCED_FADE_MS = 300

const PHASE_ORDER: readonly RevealPhase[] = ['hold', 'gust', 'settle', 'resolve', 'done']

/** Whether `phase` is at/past `from` in the §3.8 walk — the one comparison every
 *  phase-staged consumer needs (drawer mount timing, fog denominator flips). */
export function revealPhaseAtLeast(phase: RevealPhase, from: RevealPhase): boolean {
  return PHASE_ORDER.indexOf(phase) >= PHASE_ORDER.indexOf(from)
}

/** The walk's cumulative schedule: [phase it advances to, ms after the latch]. */
const WALK: readonly (readonly [RevealPhase, number])[] = [
  ['gust', REVEAL_HOLD_MS],
  ['settle', REVEAL_HOLD_MS + REVEAL_GUST_MS],
  ['resolve', REVEAL_HOLD_MS + REVEAL_GUST_MS + REVEAL_SETTLE_MS],
  ['done', REVEAL_HOLD_MS + REVEAL_GUST_MS + REVEAL_SETTLE_MS + REVEAL_RESOLVE_MS],
]

interface MomentState {
  phase: RevealPhase
  instant: boolean
  /** The moment is over (or never existed): skip listeners off, timeline dead. */
  settled: boolean
  /** Reduced-motion entry: true for the pre-fade first frame (wrapper transparent). */
  entering: boolean
}

/** The state a mount that never plays renders — and the state every played
 *  mount must END in (the tests pin the equivalence). */
const NEVER_PLAYED: MomentState = { phase: 'done', instant: true, settled: true, entering: false }

export function RevealTransition({
  play,
  reducedMotion = false,
  onDone,
  children,
  'data-testid': dataTestId,
}: RevealTransitionProps) {
  // The play latch: the FIRST true wins, sampled at mount and per-render. A
  // ref (not state) — latching must not re-render, and later `play` flips are
  // meaningless once the walk is scheduled.
  const playedRef = useRef(false)
  const [state, setState] = useState<MomentState>(() => {
    if (!play) return NEVER_PLAYED
    playedRef.current = true
    return reducedMotion
      ? { phase: 'done', instant: false, settled: false, entering: true }
      : { phase: 'hold', instant: false, settled: false, entering: false }
  })
  const onDoneRef = useRef(onDone)
  onDoneRef.current = onDone
  // The skip's synchronous latch. `state.settled` only commits on re-render, so
  // two skip triggers in one tick (a pointer-down and a key-down before React
  // flushes) would both read it false and double-fire onDone. This ref lands
  // synchronously, collapsing the burst to a single skip.
  const skippedRef = useRef(false)

  // The timeline — scheduled once, on whichever render first latched (mount
  // above, or a later play=true via this effect). All timers die on unmount;
  // a skip marks `settled`, which cancels them via the cleanup re-run.
  const [armed, setArmed] = useState(play)
  useEffect(() => {
    if (play && !playedRef.current) {
      playedRef.current = true
      setState(
        reducedMotion
          ? { phase: 'done', instant: false, settled: false, entering: true }
          : { phase: 'hold', instant: false, settled: false, entering: false },
      )
      setArmed(true)
    }
  }, [play, reducedMotion])

  useEffect(() => {
    if (!armed || state.settled) return
    if (reducedMotion) {
      // The surface fade: transparent first frame → visible next macrotask →
      // the moment ends when the fade's clock runs out.
      const enter = setTimeout(() => {
        setState((s) => ({ ...s, entering: false }))
      }, 0)
      const finish = setTimeout(() => {
        setState((s) => ({ ...s, settled: true }))
        onDoneRef.current?.()
      }, REVEAL_REDUCED_FADE_MS)
      return () => {
        clearTimeout(enter)
        clearTimeout(finish)
      }
    }
    const timers = WALK.map(([phase, atMs]) =>
      setTimeout(() => {
        setState((s) => ({ ...s, phase, settled: phase === 'done' }))
        if (phase === 'done') onDoneRef.current?.()
      }, atMs),
    )
    return () => {
      for (const id of timers) clearTimeout(id)
    }
    // The walk is anchored to the LATCH, not re-derived per render: `state.settled`
    // only flips once (skip/finish) and `reducedMotion` is fixed for a played moment.
  }, [armed, state.settled])

  // The skip: while the moment is live, ANY pointer-down or key-down lands the
  // consumer in the final state, hard (instant — transitions cut). Captured on
  // window so a tap into the graph/drawer both skips AND does its final-state
  // work; never preventDefault'ed.
  useEffect(() => {
    if (state.settled) return
    const skip = (): void => {
      if (skippedRef.current) return
      skippedRef.current = true
      setState({ phase: 'done', instant: true, settled: true, entering: false })
      onDoneRef.current?.()
    }
    window.addEventListener('pointerdown', skip, true)
    window.addEventListener('keydown', skip, true)
    return () => {
      window.removeEventListener('pointerdown', skip, true)
      window.removeEventListener('keydown', skip, true)
    }
  }, [state.settled])

  const moment: RevealMoment = { phase: state.phase, instant: state.instant }
  // The wrapper is visual ONLY on the reduced-motion entry (the §3.8 ~300ms
  // cross-fade); every other path renders it inert. Opacity-only — the brand's
  // one sanctioned motion; base.css collapses it under a real OS preference.
  const fading = armed && reducedMotion && !state.instant
  return (
    <div
      {...(dataTestId !== undefined ? { 'data-testid': dataTestId } : {})}
      data-reveal-phase={state.phase}
      className={cn(fading && 'transition-opacity', fading && (state.entering ? 'opacity-0' : 'opacity-100'))}
      style={fading ? { transitionDuration: `${String(REVEAL_REDUCED_FADE_MS)}ms`, transitionTimingFunction: 'var(--ease-out)' } : undefined}
    >
      {children(moment)}
    </div>
  )
}

// ── RevealPanes — the desktop layout arrival (§3.8 phase 3) ──────────────────
//
// Before `resolve` the stage owns the full width (the generating act's
// geometry). At `resolve` two things compose the arrival:
//  - the cells RE-SEAT in one step (the panel cell flips 0 → equal-grow, the
//    gutter opens): the graph's canvases re-derive their pane-adaptive virtual
//    space once and the FORCE-SIM visibly re-flows the world into its half —
//    an organic re-seat through the graph's own machinery, never a crop. The
//    seat is deliberately NOT width-animated: a continuously-resizing canvas
//    is CLEARED by every backing-store re-size after its frame's repaint
//    (rAF → ResizeObserver → paint), so an eased width blanks the world for
//    the whole slide (caught on the D6 sequence capture).
//  - the wiki SLIDES in from the right edge over the resolve window — a pure
//    transform inside the overflow-hidden cell (the Drawer's own arrival
//    vocabulary), its content laid out at the cell's final width throughout
//    (`50cqi − half the gutter`, container-query units off this frame), so
//    nothing re-wraps mid-slide.
// At `done` the frame IS the §4.1 true 50/50: two equal-grow min-width-0
// cells and the `--space-4` gutter — the same track behavior as
// `Grid columns={2}` — with every moment style dropped (natural responsive
// layout). The panel contributes layout height from the first frame, so no
// phase boundary shifts the page. An `instant` moment renders the end state
// with no transition (the hard skip landing).
//
// THE ROW OWNS THE VERTICAL SPACE (MYT-89 audit v3): the frame carries a
// viewport-derived height — the reveal composition is landscape-shaped, the
// graph half FILLS it (the graph's `fillHost` mode) and the wiki half CAPS to
// it (WorldWiki's own max-h-full stack) and scrolls internally, so a long wiki
// page can never stretch the row. The height lives HERE, not on the graph
// pane, because a flex row's auto height is content-circular: a definite row
// height is the only way one half can cap while the other fills. Since ux-run2
// myth-ma8yv the stage cell is a flex COLUMN and the consumer composes the
// whole left column inside it (title over graph over the Continue row), so the
// two panes share both alignment edges — the wiki's top lands on the title's
// line and its bottom on the Continue row's line (the "spread in a book"
// rhythm, critique 018). The chrome allowance (8.5rem) is therefore only the
// app frame's fixed dressing — header + hairline + the page paddings; the
// floor keeps short windows usable (the page scrolls instead of crushing the
// graph), the ceiling keeps giant monitors landscape-shaped.

/** The panel content's fixed final width: half this frame minus half the gutter. */
const PANEL_FINAL_WIDTH = 'calc(50cqi - calc(var(--space-4) / 2))'

/** The row's viewport-derived height (see "THE ROW OWNS THE VERTICAL SPACE"). */
const ROW_HEIGHT_CLASS = 'h-[clamp(24rem,calc(100dvh-8.5rem),72rem)]'

export function RevealPanes({ moment, stage, panel, 'data-testid': dataTestId }: RevealPanesProps) {
  const arrived = revealPhaseAtLeast(moment.phase, 'resolve')
  const slideStyle: React.CSSProperties | undefined =
    moment.phase === 'done'
      ? undefined
      : {
          width: PANEL_FINAL_WIDTH,
          transform: arrived ? 'translateX(0)' : 'translateX(100%)',
          transition: moment.instant
            ? 'none'
            : `transform ${String(REVEAL_RESOLVE_MS)}ms var(--ease-out)`,
        }
  return (
    <div
      {...(dataTestId !== undefined ? { 'data-testid': dataTestId } : {})}
      className={cn('flex min-w-0 [container-type:inline-size]', ROW_HEIGHT_CLASS)}
      style={{ columnGap: arrived ? 'var(--space-4)' : '0px' }}
    >
      {/* A flex COLUMN cell (definite height via the row's stretch), so the
          consumer's stage — a grow Stack composing title / graph / Continue —
          fills the full pane height and the graph's h-full fill resolves. */}
      <div className="flex min-w-0 grow basis-0 flex-col">{stage}</div>
      <div className="min-w-0 basis-0 overflow-hidden" style={{ flexGrow: arrived ? 1 : 0 }}>
        {/* h-full in EVERY phase: the wiki's max-h-full must bind mid-slide too. */}
        <div className="h-full" style={slideStyle}>{panel}</div>
      </div>
    </div>
  )
}

// ── RevealFade — the phase-keyed chrome fade (§3.8 phases 2–3) ───────────────
//
// Wraps chrome that ARRIVES at a phase (the title at `settle`, the explore
// prompt at `resolve`) in a whole-block opacity fade — the card pulse's
// vocabulary, the brand's one sanctioned motion. Space is reserved from the
// first frame (opacity only, zero mid-moment layout shift) and the content
// stays in the accessibility tree throughout (the moment is decorative; AT
// reads the full document immediately). An `instant` moment lands hard.

export function RevealFade({ moment, visibleFrom, children, 'data-testid': dataTestId }: RevealFadeProps) {
  const visible = revealPhaseAtLeast(moment.phase, visibleFrom)
  return (
    <div
      {...(dataTestId !== undefined ? { 'data-testid': dataTestId } : {})}
      className={cn('transition-opacity', visible ? 'opacity-100' : 'opacity-0')}
      style={
        moment.instant
          ? { transition: 'none' }
          : { transitionDuration: 'var(--duration-slow)', transitionTimingFunction: 'var(--ease-out)' }
      }
    >
      {children}
    </div>
  )
}
