// Fold the Vite build (one JS chunk + one CSS file, every asset already a data:
// URI) into ONE self-contained HTML fragment for the artifact host — same shape
// as animation-audit/fold.mjs.
//
// The host wraps the fragment in <!doctype><html><head><body>, so we emit NO such
// wrapper tags — just <title>, an inlined <style>, the root <div>, and the inlined
// <script type="module">. Two CSS transforms:
//   1. Neutralize the DS's `@media (prefers-reduced-motion: reduce)` reset so the
//      viewer's OS setting never auto-freezes the exhibits — motion is forced full
//      by the matchMedia shim so the designer sees the real, moving UI.
//   2. Drop the `.woff` fallback inside @font-face `src` (keep the inlined `.woff2`
//      data: URI) — modern-only, halves the font payload.

import { readFileSync, writeFileSync, statSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
const dist = join(here, 'dist')
const outPath = process.argv[2] ?? join(dist, 'copy-workbench.html')

let css = readFileSync(join(dist, 'workbench.css'), 'utf8')
const js = readFileSync(join(dist, 'workbench.js'), 'utf8')

// 1. Make the OS reduced-motion reset never auto-match (the shim forces full motion).
css = css.replaceAll(
  '@media (prefers-reduced-motion: reduce)',
  '@media (prefers-reduced-motion: reduce) and (min-width: 999999px)',
)

// 2. Strip the woff fallback in @font-face src, keeping the woff2 data: URI.
css = css.replace(
  /,\s*url\((?:"|')?data:[^)]*?(?:"|')?\)\s*format\(\s*(?:"|')woff(?:"|')\s*\)/g,
  '',
)

const escapeClose = (s) => s.replaceAll('</script>', '<\\/script>').replaceAll('</style>', '<\\/style>')

const html = `<title>Mythrun — Copy Workbench</title>
<style>
${escapeClose(css)}
</style>
<div id="workbench-root"></div>
<script type="module">
${escapeClose(js)}
</script>
`

writeFileSync(outPath, html)

const kb = (n) => `${(n / 1024).toFixed(1)} KB`
console.log(`wrote ${outPath}`)
console.log(`  css ${kb(css.length)}  js ${kb(js.length)}  total ${kb(statSync(outPath).size)}`)

// Guard: nothing external may remain (the artifact CSP blocks all external hosts).
const external = [...html.matchAll(/https?:\/\/[^\s"')]+/g)].map((m) => m[0])
const nonDataUrls = [...html.matchAll(/url\(\s*(?!['"]?data:)([^)]+)\)/g)].map((m) => m[1].trim())
if (external.length > 0) console.warn(`  WARN external URLs: ${[...new Set(external)].slice(0, 8).join(', ')}`)
if (nonDataUrls.length > 0) console.warn(`  WARN non-data url(): ${[...new Set(nonDataUrls)].slice(0, 8).join(', ')}`)
if (external.length === 0 && nonDataUrls.length === 0) console.log('  self-contained: no external references')
