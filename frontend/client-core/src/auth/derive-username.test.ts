import { describe, expect, it } from 'vitest'
import { deriveUsername } from './derive-username.ts'

const REGEX = /^[a-zA-Z0-9](?:[a-zA-Z0-9_]{1,18}[a-zA-Z0-9])?$/
// Deterministic 'a'-runs for the random-padding/fallback branches.
const rand = (n: number): string => 'a'.repeat(n)

describe('deriveUsername', () => {
  it('lowercases + strips to a regex-valid handle', () => {
    const u = deriveUsername('Aria Thorne')
    expect(u).toBe('ariathorne')
    expect(REGEX.test(u)).toBe(true)
  })
  it('pads a too-short (<3) alnum slug to length 3', () => {
    expect(deriveUsername('Bo', rand)).toBe('boa')
  })
  it('trims a leading underscore', () => {
    expect(deriveUsername('_bob')).toBe('bob')
  })
  it('trims a trailing underscore', () => {
    expect(deriveUsername('bob_')).toBe('bob')
  })
  it('collapses underscore runs', () => {
    expect(deriveUsername('a__b')).toBe('a_b')
  })
  it('all-underscore → player_ fallback (regex-valid)', () => {
    const u = deriveUsername('___', rand)
    expect(u.startsWith('player_')).toBe(true)
    expect(REGEX.test(u)).toBe(true)
  })
  it('empty after stripping (CJK / emoji) → player_ fallback', () => {
    expect(deriveUsername('日本語', rand).startsWith('player_')).toBe(true)
    expect(deriveUsername('🐉🔥', rand).startsWith('player_')).toBe(true)
  })
  it('clamps a 40-char display name to ≤20, last char alphanumeric', () => {
    const u = deriveUsername('A'.repeat(40))
    expect(u.length).toBeLessThanOrEqual(20)
    expect(/[a-z0-9]$/.test(u)).toBe(true)
    expect(REGEX.test(u)).toBe(true)
  })
  it('trims a trailing underscore left by truncation', () => {
    // 19 chars + '_' + 'x' → truncating to 20 lands on '_' → trimmed.
    const u = deriveUsername(`${'a'.repeat(19)}_x`)
    expect(u.endsWith('_')).toBe(false)
    expect(REGEX.test(u)).toBe(true)
  })
  it('uses the real CSPRNG-free random padding when no generator is injected', () => {
    // Exercises the default `randomAlnum` (the <3 pad branch) so the client-core
    // 100% coverage gate sees its body run; the value is random, so assert shape.
    const u = deriveUsername('Bo')
    expect(u.length).toBe(3)
    expect(u.startsWith('bo')).toBe(true)
    expect(REGEX.test(u)).toBe(true)
  })
  it('uses the real random fallback when stripping leaves nothing (default generator)', () => {
    // Default-generator path through the empty → player_<rand> branch.
    const u = deriveUsername('🐉🔥')
    expect(u.startsWith('player_')).toBe(true)
    expect(REGEX.test(u)).toBe(true)
  })
})
