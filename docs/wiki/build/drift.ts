import type { PageMeta } from './types.ts'

// Matches a real `sha256:<hex>` hash OR the `<auto>` / `<auto-maintained>`
// placeholder convention from AUTHORING.md examples. Without the placeholder
// alternative, rewriteSourceHash fell through to the "insert" branch instead
// of replacing the placeholder, leaving stale `<!-- source-hash: sha256:<auto> -->`
// comments next to the real hash on first accept-drift. Capture group 1 is
// the real hash when present; group 2 is the placeholder marker.
const sourceHashRegex =
  /<!--\s*source-hash:\s*(?:(sha256:[0-9a-f]+)|sha256:(<auto(?:-maintained)?>))\s*-->/
const lastTicketRegex = /<!--\s*last-ticket:\s*([A-Z]+-\d+)\s*-->/

// The literal `source:` (with colon) can't match `source-hash:` (with dash), so
// the pattern naturally excludes hash comments without needing a first-char
// exclusion trick. The capture is non-greedy and surrounding `\s*` trims
// whitespace, so `<!-- source:  /path/  -->` cleanly captures `/path/`.
const sourceCommentPattern = String.raw`<!--\s*source:\s*([^\n]+?)\s*-->`

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

export function parsePageMeta(content: string): PageMeta {
  const sourcePaths: string[] = []
  const re = new RegExp(sourceCommentPattern, 'g')
  for (let m = re.exec(content); m !== null; m = re.exec(content)) {
    const path = m[1]
    if (path !== undefined) sourcePaths.push(path)
  }
  const hashMatch = sourceHashRegex.exec(content)
  const ticketMatch = lastTicketRegex.exec(content)
  return {
    sourcePaths,
    sourceHash: hashMatch?.[1] ?? null,
    lastTicket: ticketMatch?.[1] ?? null,
  }
}

type DriftStatus = 'match' | 'mismatch' | 'new' | 'sourceless'

export interface DriftResult {
  drifted: boolean
  status: DriftStatus
}

export function checkDrift(meta: PageMeta, currentHash: string | null): DriftResult {
  if (meta.sourcePaths.length === 0) {
    return { drifted: false, status: 'sourceless' }
  }
  if (meta.sourceHash === null) {
    return { drifted: true, status: 'new' }
  }
  if (meta.sourceHash === currentHash) {
    return { drifted: false, status: 'match' }
  }
  return { drifted: true, status: 'mismatch' }
}

export function renderDriftBanner(sourcePaths: string[]): string {
  // Defensive HTML escape — paths come from content-file comments which are
  // agent-authored today, but that process assumption can erode. Escape now
  // so we don't have to audit every future author path.
  const pathList = sourcePaths.map((p) => `<code>${escapeHtml(p)}</code>`).join(', ')
  return [
    '<div class="wiki-drift-banner" role="alert">',
    '  <strong>⚠️ Source has drifted.</strong>',
    '  <span>The source files this page documents have changed since the page was last updated. Verify before trusting.</span>',
    `  <div class="wiki-drift-paths">source: ${pathList}</div>`,
    '</div>',
  ].join('\n')
}

export function rewriteSourceHash(content: string, newHash: string): string {
  // Check for source comments using a function-local regex to avoid module-level
  // lastIndex state leaks.
  const sourceCheck = new RegExp(sourceCommentPattern)
  if (sourceCheck.exec(content) === null) {
    throw new Error('rewriteSourceHash: page has no source declarations')
  }

  if (sourceHashRegex.exec(content) !== null) {
    return content.replace(sourceHashRegex, `<!-- source-hash: ${newHash} -->`)
  }

  // Insert after the last <!-- source: --> comment. Reuses sourceCommentPattern
  // so the boundary-finding regex stays in sync with the source-detection regex.
  let lastEnd = -1
  const locateRegex = new RegExp(sourceCommentPattern, 'g')
  for (let m = locateRegex.exec(content); m !== null; m = locateRegex.exec(content)) {
    lastEnd = m.index + m[0].length
  }
  if (lastEnd === -1) {
    throw new Error('rewriteSourceHash: could not find source comment boundary')
  }
  const insertion = `\n<!-- source-hash: ${newHash} -->`
  return content.slice(0, lastEnd) + insertion + content.slice(lastEnd)
}
