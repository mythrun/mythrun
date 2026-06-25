import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { findScreensWithoutStories } from './screen-story-coverage.mjs'

// findScreensWithoutStories(srcDir) requires a co-located *.stories.tsx for
// every flat src/routes/*.tsx screen + the enumerated app screens
// (app-frame, not-found). Driven against fixture trees so the discriminator is
// pinned without depending on the real (evolving) screen set.

describe('findScreensWithoutStories', () => {
  let src: string

  beforeEach(() => {
    src = mkdtempSync(join(tmpdir(), 'screen-coverage-'))
    mkdirSync(join(src, 'routes'), { recursive: true })
    mkdirSync(join(src, 'app'), { recursive: true })
    // The enumerated app screens exist with stories by default; tests below
    // remove pieces to assert the gate.
    for (const base of ['app-frame', 'not-found']) {
      writeFileSync(join(src, 'app', `${base}.tsx`), 'export const X = () => null\n')
      writeFileSync(join(src, 'app', `${base}.stories.tsx`), 'export default {}\n')
    }
  })
  afterEach(() => {
    rmSync(src, { recursive: true, force: true })
  })

  it('passes a route file that has a co-located story', () => {
    writeFileSync(join(src, 'routes', 'home.tsx'), 'export const HomeRoute = () => null\n')
    writeFileSync(join(src, 'routes', 'home.stories.tsx'), 'export default {}\n')
    expect(findScreensWithoutStories(src)).toEqual([])
  })

  it('reports a route file that lacks a story', () => {
    writeFileSync(join(src, 'routes', 'settings.tsx'), 'export const SettingsRoute = () => null\n')
    expect(findScreensWithoutStories(src)).toEqual(['src/routes/settings.tsx'])
  })

  it('ignores *.test.tsx and *.stories.tsx themselves (not screens)', () => {
    writeFileSync(join(src, 'routes', 'home.tsx'), 'export const HomeRoute = () => null\n')
    writeFileSync(join(src, 'routes', 'home.stories.tsx'), 'export default {}\n')
    writeFileSync(join(src, 'routes', 'home.test.tsx'), 'export {}\n')
    expect(findScreensWithoutStories(src)).toEqual([])
  })

  it('reports an enumerated app screen missing its story', () => {
    rmSync(join(src, 'app', 'not-found.stories.tsx'))
    expect(findScreensWithoutStories(src)).toEqual(['src/app/not-found.tsx'])
  })

  it('does NOT require a story for non-screen app infra (router, providers)', () => {
    writeFileSync(join(src, 'app', 'router.tsx'), 'export const routes = []\n')
    writeFileSync(join(src, 'app', 'providers.tsx'), 'export const AppProviders = () => null\n')
    expect(findScreensWithoutStories(src)).toEqual([])
  })
})
