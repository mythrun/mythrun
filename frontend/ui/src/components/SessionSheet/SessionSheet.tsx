import { forwardRef } from 'react'
import type {
  SessionSheetPanelProps,
  AbilityTile,
  SheetEntry,
  SheetStat,
  SheetStatKey,
  CharacterOverlay,
} from '@mythrun/client-core/contract'
import { cn } from '../../lib/cn.ts'
import { Stack } from '../Stack/Stack.tsx'
import { Heading } from '../Heading/Heading.tsx'

// SessionSheet (MYT-94, spec §6) — the in-session variant of the member's own
// curated sheet, mounted in the play sidebar's "Character Sheet" tab. It renders the
// SAME field-guide body as CharacterSheetReveal (identity line, the AC/HP/… stat
// stripe, six square ability tiles, connection prose, and the "what they can do /
// carry / cast" panels) but STRIPS the creation-flow chrome — no "This is me" /
// "Start over" / "See full sheet" affordances (those are the meet-your-character
// payoff, wrong mid-session). It is fully read-only: no buttons, no callbacks.
//
// Over that static sheet it folds the LIVE character-state overlay (Task 5's
// `CharacterOverlay`, folded from `ledger_update` frames): when `overlay.hp` is
// non-null the HP stat shows the authoritative live `hp / maxHp` in place of the
// base sheet's static HP cell, and the condition log renders as a quiet
// chronological "recent changes" list (prose lines — a LOG, never status chips;
// the frame carries no add/remove flag, so a maintained active-condition set is a
// filed follow-up). When the log is empty the calm `emptyLabel` line stands in.
//
// Register (flat 1-bit / paper / SQUARE), mirroring the reveal: `rounded-none`,
// token edges, NO circles/dots/chips — state reads as TEXT/DATA. Ember accent for
// the identity eyebrow, ability modifiers, and panel labels. Single vertical column
// throughout: this sheet lives inside a narrow (~30%) sidebar rail and the mobile
// Drawer, where the reveal's viewport-breakpoint two-column grid would crowd — a
// single Stack holds cleanly from the rail down to ~375px (every child min-w-0 via
// Stack, so long prose never forces a horizontal scroll).
//
// Standalone (not a refactor of the shipped CharacterSheetReveal): the presentation
// idiom is mirrored here rather than extracted into a shared body, per the plan's
// Task-12 flag (the controller scoped this surface to SessionSheet/ only). The panel
// TITLES + the 'HP' stat key are fixed brand chrome that mirror the reveal's own
// documented fixed chrome (the contract carries only the live-overlay labels).

// Fixed brand chrome — mirrors CharacterSheetReveal's panel titles (the contract
// carries no per-panel copy; MYT-100 is the copy pass if these ever go shell-owned).
const FEATURES_TITLE = 'What they can do'
const EQUIPMENT_TITLE = 'What they carry'
const SPELLS_TITLE = 'What they can cast'

// The stat cell the live-HP overlay replaces — matched on the view-model's
// STRUCTURAL key (myth-qeyqq), never on the 'HP' label string it happens to
// carry. Keying on the copy meant a rename in `buildStats` would switch the
// live overlay off in silence, leaving a player reading stale hit points off
// the sheet mid-combat with nothing to show for it.
const HP_STAT_KEY: SheetStatKey = 'hp'

// The identity eyebrow — mono uppercase ember, the machine line under the serif name.
const IDENT_CLASS = 'font-ui text-sm font-medium uppercase tracking-wide text-accent-fg'

// The AC / HP / Proficiency / Hit Die / Speed stripe — a bordered row that WRAPS at
// narrow widths (each cell floors at its own content width). Strong edge; hairline
// inter-cell rules. Matches the reveal's stripe so the two sheets read as one object.
const STRIPE_CLASS = 'flex flex-wrap rounded-none border border-border-strong bg-surface'
const STRIPE_CELL =
  'min-w-fit flex-1 border-r border-border px-[var(--space-3)] py-[var(--space-2)] last:border-r-0'
const STRIPE_KEY = 'font-ui text-xs uppercase tracking-wide text-ink-tertiary'
const STRIPE_VALUE = 'font-body text-lg font-semibold text-ink'

// The six ability tiles — a 3-up square grid (two rows), holding down to ~375px.
const ABILITIES_CLASS = 'grid grid-cols-3 gap-[var(--space-2)]'
const ABILITY_TILE_CLASS = cn(
  'flex flex-col items-center gap-[var(--space-1)] rounded-none border border-border-strong bg-surface',
  'px-[var(--space-2)] py-[var(--space-3)] text-center',
)
const ABILITY_ABBREV_CLASS = 'font-ui text-xs uppercase tracking-wide text-ink-tertiary'
const ABILITY_SCORE_CLASS = 'font-body text-2xl font-semibold leading-[1.1] text-ink'
const ABILITY_MOD_CLASS = 'font-ui text-sm text-accent-fg'

// The connection prose — generous serif, the emotional centre (non-color arbitrary
// values → R3-allowed), matching the reveal's payoff text.
const PROSE_CLASS = 'font-body text-[1.05rem] leading-[1.65] text-ink'

// A titled panel — a hairline-edged paper card with a mono ember header rule over a
// list of name (+ optional quiet gloss) rows. Shared by the curated panels AND the
// condition-log "recent changes" panel.
const PANEL_CLASS = 'rounded-none border border-border bg-surface'
const PANEL_TITLE_CLASS =
  'border-b border-border px-[var(--space-3)] py-[var(--space-2)] font-ui text-xs uppercase tracking-wide text-accent-fg'
const PANEL_LIST_CLASS = 'flex list-none flex-col px-[var(--space-3)] py-[var(--space-1)]'
const PANEL_ITEM_CLASS = 'border-b border-border py-[var(--space-2)] last:border-b-0'
const PANEL_ITEM_NAME = 'block font-body text-sm font-semibold text-ink'
const PANEL_ITEM_GLOSS = 'mt-[2px] block font-body text-xs text-ink-tertiary'
// The "what they can do" gloss is canonical SRD rule text in the SECOND person under
// a THIRD-person title — frame and fill disagree (MYT-olo9c). Mirrors the reveal's
// mitigation: distance the feature gloss into a quoted rule reference (hanging left
// rule + italic + muted) so it reads as a rulebook quotation, not the character's
// portrait. Deep fix (a Haiku third-person rewrite in char-gen) is deferred; this
// changes NO authored copy.
const PANEL_ITEM_GLOSS_RULE =
  'mt-[var(--space-1)] block border-l-2 border-border pl-[var(--space-2)] font-body text-xs italic text-ink-tertiary'

// One condition-log line — quiet serif prose (a recent-change note, not a badge).
const LOG_ITEM_CLASS = 'border-b border-border py-[var(--space-2)] font-body text-sm text-ink last:border-b-0'
// The calm empty-state line — a low-key mono note when nothing has changed yet.
const EMPTY_CLASS = 'font-ui text-sm text-ink-tertiary'

/** Format an ability modifier with an explicit sign — `+3`, `+0`, `−1` (the mono
 * typographic minus, matching the machine register). */
function formatModifier(modifier: number): string {
  return modifier >= 0 ? `+${String(modifier)}` : `−${String(Math.abs(modifier))}`
}

/** The live HP readout — `12 / 28`, or just the current value when the overlay
 * carries no maxHp (defensive; the hp frame normally carries both). */
function formatLiveHp(hp: number, maxHp: number | null): string {
  return maxHp !== null ? `${String(hp)} / ${String(maxHp)}` : String(hp)
}

/** One square ability tile — abbrev, score, signed modifier. No circle. */
function AbilityTileView({ tile }: { tile: AbilityTile }): React.JSX.Element {
  return (
    <div data-testid="session-sheet-ability" data-abbrev={tile.abbrev} className={ABILITY_TILE_CLASS}>
      <span className={ABILITY_ABBREV_CLASS}>{tile.abbrev}</span>
      <span className={ABILITY_SCORE_CLASS}>{tile.score}</span>
      <span className={ABILITY_MOD_CLASS}>{formatModifier(tile.modifier)}</span>
    </div>
  )
}

/** A titled panel of name (+ optional gloss) rows. `glossAsRule` distances the gloss
 *  into a quoted rule reference (the features panel's SRD 2nd-person bodies). */
function EntryPanel({
  title,
  entries,
  testid,
  glossAsRule = false,
}: {
  title: string
  entries: SheetEntry[]
  testid: string
  glossAsRule?: boolean
}): React.JSX.Element {
  return (
    <div data-testid={testid} className={PANEL_CLASS}>
      {/* A category label, not a document heading — styled non-heading so it never
          breaks the page's heading order (the name is the one real heading). */}
      <p className={PANEL_TITLE_CLASS}>{title}</p>
      <ul className={PANEL_LIST_CLASS}>
        {entries.map((entry) => (
          <li key={entry.name} className={PANEL_ITEM_CLASS}>
            <span className={PANEL_ITEM_NAME}>{entry.name}</span>
            {entry.gloss !== undefined && (
              <span className={glossAsRule ? PANEL_ITEM_GLOSS_RULE : PANEL_ITEM_GLOSS}>{entry.gloss}</span>
            )}
          </li>
        ))}
      </ul>
    </div>
  )
}

/** The AC / HP / … stripe, with the HP cell overlaid by the live overlay when
 * `overlay.hp` is set (live label + live `hp / maxHp` in place of the static cell). */
function StatStripe({
  stats,
  overlay,
  hpLabel,
}: {
  stats: SheetStat[]
  overlay: CharacterOverlay
  hpLabel: string
}): React.JSX.Element {
  return (
    <div data-testid="session-sheet-stripe" className={STRIPE_CLASS}>
      {stats.map((stat) => {
        const isHp = stat.key === HP_STAT_KEY
        const live = isHp && overlay.hp !== null
        const value = isHp && overlay.hp !== null ? formatLiveHp(overlay.hp, overlay.maxHp) : stat.value
        return (
          <div
            key={stat.key}
            data-testid={isHp ? 'session-sheet-hp' : undefined}
            data-live={isHp ? String(live) : undefined}
            className={STRIPE_CELL}
          >
            <div className={STRIPE_KEY}>{live ? hpLabel : stat.label}</div>
            <div className={STRIPE_VALUE}>{value}</div>
          </div>
        )
      })}
    </div>
  )
}

/** The live "recent changes" region — the chronological condition log when
 * non-empty, else the calm empty line. Prose lines, not status chips (the frame
 * carries no add/remove flag; a maintained active set is a filed follow-up). */
function LiveChanges({
  log,
  conditionsLabel,
  emptyLabel,
}: {
  log: readonly string[]
  conditionsLabel: string
  emptyLabel: string
}): React.JSX.Element {
  if (log.length === 0) {
    return <p className={EMPTY_CLASS}>{emptyLabel}</p>
  }
  return (
    <div data-testid="session-sheet-conditions" className={PANEL_CLASS}>
      <p className={PANEL_TITLE_CLASS}>{conditionsLabel}</p>
      <ul className={PANEL_LIST_CLASS}>
        {log.map((line, index) => (
          // Condition summaries are prose DATA with a stable chronological order and
          // possible repeats, so the index is the safe key.
          <li key={index} className={LOG_ITEM_CLASS}>
            {line}
          </li>
        ))}
      </ul>
    </div>
  )
}

export const SessionSheet = forwardRef<HTMLDivElement, SessionSheetPanelProps>(function SessionSheet(
  { sheet, overlay, hpLabel, conditionsLabel, emptyLabel },
  ref,
) {
  const spells = sheet.spells ?? []
  return (
    <Stack ref={ref} data-testid="session-sheet" gap={5}>
      {/* Name + identity eyebrow — the one real heading over the mono ember line. */}
      <div className="flex flex-col gap-[var(--space-1)]">
        <Heading level={2} role="display">
          {sheet.name}
        </Heading>
        <p className={IDENT_CLASS}>{sheet.identityLine}</p>
      </div>

      <StatStripe stats={sheet.stats} overlay={overlay} hpLabel={hpLabel} />

      <div className={ABILITIES_CLASS}>
        {sheet.abilities.map((tile) => (
          <AbilityTileView key={tile.abbrev} tile={tile} />
        ))}
      </div>

      <div className="flex flex-col gap-[var(--space-3)]">
        {sheet.prose.map((paragraph, index) => (
          // Prose paragraphs have no id; order is stable, so the index is a safe key.
          <p key={index} className={PROSE_CLASS}>
            {paragraph}
          </p>
        ))}
      </div>

      <EntryPanel title={FEATURES_TITLE} entries={sheet.features} testid="session-sheet-features" glossAsRule />
      <EntryPanel title={EQUIPMENT_TITLE} entries={sheet.equipment} testid="session-sheet-equipment" />
      {spells.length > 0 && (
        <EntryPanel title={SPELLS_TITLE} entries={spells} testid="session-sheet-spells" />
      )}

      <LiveChanges
        log={overlay.conditionLog}
        conditionsLabel={conditionsLabel}
        emptyLabel={emptyLabel}
      />
    </Stack>
  )
})
