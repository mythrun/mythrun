import { describe, it, expect } from 'vitest'
import { checkFtProse } from '../ft-prose-guard.js'

// A DETERMINISTIC structural check on FT narration (ux-run1). These three defect
// classes are mechanical patterns, not judgment calls, so ZFC permits a deterministic
// gate (no LLM): it fails LOUD in smoke and logs in prod, while the render surface
// (emphasis renderer, reducer seam) and the ft-system prompt are the real fixes. The
// gate never blocks a turn — it is observability + a smoke assertion.

const kinds = (text: string): string[] => checkFtProse(text).map((v) => v.kind)

describe('checkFtProse — clean prose passes', () => {
  it('returns no violations for well-formed narration', () => {
    expect(checkFtProse('The hall runs long and low. The air is warm. It smells of wet wool.')).toEqual([])
  })

  it('accepts BALANCED emphasis markers (they render as em/strong, not literal)', () => {
    expect(checkFtProse('What is wrong is the *order*. The letters are **V. L. K.** on the page.')).toEqual([])
  })

  it('does not flag initials / acronyms with internal periods (V. L. K., U.S.A.)', () => {
    expect(checkFtProse('The letters are V. L. K. and the flag of the U.S.A. hung there.')).toEqual([])
  })
})

describe('checkFtProse — unrendered emphasis (myth-5syk3)', () => {
  it('flags an UNBALANCED asterisk that would leak to the reader as a literal', () => {
    expect(kinds('opened *but never closed')).toContain('unrendered_emphasis')
  })

  it('flags an underscore emphasis pair the renderer does not handle', () => {
    expect(kinds('the _order_ was wrong')).toContain('unrendered_emphasis')
  })

  it('does not flag prose with no markers at all', () => {
    expect(kinds('the order was wrong')).not.toContain('unrendered_emphasis')
  })
})

describe('checkFtProse — fused sentence seam (myth-uhr0f)', () => {
  it('flags a missing space at a sentence boundary ("once.Hast")', () => {
    expect(kinds('you have turned to it more than once.Hast writes with a soft hand')).toContain('fused_sentence')
  })

  it('flags the wind-down "it.You" case', () => {
    expect(kinds('if the count demands it.You sleep without difficulty')).toContain('fused_sentence')
  })

  it('does NOT flag a paragraph break between two sentences (the joined-part seam)', () => {
    // AuditedFastThinker joins text parts with a blank line — the cross-part boundary
    // is whitespace-separated, so it is not a fusion.
    expect(kinds('more than once.\n\nHast writes with a soft hand')).not.toContain('fused_sentence')
  })

  it('does not flag a normal space-separated sentence boundary', () => {
    expect(kinds('more than once. Hast writes with a soft hand')).not.toContain('fused_sentence')
  })
})

describe('checkFtProse — internal-term leak (myth-eehro)', () => {
  it('flags "session context" surfacing in the fiction', () => {
    const v = checkFtProse('The passage to the Eleventh Intercostal narrows as the session context says it does.')
    expect(v.map((x) => x.kind)).toContain('internal_term')
    expect(v.find((x) => x.kind === 'internal_term')?.detail.toLowerCase()).toContain('session context')
  })

  it('flags other scaffolding terms (stage direction, system prompt)', () => {
    expect(kinds('as the stage direction indicates')).toContain('internal_term')
    expect(kinds('per the system prompt')).toContain('internal_term')
  })

  it('is case-insensitive', () => {
    expect(kinds('The Session Context tells me')).toContain('internal_term')
  })

  it('does not flag ordinary prose that happens to use the word "context"', () => {
    expect(kinds('In the context of the war, the count matters.')).not.toContain('internal_term')
  })
})

describe('checkFtProse — structure token (ux-run2, myth-g4hf3)', () => {
  it('flags a bare horizontal-rule line ("---") that the client would render literally', () => {
    expect(kinds('The correction stands — there is no sliver.\n\n---')).toContain('structure_token')
  })

  it('flags *** and ___ rule lines too', () => {
    expect(kinds('The hall darkens.\n***\nA bell rings.')).toContain('structure_token')
    expect(kinds('The hall darkens.\n  ___  \nA bell rings.')).toContain('structure_token')
  })

  it('does not flag an em-dash or a hyphenated aside inside a sentence', () => {
    expect(kinds('The stone - old, sea-worn - does not yield.')).not.toContain('structure_token')
    expect(kinds('He waits --- longer than he should --- then speaks.')).not.toContain('structure_token')
  })
})

// myth-q9for artifact #2 — a rendered segment that OPENS MID-WORD. The 2026-07-18
// playtest saw a response begin "oss described. Wiry, amber button…" — the tail of a
// prior beat's "V-oss". The transport causes for that were closed (myth-uhr0f aligned
// live/replay segmentation; the turn worker refuses to re-stream a turnId), but no
// detector existed, so a recurrence would again reach a reader before anyone noticed.
// This is that detector: same posture as its siblings — log + smoke assertion, never
// a turn blocker.
describe('checkFtProse — leading fragment (myth-q9for #2)', () => {
  it('flags the reported artifact: a response opening mid-word', () => {
    expect(kinds('oss described. Wiry, amber button, and a look that does not settle.')).toContain(
      'leading_fragment',
    )
  })

  it('flags a mid-word opening on a LATER segment, not just the first', () => {
    // Each FT text part becomes its own dm_text row and renders as its own
    // paragraph, so every blank-line-separated segment is one a reader sees start.
    expect(
      kinds('The warden turns the seal over.\n\nard iron, still warm from his palm.'),
    ).toContain('leading_fragment')
  })

  it('does not flag prose opening with a capital, a quote, or a bracketed aside', () => {
    expect(kinds('The hall runs long and low.')).not.toContain('leading_fragment')
    expect(kinds('"Voss," she says, and does not look up.')).not.toContain('leading_fragment')
    expect(kinds('“Voss,” she says.')).not.toContain('leading_fragment')
    expect(kinds('(He does not answer.) The bell rings twice.')).not.toContain('leading_fragment')
    expect(kinds('— and the door gives, finally.')).not.toContain('leading_fragment')
  })

  it('does not flag a DELIBERATE ellipsis opening (a trailing-thought device)', () => {
    // The device that makes a naive "starts lowercase" rule wrong.
    expect(kinds('…and then the light was gone.')).not.toContain('leading_fragment')
    expect(kinds('...and then the light was gone.')).not.toContain('leading_fragment')
  })

  it('does not flag a later paragraph that legitimately opens with a capital', () => {
    expect(
      kinds('The warden turns the seal over.\n\nHard iron, still warm from his palm.'),
    ).not.toContain('leading_fragment')
  })

  it('skips blank segments from a run of newlines rather than reading them as openings', () => {
    expect(kinds('The hall is quiet.\n\n\n\nHe waits.')).not.toContain('leading_fragment')
    // A blank run before a real fragment must not mask it.
    expect(kinds('The hall is quiet.\n\n\n\narden iron, still warm.')).toContain('leading_fragment')
  })

  it('reports the class once even when several segments open mid-word', () => {
    const v = checkFtProse('one thing.\n\nnother thing.\n\nhird thing.')
    expect(v.filter((x) => x.kind === 'leading_fragment')).toHaveLength(1)
  })
})

describe('checkFtProse — multiple classes in one pass', () => {
  it('reports each distinct defect once', () => {
    const v = checkFtProse('the *order was wrong.Hast wrote it as the session context says')
    const ks = v.map((x) => x.kind)
    expect(ks).toContain('unrendered_emphasis')
    expect(ks).toContain('fused_sentence')
    expect(ks).toContain('internal_term')
  })
})
