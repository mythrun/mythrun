import { describe, it, expect, beforeAll } from 'vitest'
import { renderDot } from '../renderDot.ts'

describe('renderDot', () => {
  beforeAll(async () => {
    // Warm up the WASM runtime once.
    await renderDot('digraph { a }', '')
  })

  it('returns an SVG string containing <svg …> and </svg>', async () => {
    const svg = await renderDot('digraph { a -> b }', '')
    // Graphviz 14.x prefixes its output with an XML prolog + DOCTYPE, so we
    // match the <svg element anywhere rather than at index 0.
    expect(svg).toMatch(/<svg\b/)
    expect(svg).toContain('</svg>')
  })

  it('prepends the supplied header before the user source inner body', async () => {
    const header = 'graph [bgcolor="#ABCDEF"]'
    const svg = await renderDot('digraph { a -> b }', header)
    // Graphviz lowercases hex color literals in its SVG output, so match
    // case-insensitively: presence in the rendered SVG is what matters.
    expect(svg).toMatch(/#abcdef/i)
  })

  it('substitutes "ember" color alias with #8A5A3C', async () => {
    const source = 'digraph { a [color="ember"] }'
    const svg = await renderDot(source, '')
    // Graphviz lowercases hex color literals in its SVG output.
    expect(svg).toMatch(/#8a5a3c/i)
    expect(svg).not.toContain('"ember"')
  })

  it('surfaces a readable error when DOT source is malformed', async () => {
    await expect(renderDot('digraph { a ->> b }', '')).rejects.toThrow()
  })

  it('produces stable output for identical input (determinism)', async () => {
    const src = 'digraph { a -> b -> c }'
    const a = await renderDot(src, '')
    const b = await renderDot(src, '')
    expect(a).toBe(b)
  })
})
