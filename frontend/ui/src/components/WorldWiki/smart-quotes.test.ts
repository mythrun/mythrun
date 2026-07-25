import { describe, expect, it } from 'vitest'
import { smartQuotes } from './smart-quotes.ts'

// smart-quotes (ux-run2 myth-urtcn) — the renderer-side straight→typographic
// quote transform for wiki prose. Display-only; conservative rules.

describe('smartQuotes', () => {
  it('curls a single-quoted name (the critiqued case)', () => {
    expect(smartQuotes("named for 'Mara Solenne' herself")).toBe('named for ‘Mara Solenne’ herself')
  })

  it('curls word-internal apostrophes and trailing possessives', () => {
    expect(smartQuotes("don't touch the lamplighters' glass")).toBe(
      'don’t touch the lamplighters’ glass',
    )
  })

  it('curls double quotes as an open/close pair', () => {
    expect(smartQuotes('they call it "the deep reading" now')).toBe(
      'they call it “the deep reading” now',
    )
  })

  it('opens after an opening bracket and at start of text', () => {
    expect(smartQuotes('\'salt-debt\' ("passage-price")')).toBe('‘salt-debt’ (“passage-price”)')
  })

  it('leaves text without straight quotes untouched', () => {
    expect(smartQuotes('A sworn keeper of the gate roads.')).toBe(
      'A sworn keeper of the gate roads.',
    )
  })
})
