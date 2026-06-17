// MYT-74b T10 — the producer→consumer bridge between the post-session handoff
// and the next session's prep. Parses the repo's NEWEST-first prior rows
// (sessions.getPriorContextForPrep) into the prep's PriorSessionContext:
//
//   - previousSummaries — the chronological (oldest → newest) recap strings,
//     unwrapped from each row's `{summary, emergingThreads}` JSON.
//   - latestHandoff — the newest row's SessionHandoff (safeParsed). Feeds the
//     "Where We Left Off" anchor in the prep prompt; its verbatim voice /
//     atmosphere are appended to ft_context deterministically by the processor.
//
// All parsing is TOLERANT (safeParse / try-catch): a malformed or legacy row
// degrades to omission, never a throw mid-prep.
import { SessionHandoffSchema, type SessionHandoff } from '../schemas/post-session-analysis.js'
import type { PriorSessionContext } from './serialize-world-state-for-prep.js'

interface PriorRow {
  readonly sessionNumber: number
  readonly summaryJson: string
  readonly handoffJson: string | null
}

/** Parse the repo's NEWEST-first prior rows into the prep's PriorSessionContext.
 *  previousSummaries is chronological (oldest→newest); latestHandoff is the newest
 *  row's handoff. All parsing is tolerant (safeParse) — malformed/legacy degrades
 *  to omission, never a throw mid-prep. */
export function buildPriorSessionContext(rows: readonly PriorRow[]): PriorSessionContext {
  const chronological = [...rows].reverse()
  const previousSummaries: string[] = []
  for (const r of chronological) {
    try {
      const parsed: unknown = JSON.parse(r.summaryJson)
      const summary = (parsed as { summary?: unknown }).summary
      if (typeof summary === 'string' && summary.length > 0) previousSummaries.push(summary)
    } catch {
      // malformed/legacy summary wrapper → skip (never throw mid-prep)
    }
  }
  const latestRaw = rows[0]?.handoffJson ?? null
  let latestHandoff: SessionHandoff | undefined
  if (latestRaw !== null) {
    try {
      const parsed = SessionHandoffSchema.safeParse(JSON.parse(latestRaw))
      if (parsed.success) latestHandoff = parsed.data
    } catch {
      // malformed JSON → no handoff
    }
  }
  return { previousSummaries, ...(latestHandoff !== undefined ? { latestHandoff } : {}) }
}
