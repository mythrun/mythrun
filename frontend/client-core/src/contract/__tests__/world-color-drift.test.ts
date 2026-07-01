import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'
import { WORLD_COLORS, worldColorCssVar } from '@mythrun/contract/rest'

// Drift guard: the widened `WorldColor` set lives in the react-free
// `@mythrun/contract` (so the backend can validate it), but the actual colour
// VALUES it names are the design tokens emitted by `@mythrun/ui` into
// `tokens.manifest.json`. Nothing at the type level couples the two — a
// `WorldColor` is just a `${ramp}-${step}` string literal. This test IS that
// coupling: every member must resolve to a `--color-{name}` token that really
// exists, so the set can never reference a deleted/renamed/never-emitted token.
const here = dirname(fileURLToPath(import.meta.url))
// __tests__ → contract → src → client-core → frontend → repo root
const repoRoot = resolve(here, '../../../../..')
const manifestText = readFileSync(
  resolve(repoRoot, 'frontend/ui/src/styles/tokens.manifest.json'),
  'utf8',
)

/** The set of every `--color-*` key present in the generated tokens manifest. */
function manifestColorTokens(json: string): Set<string> {
  const out = new Set<string>()
  for (const m of json.matchAll(/"(--color-[\w-]+)":\s*"#[0-9A-Fa-f]{6}"/g)) {
    const name = m[1]
    if (name !== undefined) out.add(name)
  }
  return out
}

const MANIFEST_TOKENS = manifestColorTokens(manifestText)

describe('WorldColor drift guard — every cover colour resolves to a real design token', () => {
  it('the manifest actually parsed (guard against an empty regex match)', () => {
    // A non-trivial floor so a broken read / renamed manifest can't vacuously pass.
    expect(MANIFEST_TOKENS.size).toBeGreaterThan(WORLD_COLORS.length)
    expect(MANIFEST_TOKENS.has('--color-verdigris-200')).toBe(true)
  })

  it('every WorldColor resolves to a real --color-{name} manifest token', () => {
    for (const name of WORLD_COLORS) {
      const cssVar = worldColorCssVar(name)
      expect(cssVar).toBe(`var(--color-${name})`)
      // The token the css-var references must exist in the emitted manifest.
      expect(MANIFEST_TOKENS.has(`--color-${name}`), `${name} → --color-${name} exists`).toBe(true)
    }
  })

  it('does NOT reference the semantic ramps (success/warning/danger/info)', () => {
    for (const name of WORLD_COLORS) {
      const ramp = name.slice(0, name.lastIndexOf('-'))
      expect(['success', 'warning', 'danger', 'info']).not.toContain(ramp)
    }
  })
})
