// backend/src/llm/prep/__tests__/name-resolution.test.ts
import { describe, it, expect } from 'vitest'
import { normalizeName } from '../name-resolution.js'

describe('normalizeName', () => {
  it('trims leading and trailing whitespace', () => {
    expect(normalizeName('  Mother Ehren  ')).toBe('Mother Ehren')
  })

  it('collapses internal whitespace runs to a single space', () => {
    expect(normalizeName('Mother  Ehren\t\tSalt-Tongue')).toBe('Mother Ehren Salt-Tongue')
  })

  it('applies Unicode NFC normalization', () => {
    // 'é' as NFD (e + combining acute U+0301) vs NFC (single code point U+00E9).
    // Constructed via escapes so the byte distinction survives source-file
    // pipelines that would otherwise auto-normalize visually-identical literals.
    const nfd = 'Marén'
    const nfc = 'Marén'
    expect(nfd).not.toBe(nfc)
    expect(normalizeName(nfd)).toBe(nfc)
  })

  it('preserves case (case-sensitive contract)', () => {
    expect(normalizeName('The Drowned Quarter')).toBe('The Drowned Quarter')
    expect(normalizeName('the drowned quarter')).toBe('the drowned quarter')
    expect(normalizeName('The Drowned Quarter')).not.toBe(normalizeName('the drowned quarter'))
  })

  it('is idempotent', () => {
    const input = '  Mother   Ehren  '
    const once = normalizeName(input)
    expect(normalizeName(once)).toBe(once)
  })
})
