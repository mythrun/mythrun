// ENTITY MATCHER — the pure, DOM-free index that turns SETTLED DM prose into a
// run of plain-text + recognized-entity segments (MYT-94 Task 3). Lives in the
// client brain: it consumes a snapshot and returns pure functions, never a fetch
// of its own. ZFC: this is MECHANICAL substring matching over a data-derived name
// index — no LLM, no heuristic classification, no pattern-matching on the prose
// (the prose is displayed verbatim; matching is against entity NAMES only).
//
// ENFORCED IGNORANCE IS SERVER-SIDE. The snapshot is the already-known-tier,
// member-readable `getWorldSnapshot` projection — the matcher adds no tier logic.
//
// NAMES ONLY. No alias field exists on any known-tier projection, so a name is
// the only surface a player recognizes mid-narrative. Highlightable kinds are
// npc / location / faction (world lore); 'item' clutters prose and 'pc' is the
// player's own name, so both fall through to the neutral 'other' glyph and are
// NOT highlighted.
//
// WORD BOUNDARIES — a DELIBERATE deviation from the plan's literal `\b`. The plan
// pins the ALGORITHM (one longest-first alternation + `matchAll`, escaped names,
// case-insensitive), and this module honors that exactly. It substitutes the
// boundary MECHANISM: `\b` is ASCII-only and silently drops any name with a
// leading/trailing non-ASCII letter (accents — common in evocative fantasy
// names: "Éowyn", "André", "Zoë"). Verified empirically that `\bÉowyn\b` fails to
// match "Éowyn". The Unicode-aware lookaround guards `(?<![\p{L}\p{N}_]) … (?![…])`
// (with the `u` flag) preserve the plan's exact INTENT — longest-match, no
// partial-word hits — while matching accented names too. Every enumerated plan
// test passes identically under this mechanism.

import type { EntityKind } from '@mythrun/contract/rest'
import type { WorldGenSnapshot } from '../api/campaigns.ts'

/** The type-glyph vocabulary. The four world-lore kinds map to a leading glyph;
 *  'item'/'pc' fall through to a neutral 'other' (never highlighted). No COLOR is
 *  derived from this (spec §6 monochrome pin). */
export type EntityGlyph = 'npc' | 'location' | 'faction' | 'other'

/** One run of settled DM prose: plain text, or a matched entity mention. */
export type ProseSegment =
  | { readonly kind: 'text'; readonly text: string }
  | { readonly kind: 'entity'; readonly text: string; readonly entityId: string; readonly glyph: EntityGlyph }

/** The terse popover card — the one-tap knowledge surface. `leadLine` is the
 *  first sentence of the entity's prose kernel (MYT-102 put kernels on the
 *  known-tier wire), falling back to the entity's first known fact content;
 *  empty when it has neither. */
export interface EntityCard {
  readonly entityId: string
  readonly name: string
  readonly glyph: EntityGlyph
  readonly leadLine: string
}

/** The compiled matcher. `segment` runs per settled message; `card` resolves the
 *  popover content lazily on open. Both pure + fast (no fetch, no LLM). */
export interface EntityIndex {
  segment(text: string): readonly ProseSegment[]
  card(entityId: string): EntityCard | null
}

/** A resolved highlightable entity, keyed in `byLowerName` by its lowercased name. */
interface EntityRef {
  readonly id: string
  readonly glyph: EntityGlyph
}

/** Map a snapshot entity_type to its glyph. Only npc/location/faction are
 *  highlightable; item/pc collapse to the neutral 'other'. */
function glyphForKind(kind: EntityKind): EntityGlyph {
  switch (kind) {
    case 'npc':
      return 'npc'
    case 'location':
      return 'location'
    case 'faction':
      return 'faction'
    default:
      return 'other'
  }
}

/** Escape the regex metacharacters in an LLM-authored name so it matches
 *  literally (a name like "The Vault (Sealed)" is not a group). */
function escapeRegExp(literal: string): string {
  return literal.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/** The MECHANICAL first sentence of a prose kernel (ZFC — a '. ' split, no
 *  summarization), capped at the first line so a multi-paragraph kernel never
 *  leaks a wall into the popover. '' for whitespace-only input. */
function firstSentence(prose: string): string {
  const text = prose.trim()
  const newline = text.indexOf('\n')
  const firstLine = newline === -1 ? text : text.slice(0, newline)
  const stop = firstLine.indexOf('. ')
  return (stop === -1 ? firstLine : firstLine.slice(0, stop + 1)).trim()
}

/** The narrow snapshot slice a lead line needs — kernels + facts. Declared
 *  STRUCTURALLY (not as `WorldGenSnapshot`) so the wiki view model's
 *  `WikiSnapshot` fits the same function: both wires carry these two
 *  collections, and one derivation keeps the popover card and the wiki index
 *  handle saying the SAME sentence about a person (ux-run3 myth-ry14g). */
export interface LeadLineSource {
  readonly proseKernels?: readonly { readonly entityId: string; readonly content: string }[] | undefined
  readonly facts: readonly { readonly id: string; readonly entityId: string; readonly content: string }[]
}

/** entityId → its lead line: the first sentence of its prose kernel (MYT-102 —
 *  the entity's actual description), falling back to the content of its
 *  lowest-id fact (matching the id-ordered fact grouping the wiki view model
 *  uses), absent when it has neither. */
export function buildLeadLines(snapshot: LeadLineSource): Map<string, string> {
  const leadLines = new Map<string, string>()
  for (const kernel of snapshot.proseKernels ?? []) {
    const lead = firstSentence(kernel.content)
    if (lead !== '') leadLines.set(kernel.entityId, lead)
  }
  const bestFact = new Map<string, { id: string; content: string }>()
  for (const fact of snapshot.facts) {
    const current = bestFact.get(fact.entityId)
    if (current === undefined || fact.id.localeCompare(current.id) < 0) {
      bestFact.set(fact.entityId, { id: fact.id, content: fact.content })
    }
  }
  for (const [entityId, fact] of bestFact) {
    if (!leadLines.has(entityId)) leadLines.set(entityId, fact.content)
  }
  return leadLines
}

/** The precomputed lookups the compiled matcher closes over. */
interface Compiled {
  readonly byLowerName: Map<string, EntityRef>
  readonly cardById: Map<string, EntityCard>
  readonly names: string[]
}

/**
 * Precompute the highlightable name index ONCE. Entities are ordered by
 * (name, id) so that a duplicate lowercased name resolves to the FIRST
 * deterministically; each unique lowercased name is registered once (later
 * duplicates skipped), and every highlightable entity gets a card.
 */
function compile(snapshot: WorldGenSnapshot, leadLines: ReadonlyMap<string, string>): Compiled {
  const highlightable = snapshot.entities
    .map((e) => ({ id: e.id, name: e.name, glyph: glyphForKind(e.entityType) }))
    .filter((e) => e.glyph !== 'other')
    .sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id))

  const byLowerName = new Map<string, EntityRef>()
  const cardById = new Map<string, EntityCard>()
  const names: string[] = []
  for (const e of highlightable) {
    cardById.set(e.id, { entityId: e.id, name: e.name, glyph: e.glyph, leadLine: leadLines.get(e.id) ?? '' })
    const key = e.name.toLowerCase()
    if (!byLowerName.has(key)) {
      byLowerName.set(key, { id: e.id, glyph: e.glyph })
      names.push(e.name)
    }
  }
  return { byLowerName, cardById, names }
}

/**
 * Compile the longest-first, Unicode-boundary-anchored matcher over the names.
 * Ordered alternation makes the FIRST (longest) alternative win at each start
 * position, so "Gorm the Bloody" beats "Gorm"; the lookaround guards enforce
 * no-partial-word; flags `giu` give case-insensitive Unicode matching.
 */
function buildMatcher(names: string[]): RegExp {
  const alternation = names
    .slice()
    .sort((a, b) => b.length - a.length || a.localeCompare(b))
    .map(escapeRegExp)
    .join('|')
  return new RegExp(`(?<![\\p{L}\\p{N}_])(?:${alternation})(?![\\p{L}\\p{N}_])`, 'giu')
}

/**
 * Walk the non-overlapping `matchAll` results left-to-right, emitting text runs
 * between matches and entity runs for matches. A case-fold-divergent match (the
 * `i` flag folds it, but `.toLowerCase()` re-derivation misses — e.g. Greek Σ vs
 * a name "ς") degrades gracefully to plain text: `lastIndex` is not advanced, so
 * the characters fall into the surrounding text run rather than a broken entity.
 */
function segmentText(text: string, matcher: RegExp, byLowerName: ReadonlyMap<string, EntityRef>): ProseSegment[] {
  const segments: ProseSegment[] = []
  let lastIndex = 0
  for (const match of text.matchAll(matcher)) {
    const ref = byLowerName.get(match[0].toLowerCase())
    if (ref === undefined) continue
    const start = match.index
    if (start > lastIndex) segments.push({ kind: 'text', text: text.slice(lastIndex, start) })
    segments.push({ kind: 'entity', text: match[0], entityId: ref.id, glyph: ref.glyph })
    lastIndex = start + match[0].length
  }
  if (lastIndex < text.length) segments.push({ kind: 'text', text: text.slice(lastIndex) })
  if (segments.length === 0) return [{ kind: 'text', text }]
  return segments
}

/**
 * Build the compiled entity index from a member-readable world snapshot. Called
 * ONCE on snapshot fetch (by the knowledge cache), not per render — `segment`
 * and `card` are the pure, allocation-light functions the highlighter and
 * popover invoke thereafter.
 */
export function buildEntityIndex(snapshot: WorldGenSnapshot): EntityIndex {
  const { byLowerName, cardById, names } = compile(snapshot, buildLeadLines(snapshot))
  const card = (entityId: string): EntityCard | null => cardById.get(entityId) ?? null
  if (names.length === 0) {
    return { segment: (text) => [{ kind: 'text', text }], card }
  }
  const matcher = buildMatcher(names)
  return { segment: (text) => segmentText(text, matcher, byLowerName), card }
}
