// backend/src/llm/ft-prose-guard.ts
//
// A DETERMINISTIC structural guard on Fast-Thinker narration (ux-run1). The three
// defects it catches are MECHANICAL patterns — a leaked emphasis marker, a fused
// sentence seam, a scaffolding term in the fiction — not judgment calls, so ZFC
// permits a deterministic check here (the Haiku turn-audit stays for the semantic
// classes: PC-speech, inline correction, fake end).
//
// This guard is OBSERVABILITY + a smoke assertion, never a turn blocker: the real
// fixes live elsewhere (the emphasis renderer + the reducer seam on the client, the
// ft-system prompt for the internal-term leak). A leak that slips past those should
// FAIL LOUD in a constructed smoke and log a warn in prod — not fail a live turn on a
// prose nit (that would strand the player mid-scene). The AuditedFastThinker calls it
// post-render and logs any hits.

export type FtProseViolationKind =
  | 'unrendered_emphasis'
  | 'fused_sentence'
  | 'internal_term'
  | 'structure_token'
  | 'leading_fragment'

export interface FtProseViolation {
  readonly kind: FtProseViolationKind
  /** The offending fragment, for the log line / smoke assertion. */
  readonly detail: string
}

// Scaffolding phrases that must never surface in player-facing prose (myth-eehro).
// Specific multi-word phrases only — a bare word like "context" appears in legitimate
// narration ("in the context of the war"), so it is NOT on the list.
const INTERNAL_TERMS: readonly string[] = [
  'session context',
  'stage direction',
  'system prompt',
  'world delta',
  'dm direction',
  'as provided',
  'the context says',
  'my instructions',
  'the scaffolding',
]

// A markdown structure token (ux-run2, myth-g4hf3 cross-cutting): a line that is
// nothing but a horizontal rule (---, ***, ___). The client renders FT narration
// as prose, so the token surfaces LITERALLY on the page (playthrough-2 seq 12
// ended with a bare "---"). Same posture as the other checks: observability
// only; the real fix is the ft-system prompt.
const STRUCTURE_TOKEN = /^[ \t]*(-{3,}|\*{3,}|_{3,})[ \t]*$/m

// A fused sentence seam (myth-uhr0f): sentence-final punctuation immediately followed
// by a capital, with a LOWERCASE letter before the punctuation. The lowercase-before
// guard excludes initials / acronyms ("V. L. K.", "U.S.A.", "J.R.R.") whose letter
// before the period is itself a capital, while still catching "once.Hast" / "it.You".
const FUSED_SEAM = /[a-z][.!?]["'”’)]?[A-Z]/

// A rendered segment that OPENS MID-WORD (myth-q9for artifact #2). The 2026-07-18
// playtest saw a response begin `oss described. Wiry, amber button…` — the tail of a
// prior beat's "V-oss", surfacing as if it were the start of the turn. The transport
// causes were closed since (myth-uhr0f aligned live/replay segmentation; the turn
// worker's §5 order refuses to re-stream an already-streamed turnId), but nothing
// DETECTED the shape, so a recurrence would reach a reader before anyone noticed.
//
// Granularity: every FT text part becomes its own dm_text row and renders as its own
// paragraph, and `joinNarration` joins parts with a blank line — so the blank-line
// split below is exactly the set of openings a reader sees. Legitimate narration opens
// with a capital, a quotation mark, or a bracket. Two openings are DELIBERATE devices
// that legitimately precede a lowercase word — a leading ellipsis ("…and then the
// light was gone") and a leading dash ("— and the door gives, finally") — so both are
// exempt rather than stripped. They are the cases that make a naive "segment starts
// lowercase" rule wrong.
const SEGMENT_SPLIT = /\n[ \t]*\n/
/** Opening punctuation a segment may legitimately lead with, skipped before the test.
 *  Deliberately EXCLUDES dashes — see DELIBERATE_OPENING. */
const OPENING_PUNCTUATION = /^[\s"'“”‘’(\[{]+/
/** A device opening (ellipsis or dash) that may correctly be followed by lowercase. */
const DELIBERATE_OPENING = /^\s*(?:…|\.{3}|[—–-])/

/** The first segment whose visible opening is a lowercase letter, or undefined. */
function findLeadingFragment(narration: string): string | undefined {
  for (const segment of narration.split(SEGMENT_SPLIT)) {
    if (segment.trim() === '') continue
    if (DELIBERATE_OPENING.test(segment)) continue
    const opening = segment.replace(OPENING_PUNCTUATION, '')
    if (/^\p{Ll}/u.test(opening)) return opening.slice(0, 32).trim()
  }
  return undefined
}

// Detect an emphasis marker that the client renderer would leave as a LITERAL on the
// page. The renderer converts balanced `*em*` / `**strong**`; it does NOT handle `_`.
// So a leak is either an unbalanced `*`, or any `_`-delimited emphasis pair. We strip
// the balanced `*` spans first (longest marker first), then look for a residual `*`.
function findEmphasisLeak(text: string): string | undefined {
  const withoutBalanced = text
    .replace(/\*\*([^*\n]+?)\*\*/g, '$1') // **strong**
    .replace(/\*([^*\n]+?)\*/g, '$1') // *em*
  const starIdx = withoutBalanced.indexOf('*')
  if (starIdx !== -1) return sliceAround(withoutBalanced, starIdx)
  // A `_word_` / `__word__` pair the renderer can't convert (flanked by non-word chars
  // so snake_case / mid-word underscores don't false-positive).
  const underscore = /(?:^|[^\w])(_{1,2}[^_\n]+_{1,2})(?:[^\w]|$)/.exec(text)
  /* c8 ignore next 2 — the `?? '_'` arm is TS-required (exec's groups type as
     string|undefined) but unreachable: group 1 is non-optional when the regex matches. */
  if (underscore) return underscore[1] ?? '_'
  return undefined
}

/** A short window around an index, for a readable log detail. */
function sliceAround(text: string, idx: number): string {
  return text.slice(Math.max(0, idx - 16), idx + 16).trim()
}

/** Run the deterministic checks over one turn's joined narration. Order is stable
 *  (emphasis, fused seam, internal term); each class reports at most once. */
export function checkFtProse(narration: string): FtProseViolation[] {
  const violations: FtProseViolation[] = []

  const emphasis = findEmphasisLeak(narration)
  if (emphasis !== undefined) violations.push({ kind: 'unrendered_emphasis', detail: emphasis })

  const fused = FUSED_SEAM.exec(narration)
  if (fused !== null) violations.push({ kind: 'fused_sentence', detail: sliceAround(narration, fused.index) })

  const lower = narration.toLowerCase()
  const term = INTERNAL_TERMS.find((t) => lower.includes(t))
  if (term !== undefined) {
    const idx = lower.indexOf(term)
    violations.push({ kind: 'internal_term', detail: narration.slice(idx, idx + term.length) })
  }

  const structure = STRUCTURE_TOKEN.exec(narration)
  if (structure !== null) {
    violations.push({ kind: 'structure_token', detail: sliceAround(narration, structure.index) })
  }

  const fragment = findLeadingFragment(narration)
  if (fragment !== undefined) violations.push({ kind: 'leading_fragment', detail: fragment })

  return violations
}
