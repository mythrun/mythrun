// backend/src/session/playbook-split.ts
//
// myth-g4hf3 — the sd_playbook → tripwire-input split. The run-2 forensics root
// cause: the whole playbook rode a single `[SECRET-1]` handle, so "prose
// contradicts an encounter script" was indistinguishable from "prose revealed a
// secret" and a dice-earned reward got openly retconned. Only actual SECRET
// material (the NPC-secrets and revelation-list sections of the prep template)
// gets a per-secret `[SECRET-n]` handle; everything else (session goals,
// knowledge bounds, encounter scripts, pacing, hooks) is CONSISTENCY material,
// which the tripwire may route to the soft path only. Deterministic structural
// parsing of a template we author — ZFC-legal. Consumed ONLY by the Scribe
// worker (the secret side of the enforced-ignorance boundary); nothing here may
// ever feed an FT-side call.

/** The tripwire's view of the sd_playbook, split along the prep template's
 *  section seams. */
export interface PlaybookSplit {
  /** Handle-annotated secret blocks, one `[SECRET-n]` per NPC-secret /
   *  revelation-conclusion block, joined for the tripwire's `secrets` input. */
  readonly secrets: string
  /** The emitted handles — the hard_reveal routing gate: a hard verdict whose
   *  secretRef is not one of these routes to the SOFT path (no open retcon). */
  readonly handles: readonly string[]
  /** Non-secret playbook material (session goals, knowledge bounds, encounter
   *  scripts, pacing, hooks). Still STAYS on the Scribe side of the enforced-
   *  ignorance boundary — it feeds only the tripwire's consistency input. */
  readonly consistency: string
  /** True when NO secret section was recognized and the whole playbook fell
   *  back to the v1 `[SECRET-1]` lump (over-protective, warn-worthy). */
  readonly fallback: boolean
}

/** The h2 headings whose sections carry ACTUAL secret material per the
 *  session-prep template (prompts/prep/session-prep.txt): "## NPC Secrets &
 *  Revelation Conditions" and "## Revelation List (Three Clue Rule)". Matched
 *  as case-insensitive heading PREFIXES so minor prep drift (a dropped suffix)
 *  still classifies. */
const SECRET_SECTION_PREFIXES = ['npc secrets', 'revelation list'] as const

interface PlaybookSection {
  readonly heading: string
  readonly body: string
}

/** Split a markdown document on its `## ` headings. The preamble (anything
 *  before the first h2, including the `# ` title) rides as heading ''. */
function splitH2Sections(doc: string): PlaybookSection[] {
  const sections: PlaybookSection[] = []
  let heading = ''
  let lines: string[] = []
  for (const line of doc.split('\n')) {
    const m = /^##\s+(.+?)\s*$/.exec(line)
    if (m !== null && !line.startsWith('###')) {
      sections.push({ heading, body: lines.join('\n') })
      /* c8 ignore start — the capture group is non-optional, so `m[1]` on a
       * successful exec is always a string; the `?? ''` arm exists only for
       * noUncheckedIndexedAccess. */
      heading = m[1] ?? ''
      /* c8 ignore stop */
      lines = []
      continue
    }
    lines.push(line)
  }
  sections.push({ heading, body: lines.join('\n') })
  return sections
}

/** Split one SECRET section into its per-secret `### ` blocks (one per NPC /
 *  conclusion). A section-level preamble with real content becomes its own
 *  block; a section with no sub-heads is one block whole. */
function splitSecretBlocks(section: PlaybookSection): string[] {
  const blocks: string[] = []
  let current: string[] = []
  let sawSubhead = false
  const push = (): void => {
    const text = current.join('\n').trim()
    if (text !== '') blocks.push(text)
    current = []
  }
  for (const line of section.body.split('\n')) {
    if (/^###\s+/.test(line)) {
      push()
      sawSubhead = true
    }
    current.push(line)
  }
  push()
  if (!sawSubhead) {
    const whole = section.body.trim()
    return whole === '' ? [] : [`## ${section.heading}\n${whole}`]
  }
  return blocks
}

/**
 * Split the sd_playbook into per-secret handles + consistency material.
 * FAIL-SAFE fallback: a playbook with NO recognizable secret section keeps the
 * v1 whole-playbook `[SECRET-1]` lump (the caller warns) — a mis-split must
 * degrade toward over-protection of secrets, never toward a disarmed tripwire.
 */
export function splitPlaybook(sdPlaybook: string): PlaybookSplit {
  const sections = splitH2Sections(sdPlaybook)
  const secretBlocks: string[] = []
  const consistencyParts: string[] = []
  for (const section of sections) {
    const h = section.heading.trim().toLowerCase()
    const isSecret = SECRET_SECTION_PREFIXES.some((p) => h.startsWith(p))
    if (isSecret) {
      secretBlocks.push(...splitSecretBlocks(section))
    } else {
      const text = section.heading === '' ? section.body : `## ${section.heading}\n${section.body}`
      if (text.trim() !== '') consistencyParts.push(text.trim())
    }
  }
  if (secretBlocks.length === 0) {
    return {
      secrets: `[SECRET-1] ${sdPlaybook}`,
      handles: ['[SECRET-1]'],
      consistency: '',
      fallback: true,
    }
  }
  const handles = secretBlocks.map((_b, i) => `[SECRET-${String(i + 1)}]`)
  return {
    /* c8 ignore start — `handles` maps 1:1 from `secretBlocks`, so `handles[i]`
     * is always present here; the `?? ''` arm exists only for
     * noUncheckedIndexedAccess. */
    secrets: secretBlocks.map((b, i) => `${handles[i] ?? ''} ${b}`).join('\n\n'),
    /* c8 ignore stop */
    handles,
    consistency: consistencyParts.join('\n\n'),
    fallback: false,
  }
}

/** Normalize a model-emitted secret handle for gate comparison — tolerates
 *  missing brackets / case drift ('secret-2' == '[SECRET-2]'). */
export function normalizeHandle(ref: string): string {
  return ref.toUpperCase().replace(/[^A-Z0-9-]/g, '')
}

/** True iff the verdict's secretRef names one of the emitted [SECRET-n]
 *  handles. Structural validation of an opaque control signal (ZFC-legal). */
export function isKnownSecretHandle(handles: readonly string[], ref: string | null): boolean {
  if (ref === null) return false
  const norm = normalizeHandle(ref)
  return norm !== '' && handles.some((h) => normalizeHandle(h) === norm)
}
