import type { SessionHandoff } from '../../llm/schemas/post-session-analysis.js'

/** A transcript row as the verifier needs it: the prose + its originating trigger
 *  kind (NULL for player + pre-028 rows). */
export interface AnalysisTranscriptRow {
  readonly content: string
  readonly triggerKind: string | null
}

/** Rows whose prose must NEVER seed a verbatim excerpt (§5): a MYT-73 retcon
 *  ([[DM CORRECTION:]]) line points at the buried secret; a farewell line is
 *  meta-closure, not characterization. */
const EXCLUDED_TRIGGER_KINDS = new Set(['correction', 'farewell'])

/** Normalize for containment: collapse runs of whitespace + lowercase. The
 *  verbatim guarantee is "this excerpt is a copy of a player-witnessed,
 *  non-correction line" — whitespace/case drift from JSON re-emission is tolerated;
 *  a semantic (non-substring) difference is not. */
function normalize(s: string): string {
  return s.replace(/\s+/g, ' ').trim().toLowerCase()
}

export interface ContainmentResult {
  readonly handoff: SessionHandoff
  readonly droppedVoice: number
  readonly droppedAtmosphere: number
}

/** Mechanically verify every NPC voice excerpt + location atmosphere snippet is a
 *  verbatim substring of a NON-correction/farewell transcript row; drop the rest.
 *  Returns the sanitized handoff + drop COUNTS (structural only — the worker logs
 *  the counts, never the content). */
export function verifyHandoffContainment(
  handoff: SessionHandoff,
  rows: readonly AnalysisTranscriptRow[],
): ContainmentResult {
  const haystack = rows
    .filter((r) => r.triggerKind === null || !EXCLUDED_TRIGGER_KINDS.has(r.triggerKind))
    .map((r) => normalize(r.content))
  const contains = (excerpt: string): boolean => {
    const needle = normalize(excerpt)
    return needle.length > 0 && haystack.some((h) => h.includes(needle))
  }

  let droppedVoice = 0
  const npcs = handoff.npcs.map((npc) => {
    const voice = npc.voice.filter((v) => contains(v))
    droppedVoice += npc.voice.length - voice.length
    return { ...npc, voice }
  })

  let droppedAtmosphere = 0
  const keyLocations = handoff.keyLocations.filter((loc) => {
    const ok = contains(loc.atmosphere)
    if (!ok) droppedAtmosphere += 1
    return ok
  })

  return { handoff: { ...handoff, npcs, keyLocations }, droppedVoice, droppedAtmosphere }
}
