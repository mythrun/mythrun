// Screen-story-coverage gate (MYT-97 §5). The component story-coverage gate
// globs DIRECTORIES under ui/src/components — it cannot see the app shell's
// FLAT screen files. This gate requires a co-located *.stories.tsx for every
// player-facing screen so the 375/1280 overflow gate actually measures it:
//   • every flat src/routes/*.tsx (each is a screen), and
//   • the enumerated assembled app screens (the frame + the 404). Other app/
//     files (providers, router, require-auth, error-boundary) are
//     infrastructure, not navigable screens, and are exempt by construction.
//
// Exit 1 (offender list printed) if any screen lacks a story; exit 0 otherwise.

import { readdirSync, existsSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const DEFAULT_SRC = resolve(dirname(fileURLToPath(import.meta.url)), '../src')
const APP_SCREENS = ['app-frame', 'not-found']

/**
 * @param {string} srcDir absolute path to the frontend `src/` dir
 * @returns {string[]} screen paths (repo-relative-ish) lacking a co-located story
 */
export function findScreensWithoutStories(srcDir = DEFAULT_SRC) {
  const routesDir = join(srcDir, 'routes')
  const appDir = join(srcDir, 'app')
  const offenders = []

  let routeEntries = []
  try {
    routeEntries = readdirSync(routesDir)
  } catch {
    routeEntries = []
  }
  const routeScreens = routeEntries.filter(
    (f) => f.endsWith('.tsx') && !f.endsWith('.stories.tsx') && !f.endsWith('.test.tsx'),
  )
  for (const file of routeScreens) {
    const base = file.replace(/\.tsx$/, '')
    if (!existsSync(join(routesDir, `${base}.stories.tsx`))) {
      offenders.push(`src/routes/${file}`)
    }
  }

  for (const base of APP_SCREENS) {
    if (!existsSync(join(appDir, `${base}.stories.tsx`))) {
      offenders.push(`src/app/${base}.tsx`)
    }
  }
  return offenders
}

function main() {
  const offenders = findScreensWithoutStories()
  if (offenders.length > 0) {
    console.error('Screen-story-coverage gate failed. These screens lack a co-located *.stories.tsx:')
    for (const f of offenders) console.error(`  - ${f}`)
    console.error(
      '\nEvery screen (routes/* + the assembled app screens) must ship a Storybook story so the 375/1280 overflow gate measures it.',
    )
    process.exit(1)
  }
  console.log('Screen-story-coverage gate passed.')
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main()
}
