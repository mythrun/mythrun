import { describe, it, expect } from 'vitest'
import { renderShell } from '../renderShell.ts'

describe('renderShell', () => {
  it('substitutes a single slot marker', () => {
    const shell = '<title><!-- @pageTitle --></title>'
    const out = renderShell(shell, { pageTitle: 'Fast Thinker' })
    expect(out).toBe('<title>Fast Thinker</title>')
  })

  it('substitutes multiple distinct slots', () => {
    const shell = '<h1><!-- @title --></h1><aside><!-- @sidebar --></aside>'
    const out = renderShell(shell, { title: 'X', sidebar: '<ul></ul>' })
    expect(out).toBe('<h1>X</h1><aside><ul></ul></aside>')
  })

  it('substitutes repeated occurrences of the same slot', () => {
    const shell = '<!-- @x --> and <!-- @x -->'
    const out = renderShell(shell, { x: 'hi' })
    expect(out).toBe('hi and hi')
  })

  it('throws when a marker is present but unprovided', () => {
    const shell = '<!-- @missing -->'
    expect(() => renderShell(shell, {})).toThrow(/missing/)
  })

  it('throws when an unknown slot is provided (typo guard)', () => {
    const shell = '<h1><!-- @title --></h1>'
    expect(() => renderShell(shell, { title: 'X', titel: 'Y' })).toThrow(/titel/)
  })

  it('treats empty string as a valid substitution (does not throw)', () => {
    const shell = '[<!-- @maybe -->]'
    const out = renderShell(shell, { maybe: '' })
    expect(out).toBe('[]')
  })

  it('does not match @name tokens outside an HTML comment', () => {
    const shell = '<p>Email me @steve at work.</p>'
    // No slots needed — the @steve is not a marker, so no provided values required.
    const out = renderShell(shell, {})
    expect(out).toBe(shell)
  })
})
