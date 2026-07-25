import { forwardRef, useCallback, useEffect, useRef, useState, Fragment } from 'react'
import type { ReactNode } from 'react'
import type {
  EntityIndex,
  MessageStreamProps,
  RollCardLabels,
  RollRevealView,
  TableTalkView,
  TranscriptItem,
} from '@mythrun/client-core/contract'
import { cn } from '../../lib/cn.ts'
import { TYPE_ROLE_CLASS } from '../../lib/typography.ts'
import { Button } from '../Button/Button.tsx'
import { Divider } from '../Divider/Divider.tsx'
import { DmMessage } from '../DmMessage/DmMessage.tsx'
import { DmCorrection } from '../DmCorrection/DmCorrection.tsx'
import { PlayerMessage } from '../PlayerMessage/PlayerMessage.tsx'
import { RollCard } from '../RollCard/RollCard.tsx'
import { TableTalk } from '../TableTalk/TableTalk.tsx'
import { VisuallyHidden } from '../VisuallyHidden/VisuallyHidden.tsx'

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
// scroll up, following stops and a labeled jump-to-latest PILL appears
// (myth-em6bg — the old anonymous chevron read as a rendering artifact clipped
// onto card edges). When new content lands while scrolled up, the pill swaps to
// the new-messages label AND announces via a polite live region, so an answer
// below the fold never looks like nothing happened. Reduced motion swaps the
// smooth scroll for INSTANT positioning (spec §2 — no vestibular trigger). A
// non-null `connectionLine` pins a quiet status line (reconnect / system notice)
// below the scroll region.
//
// myth-1msig: an @dm exchange (grouped route-side into `tableTalk`) wraps in the
// marked TableTalk frame — contiguous items of one block render inside one
// framed segment, and the scene divider is suppressed inside it (the frame
// carries the boundary).
//
// Register: paper / flat-1-bit, square (no radius, no circles), no chat bubbles /
// avatars — the DM↔player distinction is carried by the two type faces, not by
// bubble chrome. Two faces only: serif body (DM prose) + mono `--font-ui`
// (players + all mechanical / system lines).

/** The non-card mechanical subset of TranscriptItem — the four kinds that still
 *  render as a terse mono system line. dm / player have their own register
 *  components; skill_check / dice_roll became RollCards (MYT-93, spec §5);
 *  dm_correction is a set-apart errata slip (myth-d6knq), not a system line. */
type MechanicalItem = Exclude<
  TranscriptItem,
  { kind: 'dm' } | { kind: 'player' } | { kind: 'skill_check' } | { kind: 'dice_roll' } | { kind: 'dm_correction' }
>

// Slack (px) from the bottom within which the stream still counts as "at the
// tail" and keeps auto-following — a near-bottom read should not lose follow.
const BOTTOM_THRESHOLD = 32

// Inline English fallbacks for the off-edge pill (myth-em6bg closed the old T9
// contract gap: `jumpLabel` / `newMessagesLabel` are now real props the route
// resolves via i18n; the fallbacks keep every pre-pill caller rendering).
const JUMP_LABEL = 'Jump to latest ↓'
const NEW_MESSAGES_LABEL = 'New messages ↓'

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
  correctionLabel: string | undefined,
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
  if (item.kind === 'dm_correction') {
    // A set-apart errata slip (myth-d6knq) — NEVER the DM narrative register, so a
    // correction can't read as the fiction it corrects. `correctionLabel` is the
    // resolved eyebrow; absent ⇒ no eyebrow (the slip still stands apart).
    return <DmCorrection text={item.text} label={correctionLabel ?? ''} />
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

// myth-1msig — fold the item list into render segments: contiguous items sharing
// one table-talk block become a framed segment; everything else renders as the
// plain per-item stream. Pure list plumbing over the route-computed grouping.
interface StreamSegment {
  /** The table-talk block ordinal, or null for the plain stream. */
  readonly block: number | null
  /** The segment's items with their ORIGINAL indices (the divider probe needs them). */
  readonly entries: readonly { item: TranscriptItem; index: number }[]
}

function buildSegments(
  items: readonly TranscriptItem[],
  tableTalk: TableTalkView | undefined,
): StreamSegment[] {
  const segments: StreamSegment[] = []
  let open: { block: number | null; entries: { item: TranscriptItem; index: number }[] } | null = null
  items.forEach((item, index) => {
    const block = tableTalk?.blockByKey[item.key] ?? null
    if (open?.block !== block) {
      open = { block, entries: [] }
      segments.push(open)
    }
    open.entries.push({ item, index })
  })
  return segments
}

export const MessageStream = forwardRef<HTMLDivElement, MessageStreamProps>(function MessageStream(
  { items, connectionLine, reducedMotion, rollReveal, rollLabels, onRoll, onContinue, highlight, onEntityOpen, highlightLabels, correctionLabel, jumpLabel, newMessagesLabel, tableTalk, tableTalkLabel },
  ref,
) {
  const scrollRef = useRef<HTMLDivElement>(null)
  const wasAtBottom = useRef(true)
  const [showJump, setShowJump] = useState(false)
  // myth-em6bg — true when content arrived while the reader was scrolled up; the
  // pill swaps to the new-messages label and the live region announces it.
  const [hasNew, setHasNew] = useState(false)

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
  // but only while the reader is already at the bottom. Scrolled up, the same
  // change instead ARMS the new-content announcement (myth-em6bg).
  const tail = items[items.length - 1]
  const tailTextLen = tail?.kind === 'dm' ? tail.text.length : 0
  useEffect(() => {
    if (wasAtBottom.current) {
      scrollToTail()
      setShowJump(false)
      setHasNew(false)
    } else {
      setHasNew(true)
    }
  }, [items.length, tailTextLen, scrollToTail])

  const handleScroll = (): void => {
    const el = scrollRef.current
    if (el === null) return
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < BOTTOM_THRESHOLD
    wasAtBottom.current = atBottom
    setShowJump(!atBottom)
    if (atBottom) setHasNew(false)
  }

  const jumpToTail = (): void => {
    wasAtBottom.current = true
    scrollToTail()
    setShowJump(false)
    setHasNew(false)
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
        {buildSegments(items, tableTalk).map((seg) =>
          seg.block === null ? (
            seg.entries.map(({ item, index }) => (
              <Fragment key={item.key}>
                {needsDivider(items, index) ? <Divider /> : null}
                {renderItem(item, rollReveal, rollLabels, reducedMotion, onRoll, onContinue, highlight, onEntityOpen, highlightLabels, correctionLabel)}
              </Fragment>
            ))
          ) : (
            // The marked OOC exchange (myth-1msig): question + answer inside one
            // frame; no scene divider inside — the frame carries the boundary.
            <TableTalk key={`table-talk:${seg.entries[0]?.item.key ?? String(seg.block)}`} label={tableTalkLabel ?? ''}>
              {seg.entries.map(({ item }) => (
                <Fragment key={item.key}>
                  {renderItem(item, rollReveal, rollLabels, reducedMotion, onRoll, onContinue, highlight, onEntityOpen, highlightLabels, correctionLabel)}
                </Fragment>
              ))}
            </TableTalk>
          ),
        )}
      </div>
      {/* The off-edge pill (myth-em6bg): a labeled square Button, bottom-centre —
          clear of the card edges the old anonymous chevron sheared. It reads
          "Jump to latest ↓" while merely scrolled up, and "New messages ↓" once
          content has landed below the fold. */}
      {showJump ? (
        <div className="absolute bottom-[var(--space-4)] left-1/2 -translate-x-1/2">
          <Button variant="secondary" size="sm" onPress={jumpToTail}>
            {hasNew ? (newMessagesLabel ?? NEW_MESSAGES_LABEL) : (jumpLabel ?? JUMP_LABEL)}
          </Button>
        </div>
      ) : null}
      {/* Persistent polite live region: a new-content arrival below the fold is
          announced, never silent (mounted always so the announcement fires). */}
      <VisuallyHidden>
        <span role="status" aria-live="polite">
          {showJump && hasNew ? (newMessagesLabel ?? NEW_MESSAGES_LABEL) : ''}
        </span>
      </VisuallyHidden>
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
