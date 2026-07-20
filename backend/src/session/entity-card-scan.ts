// backend/src/session/entity-card-scan.ts
//
// myth-dwyuw — the PURE, deterministic name-scan + entity-card formatting used
// to fix "FT invents attributes for a canon NPC that enters play BY NAME
// mid-session." When a canonical entity's name is spoken in the recent
// transcript but its card is not in the FT's context, the Fast Thinker guesses
// attributes (the live bug: canon-female Captain Marsen Roud rendered male for a
// whole session). This module answers ONE structural question — "which of the
// world's KNOWN entities are named in this text?" — via normalized-name
// matching against the structured entity list. That is deterministic string
// matching against canon (an allowed ZFC exception, same family as schema
// validation / the `findIdByWorldAndNormalizedName` reconcile heal), NOT a
// semantic judgment: no model, no heuristics about MEANING.
//
// The DB-backed orchestrator that turns matches into an injected ft_context
// block lives in turn-context.ts (`augmentFtContextWithEntityCards`); this file
// is IO-free so the matching rules are unit-testable in isolation.
//
// ENFORCED IGNORANCE: this module never decides tiers. The orchestrator hands it
// only KNOWN-tier entity names to match and only KNOWN-tier fact content to
// format — discoverable/secret data never reaches here. Keeping the tier filter
// upstream (in the SQL reads) means there is structurally no path for a secret
// to enter a card.

/** Minimum token count for a name to be matchable. Single-token names (e.g. a
 *  bare "Trask") are EXCLUDED: a one-word match against free prose is too
 *  false-positive-prone (common words collide with short names). Requiring ≥2
 *  contiguous name tokens at word boundaries is the documented guard the bead
 *  calls for. Consequence: a canon NPC whose only name form is a single token
 *  is not auto-injected (acceptable — the live bug case, "Marsen Roud", is two
 *  tokens; multi-token is the overwhelmingly common shape for named NPCs). */
export const MATCH_MIN_TOKENS = 2

/** Max entity cards injected per turn. A single scene rarely surfaces more than
 *  a handful of canon names at once; this caps the token cost of the injected
 *  block (the ft_context rides the cached system prefix — an unbounded block
 *  would bloat every turn). Beyond the cap, the earliest-mentioned entities in
 *  the window win (deterministic); over-cap truncation is rare in practice. */
export const ENTITY_CARD_CAP = 6

/** A leading/trailing space-padded, normalized haystack. Built once per scan so
 *  the per-entity match loop is a cheap `indexOf`. The padding lets a run match
 *  test word boundaries with `indexOf(' ' + run + ' ')` (a run at the very start
 *  or end of the text still has a bounding space). */
export type Haystack = string & { readonly __brand: 'entity-scan-haystack' }

/** The minimal entity shape the scan needs. `entityType` rides through only so
 *  the caller can format the card label; it plays no part in matching. */
export interface ScanEntity {
  readonly id: string
  readonly name: string
  readonly entityType: string
}

/** Lowercase, fold every non-alphanumeric run to a single space, trim. Apostrophes
 *  and punctuation become boundaries, so "Willow's Grace" → "willow s grace" and a
 *  transcript "the Willow's Grace rail" → "…willow s grace rail" — BOTH sides fold
 *  identically, so the tokenization stays consistent even for the odd `s` token. */
export function normalizeName(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
}

/** Normalize `text` and pad it with bounding spaces → a `Haystack` ready for
 *  `firstMentionIndex`. Build this ONCE per body of text, then test many names
 *  against it. */
export function toHaystack(text: string): Haystack {
  return ` ${normalizeName(text)} ` as Haystack
}

/**
 * The index (into `haystack`) of the FIRST word-boundary mention of `name`, or
 * `null` when it does not appear. A name is "mentioned" when ANY contiguous run
 * of ≥ `MATCH_MIN_TOKENS` of its tokens appears at word boundaries — this makes
 * the match robust to leading honorifics WITHOUT a hardcoded title list: canon
 * "Captain Marsen Roud" is mentioned by a transcript "Marsen Roud brought the
 * charter" via the run "marsen roud". Names shorter than `MATCH_MIN_TOKENS`
 * tokens never match (the single-token false-positive guard).
 */
export function firstMentionIndex(name: string, haystack: Haystack): number | null {
  const tokens = normalizeName(name).split(' ').filter((t) => t !== '')
  if (tokens.length < MATCH_MIN_TOKENS) return null

  let best: number | null = null
  // All contiguous runs of length ≥ MATCH_MIN_TOKENS. The full name is the
  // longest run; sub-runs cover the honorific-stripped and suffix forms.
  for (let len = tokens.length; len >= MATCH_MIN_TOKENS; len--) {
    for (let start = 0; start + len <= tokens.length; start++) {
      const run = tokens.slice(start, start + len).join(' ')
      const at = haystack.indexOf(` ${run} `)
      if (at !== -1 && (best === null || at < best)) best = at
    }
  }
  return best
}

/**
 * Scan `text` for every entity in `entities` whose name is mentioned (per
 * `firstMentionIndex`), returning the matches ordered by FIRST appearance in the
 * text (earliest first; ties broken by id for determinism) and capped at `cap`
 * (default `ENTITY_CARD_CAP`). Deterministic: same inputs → same output, which
 * keeps the injected block idempotent turn-over-turn.
 */
export function scanMentionedEntities(
  entities: readonly ScanEntity[],
  text: string,
  opts?: { readonly cap?: number },
): ScanEntity[] {
  const cap = opts?.cap ?? ENTITY_CARD_CAP
  const haystack = toHaystack(text)
  const matched: { readonly e: ScanEntity; readonly idx: number }[] = []
  for (const e of entities) {
    const idx = firstMentionIndex(e.name, haystack)
    if (idx !== null) matched.push({ e, idx })
  }
  matched.sort((a, b) => a.idx - b.idx || (a.e.id < b.e.id ? -1 : a.e.id > b.e.id ? 1 : 0))
  return matched.slice(0, cap).map((m) => m.e)
}

/** Format ONE entity card: `- Name (type): known fact. known fact.` Facts are
 *  the entity's KNOWN-tier fact content ONLY (the orchestrator fetches nothing
 *  else). With no known facts the card is just the labelled name — still useful
 *  grounding (the name/type exist in canon), though the attribute-fixing power
 *  comes from the facts. Blank fact strings are dropped. */
export function formatEntityCard(
  name: string,
  entityType: string,
  knownFacts: readonly string[],
): string {
  const body = knownFacts.map((f) => f.trim()).filter((f) => f !== '').join(' ')
  return body === '' ? `- ${name} (${entityType})` : `- ${name} (${entityType}): ${body}`
}

/** Wrap the formatted cards in the injected ft_context block, or `''` when there
 *  are none (the caller appends the return value to the base ft_context). The
 *  label is a neutral, factual grounding frame — mirrors the code-owned
 *  `[Party ledger: …]` / `[DM direction: …]` tails in fast-thinker.ts. It carries
 *  NO plot rationale (enforced ignorance): it states only that these are already-
 *  established, player-visible canon the FT must not contradict. */
export function buildEntityCardBlock(cards: readonly string[]): string {
  if (cards.length === 0) return ''
  return (
    '\n\n[Established canon for named characters and places now in play — ' +
    'treat as ground truth; do not invent details that contradict it:\n' +
    cards.join('\n') +
    ']'
  )
}
