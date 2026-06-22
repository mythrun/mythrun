import { describe, it, expect } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const generatorPath = resolve(here, 'generate-palette.mjs')
// The committed web CSS the relocated generator must still reproduce byte-for-byte.
const committedCssPath = resolve(here, '../../../ui/src/styles/colors.generated.css')
const committedManifestPath = resolve(here, '../../../ui/src/styles/tokens.manifest.json')

describe('relocated token generator — round-trip idempotency', () => {
  it('reproduces the committed colors.generated.css byte-for-byte', () => {
    // The generator writes tokens.html two levels above its output dir, so we
    // run it into <tmp>/src/styles — the html lands at <tmp>/tokens.html, fully
    // contained in the scratch tree (never touches the committed package).
    const root = mkdtempSync(resolve(tmpdir(), 'mythrun-tokens-'))
    const outDir = resolve(root, 'src', 'styles')
    mkdirSync(outDir, { recursive: true })
    try {
      execFileSync('node', [generatorPath, outDir], { stdio: 'pipe' })

      const fresh = readFileSync(resolve(outDir, 'colors.generated.css'), 'utf8')
      const committed = readFileSync(committedCssPath, 'utf8')
      expect(fresh).toBe(committed)

      const freshManifest = readFileSync(resolve(outDir, 'tokens.manifest.json'), 'utf8')
      const committedManifest = readFileSync(committedManifestPath, 'utf8')
      expect(freshManifest).toBe(committedManifest)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})
