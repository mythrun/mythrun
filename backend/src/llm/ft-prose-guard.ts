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

export type FtProseViolationKind = 'unrendered_emphasis' | 'fused_sentence' | 'internal_term'

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

// A fused sentence seam (myth-uhr0f): sentence-final punctuation immediately followed
// by a capital, with a LOWERCASE letter before the punctuation. The lowercase-before
// guard excludes initials / acronyms ("V. L. K.", "U.S.A.", "J.R.R.") whose letter
// before the period is itself a capital, while still catching "once.Hast" / "it.You".
const FUSED_SEAM = /[a-z][.!?]["'”’)]?[A-Z]/

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

  return violations
}
