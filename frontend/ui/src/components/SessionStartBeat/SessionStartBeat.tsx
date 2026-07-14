import { forwardRef } from 'react'
import type { SessionStartBeatProps } from '@mythrun/client-core/contract'
import { cn } from '../../lib/cn.ts'
import { Dither } from '../Dither/Dither.tsx'
import { VisuallyHidden } from '../VisuallyHidden/VisuallyHidden.tsx'

// SessionStartBeat (MYT-92 live play) — the beat that holds the screen between
// pressing Start and the first DM token. It is the SHIPPED 1-bit loading-beat
// register (paper / ordered-Bayer hatch — NOT voxel/3D), the same figure/Dither
// idiom as CharacterLoadingBeat: a squared silhouette that FILLS from the base
// beside a mono column of surfacing rows. Pure/presentational — it renders from
// `phase` + `reducedMotion` and owns no timing; the play route advances the phase.
//
// ONE BEAT, TWO LABELED PHASES (spec §2): `prep` — the SSE-driven atmospheric
// "the DM is preparing tonight's session…" 1–2 minute wait — and `connecting`, the
// short socket-connect boundary. The two phases render as a two-row itinerary
// (prep, then connecting); the current `phase` drives each row's derived state:
//   prep       → prep = active,  connecting = pending
//   connecting → prep = done,    connecting = active
// so the beat ACCELERATES TOWARD COMPLETION — the hatch is partway up in `prep`
// and rises to full on `connecting` (an ease-IN transition: the fill speeds up as
// it lands). There is no numeric progress signal on the wire; the phase IS the
// progress. `reducedMotion` drops the transition so the beat LANDS INSTANTLY at
// its phase proportion — no churn.
//
// THE FIGURE: a fixed 1-bit ink-on-paper tile — a squared frame over which a
// DITHER HATCH rises from the base (the shipped `Dither`, the brand's only
// sanctioned gradient, UNCHANGED — a 4×4-Bayer paper→ink band anchored at the
// figure base inside an overflow-clipped fill box, so a taller fill reveals more
// of the same band). Theme-INVARIANT by design — the frozen `--color-paper-*`
// tokens (as the Dither's own colors are frozen at light), a deliberate 1-bit
// relic framed by the theme-aware card around it. Decoration → `aria-hidden`.
//
// THE ROWS: the two phases as a mono column. `done` reads solid ink, `active` is
// emphasised in ember, `pending` is the SOLID tertiary-ink token — NOT a sub-AA
// `opacity` dim (an `opacity-60` here rendered #a09b8d = 2.52:1, below the 4.5:1
// floor: the CharacterLoadingBeat contrast lesson — progress rows carry meaning,
// so they meet contrast). A fixed mono eyebrow names the beat (`[ph:]` interim
// chrome, like CharacterLoadingBeat's — not carried by the contract).
//
// a11y: the whole surface is `aria-busy` while mounted (the parent unmounts it
// when play begins); the figure + rows are `aria-hidden` decoration, so an SR-only
// polite live region announces the ACTIVE phase's label as the single AT source of
// truth (motion is never the sole signal).

// Fixed interim chrome — the beat's eyebrow. Not carried by the contract, so it is
// a `[ph:]` placeholder (the deliberate pre-copy-pass convention), not real copy.
const START_HEADING = '[ph: the table gathers…]'

// The fill proportion per phase: `prep` is well underway (the long atmospheric
// wait), `connecting` lands at completion. The prep→connecting rise is the beat
// "accelerating toward completion".
const FILL_PCT: Record<SessionStartBeatProps['phase'], number> = {
  prep: 58,
  connecting: 100,
}

// The loadwrap: a theme-aware paper card holding the figure + the text column, a
// flex row that collapses gracefully at ~375px (the text column is min-w-0).
const WRAP_CLASS = cn(
  'flex min-w-0 items-center gap-[var(--space-5)] rounded-none border border-border bg-surface',
  'p-[var(--space-4)]',
)

// The figure box — a fixed 80×120 1-bit tile. `overflow-hidden` clips the rising
// fill (and the oversized dither band) to the frame. Ink-on-paper via the FROZEN
// ramp utilities (`bg-paper-50` / `paper-900` — the same non-flipping idiom as
// Divider's ink line), so it reads identically in light + dark.
const FIG_CLASS =
  'relative block h-[120px] w-[80px] flex-none overflow-hidden border-[1.5px] border-paper-900 bg-paper-50'
// The rising fill — bottom-anchored, its block-size the phase proportion,
// overflow-clipped so it reveals the base of the dither band. Height eases IN by
// default (accelerating as it lands); `reducedMotion` snaps it.
const FILL_CLASS = 'absolute inset-x-0 bottom-0 overflow-hidden'
const FILL_ANIM_CLASS = 'transition-[height] duration-[var(--duration-slow)] ease-in'
// The dither hatch, sized to the full figure and pinned to its base so the fill's
// overflow-clip reveals it bottom-up. Centred over the narrow figure (the band's
// cross-axis min-width exceeds 80px; the surplus is clipped).
const DITHER_WRAP_CLASS = 'absolute inset-x-0 bottom-0 left-1/2 -translate-x-1/2'

// The text column — the eyebrow + the two phase rows.
const TEXT_CLASS = 'flex min-w-0 flex-col gap-[var(--space-2)]'
const HEADING_CLASS = 'font-ui text-xs uppercase tracking-wide text-accent-fg'
const ROWS_CLASS = 'flex flex-col gap-[var(--space-1)]'
const ROW_CLASS = 'font-ui text-sm leading-[1.4]'
const ROW_ANIM_CLASS = 'transition-opacity duration-[var(--duration-fast)]'

// A phase row is `done` (already crossed), `active` (the current phase), or
// `pending` (still ahead). Per-state treatment: done = solid ink, active =
// emphasised ember, pending = the muted-but-SOLID tertiary-ink token (~5.7:1 on
// paper — the state stays distinct via token + weight, never a sub-AA opacity dim).
type RowState = 'done' | 'active' | 'pending'
const ROW_STATE_CLASS: Record<RowState, string> = {
  done: 'text-ink',
  active: 'font-medium text-accent-fg',
  pending: 'text-ink-tertiary',
}

/** The two phase rows in itinerary order, each with its state derived from the
 *  active `phase` — prep resolves as the beat advances to connecting. */
function phaseRows(
  phase: SessionStartBeatProps['phase'],
  prepLabel: string,
  connectingLabel: string,
): { phase: SessionStartBeatProps['phase']; label: string; state: RowState }[] {
  return [
    { phase: 'prep', label: prepLabel, state: phase === 'prep' ? 'active' : 'done' },
    { phase: 'connecting', label: connectingLabel, state: phase === 'connecting' ? 'active' : 'pending' },
  ]
}

export const SessionStartBeat = forwardRef<HTMLDivElement, SessionStartBeatProps>(
  function SessionStartBeat({ phase, reducedMotion, prepLabel, connectingLabel }, ref) {
    const fillPct = FILL_PCT[phase]
    // The active phase's label is the single AT source of truth.
    const activeLabel = phase === 'prep' ? prepLabel : connectingLabel
    const rows = phaseRows(phase, prepLabel, connectingLabel)
    const animate = !reducedMotion

    return (
      <div
        ref={ref}
        data-testid="session-start-beat"
        data-phase={phase}
        data-reduced-motion={reducedMotion}
        aria-busy={true}
        className={WRAP_CLASS}
      >
        {/* The single AT source of truth: the figure + rows are decoration, so a
            polite live region carries the active phase's label. */}
        <VisuallyHidden>
          <span role="status" aria-live="polite" data-testid="session-start-beat-live">
            {activeLabel}
          </span>
        </VisuallyHidden>

        {/* The 1-bit figure filling toward the session — decorative. */}
        <div data-testid="session-start-beat-figure" aria-hidden="true" className={FIG_CLASS}>
          <div
            data-testid="session-start-beat-fill"
            data-fill-pct={fillPct}
            className={cn(FILL_CLASS, animate && FILL_ANIM_CLASS)}
            style={{ height: `${String(fillPct)}%` }}
          >
            <div className={DITHER_WRAP_CLASS}>
              <Dither from="paper-100" to="paper-900" direction="vertical" scale="preview" />
            </div>
          </div>
        </div>

        {/* The two phase rows. */}
        <div className={TEXT_CLASS}>
          <p aria-hidden="true" className={HEADING_CLASS}>
            {START_HEADING}
          </p>
          <ul className={ROWS_CLASS} aria-hidden="true">
            {rows.map((row) => (
              <li
                key={row.phase}
                data-testid="session-start-beat-row"
                data-phase={row.phase}
                data-state={row.state}
                className={cn(ROW_CLASS, ROW_STATE_CLASS[row.state], animate && ROW_ANIM_CLASS)}
              >
                {row.label}
              </li>
            ))}
          </ul>
        </div>
      </div>
    )
  },
)
