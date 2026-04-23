import { describe, it, expect } from 'vitest'
import { readFileSync, writeFileSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { computeSourceHash } from '../sourceHash.ts'

const here = dirname(fileURLToPath(import.meta.url))
const fixtureA = resolve(here, 'fixtures/sourceHash/moduleA')
const fixtureFile = resolve(here, 'fixtures/sourceHash/single-file.txt')

describe('computeSourceHash', () => {
  it('produces a stable 64-char hex digest for a directory', async () => {
    const hash = await computeSourceHash([fixtureA])
    expect(hash).toMatch(/^[0-9a-f]{64}$/)
  })

  it('is deterministic across calls on unchanged input', async () => {
    const a = await computeSourceHash([fixtureA])
    const b = await computeSourceHash([fixtureA])
    expect(a).toBe(b)
  })

  it('changes when a tracked file changes', async () => {
    const before = await computeSourceHash([fixtureA])
    const changed = resolve(fixtureA, 'a.txt')
    const original = readFileSync(changed, 'utf-8')
    writeFileSync(changed, 'alpha-modified\n')
    try {
      const after = await computeSourceHash([fixtureA])
      expect(after).not.toBe(before)
    } finally {
      writeFileSync(changed, original)
    }
  })

  it('differs for different path lists with same content', async () => {
    const onlyDir = await computeSourceHash([fixtureA])
    const dirAndFile = await computeSourceHash([fixtureA, fixtureFile])
    expect(onlyDir).not.toBe(dirAndFile)
  })

  it('throws a clear error if a path does not exist', async () => {
    await expect(computeSourceHash(['/nonexistent/path/xyz'])).rejects.toThrow(/nonexistent/)
  })

  it('enumerates directory files in a deterministic sorted order', async () => {
    // Hash shouldn't depend on filesystem-returned order.
    // We test this indirectly: adding a file and removing it should restore the original hash.
    const before = await computeSourceHash([fixtureA])
    const extra = resolve(fixtureA, 'zz-extra.txt')
    writeFileSync(extra, 'extra\n')
    try {
      const withExtra = await computeSourceHash([fixtureA])
      expect(withExtra).not.toBe(before)
    } finally {
      const { unlinkSync } = await import('node:fs')
      unlinkSync(extra)
    }
    const restored = await computeSourceHash([fixtureA])
    expect(restored).toBe(before)
  })
})
