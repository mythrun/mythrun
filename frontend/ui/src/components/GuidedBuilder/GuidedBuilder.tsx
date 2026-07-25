import { forwardRef } from 'react'
import type { GuidedBuilderProps } from '@mythrun/client-core/contract'
import { cn } from '../../lib/cn.ts'
import { Stack } from '../Stack/Stack.tsx'
import { Heading } from '../Heading/Heading.tsx'
import { Button } from '../Button/Button.tsx'
import { GuidedRail } from './GuidedRail.tsx'

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
// The nav control labels ("Next", "Back", "Describe them instead") arrive resolved
// via `labels` — the shell owns i18n and passes them in (MYT-100 grew the contract
// the label props, exactly as anticipated when they were interim brand chrome).

// The progress rail's rung markup lives in GuidedRail.tsx (extracted in MYT-102
// so the builder-less notes/grounding screens keep the same signposting); the
// builder composes it below under its historical `guided-builder-rail` testid.

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
  { labels, rail, counter, question, options, selectedId, onSelect, onNext, onBack, onSkipToFreeform },
  ref,
) {
  return (
    <Stack ref={ref} data-testid="guided-builder" gap={6}>
      {/* Progress rail — the extracted GuidedRail (a semantic ordered list of
          rungs), under the builder's historical testid so the composition renders
          identically to the pre-extraction markup. */}
      <GuidedRail rail={rail} data-testid="guided-builder-rail" {...(counter !== undefined && { counter })} />

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
              {option.description !== '' && <span className={OPTION_DESC}>{option.description}</span>}
            </button>
          )
        })}
      </div>

      {/* Nav row (ux-run2 myth-80an1 / myth-esd1y): the quiet Back holds the
          bottom-left on EVERY step — one Back, one meaning, one position (on the
          first step the parent wires it to leave the builder). The mode-switching
          "describe them instead" escape hatch is separated from step navigation:
          it sits right-aligned beside Next. Wraps at narrow widths. */}
      <Stack direction="row" justify="between" align="center" wrap gap={4}>
        <button type="button" onClick={onBack} className={LINK_CLASS}>
          <span aria-hidden="true">‹</span>
          {labels.back}
        </button>
        <Stack direction="row" align="center" wrap gap={4}>
          <button type="button" onClick={onSkipToFreeform} className={LINK_CLASS}>
            {labels.switchToFreeform}
          </button>
          {/* Next is honestly gated: disabled (muted, identical geometry — the DS
              Button owns the styling) until the step has an answer; the accent
              fill is the reward for deciding (ux-run2 myth-x9ugl / myth-skbzw). */}
          <Button variant="primary" size="lg" disabled={selectedId === null} onPress={onNext}>
            {labels.next}
          </Button>
        </Stack>
      </Stack>
    </Stack>
  )
})
