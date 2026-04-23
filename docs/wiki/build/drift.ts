import type { PageMeta } from './types.ts'

const sourceHashRegex = /<!--\s*source-hash:\s*(sha256:[0-9a-zA-Z]+)\s*-->/
const lastTicketRegex = /<!--\s*last-ticket:\s*([A-Z]+-\d+)\s*-->/

// The `[^\n-]` first-char class is intentional: it prevents `source-hash:` and
// `source-hash ...` from matching this regex (since those lines would start
// with `-` after `source`). If you ever declare a tracked path that literally
// begins with `-`, this will reject it — that's fine, paths shouldn't start
// with `-` anyway.
const sourceCommentPattern = String.raw`<!--\s*source:\s*([^\n-][^\n]*?)\s*-->`

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

export type DriftStatus = 'match' | 'mismatch' | 'new' | 'sourceless'

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
  const pathList = sourcePaths.map((p) => `<code>${p}</code>`).join(', ')
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

  // Insert after the last <!-- source: --> comment.
  let lastEnd = -1
  const locateRegex = /<!--\s*source:[^\n]*-->/g
  for (let m = locateRegex.exec(content); m !== null; m = locateRegex.exec(content)) {
    lastEnd = m.index + m[0].length
  }
  if (lastEnd === -1) {
    throw new Error('rewriteSourceHash: could not find source comment boundary')
  }
  const insertion = `\n<!-- source-hash: ${newHash} -->`
  return content.slice(0, lastEnd) + insertion + content.slice(lastEnd)
}
