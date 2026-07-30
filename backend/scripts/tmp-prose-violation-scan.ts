/* Violation scanner over a prose flight. Counts the MECHANICAL,
 * regex-detectable tells from the negative catalog per (scene, candidate).
 * Narrative-level tells (theme-explaining, moralizing, tidy wrap-up) are judged
 * by reading, not by this scanner. Prints a table to stdout.
 *
 * Two input formats, auto-detected:
 *   tasting-flight.md  — "## Scene N" x "### Candidate X"
 *   confirm-raw.md     — "## <surface>" x "### NONE|SHIPPED|NEW" x "**Draw N**"
 *
 * Run: pnpm exec tsx scripts/tmp-prose-violation-scan.ts <path.md>
 */
import { readFileSync } from 'node:fs'

const path = process.argv[2]
if (!path) throw new Error('usage: tsx scripts/tmp-prose-violation-scan.ts <path.md>')
const md = readFileSync(path, 'utf8')

interface Cell {
  scene: string
  cand: string
  prose: string
}

const quoted = (chunk: string): string =>
  chunk
    .split('\n')
    .filter((l) => l.startsWith('> '))
    .map((l) => l.slice(2))
    .join('\n')
    .trim()

const cells: Cell[] = []
const isConfirm = /^### (NONE|SHIPPED|NEW)\s*$/m.test(md)

if (isConfirm) {
  // ## <surface title> ... ### CELL ... **Draw N** ... > prose
  for (const sc of md.split(/\n## /).slice(1)) {
    const surface = (sc.split('\n')[0] ?? '').trim()
    for (const cc of sc.split(/\n### /).slice(1)) {
      const cell = (cc.split('\n')[0] ?? '').trim()
      for (const dc of cc.split(/\n\*\*Draw /).slice(1)) {
        const n = (dc.split('\n')[0] ?? '').replace(/\*\*/g, '').trim()
        cells.push({ scene: `${surface.slice(0, 14)}#${n}`, cand: cell, prose: quoted(dc) })
      }
    }
  }
} else {
  // ## Scene N — title ... ### Label \n desc \n > prose... (stop at the Appendix)
  const body = md.split('## Appendix')[0] ?? md
  for (const sc of body.split(/\n## Scene /).slice(1)) {
    const sceneTitle = (sc.split('\n')[0] ?? '').trim()
    for (const cc of sc.split(/\n### /).slice(1)) {
      const label = (cc.split('\n')[0] ?? '').trim()
      cells.push({ scene: sceneTitle.slice(0, 6), cand: label, prose: quoted(cc) })
    }
  }
}

const TELLS: { name: string; re: RegExp }[] = [
  { name: 'emdash', re: /—/g },
  { name: 'seems/seemed', re: /\bseem(s|ed)?\b/gi },
  { name: 'something-about', re: /\bsomething about\b/gi },
  { name: 'as-if', re: /\bas if\b/gi },
  { name: 'depending-on', re: /\bdepending on\b/gi },
  { name: 'not-X-but/It-was', re: /\b(wasn't|isn't|weren't|aren't)\b[^.?!]*[.?!]\s*(It|They|That)\b|\bnot\b[^.?!]{0,40}\bbut\b/gi },
  { name: 'no-ordinary', re: /\bno ordinary\b|\bnot just\b/gi },
  { name: 'air/silence/weight', re: /\bthe air\b|\bthe silence\b|\ba weight\b|\bhung in the air\b|\bsettled over\b|\bpalpable\b/gi },
  { name: 'tricolon(X,Y,and Z)', re: /,\s+[^,.]+,\s+and\s+[^,.]+[.,]/gi },
  { name: 'mystery-signal', re: /\bmore than meets\b|\bnot what (it|they) seem/gi },
  { name: 'copula-dodge', re: /\bserves as\b|\bstands as\b|\bboasts\b|\btestament\b/gi },
  // The flourish-landing family — the trailing verdict that A/C/D/E all reached
  // for in the flight ("the only building on the block that hasn't called it a
  // night"). Personification / simile / "the kind of X that Y" summary.
  { name: 'verdict-simile', re: /\b(like|as though|as if)\s+(it|they|the\s+\w+)\s+\w+/gi },
  { name: 'the-kind-of', re: /\bthe kind of\b/gi },
  { name: 'the-only-X-that', re: /\bthe only \w+[^.]{0,40}\bthat\b/gi },
]

// Rhythm — what the exemplar in the register block actually targets, and what
// the tell-regexes cannot see. Long mean sentences and high commas-per-sentence
// are the clause-piled breath the block tells the model to stop writing.
function rhythm(prose: string): { words: number; wps: number; cps: number } {
  const sentences = prose.split(/[.?!]+[\s"']*/).filter((s) => s.trim().length > 0)
  const words = prose.split(/\s+/).filter(Boolean).length
  const commas = (prose.match(/,/g) ?? []).length
  const n = Math.max(sentences.length, 1)
  return { words, wps: words / n, cps: commas / n }
}

function countTells(prose: string): Record<string, number> {
  const out: Record<string, number> = {}
  for (const t of TELLS) {
    const m = prose.match(t.re)
    if (m && m.length) out[t.name] = m.length
  }
  return out
}

// One-line closer: last non-empty paragraph is a short single sentence.
function shortCloser(prose: string): boolean {
  const paras = prose.split(/\n\s*\n/).map((p) => p.trim()).filter(Boolean)
  const last = paras[paras.length - 1] ?? ''
  const sentences = last.split(/[.?!]+/).filter((s) => s.trim().length > 0)
  return sentences.length === 1 && last.split(/\s+/).length <= 12
}

interface Agg {
  total: number
  closers: number
  cells: number
  words: number
  wps: number
  cps: number
}
const byCand: Record<string, Agg> = {}
console.log('scene           | candidate                | tell counts')
console.log('----------------|--------------------------|--------------------------------')
for (const c of cells) {
  const tells = countTells(c.prose)
  const closer = shortCloser(c.prose)
  const total = Object.values(tells).reduce((a, b) => a + b, 0)
  const r = rhythm(c.prose)
  const key = c.cand.split(' ')[0] === 'Baseline' ? 'Baseline' : c.cand.replace('Candidate ', 'Cand ')
  byCand[key] ??= { total: 0, closers: 0, cells: 0, words: 0, wps: 0, cps: 0 }
  const a = byCand[key]
  a.total += total
  a.closers += closer ? 1 : 0
  a.cells += 1
  a.words += r.words
  a.wps += r.wps
  a.cps += r.cps
  const parts = Object.entries(tells).map(([k, v]) => `${k}:${v}`)
  if (closer) parts.push('SHORT-CLOSER')
  console.log(`${c.scene.padEnd(15)} | ${c.cand.padEnd(24)} | ${parts.join(', ') || '(none)'}`)
}

console.log('\n=== per-candidate totals ===')
console.log('candidate    | tells | short-closers | mean words | mean words/sent | mean commas/sent')
for (const [k, v] of Object.entries(byCand)) {
  const f = (x: number): string => (x / v.cells).toFixed(1)
  console.log(
    `${k.padEnd(12)} | ${String(v.total).padStart(5)} | ${`${v.closers}/${v.cells}`.padStart(13)} | ` +
      `${f(v.words).padStart(10)} | ${f(v.wps).padStart(15)} | ${f(v.cps).padStart(16)}`,
  )
}
console.log('\nLower is better on every column. Tell-counts are the weak signal (they erode')
console.log('with each model update); words/sent and commas/sent measure the clause-piled')
console.log('breath the exemplar exists to break. Narrative portent is judged by READING.')
