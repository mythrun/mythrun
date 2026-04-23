import { describe, it, expect } from 'vitest'
import { extractToc } from '../extractToc.ts'

describe('extractToc', () => {
  it('returns an empty array for content with no h2/h3', () => {
    const { entries, html } = extractToc('<p>Just prose.</p>')
    expect(entries).toEqual([])
    expect(html).toBe('<p>Just prose.</p>')
  })

  it('extracts h2 and h3 with levels, slugifies ids, preserves order', () => {
    const html = '<h2>Inputs</h2><p>x</p><h3>Sub One</h3><h2>Outputs</h2>'
    const { entries } = extractToc(html)
    expect(entries).toEqual([
      { level: 2, id: 'inputs', text: 'Inputs' },
      { level: 3, id: 'sub-one', text: 'Sub One' },
      { level: 2, id: 'outputs', text: 'Outputs' },
    ])
  })

  it('injects id attributes into the rendered html when missing', () => {
    const { html } = extractToc('<h2>Inputs</h2><h3>Sub</h3>')
    expect(html).toContain('<h2 id="inputs">Inputs</h2>')
    expect(html).toContain('<h3 id="sub">Sub</h3>')
  })

  it('preserves a user-provided id attribute and uses it as the toc id', () => {
    const html = '<h2 id="custom-slug">Inputs</h2>'
    const { entries, html: out } = extractToc(html)
    expect(entries).toEqual([{ level: 2, id: 'custom-slug', text: 'Inputs' }])
    expect(out).toBe(html)
  })

  it('slugifies titles with punctuation and multiple spaces', () => {
    const { entries } = extractToc('<h2>Request / Response — Pairs</h2>')
    expect(entries[0]?.id).toBe('request-response-pairs')
  })

  it('disambiguates duplicate slugs with numeric suffixes', () => {
    const { entries } = extractToc('<h2>Inputs</h2><h2>Inputs</h2>')
    expect(entries).toEqual([
      { level: 2, id: 'inputs', text: 'Inputs' },
      { level: 2, id: 'inputs-2', text: 'Inputs' },
    ])
  })

  it('ignores h1 (page title) and h4+ (out-of-toc scope)', () => {
    const { entries } = extractToc('<h1>Page</h1><h2>Keep</h2><h4>Skip</h4>')
    expect(entries).toEqual([{ level: 2, id: 'keep', text: 'Keep' }])
  })
})
