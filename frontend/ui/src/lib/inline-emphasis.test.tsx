import { describe, it, expect } from 'vitest'
import { render } from '@testing-library/react'
import { parseInlineEmphasis, stripInlineEmphasis, renderInlineEmphasis } from './inline-emphasis.tsx'

// myth-5syk3 — the brand is a book page: subtle italics (a quoted ledger line) and
// the occasional bold (three ominous initials) are period-appropriate; a raw `*` on
// the page reads as "an AI wrote this and nobody checked". We RENDER inline emphasis
// (em / strong ONLY — no headings, lists, links) rather than strip it, so the
// typographic intent survives. The parser is the single source of truth: the settled
// render maps its segments to <em>/<strong>; the streaming render strips markers so no
// literal `*` flashes; the FT-output validator reuses it to fail loud on a leak.

describe('parseInlineEmphasis', () => {
  it('parses single-asterisk spans as em (the *order* case)', () => {
    expect(parseInlineEmphasis('what is wrong is the *order*.')).toEqual([
      { text: 'what is wrong is the ', kind: 'plain' },
      { text: 'order', kind: 'em' },
      { text: '.', kind: 'plain' },
    ])
  })

  it('parses double-asterisk spans as strong (the **V. L. K.** case)', () => {
    expect(parseInlineEmphasis('The letters are: **V. L. K.** No message.')).toEqual([
      { text: 'The letters are: ', kind: 'plain' },
      { text: 'V. L. K.', kind: 'strong' },
      { text: ' No message.', kind: 'plain' },
    ])
  })

  it('handles a span with inner punctuation and dashes (the ledger quote)', () => {
    expect(parseInlineEmphasis('*Torv, P. — present.* But the letters are wrong.')).toEqual([
      { text: 'Torv, P. — present.', kind: 'em' },
      { text: ' But the letters are wrong.', kind: 'plain' },
    ])
  })

  it('parses a single-character span (*T*)', () => {
    expect(parseInlineEmphasis('the *T* of both surnames')).toEqual([
      { text: 'the ', kind: 'plain' },
      { text: 'T', kind: 'em' },
      { text: ' of both surnames', kind: 'plain' },
    ])
  })

  it('parses multiple spans in one line', () => {
    expect(parseInlineEmphasis('the *order* and the *T*')).toEqual([
      { text: 'the ', kind: 'plain' },
      { text: 'order', kind: 'em' },
      { text: ' and the ', kind: 'plain' },
      { text: 'T', kind: 'em' },
    ])
  })

  it('leaves an UNBALANCED asterisk as literal plain text (the fail-loud signal)', () => {
    expect(parseInlineEmphasis('a lone * asterisk')).toEqual([{ text: 'a lone * asterisk', kind: 'plain' }])
    expect(parseInlineEmphasis('opened *but never closed')).toEqual([{ text: 'opened *but never closed', kind: 'plain' }])
  })

  it('leaves plain prose (no markers) as a single plain segment', () => {
    expect(parseInlineEmphasis('The hall runs long and low.')).toEqual([
      { text: 'The hall runs long and low.', kind: 'plain' },
    ])
  })

  it('does not treat an empty span (**) as emphasis', () => {
    expect(parseInlineEmphasis('a ** b')).toEqual([{ text: 'a ** b', kind: 'plain' }])
  })
})

describe('stripInlineEmphasis (streaming render — no literal marker flashes)', () => {
  it('removes balanced markers, leaving the words in place', () => {
    expect(stripInlineEmphasis('the *order* and **V. L. K.**')).toBe('the order and V. L. K.')
  })

  it('drops an in-progress opener mid-stream (no lingering asterisk)', () => {
    // The stream has emitted the opener + partial content but not the closer yet.
    expect(stripInlineEmphasis('the *ord')).toBe('the ord')
    expect(stripInlineEmphasis('The letters are: **V. L. K')).toBe('The letters are: V. L. K')
  })

  it('is a no-op for prose with no markers (byte-identical streaming path preserved)', () => {
    const s = 'The air is warm. It smells of wet wool.'
    expect(stripInlineEmphasis(s)).toBe(s)
  })
})

describe('renderInlineEmphasis (settled render)', () => {
  it('renders em / strong spans; plain text stays a bare node', () => {
    const { container } = render(<p>{renderInlineEmphasis('the *order*, then **V. L. K.** and plain')}</p>)
    const em = container.querySelector('em')
    const strong = container.querySelector('strong')
    expect(em).not.toBeNull()
    expect(em).toHaveTextContent('order')
    expect(strong).not.toBeNull()
    expect(strong).toHaveTextContent('V. L. K.')
    expect(container).toHaveTextContent('the order, then V. L. K. and plain')
    // The load-bearing invariant: NO literal asterisk reaches the DOM.
    expect(container.textContent).not.toContain('*')
  })

  it('renders an unbalanced marker as a literal node (fail loud — a leak is visible)', () => {
    const { container } = render(<p>{renderInlineEmphasis('opened *but never closed')}</p>)
    expect(container.querySelector('em')).toBeNull()
    expect(container.textContent).toContain('*')
  })
})
