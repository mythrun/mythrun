import type { DmMessageProps, EntityCard, EntityGlyph, EntityIndex, ProseSegment } from '@mythrun/client-core/contract'

// Story-only highlight fixtures (MYT-94 Task 11) — a self-contained EntityIndex + resolved
// chrome so the DmMessage / MessageStream "highlighted" specimens render without the live
// client-core cache. In production the index is built by `buildEntityIndex` from the
// member world-snapshot and the labels are resolved from i18n by the play route (Task 14);
// here we hand-roll a small cast so the specimen is deterministic. NOT a CSF module (a
// `.ts`, not `.stories.tsx`), so Storybook does not treat these exports as stories.

interface StoryEntity {
  readonly id: string
  readonly name: string
  readonly glyph: EntityGlyph
  readonly leadLine: string
}

/** Escape regex metacharacters so a name matches literally. */
function escapeRegExp(literal: string): string {
  return literal.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/** A small, story-only EntityIndex: longest-first, word-boundary name matching over a fixed
 *  cast. (The production matcher — client-core's `buildEntityIndex` — is Unicode-boundary
 *  aware; a specimen over ASCII cast names needs only `\b`.) */
export function makeStoryIndex(entities: readonly StoryEntity[]): EntityIndex {
  const byLower = new Map(entities.map((e) => [e.name.toLowerCase(), e]))
  const alternation = entities
    .map((e) => e.name)
    .sort((a, b) => b.length - a.length || a.localeCompare(b))
    .map(escapeRegExp)
    .join('|')
  const matcher = new RegExp(`\\b(?:${alternation})\\b`, 'gi')
  return {
    segment(text: string): readonly ProseSegment[] {
      const segments: ProseSegment[] = []
      let lastIndex = 0
      for (const match of text.matchAll(matcher)) {
        const entity = byLower.get(match[0].toLowerCase())
        if (entity === undefined) continue
        const start = match.index
        if (start > lastIndex) segments.push({ kind: 'text', text: text.slice(lastIndex, start) })
        segments.push({ kind: 'entity', text: match[0], entityId: entity.id, glyph: entity.glyph })
        lastIndex = start + match[0].length
      }
      if (lastIndex < text.length) segments.push({ kind: 'text', text: text.slice(lastIndex) })
      return segments.length > 0 ? segments : [{ kind: 'text', text }]
    },
    card(entityId: string): EntityCard | null {
      const entity = entities.find((e) => e.id === entityId)
      return entity === undefined
        ? null
        : { entityId: entity.id, name: entity.name, glyph: entity.glyph, leadLine: entity.leadLine }
    },
  }
}

/** A small world-lore cast: an NPC + a location (both with a lead line) and a faction with
 *  NO lead line (exercises the omitted-lead popover branch). */
export const STORY_CAST: readonly StoryEntity[] = [
  {
    id: 'npc-elenya',
    name: 'Elenya',
    glyph: 'npc',
    leadLine: 'The herbalist who keeps the low road; she trades in cures and in rumours.',
  },
  {
    id: 'loc-highreach',
    name: 'Highreach',
    glyph: 'location',
    leadLine: 'A cliff-town of switchback stairs, roped to the mountain by old rope bridges.',
  },
  { id: 'fac-ashen-hand', name: 'the Ashen Hand', glyph: 'faction', leadLine: '' },
]

/** The compiled specimen index over {@link STORY_CAST}. */
export const STORY_INDEX: EntityIndex = makeStoryIndex(STORY_CAST)

const TYPE_LABEL: Record<EntityGlyph, string> = {
  npc: 'Character',
  location: 'Location',
  faction: 'Faction',
  other: 'Entity',
}

/** Resolved mention / popover chrome for the specimen (the route resolves these from i18n). */
export const STORY_LABELS: NonNullable<DmMessageProps['highlightLabels']> = {
  mentionLabelFor: (name) => `Entity: ${name}`,
  typeLabelFor: (glyph) => TYPE_LABEL[glyph],
  openInWikiLabel: 'Open in wiki',
}
