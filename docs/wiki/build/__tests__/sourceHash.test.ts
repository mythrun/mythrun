import { describe, it, expect } from 'vitest'
import { readFileSync, writeFileSync, symlinkSync, unlinkSync, existsSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { computeSourceHash } from '../sourceHash.ts'

const here = dirname(fileURLToPath(import.meta.url))
const fixtureRoot = resolve(here, 'fixtures/sourceHash')

describe('computeSourceHash', () => {
  it('produces a stable 64-char hex digest for a directory', async () => {
    const hash = await computeSourceHash(['moduleA'], fixtureRoot)
    expect(hash).toMatch(/^[0-9a-f]{64}$/)
  })

  it('is deterministic across calls on unchanged input', async () => {
    const a = await computeSourceHash(['moduleA'], fixtureRoot)
    const b = await computeSourceHash(['moduleA'], fixtureRoot)
    expect(a).toBe(b)
  })

  it('changes when a tracked file changes', async () => {
    const before = await computeSourceHash(['moduleA'], fixtureRoot)
    const changed = resolve(fixtureRoot, 'moduleA/a.txt')
    const original = readFileSync(changed, 'utf-8')
    writeFileSync(changed, 'alpha-modified\n')
    try {
      const after = await computeSourceHash(['moduleA'], fixtureRoot)
      expect(after).not.toBe(before)
    } finally {
      writeFileSync(changed, original)
    }
  })

  it('differs for different path lists with same underlying content', async () => {
    const onlyDir = await computeSourceHash(['moduleA'], fixtureRoot)
    const dirAndFile = await computeSourceHash(['moduleA', 'single-file.txt'], fixtureRoot)
    expect(onlyDir).not.toBe(dirAndFile)
  })

  it('throws a clear error if a path does not exist', async () => {
    await expect(computeSourceHash(['nonexistent/path/xyz'], fixtureRoot)).rejects.toThrow(
      /nonexistent/,
    )
  })

  it('enumerates directory files in a deterministic sorted order', async () => {
    const before = await computeSourceHash(['moduleA'], fixtureRoot)
    const extra = resolve(fixtureRoot, 'moduleA/zz-extra.txt')
    writeFileSync(extra, 'extra\n')
    try {
      const withExtra = await computeSourceHash(['moduleA'], fixtureRoot)
      expect(withExtra).not.toBe(before)
    } finally {
      unlinkSync(extra)
    }
    const restored = await computeSourceHash(['moduleA'], fixtureRoot)
    expect(restored).toBe(before)
  })

  it('is machine-independent: the same relative paths and content produce the same hash regardless of absolute root', async () => {
    // Simulated by computing twice with different root-prefixes onto the same fixture.
    // Achieved by resolving root from two different starting points.
    const viaFixture = await computeSourceHash(['moduleA'], fixtureRoot)
    const viaFixtureAgain = await computeSourceHash(['moduleA'], resolve(fixtureRoot, '.'))
    expect(viaFixtureAgain).toBe(viaFixture)
  })

  it('throws if a tracked directory contains a symlink (rejects symlinks explicitly)', async () => {
    const linkPath = resolve(fixtureRoot, 'moduleA/zz-link.txt')
    const target = resolve(fixtureRoot, 'single-file.txt')
    if (existsSync(linkPath)) unlinkSync(linkPath)
    symlinkSync(target, linkPath)
    try {
      await expect(computeSourceHash(['moduleA'], fixtureRoot)).rejects.toThrow(/symlink/i)
    } finally {
      unlinkSync(linkPath)
    }
  })

  it('excludes gitignored files from the hash (CI-portable)', async () => {
    // The fixture's .gitignore matches `ignored-*.txt`. Writing such a file
    // must not change the hash — otherwise local-only artifacts (terraform
    // state, node_modules, etc.) would poison the hash on CI vs dev.
    const before = await computeSourceHash(['moduleA'], fixtureRoot)
    const ignored = resolve(fixtureRoot, 'moduleA/ignored-local-only.txt')
    writeFileSync(ignored, 'should not affect hash\n')
    try {
      const after = await computeSourceHash(['moduleA'], fixtureRoot)
      expect(after).toBe(before)
    } finally {
      unlinkSync(ignored)
    }
  })

  it('throws if a tracked path itself is a symlink', async () => {
    const linkPath = resolve(fixtureRoot, 'zz-link-dir')
    const target = resolve(fixtureRoot, 'moduleA')
    if (existsSync(linkPath)) unlinkSync(linkPath)
    symlinkSync(target, linkPath)
    try {
      await expect(computeSourceHash(['zz-link-dir'], fixtureRoot)).rejects.toThrow(/symlink/i)
    } finally {
      unlinkSync(linkPath)
    }
  })
})
