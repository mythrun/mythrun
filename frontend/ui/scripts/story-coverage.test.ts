import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { findStoryless } from './story-coverage.mjs'

// findStoryless(componentsDir) globs the immediate child directories of
// `componentsDir` and returns the names of those lacking a sibling
// `*.stories.tsx`. The CLI wrapper turns a non-empty result into exit 1.
// Driven here against throwaway fixture dirs so the gate's discriminator is
// pinned without depending on the real (currently empty) component tree.

describe('findStoryless', () => {
  let root: string

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'story-coverage-'))
  })
  afterEach(() => {
    rmSync(root, { recursive: true, force: true })
  })

  const componentDir = (name: string): string => {
    const dir = join(root, name)
    mkdirSync(dir, { recursive: true })
    return dir
  }

  it('passes a component directory that has a sibling story', () => {
    const dir = componentDir('Button')
    writeFileSync(join(dir, 'Button.tsx'), 'export const Button = () => null\n')
    writeFileSync(join(dir, 'Button.stories.tsx'), 'export default {}\n')

    expect(findStoryless(root)).toEqual([])
  })

  it('reports a component directory that lacks a story', () => {
    const dir = componentDir('Card')
    writeFileSync(join(dir, 'Card.tsx'), 'export const Card = () => null\n')

    expect(findStoryless(root)).toEqual(['Card'])
  })

  it('reports only the storyless directories in a mixed tree', () => {
    const withStory = componentDir('Button')
    writeFileSync(join(withStory, 'Button.tsx'), 'export const Button = () => null\n')
    writeFileSync(join(withStory, 'Button.stories.tsx'), 'export default {}\n')

    const withoutStory = componentDir('Card')
    writeFileSync(join(withoutStory, 'Card.tsx'), 'export const Card = () => null\n')

    expect(findStoryless(root).sort()).toEqual(['Card'])
  })

  it('accepts any *.stories.tsx name, not just one matching the dir', () => {
    const dir = componentDir('Dialog')
    writeFileSync(join(dir, 'Dialog.tsx'), 'export const Dialog = () => null\n')
    writeFileSync(join(dir, 'examples.stories.tsx'), 'export default {}\n')

    expect(findStoryless(root)).toEqual([])
  })

  it('returns empty when there are no component directories', () => {
    expect(findStoryless(root)).toEqual([])
  })

  it('ignores files at the components root (only directories are components)', () => {
    writeFileSync(join(root, 'index.ts'), 'export {}\n')

    expect(findStoryless(root)).toEqual([])
  })

  it('returns empty when the components directory does not exist', () => {
    expect(findStoryless(join(root, 'does-not-exist'))).toEqual([])
  })
})
