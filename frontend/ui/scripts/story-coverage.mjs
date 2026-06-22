// Story-coverage gate (MYT-82 F0c4).
//
// Every first-class component in the design system must ship a Storybook
// story — that is the contract the [[feedback_components_live_in_design_system]]
// rule enforces structurally (a story-coverage gate + the import boundary). A
// component without a story is invisible to the visual catalogue and tends to
// drift out of the system.
//
// The discriminator is the directory layout: each component lives in its own
// `src/components/<Name>/` directory. So we glob the immediate child
// DIRECTORIES of `src/components/` and require each to contain at least one
// `*.stories.tsx` file. Type-only / util / hook / foundation files are not in
// `src/components/<Name>/`, so they are exempt by construction — the gate is
// scoped to the component surface, nothing else.
//
// Exit 1 (with the offender list printed) if any component dir lacks a story;
// exit 0 otherwise. With zero component dirs today, the gate is a clean no-op.

import { readdirSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const COMPONENTS_DIR = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '../src/components',
)

/**
 * Return the names of component directories under `componentsDir` that lack a
 * sibling `*.stories.tsx`. A missing `componentsDir` yields `[]` (nothing to
 * check). Files at the root are ignored — only directories are components.
 *
 * @param {string} componentsDir absolute path to the components directory
 * @returns {string[]} storyless component directory names
 */
export function findStoryless(componentsDir) {
  let entries
  try {
    entries = readdirSync(componentsDir, { withFileTypes: true })
  } catch {
    // Components dir doesn't exist yet (no components shipped) — nothing to gate.
    return []
  }

  const offenders = []
  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    const dir = join(componentsDir, entry.name)
    const hasStory = readdirSync(dir).some((f) => f.endsWith('.stories.tsx'))
    if (!hasStory) offenders.push(entry.name)
  }
  return offenders
}

function main() {
  const offenders = findStoryless(COMPONENTS_DIR)
  if (offenders.length > 0) {
    console.error('Story-coverage gate failed. These component directories lack a *.stories.tsx:')
    for (const name of offenders) console.error(`  - src/components/${name}/`)
    console.error('\nEvery component in the design system must ship a Storybook story.')
    process.exit(1)
  }
  console.log(`Story-coverage gate passed (${COMPONENTS_DIR}).`)
}

// Run the CLI only when invoked directly (not when imported by the test).
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main()
}
