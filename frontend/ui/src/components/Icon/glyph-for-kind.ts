import type { EntityGlyph, IconName } from '@mythrun/client-core/contract'

// The one entity-kind → icon map (MYT-94). A plain lookup, not a heuristic:
// the glyph was already chosen from `entityType` upstream (the matcher); this
// only names the shape. `other` deliberately has no glyph — an unrecognized
// kind renders as plain monochrome text, never a guessed symbol.
export const GLYPH_ICON: Record<EntityGlyph, IconName | null> = {
  npc: 'entity-npc',
  location: 'entity-location',
  faction: 'entity-faction',
  other: null,
}
