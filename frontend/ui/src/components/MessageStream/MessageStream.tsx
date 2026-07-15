import { forwardRef, useCallback, useEffect, useRef, useState, Fragment } from 'react'
import type { ReactNode } from 'react'
import type {
  EntityIndex,
  MessageStreamProps,
  RollCardLabels,
  RollRevealView,
  TranscriptItem,
} from '@mythrun/client-core/contract'
import { cn } from '../../lib/cn.ts'
import { TYPE_ROLE_CLASS } from '../../lib/typography.ts'
import { Divider } from '../Divider/Divider.tsx'
import { IconButton } from '../IconButton/IconButton.tsx'
import { DmMessage } from '../DmMessage/DmMessage.tsx'
import { PlayerMessage } from '../PlayerMessage/PlayerMessage.tsx'
import { RollCard } from '../RollCard/RollCard.tsx'

// MessageStream (MYT-92, spec §2) — the live-play transcript: a scroll container
// that maps each TranscriptItem to its register renderer and auto-follows the
// tail. The DM narrates in serif prose (DmMessage), the humans speak in mono
// (PlayerMessage). MYT-93 (spec §5) extended `renderItem`'s dispatch (the RENDERING
// seam) so skill_check / dice_roll render as a RollCard (the dice moment) and a
// dm turn whose skill_check is still un-continued is BUFFERED (renders nothing)
// until its card's Continue — the post-check prose gate. The remaining four
// mechanical kinds (ledger_update / mode_change / combat_*) still render as a terse
// mono system line; MYT-94 extends the dispatch further (entity highlighting). The
// reveal phase + gated-turn set are computed route-side by client-core selectors
// and passed as plain data (`rollReveal`), so this component stays presentational
// (no client-core runtime import — R1). The reducer + dm/player arms are untouched.
//
// Auto-follow: while the reader sits at the tail (`wasAtBottom`), a new item OR
// streaming growth of the open DM turn scrolls the view down; the moment they
// scroll up, following stops and a quiet "jump to latest" control appears.
// Reduced motion swaps the smooth scroll for INSTANT positioning (spec §2 — no
// vestibular trigger). A non-null `connectionLine` pins a quiet status line
// (reconnect / system notice) below the scroll region.
//
// Register: paper / flat-1-bit, square (no radius, no circles), no chat bubbles /
// avatars — the DM↔player distinction is carried by the two type faces, not by
// bubble chrome. Two faces only: serif body (DM prose) + mono `--font-ui`
// (players + all mechanical / system lines).

/** The non-card mechanical subset of TranscriptItem — the four kinds that still
 *  render as a terse mono system line. dm / player have their own register
 *  components; skill_check / dice_roll became RollCards (MYT-93, spec §5). */
type MechanicalItem = Exclude<
  TranscriptItem,
  { kind: 'dm' } | { kind: 'player' } | { kind: 'skill_check' } | { kind: 'dice_roll' }
>

// Slack (px) from the bottom within which the stream still counts as "at the
// tail" and keeps auto-following — a near-bottom read should not lose follow.
const BOTTOM_THRESHOLD = 32

// Accessible name for the scroll-to-latest control. NOTE (contract gap): the
// committed MessageStreamProps carries NO label prop, so this generic-chrome
// control name is inlined rather than threaded as a resolved [ph:] key. Flagged
// for the Task 8 contract + the MYT-100 copy pass (see the T9 report).
const JUMP_LABEL = 'Jump to latest'

// The terse system line for a non-card mechanical frame, composed from FRAME DATA
// only (the server `summary` / enemy names / mode) plus typographic separators. No
// i18n keys — the committed contract carries no label props for these. skill_check
// / dice_roll no longer pass through here (they became RollCards — MYT-93).
function mechanicalText(item: MechanicalItem): string {
  switch (item.kind) {
    case 'ledger_update':
      return item.frame.summary
    case 'mode_change':
      return `— ${item.frame.to} —`
    case 'combat_started':
      return item.frame.enemies.map((e) => (e.count > 1 ? `${String(e.count)}× ${e.name}` : e.name)).join(' · ')
    case 'combat_resolved':
      return `— ${item.frame.outcome} —`
  }
}

// Per-item dispatch — the RENDERING seam (spec §7), extended by BOTH wave-2 issues.
// MYT-93: skill_check / dice_roll dispatch to a RollCard (phase from
// `reveal.phaseByKey`, callbacks bound to the item key), and a `dm` item whose turn
// is still gated renders NOTHING (the post-check prose buffer, released on Continue).
// MYT-94: the settled-prose highlight seam threads straight into the `dm` arm
// (append-only optionals — DmMessage owns the settle-only gating + the once-per-row
// memoized segmentation). The four remaining mechanical kinds keep their terse mono
// line. Keys live on the wrapping Fragment in the map, so the returned nodes are unkeyed.
function renderItem(
  item: TranscriptItem,
  reveal: RollRevealView,
  labels: RollCardLabels,
  reducedMotion: boolean,
  onRoll: (key: string) => void,
  onContinue: (key: string) => void,
  highlight: EntityIndex | undefined,
  onEntityOpen: ((entityId: string) => void) | undefined,
  highlightLabels: MessageStreamProps['highlightLabels'],
): ReactNode {
  if (item.kind === 'dm') {
    // Buffered until the turn's skill_check is continued (spec §5 prose gate).
    if (reveal.gatedTurnIds.has(item.turnId)) return null
    return (
      <DmMessage
        text={item.text}
        streaming={item.streaming}
        {...(highlight !== undefined ? { highlight } : {})}
        {...(onEntityOpen !== undefined ? { onEntityOpen } : {})}
        {...(highlightLabels !== undefined ? { highlightLabels } : {})}
      />
    )
  }
  if (item.kind === 'player') {
    return (
      <PlayerMessage
        displayName={item.displayName}
        characterName={item.characterName}
        text={item.text}
        pending={item.pending}
      />
    )
  }
  if (item.kind === 'skill_check' || item.kind === 'dice_roll') {
    return (
      <RollCard
        item={item}
        phase={reveal.phaseByKey[item.key] ?? 'idle'}
        reducedMotion={reducedMotion}
        labels={labels}
        onRoll={() => {
          onRoll(item.key)
        }}
        onContinue={() => {
          onContinue(item.key)
        }}
      />
    )
  }
  return (
    <p data-mechanical={item.kind} className={cn(TYPE_ROLE_CLASS.meta, 'py-[var(--space-1)] text-center')}>
      {mechanicalText(item)}
    </p>
  )
}

// A light scene rule between turns: a hairline precedes a DM turn that opens after
// a DIFFERENT turn (a new beat). Minimal by design (spec §2) — the rich day/scene
// divider is later polish.
function needsDivider(items: readonly TranscriptItem[], i: number): boolean {
  const item = items[i]
  const prev = items[i - 1]
  if (item === undefined || prev === undefined) return false
  return item.kind === 'dm' && prev.turnId !== item.turnId
}

export const MessageStream = forwardRef<HTMLDivElement, MessageStreamProps>(function MessageStream(
  { items, connectionLine, reducedMotion, rollReveal, rollLabels, onRoll, onContinue, highlight, onEntityOpen, highlightLabels },
  ref,
) {
  const scrollRef = useRef<HTMLDivElement>(null)
  const wasAtBottom = useRef(true)
  const [showJump, setShowJump] = useState(false)

  const scrollToTail = useCallback(() => {
    const el = scrollRef.current
    if (el === null) return
    if (reducedMotion) {
      el.scrollTop = el.scrollHeight
    } else {
      // Defensive optional call: the DOM lib types scrollTo as always-present, but
      // jsdom (and very old engines) lack it — the guard prevents a throw on mount
      // rather than requiring every consumer's test to shim it. Verified: `typeof
      // el.scrollTo === 'undefined'` under jsdom.
      // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- jsdom lacks Element.scrollTo (runtime gap, not a type gap)
      el.scrollTo?.({ top: el.scrollHeight, behavior: 'smooth' })
    }
  }, [reducedMotion])

  // Follow the tail on a new item AND on streaming growth of the open DM turn
  // (text_delta appends to the same item, so items.length alone would miss it) —
  // but only while the reader is already at the bottom.
  const tail = items[items.length - 1]
  const tailTextLen = tail?.kind === 'dm' ? tail.text.length : 0
  useEffect(() => {
    if (wasAtBottom.current) {
      scrollToTail()
      setShowJump(false)
    }
  }, [items.length, tailTextLen, scrollToTail])

  const handleScroll = (): void => {
    const el = scrollRef.current
    if (el === null) return
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < BOTTOM_THRESHOLD
    wasAtBottom.current = atBottom
    setShowJump(!atBottom)
  }

  const jumpToTail = (): void => {
    wasAtBottom.current = true
    scrollToTail()
    setShowJump(false)
  }

  return (
    <div ref={ref} data-testid="message-stream" className="relative flex h-full min-h-0 min-w-0 flex-col">
      <div
        ref={scrollRef}
        data-testid="message-stream-scroll"
        // An overflow-scroll region must be keyboard-reachable (axe
        // scrollable-region-focusable); tabIndex=0 is the sanctioned fix.
        // eslint-disable-next-line jsx-a11y/no-noninteractive-tabindex -- scrollable region, keyboard access
        tabIndex={0}
        onScroll={handleScroll}
        className="flex min-h-0 flex-1 flex-col gap-[var(--space-2)] overflow-y-auto px-[var(--space-4)] py-[var(--space-4)]"
      >
        {items.map((item, i) => (
          <Fragment key={item.key}>
            {needsDivider(items, i) ? <Divider /> : null}
            {renderItem(item, rollReveal, rollLabels, reducedMotion, onRoll, onContinue, highlight, onEntityOpen, highlightLabels)}
          </Fragment>
        ))}
      </div>
      {showJump ? (
        <div className="absolute bottom-[var(--space-4)] right-[var(--space-4)]">
          <IconButton icon="chevron-down" label={JUMP_LABEL} variant="secondary" size="sm" onPress={jumpToTail} />
        </div>
      ) : null}
      {connectionLine !== null ? (
        <p
          data-testid="message-stream-connection"
          role="status"
          aria-live="polite"
          className={cn(TYPE_ROLE_CLASS.meta, 'border-t border-border py-[var(--space-2)] text-center')}
        >
          {connectionLine}
        </p>
      ) : null}
    </div>
  )
})
