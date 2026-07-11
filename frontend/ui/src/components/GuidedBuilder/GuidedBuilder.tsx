import { forwardRef } from 'react'
import type { GuidedBuilderProps, RailStep } from '@mythrun/client-core/contract'
import { cn } from '../../lib/cn.ts'
import { Stack } from '../Stack/Stack.tsx'
import { Heading } from '../Heading/Heading.tsx'
import { Button } from '../Button/Button.tsx'

// GuidedBuilder (MYT-90) — the one-question-at-a-time character builder (Calling →
// Practice → Origin → Background → …). FULLY CONTROLLED and purely presentational:
// it renders whatever `rail` + `question` + `options` + `selectedId` it is handed
// and fires the neutral callbacks. It holds NO step/flow state — the client-core
// guided reducer (B4) owns the cursor, the subclass-skip logic, and which options a
// step shows. So the SAME props always render the SAME step; a select fires
// `onSelect` and nothing more (the parent advances via `onNext`).
//
// Register (flat 1-bit / paper / SQUARE): `rounded-none`, token-driven edges, NO
// circles/dots/chips. The option cards reuse the shipped LevelCard selection idiom —
// a `--border-strong` interactive edge that recolors to ember (`border-accent`) with
// an inset 2px ember ring on the selected pick (same border WIDTH, so selecting never
// shifts layout). The rail rungs read state through the same ember/ink/muted token
// language: `now` = ember edge+text, `done` = ink edge over the chosen value, `todo`
// = muted. Everything is theme-aware (semantic tokens flip under `.dark`).
//
// Responsive by construction: the option grid is `auto-fit`/`minmax`, so it flows
// from four-ish columns on desktop down to one at ~375px with no breakpoints, and a
// single-option step (e.g. the Cleric/Sorcerer/Warlock subclass) stretches to one
// full-width confirm card. The rail wraps; the nav row wraps.
//
// The nav CONTROL LABELS ("Next", "Back", "Describe them instead") are fixed brand
// chrome, not passed-in copy — the contract carries no label props (only the
// callbacks), exactly like LevelCard's fixed "Level" eyebrow and FreeformPrompt's
// fixed "Continue". They read as generic navigation chrome; the mockup's evocative
// per-step labels ("Next: how you practice it →") are deferred to the end-of-milestone
// copy pass, and if strict i18n later wants them shell-owned the contract would grow
// label props.
const NEXT_LABEL = 'Next'
const BACK_LABEL = 'Back'
const SKIP_LABEL = 'Describe them instead'

// One rung of the progress rail. NON-interactive (the rail is a status display; the
// contract carries no per-rung callback) — a bordered square showing the step label
// and, once chosen, its picked value. State recolors the edge: `now` ember, `done`
// ink, `todo` muted.
const NODE_BASE = cn(
  'inline-flex items-center gap-[var(--space-2)] rounded-none border',
  'px-[var(--space-3)] py-[var(--space-1)]',
)
const NODE_STATE: Record<RailStep['state'], string> = {
  done: 'border-ink bg-surface text-ink-secondary',
  now: 'border-accent bg-surface text-accent-fg',
  todo: 'border-border bg-bg text-ink-tertiary',
}
// The rung's step label — the small mono/machine register.
const NODE_LABEL = 'font-ui text-xs font-medium uppercase tracking-wide'
// The picked value carried on a completed rung — serif, strong ink so it pops past
// the muted label.
const NODE_CHOSEN = 'font-body text-sm font-semibold text-ink'
// The directional separator between rungs — decorative, so it is aria-hidden.
const SEP = 'font-ui text-xs text-ink-tertiary'

// One selectable option card — a REAL <button> (native click AND keyboard fire
// `onSelect`). Mirrors LevelCard: `--border-strong` edge + `--surface` fill, neutral
// surface token-swap on hover/press, the shared theme-aware focus ring, and the ember
// edge + inset ring on the SELECTED pick (`var(--accent)` is a semantic var, so the
// arbitrary shadow value is token-driven, not a frozen color).
const OPTION_CLASS = cn(
  'group flex w-full min-w-0 cursor-pointer select-none flex-col gap-[var(--space-1)] text-left',
  'rounded-none border border-border-strong bg-surface p-[var(--space-4)]',
  'transition-[box-shadow,border-color,background-color] duration-[var(--duration-fast)]',
  'hover:bg-surface-hover active:bg-surface-active',
  'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent-fg',
  'data-[state=selected]:border-accent',
  'data-[state=selected]:shadow-[inset_0_0_0_2px_var(--accent)]',
)
const OPTION_NAME = 'font-body text-base font-semibold leading-[1.4] text-ink'
const OPTION_DESC = 'font-body text-sm leading-[1.4] text-ink-secondary'

// The option grid: `auto-fit`/`minmax` flows the cards from ~four columns on desktop
// to one at ~375px with no breakpoints, and collapses empty tracks so a single-option
// step reads as one full-width confirm card. Non-color arbitrary value → R3-allowed.
const GRID_CLASS = 'grid gap-[var(--space-3)] grid-cols-[repeat(auto-fit,minmax(16rem,1fr))]'

// Back + skip are subtle text-link affordances (the mockup's quiet nav, not solid
// buttons) — real <button>s so they are keyboard-operable, styled as underlined mono
// links with the shared focus ring.
const LINK_CLASS = cn(
  'inline-flex items-center gap-[var(--space-1)] rounded-none bg-transparent cursor-pointer',
  'font-ui text-xs tracking-wide text-ink-tertiary underline underline-offset-2',
  'hover:text-ink transition-colors duration-[var(--duration-fast)]',
  'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent-fg',
)

export const GuidedBuilder = forwardRef<HTMLDivElement, GuidedBuilderProps>(function GuidedBuilder(
  { rail, question, options, selectedId, onSelect, onNext, onBack, onSkipToFreeform },
  ref,
) {
  // First step ⇔ nothing is completed yet: derive it from the rail (no internal
  // state) so Back is hidden on the opening step and surfaces once a rung is `done`.
  const isFirstStep = !rail.some((rung) => rung.state === 'done')
  return (
    <Stack ref={ref} data-testid="guided-builder" gap={6}>
      {/* Progress rail — a semantic ordered list of rungs. Self-describing (label +
          chosen value), so it needs no landmark label. */}
      <ol
        data-testid="guided-builder-rail"
        className="flex list-none flex-wrap items-center gap-[var(--space-2)] p-0"
      >
        {rail.map((rung, index) => (
          <li key={rung.step} className="flex items-center gap-[var(--space-2)]">
            {index > 0 && (
              <span aria-hidden="true" className={SEP}>
                →
              </span>
            )}
            <span data-state={rung.state} className={cn(NODE_BASE, NODE_STATE[rung.state])}>
              <span className={NODE_LABEL}>{rung.label}</span>
              {rung.chosen !== undefined && <span className={NODE_CHOSEN}>{rung.chosen}</span>}
            </span>
          </li>
        ))}
      </ol>

      {/* The step's question — the large serif hero. */}
      <Heading level={2} role="display">
        {question}
      </Heading>

      {/* The option cards — one REAL <button> each; selection is prop-driven. */}
      <div className={GRID_CLASS}>
        {options.map((option) => {
          const selected = option.id === selectedId
          return (
            <button
              key={option.id}
              type="button"
              onClick={() => {
                onSelect(option.id)
              }}
              aria-pressed={selected}
              data-option-id={option.id}
              data-state={selected ? 'selected' : 'default'}
              className={OPTION_CLASS}
            >
              <span className={OPTION_NAME}>{option.name}</span>
              <span className={OPTION_DESC}>{option.description}</span>
            </button>
          )
        })}
      </div>

      {/* Nav row: the quiet Back (hidden on the first step) + the always-available
          "describe them instead" escape hatch on the left; the primary Next on the
          right. Wraps at narrow widths. */}
      <Stack direction="row" justify="between" align="center" wrap gap={4}>
        <Stack direction="row" align="center" wrap gap={4}>
          {!isFirstStep && (
            <button type="button" onClick={onBack} className={LINK_CLASS}>
              <span aria-hidden="true">‹</span>
              {BACK_LABEL}
            </button>
          )}
          <button type="button" onClick={onSkipToFreeform} className={LINK_CLASS}>
            {SKIP_LABEL}
          </button>
        </Stack>
        <Button variant="primary" size="lg" onPress={onNext}>
          {NEXT_LABEL}
        </Button>
      </Stack>
    </Stack>
  )
})
