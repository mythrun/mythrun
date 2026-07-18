// backend/src/session/tiers/fast-thinker.ts
//
// MYT-68 Task 13 — the real FastThinker. The player-facing prose tier: it
// streams Sonnet narration, lets the model call the deterministic dice/skill
// tools, and emits player-visible frames in the EXACT order the model produced
// them. Operates under enforced ignorance by construction — `FtTurnContext`
// is public-by-type (no plot/secret field has anywhere to live).
//
// DESIGN RULES (load-bearing — these are the heart of the tier, spec §3.2 /
// §3.6 / §3.9 / §5):
//
//   1. THE CONSUME LOOP IS THE SINGLE EMISSION POINT (§3.2 step 5). We iterate
//      `fullStream` and emit in stream-part ORDER. Tools NEVER emit: the SDK
//      executes tools at internal pipeline pace, AHEAD of the consumer, so an
//      execute-side publish would race earlier prose deltas. Part-order
//      emission == model-output order, and it serializes parallel same-step
//      tool calls deterministically (the stream lists them in a fixed order).
//
//   2. `error` AND `abort` ARE IN-BAND fullStream parts — the for-await NEVER
//      throws on its own (verified against the ai@6 dist). The loop MUST throw
//      on both, or a truncated turn gets persisted as canon:
//        - `error` part → throw `part.error` (already Mythrun-mapped by the
//          ai.ts middleware).
//        - `abort` part → throw `LlmTimeoutError` (the per-turn budget fired).
//
//   3. CAP CLOSE (§3.6): we NEVER use `toolChoice: 'none'` — the Anthropic
//      provider strips the tools param for it, producing a 400 when the
//      history still holds tool blocks. Instead `prepareStep` on the FINAL
//      step (stepNumber === FT_MAX_TOOL_STEPS - 1) appends an instructed-close
//      user message (`FT_CLOSE_INSTRUCTION`); every other step returns
//      undefined (no override).
//
//   4. WE ASSEMBLE THE RETURNED `AssistantMessage` PARTS DIRECTLY from the
//      consumed stream parts — text deltas coalesce into text parts, split at
//      tool boundaries; tool-call / tool-result parts append at their
//      positions. No coupling to the SDK's `response.messages` shape. A
//      dangling tool_call with no result (a cap-defied edge) is FILTERED from
//      the returned parts and logged at warn.
//
//   5. CACHE BREAKPOINTS (§3.9): the per-MESSAGE `providerOptions.anthropic.
//      cacheControl` breakpoint goes on (a) the system message and (b) the
//      last SETTLED message (second-to-last in the history array — the current
//      batch is the last and stays uncached). Call-level providerOptions
//      carries ONLY the mythrun log bindings (cache_control is silently inert
//      at call level on this provider).
//
//   6. FRAME EMISSION FROM TOOL-RESULT PARTS: a roll_skill_check ok-output is
//      mapped from snake_case to the camelCase `SkillCheckFramePayload`; an
//      output with an `error` key emits NO frame (fail-soft — no roll
//      happened). roll_dice maps to a `DiceRollFramePayload`, falling back to
//      the tool-call input for count/sides when the output omits them. We
//      track pending tool-call inputs by toolCallId.

import {
  streamTextWithTools,
  stepCountIs,
  type LanguageModel,
  type ModelMessage,
  type ToolSet,
} from '../../llm/ai.js'
import { LlmTimeoutError } from '../../llm/errors.js'
import { loadPrompt } from '../../llm/prompts.js'
import { WorldDeltaSchema, type WorldDelta } from '../../llm/schemas/world-delta.js'
import { FT_MODEL, FT_MAX_TOOL_STEPS, FT_TURN_TIMEOUT_MS, FT_CLOSE_INSTRUCTION } from '../ft-config.js'
import type {
  FastThinker,
  FtTurnContext,
  TurnEmitter,
  AssistantMessage,
  ContentPart,
  ConversationMessage,
  SkillCheckFramePayload,
  DiceRollFramePayload,
  LedgerUpdatePayload,
  CombatStartedFramePayload,
  TokenUsage,
  PartyLedgerSnapshot,
} from './types.js'

/** Per-MESSAGE Anthropic cache breakpoint (§3.9). Attached to the system
 *  message and the last settled history message. */
const ANTHROPIC_CACHE_BREAKPOINT = {
  anthropic: { cacheControl: { type: 'ephemeral' } },
} as const

export interface SonnetFastThinkerDeps {
  /** The per-turn tool registry (`buildFtTools(...)`), constructed by the
   *  worker with that turn's scoped skill-check deps. */
  readonly tools: ToolSet
  readonly logger?: { warn: (o: Record<string, unknown>, m: string) => void }
  /** Test seam; defaults to FT_MODEL (Sonnet). */
  readonly model?: LanguageModel
  /** Test seam; defaults to FT_TURN_TIMEOUT_MS. */
  readonly timeoutMs?: number
}

// ── Message mapping ────────────────────────────────────────────────────────

/** Render one persisted ConversationMessage into one-or-two SDK ModelMessages.
 *  Assistant messages that carry tool_result parts split into an assistant
 *  message (text + tool-call blocks) followed by a tool message (tool-result
 *  blocks) per the SDK's role contract. */
function mapConversationMessage(msg: ConversationMessage): ModelMessage[] {
  if (msg.role === 'user') {
    const text = msg.parts
      .filter((p): p is Extract<ContentPart, { kind: 'text' }> => p.kind === 'text')
      .map((p) => p.text)
      .join('')
    return [{ role: 'user', content: `${msg.characterName ?? 'Player'}: ${text}` }]
  }

  // Assistant: split parts into assistant content (text + tool-call) and tool
  // content (tool-result).
  const assistantContent: AssistantContentBlock[] = []
  const toolContent: ToolResultBlock[] = []
  for (const part of msg.parts) {
    if (part.kind === 'text') {
      assistantContent.push({ type: 'text', text: part.text })
    } else if (part.kind === 'tool_call') {
      assistantContent.push({
        type: 'tool-call',
        toolCallId: part.toolCallId,
        toolName: part.toolName,
        input: part.input,
      })
    } else {
      toolContent.push({
        type: 'tool-result',
        toolCallId: part.toolCallId,
        toolName: part.toolName,
        // The SDK's ToolResultOutput union: a JSON tool output is
        // `{ type: 'json', value }`. `value` is typed `JSONValue`; our
        // persisted `output` is `unknown`, so narrow with a cast (the data
        // is always a JSON-serializable tool result by construction).
        output: { type: 'json', value: part.output as JsonValue },
      })
    }
  }

  const out: ModelMessage[] = [{ role: 'assistant', content: assistantContent }]
  if (toolContent.length > 0) {
    out.push({ role: 'tool', content: toolContent })
  }
  return out
}

/** Local mirrors of the SDK content-block shapes we emit. Kept narrow so the
 *  mapper stays self-documenting; the SDK's ModelMessage union accepts these. */
type JsonValue = string | number | boolean | null | JsonValue[] | { [k: string]: JsonValue }
type AssistantContentBlock =
  | { readonly type: 'text'; readonly text: string }
  | { readonly type: 'tool-call'; readonly toolCallId: string; readonly toolName: string; readonly input: unknown }
interface ToolResultBlock {
  readonly type: 'tool-result'
  readonly toolCallId: string
  readonly toolName: string
  readonly output: { readonly type: 'json'; readonly value: JsonValue }
}

// ── Party ledger snapshot render (§7) ────────────────────────────────────────

/** One character's block in the rendered ledger — derived from the snapshot
 *  element so the formatter tracks the repo shape without re-importing each
 *  sub-type. */
type PartyLedgerCharacter = PartyLedgerSnapshot[number]

/** The §7 slot ledger in `L1 2/4 · L2 0/2` style — only levels that exist for
 *  this character (cantrips have no slot row). */
function formatSlots(slots: PartyLedgerCharacter['slots']): string {
  if (slots.length === 0) return 'none'
  return slots
    .map((s) => `L${String(s.slotLevel)} ${String(s.slotsRemaining)}/${String(s.slotsMax)}`)
    .join(' · ')
}

/** Conditions with their numeric level where one applies (exhaustion). */
function formatConditions(conditions: PartyLedgerCharacter['conditions']): string {
  if (conditions.length === 0) return 'none'
  return conditions
    .map((c) => (c.level === null ? c.condition : `${c.condition} ${String(c.level)}`))
    .join(', ')
}

/** Tracked features as `Name uses/max (recharge)` — only resource-bearing
 *  features reach the snapshot (untracked ones are omitted upstream). */
function formatFeatures(features: PartyLedgerCharacter['trackedFeatures']): string {
  if (features.length === 0) return 'none'
  return features
    .map((f) => `${f.name} ${String(f.usesRemaining)}/${String(f.maxUses)} (${f.recharge})`)
    .join(', ')
}

/** Spells grouped by level, each tagged castable/ritual so the FT can map a
 *  paraphrase to the canonical name AND know whether a slot is needed (§7).
 *  Cantrips render as `L0`. `prepared` is the §3.2 currently-castable flag. */
function formatSpells(spells: PartyLedgerCharacter['spells']): string {
  if (spells.length === 0) return 'none'
  const byLevel = new Map<number, string[]>()
  for (const sp of spells) {
    const flags: string[] = []
    flags.push(sp.prepared ? 'castable' : 'not-prepared')
    if (sp.ritual) flags.push('ritual')
    const entry = `${sp.name} [${flags.join(', ')}]`
    const bucket = byLevel.get(sp.level)
    if (bucket) bucket.push(entry)
    else byLevel.set(sp.level, [entry])
  }
  return [...byLevel.entries()]
    .sort(([a], [b]) => a - b)
    .map(([lvl, entries]) => `L${String(lvl)}: ${entries.join(', ')}`)
    .join(' | ')
}

/** Full equipment list with quantities, consumables flagged (the §7
 *  showstopper-fix nouns — eliding them makes spend/use undrivable). */
function formatEquipment(equipment: PartyLedgerCharacter['equipment']): string {
  if (equipment.length === 0) return 'none'
  return equipment
    .map((e) => `${e.name} x${String(e.quantity)}${e.consumable ? ' (consumable)' : ''}`)
    .join(', ')
}

/** One character's compact-but-complete mechanical line. */
function formatCharacter(c: PartyLedgerCharacter): string {
  return [
    `${c.name} (L${String(c.level)}): HP ${String(c.hitPoints)}/${String(c.maxHitPoints)}`,
    `hit dice ${String(c.hitDiceRemaining)}d${String(c.hitDie)}`,
    `gold ${String(c.gold)}gp`,
    `slots ${formatSlots(c.slots)}`,
    `conditions ${formatConditions(c.conditions)}`,
    `features ${formatFeatures(c.trackedFeatures)}`,
    `spells ${formatSpells(c.spells)}`,
    `equipment ${formatEquipment(c.equipment)}`,
  ].join('; ')
}

/**
 * Format the §7 party ledger snapshot into the body of the render-time
 * `[Party ledger: …]` tail message (EXPORTED for tests; pure + deterministic).
 * Carries the NUMBERS AND the NOUNS per character — HP cur/max, hit dice, gold,
 * the slot ledger, active conditions, tracked features + uses, spells grouped
 * by level with castable/ritual flags, and the full equipment list with
 * consumable flags. The names are the showstopper fix: eliding them makes
 * `cast_spell`/spend undrivable from a paraphrase and silently defeats slot
 * enforcement. STALENESS (§7): this is turn-START state — post-mutation truth
 * within the turn comes from the tool-result payloads, not this block.
 */
export function formatPartyLedger(snapshot: PartyLedgerSnapshot): string {
  return snapshot.map(formatCharacter).join('\n')
}

/**
 * Build the SDK message array for a turn (EXPORTED for tests; deterministic —
 * the same ctx maps to byte-identical messages). Layout:
 *   [ system(ft_context + roster, cache breakpoint),
 *     ...history mapped to user/assistant/tool messages,
 *     (optional) [Party ledger: …] snapshot tail (§7),
 *     (optional) [DM direction: …] standing-directive tail (§6) ]
 * The cache breakpoint also rides the last SETTLED history message
 * (second-to-last entry; the current batch stays uncached). Both tails, when
 * live, are appended as raw user messages AFTER the breakpoint placement — they
 * ride the always-uncached zone past the last breakpoint, never perturbing the
 * cached prefix and never shifting the sliding-breakpoint index. They are
 * render-only: never persisted, never pushed into ftHistory. MERGE-ORDER PIN:
 * the party-ledger snapshot goes FIRST, the standing directive LAST (the
 * directive is the most recent DM instruction, closest to generation).
 */
export function buildModelMessages(ctx: FtTurnContext): ModelMessage[] {
  const system = loadPrompt('session', 'ft-system', {
    ft_context: ctx.ftContext,
    party_roster: ctx.participants.join(', '),
  })

  const historyMessages = ctx.ftHistory.flatMap(mapConversationMessage)

  // §3.9: cache breakpoint on the last settled message. The history's final
  // message is the current (unsettled) batch, so the breakpoint rides the
  // second-to-last ModelMessage. With only one history message there is no
  // settled prior turn, so nothing else is marked.
  if (historyMessages.length >= 2) {
    const idx = historyMessages.length - 2
    const target = historyMessages[idx]
    if (target !== undefined) {
      historyMessages[idx] = { ...target, providerOptions: ANTHROPIC_CACHE_BREAKPOINT }
    }
  }

  const messages: ModelMessage[] = [
    { role: 'system', content: system, providerOptions: ANTHROPIC_CACHE_BREAKPOINT },
    ...historyMessages,
  ]

  // §7 party ledger snapshot: a raw, uncached tail message AFTER the breakpoints
  // and BEFORE the standing-directive tail (MERGE-ORDER PIN — the standing
  // directive is the most recent "DM instruction" and stays closest to the
  // generation point). The block changes every turn, so it rides the
  // always-uncached zone past the last breakpoint — rendering it through the
  // cached system prefix would bust the static-payload cache (§7). NEVER
  // persisted, NEVER pushed into ftHistory; an empty snapshot (no joined
  // characters) renders no tail. Staleness rule: turn-START state — in-turn
  // post-mutation truth comes from the tool-result payloads.
  if (ctx.partyLedger !== undefined && ctx.partyLedger.length > 0) {
    messages.push({ role: 'user', content: `[Party ledger: ${formatPartyLedger(ctx.partyLedger)}]` })
  }

  // §6 standing directive: a raw, uncached tail message AFTER the breakpoints.
  // NEVER persisted, NEVER pushed into ftHistory (that would shift the
  // sliding-breakpoint index and render through the codec's attribution as a
  // phantom "Player"). The controller resolved it from the standing slot (read,
  // not consumed). The wrapper form mirrors the fused one-shot's `[DM direction:
  // …]` delimiter; the ft-system DM Direction Protocol amendment (T5) covers the
  // standalone form.
  if (ctx.standingDirective !== undefined && ctx.standingDirective !== '') {
    messages.push({ role: 'user', content: `[DM direction: ${ctx.standingDirective}]` })
  }

  return messages
}

// ── prepareStep (cap close, §3.6) ────────────────────────────────────────────

function makePrepareStep(): NonNullable<Parameters<typeof streamTextWithTools>[0]['prepareStep']> {
  return ({ stepNumber, messages }) => {
    // Only the FINAL step gets the instructed-close override. NEVER
    // toolChoice:'none' — the provider strips the tools param for it.
    if (stepNumber === FT_MAX_TOOL_STEPS - 1) {
      return {
        messages: [...messages, { role: 'user', content: FT_CLOSE_INSTRUCTION }],
      }
    }
    return undefined
  }
}

// ── Frame mapping from tool-result outputs ───────────────────────────────────

function toSkillCheckFrame(output: Record<string, unknown>): SkillCheckFramePayload {
  return {
    characterName: String(output.character_name),
    skill: String(output.skill),
    context: String(output.context),
    roll: Number(output.roll),
    roll2: output.roll2 === null || output.roll2 === undefined ? null : Number(output.roll2),
    rollType: output.roll_type as 'normal' | 'advantage' | 'disadvantage',
    modifier: Number(output.modifier),
    total: Number(output.total),
    dc: Number(output.dc),
    outcomeTier: output.outcome_tier as 'fail' | 'success' | 'great_success',
    constraint: String(output.constraint),
  }
}

function toDiceRollFrame(
  output: Record<string, unknown>,
  callInput: Record<string, unknown> | undefined,
): DiceRollFramePayload {
  const count = output.count ?? callInput?.count
  const sides = output.sides ?? callInput?.sides
  const results = Array.isArray(output.results) ? (output.results as number[]) : []
  return {
    count: Number(count),
    sides: Number(sides),
    results,
    total: Number(output.total),
  }
}

/** MYT-75 §combat — coerce an `initiate_combat` ok-output onto the
 *  `CombatStartedFramePayload`. The tool result is `unknown` in the consume loop
 *  (the SDK types it so); read `out.enemies` + `out.initiative` defensively the
 *  way `toSkillCheckFrame`/`toDiceRollFrame` read their fields, mapping each
 *  element through a record coercion. A non-array field degrades to `[]`. */
function toCombatStartedFrame(out: Record<string, unknown>): CombatStartedFramePayload {
  const enemies = Array.isArray(out.enemies)
    ? out.enemies.map((e) => {
        const r = asRecord(e)
        return { name: String(r.name), description: String(r.description), count: Number(r.count) }
      })
    : []
  const initiative = Array.isArray(out.initiative)
    ? out.initiative.map((i) => {
        const r = asRecord(i)
        return { combatant: String(r.combatant), roll: Number(r.roll) }
      })
    : []
  return { enemies, initiative }
}

/** The three MYT-72 world-knowledge lookup tools (§4.2). Their `execute`
 *  returns a data-only result `{ result, skill_gate, roll_hidden }`: `skill_gate`
 *  is either `null` (auto-success — no check fired) or an ALREADY-BUILT
 *  camelCase `SkillCheckFramePayload` (the gate's `frame`, passed straight
 *  through). `roll_hidden` flags the NPC variant the publisher renders as a
 *  hidden pass so a hidden NPC's standing never leaks. */
const LOOKUP_TOOL_NAMES: ReadonlySet<string> = new Set(['search_lore', 'characters_known_to', 'faction_tree'])

/** Coerce a lookup tool's `skill_gate` onto a `SkillCheckFramePayload`. UNLIKE
 *  `toSkillCheckFrame`, the gate is ALREADY a camelCase `SkillCheckFramePayload`
 *  (the gate's `frame`, passed through the tool result) — NOT the snake_case
 *  roll_skill_check OUTPUT shape. Read the camelCase keys directly; running the
 *  gate through `toSkillCheckFrame` would yield `"undefined"` for every field.
 *  `rollHidden` is conditional-spread (`exactOptionalPropertyTypes`): the DM
 *  path leaves it absent, the NPC path sets it true. */
function toLookupCheckFrame(gate: Record<string, unknown>, rollHidden: boolean): SkillCheckFramePayload {
  return {
    characterName: String(gate.characterName),
    skill: String(gate.skill),
    context: String(gate.context),
    roll: Number(gate.roll),
    roll2: gate.roll2 === null || gate.roll2 === undefined ? null : Number(gate.roll2),
    rollType: gate.rollType as 'normal' | 'advantage' | 'disadvantage',
    modifier: Number(gate.modifier),
    total: Number(gate.total),
    dc: Number(gate.dc),
    outcomeTier: gate.outcomeTier as 'fail' | 'success' | 'great_success',
    constraint: String(gate.constraint),
    ...(rollHidden ? { rollHidden: true } : {}),
  }
}

/** The six MYT-70 Rules Lawyer ledger tools (§5). Their `execute` returns a
 *  resolver result AS DATA — `{ ok: true, payload }` (a `LedgerUpdatePayload`,
 *  or an ARRAY of them for `take_rest`, or a `ConditionPayload` carrying
 *  `changed` for `update_condition`) or an `ok:false` rejection. The §8 emit
 *  rules live in `emitLedgerUpdates`. */
const LEDGER_TOOL_NAMES: ReadonlySet<string> = new Set([
  'cast_spell',
  'spend_resource',
  'acquire_resource',
  'adjust_hp',
  'update_condition',
  'take_rest',
])

/** Map a resolver payload record onto the §8 `LedgerUpdatePayload` the emit
 *  seam carries. The payload comes straight from the (typed) resolver, but the
 *  consume loop sees it as `unknown` — coerce the required fields the way
 *  `toSkillCheckFrame` does, and conditional-spread the optional value fields
 *  for `exactOptionalPropertyTypes`. The `changed` flag a `ConditionPayload`
 *  carries is NOT a frame field — it is consumed in `emitLedgerUpdates` and
 *  dropped here. */
function toLedgerUpdatePayload(p: Record<string, unknown>): LedgerUpdatePayload {
  return {
    characterName: String(p.characterName),
    kind: p.kind as LedgerUpdatePayload['kind'],
    summary: String(p.summary),
    ...(typeof p.hp === 'number' ? { hp: p.hp } : {}),
    ...(typeof p.maxHp === 'number' ? { maxHp: p.maxHp } : {}),
    ...(typeof p.gold === 'number' ? { gold: p.gold } : {}),
    ...(typeof p.slotLevel === 'number' ? { slotLevel: p.slotLevel } : {}),
    ...(typeof p.slotsRemaining === 'number' ? { slotsRemaining: p.slotsRemaining } : {}),
    ...(typeof p.itemName === 'string' ? { itemName: p.itemName } : {}),
    ...(typeof p.quantity === 'number' ? { quantity: p.quantity } : {}),
    ...(typeof p.featureName === 'string' ? { featureName: p.featureName } : {}),
    ...(typeof p.usesRemaining === 'number' ? { usesRemaining: p.usesRemaining } : {}),
    ...(typeof p.condition === 'string' ? { condition: p.condition } : {}),
    ...(Array.isArray(p.diceRolled) && p.diceRolled.every((d): d is number => typeof d === 'number')
      ? { diceRolled: p.diceRolled }
      : {}),
  }
}

/**
 * §8 ledger emission. The resolver result rides the tool output as
 * `{ ok, payload }`. On `ok:false` (a binding/structural rejection) NOTHING is
 * emitted — the model narrates the shortfall from the constraint, no frame.
 * On `ok:true`:
 *   - `take_rest` carries an ARRAY payload → emit ONE frame per character (§8:
 *     players watch their own row); an empty array emits nothing.
 *   - `update_condition` carries `changed` → an idempotent no-op (`changed:false`)
 *     emits nothing; a real change emits one frame.
 *   - every other ledger tool carries a single payload → emit one frame.
 */
async function emitLedgerUpdates(out: Record<string, unknown>, emit: TurnEmitter): Promise<void> {
  if (out.ok !== true) return
  const payload = out.payload
  if (Array.isArray(payload)) {
    for (const entry of payload) {
      await emit.emitLedgerUpdate(toLedgerUpdatePayload(asRecord(entry)))
    }
    return
  }
  const rec = asRecord(payload)
  // §8 idempotent no-op: a condition update that changed nothing emits no frame.
  if (rec.changed === false) return
  await emit.emitLedgerUpdate(toLedgerUpdatePayload(rec))
}

// ── §4.2 WORLD_DELTA delimiter-guard ─────────────────────────────────────────

/** The newline-anchored target literal. The leading `\n` is PART of the match,
 *  so a mid-sentence `[` (not preceded by a newline) can never arm the guard. */
const WORLD_DELTA_DELIMITER = '\n[[WORLD_DELTA]]'

/** KMP failure function for an arbitrary literal — `fail[i]` is the length of
 *  the longest proper prefix of `literal[0..i]` that is also a suffix of it.
 *  The guard uses it to RE-ANCHOR on a diverging char without re-feeding any
 *  character: when an extension fails at match length `m`, we fall back to
 *  `fail[m-1]` and retry, so a `[` inside a partial `\n[[` still counts as a
 *  fresh match start. EXPORTED for tests — the general border-walk is exercised
 *  with a repeated-prefix literal there (the fixed delimiter's table is all
 *  zeros, so its construction alone never enters the inner loop). */
export function buildKmpFailure(literal: string): readonly number[] {
  const fail: number[] = new Array<number>(literal.length).fill(0)
  let len = 0
  for (let i = 1; i < literal.length; i++) {
    while (len > 0 && literal[i] !== literal[len]) {
      // `fail[len-1]` is always in-bounds (`len < i < length`); the `?? 0` is
      // `noUncheckedIndexedAccess` ceremony that is never taken at runtime.
      /* v8 ignore next */
      len = fail[len - 1] ?? 0
    }
    if (literal[i] === literal[len]) len++
    fail[i] = len
  }
  return fail
}

const WORLD_DELTA_FAILURE = buildKmpFailure(WORLD_DELTA_DELIMITER)

/**
 * §4.2 — a stateful char-by-char filter on the FT's text-delta substream. It
 * sits between the stream and BOTH downstream sinks (the assembler's
 * `pushTextDelta` AND `emit.emitText`): only the PRE-delimiter prose reaches
 * either sink; everything from the literal onward is suppressed and the
 * trailing JSON is captured into `deltaAccumulator` for parsing at finalize.
 *
 * STATE (persists across deltas AND across step/tool boundaries within one
 * render):
 *   - `matchLen`: how many chars of the literal the current hold buffer matches.
 *     The hold buffer is therefore `WORLD_DELTA_DELIMITER.slice(0, matchLen)` —
 *     we never store it separately. While `matchLen > 0` those chars are held
 *     back (NOT yet flushed) because they might complete the literal.
 *   - `captured`: once the full literal matched, every subsequent char is routed
 *     to `deltaAccumulator` and NOTHING reaches the sinks.
 *
 * The sink is a single callback fed pre-delimiter prose; the caller wires it to
 * push to BOTH the assembler and the live emit so the guard can't be defeated
 * by guarding only one side (the load-bearing requirement).
 */
class WorldDeltaGuard {
  private matchLen = 0
  private captured = false
  private accumulator = ''
  /** Committed prose that immediately PRECEDES an in-progress partial match and
   *  is therefore withheld so it coalesces with the partial when it resolves
   *  (diverge / complete / tool-boundary / stream-end). Empty whenever
   *  `matchLen === 0`. */
  private heldProse = ''

  /** Feed one text-delta chunk. `sink` receives ONLY the pre-delimiter prose
   *  that survives the filter — coalesced (we never split a clean delta into
   *  per-char emissions, and a held prefix flushes WITH the prose it precedes).
   *  Async because the live emit is async; we await each flush so emission stays
   *  ordered. */
  async feed(text: string, sink: (out: string) => Promise<void>): Promise<void> {
    if (this.captured) {
      this.accumulator += text
      return
    }
    // Surviving prose carried so far this feed (prepended by any heldProse from
    // a prior feed that ended mid-match). Flushed as ONE chunk unless a partial
    // match is still pending at feed end, in which case it becomes heldProse.
    let survived = this.heldProse
    this.heldProse = ''
    // `for...of` over the string yields each char by VALUE (no indexed access);
    // `consumed` tracks the UTF-16 length walked so the capture-completion arm
    // can slice the remaining delta body. The literal is pure ASCII, so a
    // surrogate-pair char can never match it — it always falls to plain prose.
    let consumed = 0
    for (const ch of text) {
      consumed += ch.length
      // Try to extend the current match; on mismatch, KMP-fall-back through
      // shorter borders. Prefix chars that fall OUT of every candidate match
      // are committed prose (they can no longer begin the literal).
      while (this.matchLen > 0 && ch !== WORLD_DELTA_DELIMITER[this.matchLen]) {
        // `matchLen-1` is always in-bounds; the `?? 0` is `noUncheckedIndexedAccess`
        // ceremony that is never taken at runtime.
        /* v8 ignore next */
        const fallback = WORLD_DELTA_FAILURE[this.matchLen - 1] ?? 0
        survived += WORLD_DELTA_DELIMITER.slice(0, this.matchLen - fallback)
        this.matchLen = fallback
      }
      if (ch === WORLD_DELTA_DELIMITER[this.matchLen]) {
        this.matchLen++
        if (this.matchLen === WORLD_DELTA_DELIMITER.length) {
          // Full literal matched: from here on, capture (NOTHING reaches sinks).
          this.captured = true
          this.matchLen = 0
          this.accumulator += text.slice(consumed)
          if (survived !== '') await sink(survived)
          return
        }
        continue
      }
      // `ch` matches no prefix position (matchLen is 0 here) → plain prose.
      survived += ch
    }
    // A partial match is still pending → withhold the surviving prose so it
    // coalesces with the partial (or with the next feed's prose) when resolved.
    if (this.matchLen > 0) {
      this.heldProse = survived
      return
    }
    if (survived !== '') await sink(survived)
  }

  /** A tool-call / tool-result / step boundary arrived. A delimiter can't
   *  straddle a tool call, so any held partial (plus the prose it withheld) is
   *  committed prose — flush it together. No-op once captured (the delta body
   *  never resumes through a tool). */
  async flushPending(sink: (out: string) => Promise<void>): Promise<void> {
    if (this.captured) return
    if (this.matchLen === 0 && this.heldProse === '') return
    const out = this.heldProse + WORLD_DELTA_DELIMITER.slice(0, this.matchLen)
    this.matchLen = 0
    this.heldProse = ''
    if (out !== '') await sink(out)
  }

  /** Stream end: a partial literal that never completed (plus its withheld
   *  prose) is committed prose. */
  async finishStream(sink: (out: string) => Promise<void>): Promise<void> {
    await this.flushPending(sink)
  }

  /** Parse the captured delta body (if any). Empty/whitespace-only → no delta,
   *  no warn (the FT armed the section but produced no body). `JSON.parse` +
   *  `WorldDeltaSchema.safeParse`; either failure → undefined + a warn (fail-
   *  soft — the prose already shipped). */
  parse(logger?: { warn: (o: Record<string, unknown>, m: string) => void }): WorldDelta | undefined {
    const body = this.accumulator.trim()
    if (body === '') return undefined
    let json: unknown
    try {
      json = JSON.parse(body)
    } catch (err) {
      logger?.warn({ err: String(err) }, 'ft: WORLD_DELTA section is not valid JSON; dropping delta')
      return undefined
    }
    const result = WorldDeltaSchema.safeParse(json)
    if (!result.success) {
      logger?.warn({ issues: result.error.issues }, 'ft: WORLD_DELTA section failed schema; dropping delta')
      return undefined
    }
    return result.data
  }
}

// ── Stream-part assembly helpers ─────────────────────────────────────────────

/** Mutable accumulator for the returned AssistantMessage parts. Text deltas
 *  coalesce into the trailing text part; a tool boundary closes the current
 *  text run. */
class PartsAssembler {
  private readonly parts: ContentPart[] = []
  private textBuffer = ''

  pushTextDelta(text: string): void {
    this.textBuffer += text
  }

  private flushText(): void {
    if (this.textBuffer.length > 0) {
      this.parts.push({ kind: 'text', text: this.textBuffer })
      this.textBuffer = ''
    }
  }

  pushToolCall(toolCallId: string, toolName: string, input: unknown): void {
    this.flushText()
    this.parts.push({ kind: 'tool_call', toolCallId, toolName, input })
  }

  pushToolResult(toolCallId: string, toolName: string, output: unknown): void {
    this.flushText()
    this.parts.push({ kind: 'tool_result', toolCallId, toolName, output })
  }

  /** Finalize: flush any trailing text, then drop dangling tool_calls (a
   *  tool_call with no matching tool_result — the cap-defied edge), logging
   *  each at warn. */
  finalize(logger?: { warn: (o: Record<string, unknown>, m: string) => void }): ContentPart[] {
    this.flushText()
    const resolvedCallIds = new Set(
      this.parts
        .filter((p): p is Extract<ContentPart, { kind: 'tool_result' }> => p.kind === 'tool_result')
        .map((p) => p.toolCallId),
    )
    const kept: ContentPart[] = []
    for (const part of this.parts) {
      if (part.kind === 'tool_call' && !resolvedCallIds.has(part.toolCallId)) {
        logger?.warn(
          { toolCallId: part.toolCallId, toolName: part.toolName },
          'ft: dropping dangling tool_call with no result',
        )
        continue
      }
      kept.push(part)
    }
    return kept
  }
}

// ── The tier ─────────────────────────────────────────────────────────────────

/** myth-ph544 — strip a leading "<PC name>:" from the FT's first text part.
 *  The FT's output is DM narration; a line that opens with a player character's
 *  name + colon is the players' INPUT format leaking into the DM prose (the
 *  seq-30 signature). We normalize it out of the DURABLE message before persist
 *  + Scribe so it never re-enters the FT's own context next turn — breaking the
 *  contamination cycle. Only the very START of the first text part is touched;
 *  a PC name appearing mid-prose is untouched, and DM prose never legitimately
 *  opens with "Name:". */
export function stripLeadingPcPrefix(text: string, participants: readonly string[]): string {
  const lead = /^\s*/.exec(text)?.[0] ?? ''
  const rest = text.slice(lead.length)
  for (const name of participants) {
    if (name === '') continue
    const prefix = `${name}:`
    if (rest.slice(0, prefix.length).toLowerCase() === prefix.toLowerCase()) {
      return rest.slice(prefix.length).replace(/^[ \t]+/, '')
    }
  }
  return text
}

/** Apply `stripLeadingPcPrefix` to the FIRST text part of an assembled turn. A
 *  part left empty after stripping is dropped. */
export function stripPcPrefixFromParts(
  parts: readonly ContentPart[],
  participants: readonly string[],
): ContentPart[] {
  const idx = parts.findIndex((p) => p.kind === 'text')
  const target = idx === -1 ? undefined : parts[idx]
  if (target?.kind !== 'text') return [...parts]
  const stripped = stripLeadingPcPrefix(target.text, participants)
  if (stripped === target.text) return [...parts]
  const out = [...parts]
  if (stripped.trim() === '') out.splice(idx, 1)
  else out[idx] = { kind: 'text', text: stripped }
  return out
}

export class SonnetFastThinker implements FastThinker {
  private readonly tools: ToolSet
  private readonly logger: { warn: (o: Record<string, unknown>, m: string) => void } | undefined
  private readonly model: LanguageModel
  private readonly timeoutMs: number

  constructor(deps: SonnetFastThinkerDeps) {
    this.tools = deps.tools
    this.logger = deps.logger
    this.model = deps.model ?? FT_MODEL
    this.timeoutMs = deps.timeoutMs ?? FT_TURN_TIMEOUT_MS
  }

  async render(ctx: FtTurnContext, emit: TurnEmitter): Promise<AssistantMessage> {
    const messages = buildModelMessages(ctx)
    const stream = streamTextWithTools({
      model: this.model,
      messages,
      tools: this.tools,
      stopWhen: stepCountIs(FT_MAX_TOOL_STEPS),
      prepareStep: makePrepareStep(),
      callSite: 'ft-turn',
      timeoutMs: this.timeoutMs,
      providerOptions: { mythrun: { campaignId: ctx.campaignId } },
    })

    const assembler = new PartsAssembler()
    // §4.2 delimiter-guard: a single stateful filter on the text-delta substream
    // feeding BOTH sinks. Pre-delimiter prose flows to the assembler (→ persisted
    // dm_text + re-injected FT history) AND the live emit; the `\n[[WORLD_DELTA]]`
    // section + its JSON body are suppressed from BOTH and captured for parse.
    const deltaGuard = new WorldDeltaGuard()
    const sink = async (out: string): Promise<void> => {
      assembler.pushTextDelta(out)
      await emit.emitText(out)
    }
    // Track each pending tool-call's input by id so a roll_dice result can
    // fall back to it for count/sides.
    const pendingInputs = new Map<string, Record<string, unknown>>()

    for await (const part of stream.fullStream) {
      // `error` / `abort` are IN-BAND — the for-await never throws on its own.
      // Throwing here prevents a truncated turn from being persisted as canon.
      if (part.type === 'error') {
        throw part.error instanceof Error ? part.error : new Error(String(part.error))
      }
      if (part.type === 'abort') {
        throw new LlmTimeoutError('ft turn aborted (per-turn budget exceeded)')
      }

      if (part.type === 'text-delta') {
        // Route through the guard, NOT directly to the sinks — it strips the
        // newline-anchored delta section before either the player or the
        // transcript sees it. Guard state persists across deltas + steps.
        await deltaGuard.feed(part.text, sink)
        continue
      }

      if (part.type === 'tool-call') {
        // A delimiter can't straddle a tool call — flush any held partial as
        // prose before the tool boundary closes the text run.
        await deltaGuard.flushPending(sink)
        const input = asRecord(part.input)
        pendingInputs.set(part.toolCallId, input)
        assembler.pushToolCall(part.toolCallId, part.toolName, part.input)
        continue
      }

      if (part.type === 'tool-result') {
        await deltaGuard.flushPending(sink)
        assembler.pushToolResult(part.toolCallId, part.toolName, part.output)
        await this.emitFrameForResult(part.toolName, part.output, pendingInputs.get(part.toolCallId), emit)
        continue
      }
      // All other part types (text-start/end, step boundaries, finish, raw,
      // reasoning, tool-input-*) carry no player-visible payload — ignore.
    }

    // Stream end: a partial literal that never completed is committed prose.
    await deltaGuard.finishStream(sink)

    const totalUsage = await stream.totalUsage
    const usage = mapUsage(totalUsage)
    // myth-ph544: normalize a leaked "<PC name>:" prefix out of the durable turn
    // so the players' input format never enters the persisted transcript / the
    // FT's own context next turn.
    const parts = stripPcPrefixFromParts(assembler.finalize(this.logger), ctx.participants)
    const worldDelta = deltaGuard.parse(this.logger)
    return worldDelta === undefined
      ? { role: 'assistant', parts, usage }
      : { role: 'assistant', parts, usage, worldDelta }
  }

  private async emitFrameForResult(
    toolName: string,
    output: unknown,
    callInput: Record<string, unknown> | undefined,
    emit: TurnEmitter,
  ): Promise<void> {
    const out = asRecord(output)
    // Fail-soft: an `error` key means no roll happened — emit no frame.
    if ('error' in out) return

    if (toolName === 'roll_skill_check') {
      await emit.emitSkillCheck(toSkillCheckFrame(out))
      return
    }
    if (toolName === 'roll_dice') {
      await emit.emitDiceRoll(toDiceRollFrame(out, callInput))
      return
    }
    // MYT-75 §combat L1 — initiate_combat: flip the session into combat mode,
    // then announce the rolled roster + initiative. The `'error' in out`
    // short-circuit above already handled the no-fight error arm. resolve_combat
    // emits NO consume-loop frame — the worker emits combat_resolved post-ledger
    // (T7), after the reconciled deltas have been applied + persisted.
    if (toolName === 'initiate_combat') {
      await emit.emitModeChange({ from: 'exploration', to: 'combat', reason: 'combat' })
      await emit.emitCombatStarted(toCombatStartedFrame(out))
      return
    }
    // §4.2 world-lookup tools: the data-only result carries `skill_gate` (an
    // already-built camelCase SkillCheckFramePayload, or null on auto-success)
    // and `roll_hidden`. A null/absent gate means no check fired → emit nothing.
    // The NPC roll-hidden variant sets rollHidden:true so the publisher renders
    // it identically to a hidden pass (no metagame tell about the NPC's standing).
    if (LOOKUP_TOOL_NAMES.has(toolName)) {
      const gate = out.skill_gate
      if (gate === null || gate === undefined) return
      await emit.emitSkillCheck(toLookupCheckFrame(asRecord(gate), out.roll_hidden === true))
      return
    }
    // §8 ledger tools: the resolver result rides the output as `{ ok, payload }`.
    // emitLedgerUpdates applies the §8 rules (ok:false / no-op → no frame;
    // take_rest → one frame per character).
    if (LEDGER_TOOL_NAMES.has(toolName)) {
      await emitLedgerUpdates(out, emit)
    }
  }
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {}
}

function mapUsage(totalUsage: { inputTokens?: number | undefined; outputTokens?: number | undefined }): TokenUsage {
  return { input: totalUsage.inputTokens ?? 0, output: totalUsage.outputTokens ?? 0 }
}
