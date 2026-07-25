import { forwardRef, useId } from 'react'
import type {
  CharacterSheetRevealProps,
  AbilityTile,
  SheetEntry,
  SheetSkill,
  FullSheet,
} from '@mythrun/client-core/contract'
import { cn } from '../../lib/cn.ts'
import { Stack } from '../Stack/Stack.tsx'
import { Heading } from '../Heading/Heading.tsx'
import { Button } from '../Button/Button.tsx'

// CharacterSheetReveal (MYT-90) — the "Meet your character" payoff: the reward
// screen after the loading beat, where a new player MEETS their character as a
// field-guide entry (a name + identity eyebrow, a stat stripe, six square ability
// tiles, connection prose, and the "what they can do / carry / cast" panels) — a
// portrait, NOT a stat block. "Prose quality is the product": the connection
// paragraphs are the emotional centre of the screen, set in generous serif.
//
// Pure/presentational: it renders `curated` + `full` and fires the neutral confirm
// / start-over / toggle callbacks. It owns NO state — expansion is CONTROLLED by the
// parent (`expanded`), and the "See full sheet" expansion is a pure CLIENT reveal of
// data already in props (`full`): NO network. The same props always render the same
// screen.
//
// Register (flat 1-bit / paper / SQUARE): `rounded-none`, token-driven edges, NO
// circles/dots/chips — proficiency and modifiers read as TEXT/DATA, never as status
// dots (the brand's "state as prose, not badges"). The stat stripe + ability tiles
// carry the strong interactive-weight edge (`--border-strong`); the softer panels
// carry the hairline `--border`, a two-tier hierarchy matching the mockup's ink-vs-
// line borders. Ember (`text-accent-fg`) is the accent for the identity eyebrow,
// ability modifiers, and the panel/section labels. Everything is theme-aware
// (semantic tokens flip under `.dark`).
//
// Responsive by construction: a two-column grid (abilities + prose | panels) on
// desktop collapses to a single column below `md`; the ability tiles hold a 3-up
// grid down to ~375px; the action row is a full-width column on phone and a wrapping
// row on desktop. Every flex/grid child is `min-w-0` so long prose never forces a
// horizontal scroll.
//
// The curated panel titles + the action labels ("This is me", "See full sheet",
// "Hide full sheet", "Begin again") arrive resolved via `labels` — the shell owns
// i18n and passes them in (MYT-100 grew the contract the label props, exactly as
// anticipated when they were interim brand chrome). The mockup genders them to the
// character ("What she can do"); the resolved copy uses the neutral "they".
//
// The expanded full-sheet section titles + the proficiency/expertise tags below are
// NOT part of the MYT-100 label contract (§5 lifts only the curated panel titles and
// the action labels); they stay as fixed chrome for now.
const SKILLS_TITLE = 'Skills'
const SAVES_TITLE = 'Saving throws'
const FULL_EQUIPMENT_TITLE = 'Everything they carry'
const FULL_SPELLS_TITLE = 'Every spell they know'
const PROFICIENT_TAG = 'proficient'
const EXPERTISE_TAG = 'expertise'
// The caster's spellcasting-ability mark (ux-run2 myth-8ps4n) — quiet prose on
// the tile, telling a newcomer WHY their spells work.
const CASTING_TAG = 'casting'

// The identity eyebrow — mono uppercase ember, the machine-register line under the
// serif name.
const IDENT_CLASS = 'font-ui text-sm font-medium uppercase tracking-wide text-accent-fg'

// The stat stripe — a bordered row of AC / HP / Proficiency / Hit Die / Speed cells
// that WRAPS at narrow widths. Each cell floors at its own content width (min-w-fit)
// rather than a fixed 5.5rem, so a long single-word label (e.g. "PROFICIENCY", wider
// than 5.5rem once uppercased + letter-spaced) never spills its box at ~375px — the
// row wraps to fewer cells instead. Strong edge; hairline inter-cell rules.
const STRIPE_CLASS = 'flex flex-wrap rounded-none border border-border-strong bg-surface'
// Cells centre their label·value pair (ux-run3 myth-vmadj) — the value owns the
// cell instead of huddling left in empty paper.
const STRIPE_CELL =
  'min-w-fit flex-1 border-r border-border px-[var(--space-3)] py-[var(--space-2)] text-center last:border-r-0'
const STRIPE_KEY = 'font-ui text-xs uppercase tracking-wide text-ink-tertiary'
// The vitals value reads one full step above body (myth-vmadj: AC/HP are the
// numbers a player checks constantly) — clearly between body (lg) and the
// ability-score hero (2xl).
const STRIPE_VALUE = 'font-body text-xl font-semibold text-ink'

// The two-column body — abilities + prose beside the panels on desktop, a single
// column below `md`. `items-start` so the columns top-align rather than stretch.
const COLS_CLASS = 'grid items-start gap-[var(--space-6)] md:grid-cols-[1.1fr_1fr]'

// The six ability tiles — a 3-up square grid (two rows), holding down to ~375px.
// `auto-rows-fr` equalises the two rows (myth-vmadj): the caster's INT tile adds
// a casting tag line, and without the reserve its row read taller — the grid
// must read as one lattice.
const ABILITIES_CLASS = 'grid auto-rows-fr grid-cols-3 gap-[var(--space-2)]'
// One ability tile — a SQUARE paper cell (strong edge) with the abbrev, the big
// serif score, and the ember mono modifier. No circle: the signature "visual, not a
// table" element as a flat tile.
const ABILITY_TILE_CLASS = cn(
  'flex flex-col items-center gap-[var(--space-1)] rounded-none border border-border-strong bg-surface',
  'px-[var(--space-2)] py-[var(--space-3)] text-center',
)
const ABILITY_ABBREV_CLASS = 'font-ui text-xs uppercase tracking-wide text-ink-tertiary'
const ABILITY_SCORE_CLASS = 'font-body text-2xl font-semibold leading-[1.1] text-ink'
// The modifier carries real weight (ux-run2 myth-8ps4n): in play it is the number
// hands reach for — the score is the bookkeeping, the modifier is the handle.
const ABILITY_MOD_CLASS = 'font-ui text-base font-medium text-accent-fg'
// The quiet casting mark under the modifier — tertiary mono prose, never a chip.
const ABILITY_CASTING_CLASS = 'font-ui text-[0.65rem] uppercase tracking-wide text-ink-tertiary'

// The connection prose — generous serif, the emotional centre of the reveal. Sized a
// touch above the base role (the mockup's 1.05rem/1.65) because this is the payoff
// text (non-color arbitrary values → R3-allowed).
const PROSE_CLASS = 'font-body text-[1.05rem] leading-[1.65] text-ink'

// A titled panel — a hairline-edged paper card with a mono ember header rule over a
// list of name (+ optional quiet gloss) rows. Shared by the curated features/
// equipment/spells panels AND the expanded full equipment/spells panels.
const PANEL_CLASS = 'rounded-none border border-border bg-surface'
const PANEL_TITLE_CLASS =
  'border-b border-border px-[var(--space-3)] py-[var(--space-2)] font-ui text-xs uppercase tracking-wide text-accent-fg'
const PANEL_LIST_CLASS = 'flex list-none flex-col px-[var(--space-3)] py-[var(--space-1)]'
const PANEL_ITEM_CLASS = 'border-b border-border py-[var(--space-2)] last:border-b-0'
const PANEL_ITEM_NAME = 'block font-body text-sm font-semibold text-ink'
const PANEL_ITEM_GLOSS = 'mt-[2px] block font-body text-xs text-ink-tertiary'
// The label·value row register (the spells panel — ux-run2 myth-wbd89): the
// entry name is a quiet mono group label ("Cantrips", "Level 1") and the gloss
// carries the actual content as readable serif ink — one line per level group,
// the house state-as-prose form, never a per-item receipt.
const PANEL_ITEM_LABEL = 'block font-ui text-xs uppercase tracking-wide text-ink-tertiary'
const PANEL_ITEM_VALUE = 'mt-[2px] block font-body text-sm leading-[1.5] text-ink'
// The "what they can do" gloss is canonical SRD rule text authored in the SECOND
// person ("When you reach 3rd level, you gain…"), sitting under a THIRD-person panel
// title ("What they can do") — frame and fill disagree (MYT-olo9c). The deep fix is a
// Haiku third-person rewrite in char-gen (deferred). As a cheap, honest presentation
// mitigation the feature gloss is typographically DISTANCED into a quoted rule
// reference — a hanging left rule + muted ink — so it reads AS a rulebook
// quotation, not as the character's own portrait. It changes NO authored copy.
// ROMAN, not italic (ux-run3 myth-vmadj): these glosses run multi-line, and
// italics at length read as strain — the left rule alone carries the quotation;
// italics stay reserved for single-line flavour (the subtitle role).
const PANEL_ITEM_GLOSS_RULE =
  'mt-[var(--space-1)] block border-l-2 border-border pl-[var(--space-2)] font-body text-xs text-ink-tertiary'

// The expanded skills grid — two columns of rows on desktop, one at phone widths.
const SKILLS_LIST_CLASS =
  'grid list-none grid-cols-1 gap-x-[var(--space-4)] px-[var(--space-3)] py-[var(--space-1)] sm:grid-cols-2'
const SKILL_ROW_CLASS =
  'flex items-baseline justify-between gap-[var(--space-2)] border-b border-border py-[var(--space-1)]'
const SKILL_NAME_CLASS = 'font-body text-sm'
const SKILL_TAG_CLASS = 'shrink-0 font-ui text-xs uppercase tracking-wide text-accent-fg'
// The saving-throws value line.
const SAVES_VALUE_CLASS = 'px-[var(--space-3)] py-[var(--space-2)] font-body text-sm text-ink'

// The action row — a full-width column on phone (the buttons stretch via the flex-
// column default `stretch`), a wrapping centred row on desktop. A hairline rule
// separates the decision row from the sheet (ux-run2 myth-fca4y), and the
// discard action sits ALONE at the far edge (`ml-auto` on its wrapper) —
// keep-actions left, discard right: distance is the confirmation.
const ACTIONS_CLASS = cn(
  'flex flex-col items-stretch gap-[var(--space-3)] border-t border-border pt-[var(--space-4)]',
  'sm:flex-row sm:flex-wrap sm:items-center',
)
// The inline start-over confirm (two-step, CONTROLLED): the prompt over its two
// verbs, right-aligned in the discard action's isolated slot. The slot reserves
// the CONFIRM state's height on row layouts (ux-run3 myth-vshy0: 4.25rem =
// text-sm prompt line 20px + gap-2 8px + md control 40px) so arming the confirm
// never drops the action row; `justify-center` seats both states in the reserve.
const START_OVER_SLOT =
  'ml-auto flex min-w-0 flex-col items-end justify-center gap-[var(--space-2)] sm:min-h-[4.25rem]'
const START_OVER_PROMPT = 'text-right font-body text-sm text-ink'

/** Format an ability modifier with an explicit sign — `+3`, `+0`, `−1` (the mono
 * typographic minus, matching the machine register). */
function formatModifier(modifier: number): string {
  return modifier >= 0 ? `+${String(modifier)}` : `−${String(Math.abs(modifier))}`
}

/** One skill's proficiency tier — expertise (double proficiency) wins over plain
 * proficiency. Kept out of JSX so there are no nested ternaries at the call site. */
function skillState(skill: SheetSkill): 'expertise' | 'proficient' | 'none' {
  if (skill.expertise) return 'expertise'
  if (skill.proficient) return 'proficient'
  return 'none'
}

const SKILL_TAG: Record<ReturnType<typeof skillState>, string> = {
  expertise: EXPERTISE_TAG,
  proficient: PROFICIENT_TAG,
  none: '',
}

/** One square ability tile — abbrev, score, signed modifier, and (on a caster's
 *  spellcasting ability) the quiet casting mark. */
function AbilityTileView({ tile }: { tile: AbilityTile }): React.JSX.Element {
  return (
    <div data-testid="character-sheet-reveal-ability" data-abbrev={tile.abbrev} className={ABILITY_TILE_CLASS}>
      <span className={ABILITY_ABBREV_CLASS}>{tile.abbrev}</span>
      <span className={ABILITY_SCORE_CLASS}>{tile.score}</span>
      <span className={ABILITY_MOD_CLASS}>{formatModifier(tile.modifier)}</span>
      {tile.casting === true && <span className={ABILITY_CASTING_CLASS}>{CASTING_TAG}</span>}
    </div>
  )
}

/** A titled panel of name (+ optional gloss) rows. `glossAsRule` distances the gloss
 *  into a quoted rule reference (the features panel's SRD 2nd-person bodies — see
 *  PANEL_ITEM_GLOSS_RULE); equipment keeps the plain quiet gloss; `labelValue`
 *  inverts the pair for grouped prose lines (the spells panel — the name is the
 *  quiet group label, the gloss is the readable content; ux-run2 myth-wbd89). */
function EntryPanel({
  title,
  entries,
  testid,
  glossAsRule = false,
  labelValue = false,
}: {
  title: string
  entries: SheetEntry[]
  testid: string
  glossAsRule?: boolean
  labelValue?: boolean
}): React.JSX.Element {
  const glossClass = glossAsRule ? PANEL_ITEM_GLOSS_RULE : labelValue ? PANEL_ITEM_VALUE : PANEL_ITEM_GLOSS
  return (
    <div data-testid={testid} className={PANEL_CLASS}>
      {/* A category label, not a document heading — styled, non-heading element so it
          never breaks the page's heading order (the name is the one real heading). */}
      <p className={PANEL_TITLE_CLASS}>{title}</p>
      <ul className={PANEL_LIST_CLASS}>
        {entries.map((entry) => (
          <li key={entry.name} className={PANEL_ITEM_CLASS}>
            <span className={labelValue ? PANEL_ITEM_LABEL : PANEL_ITEM_NAME}>{entry.name}</span>
            {entry.gloss !== undefined && <span className={glossClass}>{entry.gloss}</span>}
          </li>
        ))}
      </ul>
    </div>
  )
}

/** One expanded skill row — the name, dimmed when un-proficient, with a mono ember
 * proficiency/expertise tag. State is exposed as data (no status dot/chip). */
function SkillRow({ skill }: { skill: SheetSkill }): React.JSX.Element {
  const state = skillState(skill)
  const tag = SKILL_TAG[state]
  return (
    <li
      data-testid="character-sheet-reveal-skill"
      data-skill-state={state}
      className={SKILL_ROW_CLASS}
    >
      <span className={cn(SKILL_NAME_CLASS, state === 'none' ? 'text-ink-tertiary' : 'text-ink')}>
        {skill.name}
      </span>
      {tag !== '' && <span className={SKILL_TAG_CLASS}>{tag}</span>}
    </li>
  )
}

/** The expanded mechanical sheet — every skill (with proficiency/expertise), the
 * saving throws, the full equipment, and (casters only) the full spell list. A pure
 * client reveal of data already in `full`: no network. */
function FullSheetView({ full }: { full: FullSheet }): React.JSX.Element {
  return (
    <Stack data-testid="character-sheet-reveal-full" gap={4}>
      <div className={PANEL_CLASS}>
        <p className={PANEL_TITLE_CLASS}>{SKILLS_TITLE}</p>
        <ul className={SKILLS_LIST_CLASS}>
          {full.skills.map((skill) => (
            <SkillRow key={skill.name} skill={skill} />
          ))}
        </ul>
      </div>
      <div className={PANEL_CLASS}>
        <p className={PANEL_TITLE_CLASS}>{SAVES_TITLE}</p>
        <p data-testid="character-sheet-reveal-saves" className={SAVES_VALUE_CLASS}>
          {full.savingThrows.join(' · ')}
        </p>
      </div>
      <EntryPanel
        title={FULL_EQUIPMENT_TITLE}
        entries={full.equipment}
        testid="character-sheet-reveal-full-equipment"
      />
      {full.spells.length > 0 && (
        <EntryPanel
          title={FULL_SPELLS_TITLE}
          entries={full.spells}
          testid="character-sheet-reveal-full-spells"
          labelValue
        />
      )}
    </Stack>
  )
}

/** The saving throws as a quiet label·value panel in the CURATED left column —
 *  it holds the column below the prose so the column carries content for the
 *  right column's full height instead of dying into dead paper (ux-run2
 *  myth-wbd89; previously hoarded by "See full sheet"). */
function CuratedSaves({ savingThrows }: { savingThrows: string[] }): React.JSX.Element {
  return (
    <div data-testid="character-sheet-reveal-saves-curated" className={PANEL_CLASS}>
      <p className={PANEL_TITLE_CLASS}>{SAVES_TITLE}</p>
      <p className={SAVES_VALUE_CLASS}>{savingThrows.join(' · ')}</p>
    </div>
  )
}

/** The action row (ux-run2 myth-fca4y): the keep-actions (confirm · toggle the
 *  full sheet) hold the left; the discard action sits ALONE at the far right,
 *  behind a two-step inline confirm — the destructive path never shares a gap
 *  with a read-only one. */
function RevealActions({
  labels,
  expanded,
  fullSheetId,
  onToggleExpand,
  onConfirm,
  startOverConfirming,
  onRequestStartOver,
  onCancelStartOver,
  onStartOver,
}: Pick<
  CharacterSheetRevealProps,
  | 'labels'
  | 'expanded'
  | 'onToggleExpand'
  | 'onConfirm'
  | 'startOverConfirming'
  | 'onRequestStartOver'
  | 'onCancelStartOver'
  | 'onStartOver'
> & { fullSheetId: string }): React.JSX.Element {
  return (
    <div className={ACTIONS_CLASS}>
      <Button variant="primary" size="lg" onPress={onConfirm}>
        {labels.confirm} <span aria-hidden="true">→</span>
      </Button>
      <Button
        variant="secondary"
        size="lg"
        onPress={onToggleExpand}
        aria-expanded={expanded}
        aria-controls={fullSheetId}
      >
        {expanded ? labels.hideFull : labels.seeFull}
      </Button>
      {startOverConfirming ? (
        <div data-testid="character-sheet-reveal-start-over-confirm" className={START_OVER_SLOT}>
          <p className={START_OVER_PROMPT}>{labels.startOverPrompt}</p>
          <div className="flex flex-wrap items-center justify-end gap-[var(--space-2)]">
            <Button variant="secondary" size="md" onPress={onStartOver}>
              {labels.startOverConfirm}
            </Button>
            <Button variant="ghost" size="md" onPress={onCancelStartOver}>
              {labels.startOverKeep}
            </Button>
          </div>
        </div>
      ) : (
        <div className={START_OVER_SLOT}>
          <Button variant="ghost" size="lg" onPress={onRequestStartOver}>
            {labels.startOver}
          </Button>
        </div>
      )}
    </div>
  )
}

export const CharacterSheetReveal = forwardRef<HTMLDivElement, CharacterSheetRevealProps>(
  function CharacterSheetReveal(
    {
      labels,
      curated,
      full,
      expanded,
      onToggleExpand,
      onConfirm,
      startOverConfirming,
      onRequestStartOver,
      onCancelStartOver,
      onStartOver,
    },
    ref,
  ) {
    const hasSpells = curated.spells !== undefined && curated.spells.length > 0
    // WAI-ARIA disclosure wiring: the "See full sheet" toggle carries
    // aria-expanded + aria-controls pointing at the full-sheet region. `useId`
    // keeps the IDREF unique across multiple reveals on one page.
    const fullSheetId = useId()
    return (
      <Stack ref={ref} data-testid="character-sheet-reveal" gap={5}>
        {/* Name + identity eyebrow — the one real heading (display role) over the mono
            ember identity line. */}
        <div className="flex flex-col gap-[var(--space-1)]">
          <Heading level={2} role="display">
            {curated.name}
          </Heading>
          <p className={IDENT_CLASS}>{curated.identityLine}</p>
        </div>

        {/* The AC / HP / Proficiency / Hit Die / Speed stripe. */}
        <div data-testid="character-sheet-reveal-stripe" className={STRIPE_CLASS}>
          {curated.stats.map((stat) => (
            <div key={stat.key} className={STRIPE_CELL}>
              <div className={STRIPE_KEY}>{stat.label}</div>
              <div className={STRIPE_VALUE}>{stat.value}</div>
            </div>
          ))}
        </div>

        {/* Two-column body: abilities + prose | the "what they can do/carry/cast"
            panels. Collapses to one column below `md`. */}
        <div className={COLS_CLASS}>
          <div className="flex min-w-0 flex-col gap-[var(--space-5)]">
            <div className={ABILITIES_CLASS}>
              {curated.abilities.map((tile) => (
                <AbilityTileView key={tile.abbrev} tile={tile} />
              ))}
            </div>
            <div className="flex flex-col gap-[var(--space-3)]">
              {curated.prose.map((paragraph, index) => (
                // Prose paragraphs have no id; order is stable, so the index is a safe key.
                <p key={index} className={PROSE_CLASS}>
                  {paragraph}
                </p>
              ))}
            </div>
            <CuratedSaves savingThrows={full.savingThrows} />
            {/* The caster's spells sit HERE, under the saving throws (ux-run3
                myth-vshy0): capabilities group left, possessions right — and the
                left column no longer dies ~220px before the right. */}
            {hasSpells && curated.spells !== undefined && (
              <EntryPanel
                title={labels.panelSpells}
                entries={curated.spells}
                testid="character-sheet-reveal-spells"
                labelValue
              />
            )}
          </div>
          <div className="flex min-w-0 flex-col gap-[var(--space-4)]">
            <EntryPanel
              title={labels.panelFeatures}
              entries={curated.features}
              testid="character-sheet-reveal-features"
              glossAsRule
            />
            <EntryPanel
              title={labels.panelEquipment}
              entries={curated.equipment}
              testid="character-sheet-reveal-equipment"
            />
          </div>
        </div>

        {/* The opt-in full mechanical sheet — a pure client reveal (no network).
            The `id` wrapper is the disclosure region the toggle's aria-controls
            targets (Stack carries no id; a bare wrapper keeps the layout identical). */}
        {expanded && (
          <div id={fullSheetId}>
            <FullSheetView full={full} />
          </div>
        )}

        <RevealActions
          labels={labels}
          expanded={expanded}
          fullSheetId={fullSheetId}
          onToggleExpand={onToggleExpand}
          onConfirm={onConfirm}
          startOverConfirming={startOverConfirming}
          onRequestStartOver={onRequestStartOver}
          onCancelStartOver={onCancelStartOver}
          onStartOver={onStartOver}
        />
      </Stack>
    )
  },
)
