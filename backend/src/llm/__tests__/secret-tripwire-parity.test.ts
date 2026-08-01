// backend/src/llm/__tests__/secret-tripwire-parity.test.ts
//
// Cost-wave1 §3 — the tripwire reorder's DECISION-PARITY GATE (blocking).
// secret-tripwire.txt was reordered stable-first for caching: instruction
// head + core secrets + public briefing + consistency notes above the cache
// breakpoint; the per-turn prose + dice outcomes + the output-format tail
// below. The reorder must not change verdicts. Two layers pin that here:
//
//   1. PURE PERMUTATION — the live template is byte-identical to the frozen
//      pre-reorder template section-for-section (head, every labeled section,
//      output tail); ONLY the section order changed. No instruction rewrite
//      was needed: every order-referential word in the head ("below" ×5 —
//      two on line 1, one each on lines 3/5/7) references material that
//      still sits below the head in the new order.
//
//   2. VERDICT PARITY THROUGH THE MOCKED PIPELINE — the constructed-state
//      scenarios (grounded→none, dice-grounded→none, consistency→soft,
//      seeded-reveal→hard) run through the real runSecretTripwire with the
//      SDK mocked by a deterministic RULE-FOLLOWING classifier that reads the
//      rendered prompt ONLY via its labeled sections and applies the
//      template's own steps (grounding floor → deducibility → consistency
//      cap). The same classifier reads the frozen pre-reorder rendering of
//      identical inputs; verdicts must match exactly. A dropped, garbled, or
//      mis-slotted section changes (or explodes) the extraction and breaks
//      parity.
//
// This is the strongest parity claim available without live spend: identical
// bytes per section + a mechanical reader reaching identical verdicts on both
// orderings. The live confirmation rides the controller's shared S-1/S-2
// proof block (cost-wave1 task plan) — not run here by design.

import { beforeEach, describe, expect, it, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import * as ai from 'ai'
import { runSecretTripwire } from '../secret-tripwire.js'
import type { SecretTripwireSeverity } from '../schemas/secret-tripwire.js'

vi.mock('ai', async (importOriginal) => ({
  ...(await importOriginal<typeof import('ai')>()),
  generateText: vi.fn(),
}))

const mockGenerateText = vi.mocked(ai.generateText)

const LIVE_TEMPLATE_PATH = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '../prompts/session/secret-tripwire.txt',
)

// ---------------------------------------------------------------------------
// The frozen PRE-REORDER template — byte-exact copy of secret-tripwire.txt as
// of 56532658 (the last commit before the stable-first reorder). This is the
// "before" ordering the parity gate diffs against. Do NOT edit alongside
// template changes: a semantic template change retires this gate and needs a
// fresh live-parity pass, not a fixture update.
// ---------------------------------------------------------------------------
const PRE_REORDER_TEMPLATE = [
  'You are the secret tripwire for an AI Dungeon Master. The narrator (Fast Thinker) just wrote the player-facing prose below. The narrator writes under ENFORCED IGNORANCE: it does NOT know any secret. It DOES have a public briefing (below) it was told to draw on, and the system may have handed it a RESOLVED DICE OUTCOME it was REQUIRED to narrate. So when its prose touches a secret it is one of: (1) a detail it was LICENSED to write (by the briefing or by a resolved dice outcome), (2) improvised color that merely rhymes with a hidden truth, (3) a contradiction of the session\'s non-secret prep notes (a consistency matter, not a leak), or (4) an accidental HARD REVEAL. You alone hold the session\'s CORE SECRETS. Your ONLY job: classify HOW the prose relates to those secrets.',
  '',
  'HARD RULE: your output is a control signal, NOT content. You return only {severity, confidence, secretRef}. `secretRef` is the HANDLE of the nearest core secret (one of the bracketed [SECRET-n] labels below), never the secret\'s text. Never quote, paraphrase, or describe a secret in any field.',
  '',
  'STEP 1 — GROUNDING (the floor). First check the PUBLIC BRIEFING and the RESOLVED DICE OUTCOMES below. If the flagged detail is already stated in, or directly licensed by, either one, the severity is "none" — the narrator was TOLD (or dice-instructed) to write this, so it CANNOT be a leak, even if it is thematically consistent with a secret. Two examples: if the briefing says an NPC is watching a certain door, the narrator writing that the NPC watches that door is grounded → "none". If a resolved skill check\'s outcome constraint says a character\'s search "reveals something gripped in the statue\'s hand", then prose granting a discovered object is grounded → "none" — the system\'s own dice licensed it, and a dice-earned discovery is canon, not a breach. Only if the prose goes BEYOND what was licensed, toward a core secret\'s hidden content, can it be a breach.',
  '',
  'STEP 2 — CONSISTENCY MATERIAL IS NOT SECRET. The consistency notes below (encounter scripts, pacing guidance, NPC knowledge bounds) are prep bookkeeping, NOT secrets. Prose that contradicts or parallels them is AT MOST "soft_consistency" with secretRef "[CONSISTENCY]" — never "hard_reveal". A player cannot have a secret spoiled by prose that merely diverges from a script.',
  '',
  'STEP 3 — for prose NOT grounded in Step 1 and NOT a mere Step 2 consistency matter, classify `severity` as EXACTLY ONE of:',
  '',
  '- "hard_reveal" — the prose STATES a core secret from the CORE SECRETS block, or says something a player could ONLY conclude that secret\'s actual CONTENT from. The test is DEDUCIBILITY: reading only this prose, could an attentive player correctly state the secret? If yes, it is a hard reveal — the secret is now known or all-but-known. This is the only severity that warrants an open, player-facing correction, and it MUST cite the [SECRET-n] handle of the revealed secret.',
  '',
  '- "soft_consistency" — the prose shows an NPC\'s behavior, mood, gaze, or scene color that is merely CONSISTENT with a hidden agenda, without stating or necessarily implying the secret\'s content, AND is not already licensed by the grounding floor; OR the prose contradicts the consistency notes (Step 2). The player cannot deduce WHAT the hidden truth is from it; a dozen innocent explanations remain open. Behavior consistent with a secret is soft, never hard.',
  '',
  '- "none" — grounded (Step 1), OR no meaningful relation to any core secret or consistency note.',
  '',
  'Player-facing prose this turn:',
  '{{prose}}',
  '',
  'Public briefing the narrator was given (enforced-ignorance-safe; anything here is ALREADY public and licensed):',
  '{{publicContext}}',
  '',
  'Resolved dice outcomes this turn (system-licensed; prose narrating these outcome constraints is grounded → "none"):',
  '{{diceOutcomes}}',
  '',
  'Consistency notes (non-secret prep material — scripts, pacing, knowledge bounds; contradiction here is at most "soft_consistency" with secretRef "[CONSISTENCY]"):',
  '{{consistencyContext}}',
  '',
  'Core secrets (each prefixed with its handle; for GATING only, never to be echoed):',
  '{{secrets}}',
  '',
  'Return JSON: { "severity": "none"|"soft_consistency"|"hard_reveal", "confidence": <0..1>, "secretRef": "<handle, or null>" }',
  'Set `secretRef` to the nearest [SECRET-n] handle for a secret-related "soft_consistency" or any "hard_reveal"; to "[CONSISTENCY]" for a consistency-notes matter; null for "none". A "hard_reveal" without a [SECRET-n] handle is invalid — if no listed core secret was revealed, it is not a hard reveal. `confidence` is your certainty in the SEVERITY call (0..1). Three independent gates protect the player experience: grounded content (briefing or dice) is never a breach (Step 1), consistency notes can never produce a hard reveal (Step 2), and only prose a player could not read WITHOUT learning a listed core secret is "hard_reveal" (Step 3). An NPC merely behaving in character — or the narrator doing exactly what the briefing or the dice told it to do — is not a hard reveal.',
  '',
].join('\n')

// ---------------------------------------------------------------------------
// Section machinery: both templates (and both renderings) are addressed ONLY
// via these header lines, so the extraction itself proves the labels survived
// the reorder intact.
// ---------------------------------------------------------------------------
const SECTION_HEADERS = {
  prose: 'Player-facing prose this turn:',
  publicContext:
    'Public briefing the narrator was given (enforced-ignorance-safe; anything here is ALREADY public and licensed):',
  diceOutcomes:
    'Resolved dice outcomes this turn (system-licensed; prose narrating these outcome constraints is grounded → "none"):',
  consistencyContext:
    'Consistency notes (non-secret prep material — scripts, pacing, knowledge bounds; contradiction here is at most "soft_consistency" with secretRef "[CONSISTENCY]"):',
  secrets: 'Core secrets (each prefixed with its handle; for GATING only, never to be echoed):',
} as const
type SectionLabel = keyof typeof SECTION_HEADERS
const TAIL_MARKER = 'Return JSON:'

interface SplitTemplate {
  readonly head: string
  /** Full segment per label: header line + content + separator bytes. */
  readonly segments: Record<SectionLabel, string>
  /** Content per label: segment minus its header line, trimmed. */
  readonly contents: Record<SectionLabel, string>
  readonly order: readonly SectionLabel[]
  readonly tail: string
}

function indexOfExactlyOnce(text: string, needle: string): number {
  const first = text.indexOf(needle)
  if (first === -1) throw new Error(`section marker not found: ${JSON.stringify(needle)}`)
  if (text.includes(needle, first + needle.length)) {
    throw new Error(`section marker appears more than once: ${JSON.stringify(needle)}`)
  }
  return first
}

function splitTemplate(text: string): SplitTemplate {
  const labels = Object.keys(SECTION_HEADERS) as SectionLabel[]
  const positions = labels
    .map((label) => ({ label, at: indexOfExactlyOnce(text, SECTION_HEADERS[label]) }))
    .sort((a, b) => a.at - b.at)
  const tailAt = indexOfExactlyOnce(text, TAIL_MARKER)
  const firstAt = positions[0]?.at ?? 0
  if (tailAt < (positions[positions.length - 1]?.at ?? 0)) {
    throw new Error('output-format tail must follow every section')
  }
  const segments = {} as Record<SectionLabel, string>
  const contents = {} as Record<SectionLabel, string>
  positions.forEach(({ label, at }, i) => {
    const end = positions[i + 1]?.at ?? tailAt
    const segment = text.slice(at, end)
    segments[label] = segment
    contents[label] = segment.slice(SECTION_HEADERS[label].length).trim()
  })
  return {
    head: text.slice(0, firstAt),
    segments,
    contents,
    order: positions.map((p) => p.label),
    tail: text.slice(tailAt),
  }
}

/** Test-side `{{var}}` interpolation with the same semantics as prompts.ts
 *  (single pass, function replacement so `$`-patterns stay literal). */
function render(template: string, vars: Record<string, string>): string {
  return template.replace(/\{\{(\w+)\}\}/g, (match: string, key: string) => {
    if (!Object.prototype.hasOwnProperty.call(vars, key)) return match
    return vars[key] ?? match
  })
}

// ---------------------------------------------------------------------------
// The deterministic rule-following classifier. Reads a rendered prompt ONLY
// through its labeled sections and applies the template's own decision steps
// mechanically:
//   STEP 1 grounding — prose contained (case-insensitively) in the public
//     briefing or the resolved dice outcomes → none.
//   STEP 3 deducibility (checked before the consistency cap because a stated
//     secret dominates) — a [SECRET-n] block whose content appears verbatim
//     in the prose → hard_reveal citing that handle.
//   STEP 2 consistency — a distinctive word (≥7 chars) shared between prose
//     and the consistency notes → soft_consistency citing [CONSISTENCY].
//   Otherwise none.
// ---------------------------------------------------------------------------
interface Verdict {
  readonly severity: SecretTripwireSeverity
  readonly secretRef: string | null
}

function words(text: string): string[] {
  return text.toLowerCase().split(/[^a-z]+/).filter((w) => w.length > 0)
}

function classifyStructurally(rendered: string): Verdict {
  const { contents } = splitTemplate(rendered)
  const prose = contents.prose
  const loweredProse = prose.toLowerCase()
  if (
    contents.publicContext.toLowerCase().includes(loweredProse) ||
    contents.diceOutcomes.toLowerCase().includes(loweredProse)
  ) {
    return { severity: 'none', secretRef: null }
  }
  for (const line of contents.secrets.split('\n')) {
    const m = /^(\[SECRET-\d+\]): (.+)$/.exec(line.trim())
    if (m?.[1] !== undefined && m[2] !== undefined && prose.includes(m[2])) {
      return { severity: 'hard_reveal', secretRef: m[1] }
    }
  }
  const noteWords = new Set(words(contents.consistencyContext).filter((w) => w.length >= 7))
  if (words(prose).some((w) => w.length >= 7 && noteWords.has(w))) {
    return { severity: 'soft_consistency', secretRef: '[CONSISTENCY]' }
  }
  return { severity: 'none', secretRef: null }
}

// ---------------------------------------------------------------------------
// Constructed-state scenarios: one per-session-stable context (as production
// caching assumes), four per-turn volatile turns.
// ---------------------------------------------------------------------------
const STABLE = {
  secrets: '[SECRET-1]: Marlow the innkeeper is the exiled crown prince of Veldenmark.',
  publicContext:
    'The Rusty Anchor is a dockside inn near the east gate. The briefing notes: Marlow keeps his eyes fixed on the cellar door as he pours.',
  consistencyContext:
    'Encounter script: the caravan arrives on the third day, at noon, from the north road.',
  sessionId: 'sess-parity-1',
}

interface Scenario {
  readonly name: string
  readonly prose: string
  readonly diceOutcomes?: string
  readonly expected: Verdict
}

const SCENARIOS: readonly Scenario[] = [
  {
    // STEP 1 — briefing-grounded: the narrator wrote exactly what the public
    // briefing licensed, so even secret-adjacent behavior is "none".
    name: 'grounded → none',
    prose: 'Marlow keeps his eyes fixed on the cellar door as he pours.',
    expected: { severity: 'none', secretRef: null },
  },
  {
    // STEP 1 — dice-grounded: the roll's outcome constraint licensed the
    // discovery; a dice-earned grant is canon, not a breach.
    name: 'dice-grounded → none',
    prose: "Her search turns up a brass key gripped in the statue's hand.",
    diceOutcomes:
      "Investigation DC 13 (success): her search turns up a brass key gripped in the statue's hand.",
    expected: { severity: 'none', secretRef: null },
  },
  {
    // STEP 2 — the prose diverges from the encounter script (early caravan):
    // a consistency matter, capped at soft with the [CONSISTENCY] handle.
    name: 'consistency → soft',
    prose: 'The caravan rumbles through the gate at dusk, two days ahead of schedule.',
    expected: { severity: 'soft_consistency', secretRef: '[CONSISTENCY]' },
  },
  {
    // STEP 3 — seeded reveal: the prose states the core secret's content
    // verbatim; deducibility is total.
    name: 'seeded-reveal → hard',
    prose:
      'A drunk patron leans close and slurs: "Marlow the innkeeper is the exiled crown prince of Veldenmark." The room goes quiet.',
    expected: { severity: 'hard_reveal', secretRef: '[SECRET-1]' },
  },
]

function preReorderRendering(scenario: Scenario): string {
  return render(PRE_REORDER_TEMPLATE, {
    prose: scenario.prose,
    secrets: STABLE.secrets,
    publicContext: STABLE.publicContext,
    consistencyContext: STABLE.consistencyContext,
    // The wrapper's absent-field default — must match secret-tripwire.ts.
    diceOutcomes: scenario.diceOutcomes ?? '(none this turn)',
  })
}

beforeEach(() => {
  vi.clearAllMocks()
})

describe('secret-tripwire reorder — pure permutation', () => {
  const live = splitTemplate(readFileSync(LIVE_TEMPLATE_PATH, 'utf8'))
  const frozen = splitTemplate(PRE_REORDER_TEMPLATE)

  it('head, output tail, and every labeled section are byte-identical to the pre-reorder template', () => {
    expect(live.head).toBe(frozen.head)
    expect(live.tail).toBe(frozen.tail)
    for (const label of Object.keys(SECTION_HEADERS) as SectionLabel[]) {
      expect(live.segments[label]).toBe(frozen.segments[label])
    }
  })

  it('only the order changed: stable sections first, volatile prose + dice below', () => {
    expect(frozen.order).toEqual([
      'prose',
      'publicContext',
      'diceOutcomes',
      'consistencyContext',
      'secrets',
    ])
    expect(live.order).toEqual([
      'secrets',
      'publicContext',
      'consistencyContext',
      'prose',
      'diceOutcomes',
    ])
  })
})

describe('secret-tripwire reorder — verdict parity through the mocked pipeline', () => {
  it.each(SCENARIOS.map((s) => [s.name, s] as const))('%s', async (_name, scenario) => {
    // The SDK mock IS the rule-following classifier: it reads the prompt the
    // wrapper actually assembled (new ordering) and derives the verdict from
    // the labeled sections alone.
    let newOrderRendering = ''
    mockGenerateText.mockImplementation((args) => {
      const messages = (args as unknown as { messages: { content: string }[] }).messages
      newOrderRendering = messages.map((m) => m.content).join('')
      const verdict = classifyStructurally(newOrderRendering)
      return Promise.resolve({
        output: { ...verdict, confidence: 0.9 },
        usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
      } as never)
    })

    const result = await runSecretTripwire({
      prose: scenario.prose,
      secrets: STABLE.secrets,
      publicContext: STABLE.publicContext,
      consistencyContext: STABLE.consistencyContext,
      sessionId: STABLE.sessionId,
      ...(scenario.diceOutcomes !== undefined ? { diceOutcomes: scenario.diceOutcomes } : {}),
    })

    // The same classifier over the frozen pre-reorder rendering of the SAME
    // inputs — this is the before/after verdict diff.
    const oldVerdict = classifyStructurally(preReorderRendering(scenario))
    const newVerdict = { severity: result.result.severity, secretRef: result.result.secretRef }
    expect(newVerdict).toEqual(oldVerdict)
    expect(newVerdict).toEqual(scenario.expected)
    // Both renderings carried identical section content (order aside).
    expect(splitTemplate(newOrderRendering).contents).toEqual(
      splitTemplate(preReorderRendering(scenario)).contents,
    )
  })

  it('the stable block is byte-identical across all scenarios (the cache premise)', async () => {
    mockGenerateText.mockImplementation((args) => {
      const messages = (args as unknown as { messages: { content: string }[] }).messages
      const verdict = classifyStructurally(messages.map((m) => m.content).join(''))
      return Promise.resolve({
        output: { ...verdict, confidence: 0.9 },
        usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
      } as never)
    })

    for (const scenario of SCENARIOS) {
      await runSecretTripwire({
        prose: scenario.prose,
        secrets: STABLE.secrets,
        publicContext: STABLE.publicContext,
        consistencyContext: STABLE.consistencyContext,
        sessionId: STABLE.sessionId,
        ...(scenario.diceOutcomes !== undefined ? { diceOutcomes: scenario.diceOutcomes } : {}),
      })
    }

    const stableBlocks = SCENARIOS.map((_s, i) => {
      const args = mockGenerateText.mock.calls[i]?.[0] as unknown as {
        messages: { content: string }[]
      }
      return args.messages[0]?.content
    })
    expect(new Set(stableBlocks).size).toBe(1)
  })
})
