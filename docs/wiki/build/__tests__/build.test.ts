import { describe, it, expect, afterAll } from 'vitest'
import { resolve, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { readFileSync, writeFileSync, rmSync, existsSync } from 'node:fs'
import { runBuild } from '../buildPipeline.ts'

const here = dirname(fileURLToPath(import.meta.url))
const fixtureRoot = resolve(here, 'fixtures/build')
const siteDir = resolve(fixtureRoot, 'site')
// fixtureRoot is <repo>/docs/wiki/build/__tests__/fixtures/build — go up 6 levels to the repo root so
// repo-relative paths in the fixture (e.g. docs/wiki/build/__tests__/.../sources/mod1) resolve correctly.
const repoRoot = resolve(fixtureRoot, '..', '..', '..', '..', '..', '..')

async function freshBuild(mode: 'build' | 'check' | 'accept-drift' = 'build') {
  if (existsSync(siteDir)) rmSync(siteDir, { recursive: true, force: true })
  const mod = (await import(
    resolve(fixtureRoot, 'structure.ts') + '?ts=' + String(Date.now())
  )) as {
    structure: import('../types.ts').Section[]
  }
  return runBuild({
    root: fixtureRoot,
    structure: mod.structure,
    mode,
    repoRoot,
  })
}

describe('runBuild (end-to-end fixture)', () => {
  afterAll(() => {
    if (existsSync(siteDir)) rmSync(siteDir, { recursive: true, force: true })
  })

  it('produces a site/ directory with landing and section pages', async () => {
    const result = await freshBuild('build')
    expect(result.errors).toEqual([])
    expect(existsSync(join(siteDir, 'index.html'))).toBe(true)
    expect(existsSync(join(siteDir, 'secA/index.html'))).toBe(true)
  })

  it('substitutes slot markers into the rendered output', async () => {
    await freshBuild('build')
    const html = readFileSync(join(siteDir, 'secA/index.html'), 'utf-8')
    expect(html).toContain('<title>Overview</title>')
    expect(html).not.toContain('<!-- @')
  })

  it('inlines rendered SVG at @diagram markers', async () => {
    await freshBuild('build')
    const html = readFileSync(join(siteDir, 'secA/index.html'), 'utf-8')
    expect(html).toMatch(/<svg\b/)
    expect(html).not.toContain('<!-- @diagram:')
  })

  it('generates a TOC containing the h2 from content', async () => {
    await freshBuild('build')
    const html = readFileSync(join(siteDir, 'secA/index.html'), 'utf-8')
    expect(html).toContain('href="#things"')
  })

  it('copies assets and layout statics into site/', async () => {
    await freshBuild('build')
    expect(existsSync(join(siteDir, 'styles.css'))).toBe(true)
    expect(existsSync(join(siteDir, 'helper.js'))).toBe(true)
  })

  it('is idempotent — second build produces identical output', async () => {
    await freshBuild('build')
    const firstSec = readFileSync(join(siteDir, 'secA/index.html'), 'utf-8')
    await freshBuild('build')
    const secondSec = readFileSync(join(siteDir, 'secA/index.html'), 'utf-8')
    expect(secondSec).toBe(firstSec)
  })

  it('flags drift when source content changes without hash update (mode=build)', async () => {
    const result = await freshBuild('build')
    expect(result.exitCode).toBe(0)
    const html = readFileSync(join(siteDir, 'secA/index.html'), 'utf-8')
    expect(html).toContain('wiki-drift-banner')
  })

  it('mode=check exits non-zero when any page has drift or missing hash', async () => {
    const result = await freshBuild('check')
    expect(result.exitCode).not.toBe(0)
  })

  it('mode=accept-drift rewrites source-hash in-place and makes subsequent check pass', async () => {
    const contentPath = resolve(fixtureRoot, 'content/secA/index.html')
    const before = readFileSync(contentPath, 'utf-8')
    try {
      const acceptResult = await freshBuild('accept-drift')
      expect(acceptResult.exitCode).toBe(0)
      const after = readFileSync(contentPath, 'utf-8')
      expect(after).toMatch(/<!-- source-hash: sha256:[0-9a-f]{64} -->/)
      const checkResult = await freshBuild('check')
      expect(checkResult.exitCode).toBe(0)
    } finally {
      writeFileSync(contentPath, before)
    }
  })
})
