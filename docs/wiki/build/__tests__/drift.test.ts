import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parsePageMeta, checkDrift, renderDriftBanner, rewriteSourceHash } from '../drift.ts'

const here = dirname(fileURLToPath(import.meta.url))
const withSource = resolve(here, 'fixtures/drift/with-source.html')
const noSource = resolve(here, 'fixtures/drift/no-source.html')
const newPage = resolve(here, 'fixtures/drift/new-page.html')

describe('parsePageMeta', () => {
  it('returns empty meta for a page with no source comments', () => {
    const content = readFileSync(noSource, 'utf-8')
    const meta = parsePageMeta(content)
    expect(meta.sourcePaths).toEqual([])
    expect(meta.sourceHash).toBeNull()
  })

  it('extracts source paths and source-hash', () => {
    const content = readFileSync(withSource, 'utf-8')
    const meta = parsePageMeta(content)
    expect(meta.sourcePaths).toHaveLength(1)
    expect(meta.sourcePaths[0]).toContain('moduleA')
    expect(meta.sourceHash).toBe('sha256:deadbeef')
  })

  it('returns null source-hash when source is declared but no hash is present', () => {
    const content = readFileSync(newPage, 'utf-8')
    const meta = parsePageMeta(content)
    expect(meta.sourcePaths).toHaveLength(1)
    expect(meta.sourceHash).toBeNull()
  })

  it('captures multiple source paths', () => {
    const content = '<!-- source: a/b -->\n<!-- source: c/d -->\n'
    const meta = parsePageMeta(content)
    expect(meta.sourcePaths).toEqual(['a/b', 'c/d'])
  })
})

describe('checkDrift', () => {
  it('returns match=true when embedded hash equals current hash', () => {
    const result = checkDrift(
      { sourceHash: 'sha256:abc', sourcePaths: ['x'], lastTicket: null },
      'sha256:abc',
    )
    expect(result).toEqual({ drifted: false, status: 'match' })
  })

  it('returns drifted=true with status=mismatch when hashes differ', () => {
    const result = checkDrift(
      { sourceHash: 'sha256:abc', sourcePaths: ['x'], lastTicket: null },
      'sha256:xyz',
    )
    expect(result).toEqual({ drifted: true, status: 'mismatch' })
  })

  it('returns drifted=true with status=new when source is declared but hash is absent', () => {
    const result = checkDrift(
      { sourceHash: null, sourcePaths: ['x'], lastTicket: null },
      'sha256:xyz',
    )
    expect(result).toEqual({ drifted: true, status: 'new' })
  })

  it('returns match when page declares no source and has no current hash', () => {
    const result = checkDrift({ sourceHash: null, sourcePaths: [], lastTicket: null }, null)
    expect(result).toEqual({ drifted: false, status: 'sourceless' })
  })
})

describe('renderDriftBanner', () => {
  it('renders a banner containing the source paths and the word drifted', () => {
    const html = renderDriftBanner(['infra/modules/network/', 'infra/modules/data/'])
    expect(html).toContain('drifted')
    expect(html).toContain('infra/modules/network/')
    expect(html).toContain('infra/modules/data/')
    expect(html).toContain('wiki-drift-banner')
  })
})

describe('rewriteSourceHash', () => {
  it('replaces an existing source-hash comment', () => {
    const input = '<!-- source: x -->\n<!-- source-hash: sha256:deadbeef -->\n<h1>hi</h1>'
    const out = rewriteSourceHash(input, 'sha256:cafebabe')
    expect(out).toContain('<!-- source-hash: sha256:cafebabe -->')
    expect(out).not.toContain('sha256:deadbeef')
  })

  it('inserts a source-hash comment after the last source comment when none exists', () => {
    const input = '<!-- source: x -->\n<!-- source: y -->\n<h1>hi</h1>'
    const out = rewriteSourceHash(input, 'sha256:cafebabe')
    expect(out).toContain('<!-- source-hash: sha256:cafebabe -->')
    expect(out.indexOf('<!-- source: y -->')).toBeLessThan(out.indexOf('<!-- source-hash:'))
    expect(out.indexOf('<!-- source-hash:')).toBeLessThan(out.indexOf('<h1>'))
  })

  it('throws when attempting to rewrite a page with no source declarations', () => {
    const input = '<h1>hi</h1>'
    expect(() => rewriteSourceHash(input, 'sha256:cafebabe')).toThrow(/no source/i)
  })
})
