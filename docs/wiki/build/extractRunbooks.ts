import type { TocEntry } from './extractToc.ts'

export interface RunbookEntry {
  title: string
  id: string
}

const RUNBOOK_H2_TEXT = 'Operating this piece'

/**
 * Given a page's TOC entries (from extractToc), return the h3 entries that
 * sit under the "Operating this piece" h2. Exact-match on the h2 text,
 * case-sensitive. Stops at the next h2 (any text).
 */
export function extractRunbookEntries(toc: TocEntry[]): RunbookEntry[] {
  const runbooks: RunbookEntry[] = []
  let insideOperating = false
  for (const entry of toc) {
    if (entry.level === 2) {
      insideOperating = entry.text === RUNBOOK_H2_TEXT
      continue
    }
    if (insideOperating) {
      runbooks.push({ title: entry.text, id: entry.id })
    }
  }
  return runbooks
}
