import { Fragment } from 'react'
import type { ReactNode } from 'react'

// Inline emphasis for DM prose (myth-5syk3). The brand is a book page — a quoted
// ledger line set in italics, three ominous initials in bold — so we RENDER the
// FT's inline markdown emphasis (em / strong ONLY) rather than let raw `*` reach the
// reader. Deliberately NOT a markdown library: narrative prose has no headings,
// lists, links, or code, and pulling a full parser (and its blast radius) to render
// two inline marks fails the dependency bar. This tiny scanner is the single source
// of truth — the settled render maps its segments to <em>/<strong>, the streaming
// render strips the markers so no literal `*` flashes mid-stream, and the FT-output
// validator reuses it to fail loud when an UNBALANCED marker would leak to the DOM.
//
// Grammar (flat, no nesting): `**text**` → strong, `*text*` → em. A span's content
// must be non-empty and marker-free (the nearest closer wins). Anything that does not
// close — an in-progress opener mid-stream, or a genuinely unbalanced marker at
// settle — stays LITERAL plain text: mid-stream the strip hides it; at settle it
// renders visibly (the fail-loud signal the validator also flags). `_` is not treated
// as emphasis (it collides with prose punctuation / names and is not in the register).

export type EmphasisKind = 'plain' | 'em' | 'strong'

export interface EmphasisSegment {
  readonly text: string
  readonly kind: EmphasisKind
}

/** Scan `text` into flat plain / em / strong segments. Pure; the single grammar. */
export function parseInlineEmphasis(text: string): EmphasisSegment[] {
  const segments: EmphasisSegment[] = []
  let plain = ''
  const flushPlain = (): void => {
    if (plain !== '') {
      segments.push({ text: plain, kind: 'plain' })
      plain = ''
    }
  }

  let i = 0
  while (i < text.length) {
    // strong first (** is a superset of *): the nearest following ** closes it.
    if (text.startsWith('**', i)) {
      const close = text.indexOf('**', i + 2)
      const content = close === -1 ? '' : text.slice(i + 2, close)
      if (content !== '' && !content.includes('*')) {
        flushPlain()
        segments.push({ text: content, kind: 'strong' })
        i = close + 2
        continue
      }
      // No valid closer / empty / marker-laden content → the `**` is literal.
      plain += '**'
      i += 2
      continue
    }
    if (text[i] === '*') {
      const close = text.indexOf('*', i + 1)
      const content = close === -1 ? '' : text.slice(i + 1, close)
      if (content !== '') {
        flushPlain()
        segments.push({ text: content, kind: 'em' })
        i = close + 1
        continue
      }
      plain += '*'
      i += 1
      continue
    }
    plain += text.charAt(i)
    i += 1
  }
  flushPlain()
  return segments
}

/** The streaming render: clean plain text with emphasis MARKERS removed so no
 *  literal `*` flashes while a span is still open. Unwraps balanced spans and drops
 *  any remaining (in-progress) `*`. A no-op for prose with no markers — the common
 *  case — so the single-text-node streaming path stays byte-identical. */
export function stripInlineEmphasis(text: string): string {
  if (!text.includes('*')) return text
  return parseInlineEmphasis(text)
    .map((s) => s.text)
    .join('')
    .replace(/\*/g, '')
}

/** The settled render: segments → React nodes (`<em>` / `<strong>` / bare text).
 *  A leftover literal marker in a plain segment renders as-is (visible → the
 *  fail-loud signal). Keys are index-stable (the settled text does not reorder). */
export function renderInlineEmphasis(text: string): ReactNode {
  const segments = parseInlineEmphasis(text)
  if (segments.length === 1 && segments[0]?.kind === 'plain') return segments[0].text
  return segments.map((seg, i) => {
    if (seg.kind === 'em') return <em key={i}>{seg.text}</em>
    if (seg.kind === 'strong') return <strong key={i}>{seg.text}</strong>
    return <Fragment key={i}>{seg.text}</Fragment>
  })
}
