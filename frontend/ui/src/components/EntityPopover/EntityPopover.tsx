import type { EntityPopoverProps } from '@mythrun/client-core/contract'
import { Popover } from '../Popover/Popover.tsx'
import { Icon } from '../Icon/Icon.tsx'
import { GLYPH_ICON } from '../Icon/glyph-for-kind.ts'
import { Heading } from '../Heading/Heading.tsx'
import { Text } from '../Text/Text.tsx'
import { Button } from '../Button/Button.tsx'

// EntityPopover — the terse, one-tap knowledge card that opens off a recognized
// entity mention in settled DM prose (spec §6). It composes the shipped `Popover`
// primitive: focus trap + return, Esc-to-close, and the `role="dialog"` ARIA
// wiring are ALL the Popover's job (never reimplemented here). This component owns
// only the CARD CONTENT + the controlled seam.
//
// Content is deliberately TERSE — the rich knowledge (facts, related entities,
// intro prose) lives one tap away in the wiki tab:
//   • the entity name — serif (`--font-body`), the card's title Heading;
//   • a STANDALONE type glyph — monochrome SHAPE conveys the type (person/pin/
//     banner for npc/location/faction), and `typeLabel` is its ACCESSIBLE NAME
//     (labelled `Icon`, NOT decorative): it is the sole type signal, so AT hears
//     it by name. NO entity-type COLOR is derived (spec §6 monochrome pin);
//   • the one-line lead (`card.leadLine`, `--font-body`) — omitted when the entity
//     has no known facts (empty `leadLine`);
//   • one "open in wiki" action → `onOpenInWiki` (Task 14 routes it to the wiki tab).
// Square register (flat 1-bit corners inherited from the Popover surface); no
// avatar, no circle, no status dot.
//
// `children` is the trigger (the `EntityMention` span); the Popover anchors to it.

// EntityGlyph → the DS icon vocabulary (Task 8's three world-lore glyphs). `other`
// (items / the player's own PC) gets NO glyph — the header is then just the name.
export function EntityPopover({
  card,
  open,
  onOpenChange,
  onOpenInWiki,
  label,
  typeLabel,
  openInWikiLabel,
  children,
  'data-testid': dataTestId,
}: EntityPopoverProps) {
  const iconName = GLYPH_ICON[card.glyph]
  return (
    <Popover
      trigger={children}
      label={label}
      open={open}
      onOpenChange={onOpenChange}
      {...(dataTestId !== undefined ? { 'data-testid': dataTestId } : {})}
    >
      <div className="flex items-center gap-[var(--space-2)]">
        {iconName !== null && <Icon name={iconName} label={typeLabel} size="sm" />}
        <Heading level={2} role="title">
          {card.name}
        </Heading>
      </div>
      {card.leadLine !== '' && (
        <Text role="prose-body" as="p" data-testid="entity-popover-lead">
          {card.leadLine}
        </Text>
      )}
      <div className="flex">
        <Button variant="ghost" size="sm" onPress={onOpenInWiki}>
          {openInWikiLabel}
        </Button>
      </div>
    </Popover>
  )
}
