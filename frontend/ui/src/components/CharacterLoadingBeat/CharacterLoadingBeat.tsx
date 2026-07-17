import { forwardRef } from 'react'
import type { CharacterLoadingBeatProps } from '@mythrun/client-core/contract'
import { cn } from '../../lib/cn.ts'
import { Dither } from '../Dither/Dither.tsx'
import { VisuallyHidden } from '../VisuallyHidden/VisuallyHidden.tsx'

// CharacterLoadingBeat (MYT-90 character creation) — the "coming into being" beat
// that holds the screen while the pipeline generates the sheet. It is the SHIPPED
// world-gen loading register (paper / 1-bit — NOT voxel/3D): a squared silhouette
// that FILLS IN beside a column of surfacing text rows. Pure/presentational — it
// renders from `beats` + `reducedMotion` and owns no timing; the client-core
// view-model advances each beat pending → active → done and the fill/rows follow.
//
// THE FIGURE (the mockup's `.fig`): a fixed 1-bit ink-on-paper artifact — a solid
// head square + a hollow torso outline drawn in ink, over which a DITHER HATCH
// rises from the base. The fill height is (# beats done) / (# beats total); as
// beats resolve, the character materialises from the feet up. The hatch reuses the
// shipped `Dither` (the brand's only sanctioned gradient — a 4×4-Bayer paper→ink
// band) UNCHANGED: it is anchored at the figure base inside an overflow-clipped
// fill box, so a taller fill simply reveals more of the same band (dense ink at the
// base fading upward). The figure is intentionally theme-INVARIANT — it uses the
// frozen `--color-paper-*` palette tokens (as the Dither's own colors are frozen at
// light), reading as a deliberate 1-bit relic in both light and dark, framed by the
// theme-aware card around it. It is decoration → `aria-hidden`.
//
// THE ROWS (the mockup's `.rows`): the beats as a mono column. `done` rows read
// solid ink, `active` is emphasised in ember, `pending` is dimmed — they surface
// one at a time as the parent advances their state. A fixed mono eyebrow names the
// beat ("bringing them to life…"); it is not in the contract, so it is fixed chrome
// (a `[ph:]` interim string, like WorldGenLoading's watch label) — if strict i18n
// later wants it shell-owned, the contract grows an eyebrow prop.
//
// REDUCED MOTION: `reducedMotion` (a prop — the platform-neutral flag, not a media
// query read here) drops every transition. The fill snaps to its proportion and the
// rows swap state with no fade; nothing churns. a11y: the whole surface is
// `aria-busy` while any beat is unfinished, and an SR-only polite live region
// announces the ACTIVE beat's label (the figure + rows are aria-hidden decoration,
// so the live region is the single source of truth for AT).

// Fixed interim chrome — the beat's eyebrow. Not carried by the contract, so it is
// a `[ph:]` placeholder (the deliberate pre-copy-pass convention), not real copy.
const LOADING_HEADING = '[ph: bringing them to life…]'

// The loadwrap: a theme-aware paper card holding the figure + the text column, a
// flex row that collapses gracefully at ~375px (the text column is min-w-0).
const WRAP_CLASS = cn(
  'flex min-w-0 items-center gap-[var(--space-5)] rounded-none border border-border bg-surface',
  'p-[var(--space-4)]',
)

// The figure box — a fixed 80×120 1-bit tile. `overflow-hidden` clips the rising
// fill (and the oversized dither band) to the silhouette. Ink-on-paper via the
// FROZEN ramp utilities (`bg-paper-50` / `paper-900` — the same non-flipping idiom
// as Divider's ink line), so it reads identically in light + dark, matching the
// Dither's own frozen colors.
const FIG_CLASS =
  'relative block h-[120px] w-[80px] flex-none overflow-hidden border-[1.5px] border-paper-900 bg-paper-50'
// The solid ink head (top-centre square) — always present, the silhouette's anchor.
const HEAD_CLASS = 'absolute left-1/2 top-[14px] h-[26px] w-[26px] -translate-x-1/2 bg-paper-900'
// The hollow ink torso outline — always present; the fill rises behind/through it.
const TORSO_CLASS =
  'absolute left-1/2 top-[42px] h-[52px] w-[44px] -translate-x-1/2 border-[1.5px] border-paper-900'
// The rising fill — bottom-anchored, its block-size the done/total proportion,
// overflow-clipped so it reveals the base of the dither band. Height animates by
// default; `reducedMotion` snaps it.
const FILL_CLASS = 'absolute inset-x-0 bottom-0 overflow-hidden'
const FILL_ANIM_CLASS = 'transition-[height] duration-[var(--duration-slow)] ease-out'
// The dither hatch, sized to the full figure and pinned to its base so the fill's
// overflow-clip reveals it bottom-up. Centred over the narrow figure (the band's
// cross-axis min-width exceeds 80px; the surplus is clipped).
const DITHER_WRAP_CLASS = 'absolute inset-x-0 bottom-0 left-1/2 -translate-x-1/2'

// The text column — the eyebrow + the surfacing beat rows + the countdown.
const TEXT_CLASS = 'flex min-w-0 flex-col gap-[var(--space-2)]'
// The ticking `~M:SS` wait (MYT-102) — the WorldGenLoading countdown register:
// quiet tertiary ink, tabular digits so the per-second tick never jitters the
// column. aria-hidden like the rows — the SR live region stays the single AT
// source of truth (a per-second churn must never spam a live region). NOT
// gated on reducedMotion: the changing number is CONTENT (the remaining wait),
// not decoration — freezing it would show a wrong number. `break-words` keeps
// an over-long label (a verbose locale; the raw-key [ph:] era) wrapping inside
// the narrow text column instead of spilling its box at 375px (the overflow
// gate's intra-row check).
const COUNTDOWN_CLASS = 'font-ui text-xs tabular-nums text-ink-tertiary break-words'
const HEADING_CLASS = 'font-ui text-xs uppercase tracking-wide text-accent-fg'
const ROWS_CLASS = 'flex flex-col gap-[var(--space-1)]'
const ROW_CLASS = 'font-ui text-sm leading-[1.4]'
const ROW_ANIM_CLASS = 'transition-opacity duration-[var(--duration-fast)]'
// Per-state row treatment: done = solid ink, active = emphasised ember, pending =
// the muted tertiary ink token. `--ink-tertiary` (paper-600) is a SOLID AA color on
// paper (~5.7:1); the state stays distinct via token + weight, NOT a sub-AA opacity
// dim (an `opacity-60` here rendered the row at #a09b8d = 2.52:1, below the 4.5:1
// contrast floor — the real progress rows carry information, so they meet contrast).
const ROW_STATE_CLASS: Record<CharacterLoadingBeatProps['beats'][number]['state'], string> = {
  done: 'text-ink',
  active: 'font-medium text-accent-fg',
  pending: 'text-ink-tertiary',
}

export const CharacterLoadingBeat = forwardRef<HTMLDivElement, CharacterLoadingBeatProps>(
  function CharacterLoadingBeat({ beats, reducedMotion, countdownLabel }, ref) {
    const total = beats.length
    const doneCount = beats.filter((beat) => beat.state === 'done').length
    // Fill proportion as an integer percent — the mechanical done/total ratio (no
    // rounding surprises: 0 beats → 0%). Drives both the height style + the
    // test/inspection hook.
    const fillPct = total > 0 ? Math.round((doneCount / total) * 100) : 0
    // Busy until every beat is done; the active beat (if any) is what AT hears.
    const busy = beats.some((beat) => beat.state !== 'done')
    const activeLabel = beats.find((beat) => beat.state === 'active')?.label ?? ''
    const animate = !reducedMotion

    return (
      <div
        ref={ref}
        data-testid="character-loading-beat"
        data-reduced-motion={reducedMotion}
        aria-busy={busy}
        className={WRAP_CLASS}
      >
        {/* The single AT source of truth: the figure + rows are decoration, so a
            polite live region carries the active beat's label. */}
        <VisuallyHidden>
          <span role="status" aria-live="polite" data-testid="character-loading-beat-live">
            {activeLabel}
          </span>
        </VisuallyHidden>

        {/* The 1-bit figure coming into being — decorative. */}
        <div data-testid="character-loading-beat-figure" aria-hidden="true" className={FIG_CLASS}>
          <div className={TORSO_CLASS} />
          <div className={HEAD_CLASS} />
          <div
            data-testid="character-loading-beat-fill"
            data-fill-pct={fillPct}
            className={cn(FILL_CLASS, animate && FILL_ANIM_CLASS)}
            style={{ height: `${String(fillPct)}%` }}
          >
            <div className={DITHER_WRAP_CLASS}>
              <Dither from="paper-100" to="paper-900" direction="vertical" scale="preview" />
            </div>
          </div>
        </div>

        {/* The surfacing beat rows. */}
        <div className={TEXT_CLASS}>
          <p aria-hidden="true" className={HEADING_CLASS}>
            {LOADING_HEADING}
          </p>
          <ul className={ROWS_CLASS} aria-hidden="true">
            {beats.map((beat) => (
              <li
                key={beat.id}
                data-testid="character-loading-beat-row"
                data-beat-id={beat.id}
                data-state={beat.state}
                className={cn(ROW_CLASS, ROW_STATE_CLASS[beat.state], animate && ROW_ANIM_CLASS)}
              >
                {beat.label}
              </li>
            ))}
          </ul>
          {/* The remaining-wait countdown — present only with a usable estimate
              (the contract OMITS the prop on cold-start; no fake numbers). */}
          {countdownLabel !== undefined && (
            <p
              aria-hidden="true"
              data-testid="character-loading-beat-countdown"
              className={COUNTDOWN_CLASS}
            >
              {countdownLabel}
            </p>
          )}
        </div>
      </div>
    )
  },
)
