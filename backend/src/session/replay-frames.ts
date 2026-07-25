// backend/src/session/replay-frames.ts
//
// The persisted-row → replay-ServerFrame mapping (moved VERBATIM from
// routes/ws-session.ts for myth-aiiao). Two consumers share it: the ws-session
// reconnect replay (buildReconnectFrame) and the turn worker's corrected-turn
// whole-turn-replace push (a live `session_reconnect` frame carrying ONE turn's
// rebuilt rows, published when the audit gate's silent retry made the durable
// turn diverge from what streamed). One mapping, one failure posture: a
// malformed row DROPS its frame(s) + warns — a player-facing replay degrades
// gracefully rather than breaking the whole batch. (Contrast the FT-context
// codec in transcript-codec.ts, which is crash-loud over the SAME row JSON —
// deliberately opposite postures for opposite audiences.)

import type { SessionMessage } from '../repo/types.js'
import type { ActiveCondition, ServerFrame } from '../contract/session-events.js'
import type { LedgerUpdatePayload } from './tiers/types.js'
import { DEPARTED_AUTHOR_NAME } from './attribution.js'

/** The minimal logger the mapping warns through. FastifyBaseLogger and the
 *  worker's pino-compatible MinimalLogger both satisfy it structurally. */
export interface ReplayFrameLogger {
  warn(obj: Record<string, unknown>, msg?: string): void
}

/** Map one persisted `session_messages` row to its reconnect-replay
 *  ServerFrame(s). Returns an ARRAY — `[]` to DROP the row (graceful
 *  degradation), one frame for the common case, and >1 for a `take_rest` row
 *  (one `ledger_update` frame per affected character; §8).
 *
 *   - `player_message` → a `player_message` frame, byline resolved through the
 *     two campaign-wide name maps (a departed author → the placeholder).
 *   - `dm_text` → a `dm_message` frame (the consolidated DM prose row).
 *   - `skill_check` / `dice_roll` → reconstructed from the row's JSON content
 *     `{toolCallId, input, output}`. On a parse failure or a missing/ill-typed
 *     field the row is DROPPED + logged — a player-facing replay drops one
 *     corrupt frame rather than breaking the whole reconnect.
 *   - the six MYT-70 ledger tools (`cast_spell` / `spend_resource` /
 *     `acquire_resource` / `adjust_hp` / `update_condition` / `take_rest`) →
 *     `ledger_update` frame(s) from the row's persisted `LedgerResolution`
 *     output. An `ok:false` rejection is SILENTLY skipped (expected, not
 *     corrupt → NO warn); a `changed:false` condition no-op emits no frame;
 *     `take_rest` emits one frame per per-character payload entry. A malformed
 *     blob still drops + warns (the existing posture).
 *   - any other messageType → dropped.
 */
export function rowToReplayFrame(
  row: SessionMessage,
  displayByUser: ReadonlyMap<string, string>,
  characterByUser: ReadonlyMap<string, string>,
  log: ReplayFrameLogger,
): ServerFrame[] {
  switch (row.messageType) {
    case 'player_message': {
      // userId is nullable on session_messages (system/DM rows carry null), but
      // a player_message row always carries its authoring user. A null author
      // (data anomaly) resolves to the same placeholder.
      const authorId = row.userId
      return [
        {
          type: 'player_message',
          seq: row.seq,
          userId: authorId ?? '',
          displayName: (authorId ? displayByUser.get(authorId) : undefined) ?? DEPARTED_AUTHOR_NAME,
          characterName: (authorId ? characterByUser.get(authorId) : undefined) ?? '',
          text: row.content,
        },
      ]
    }
    case 'dm_text':
      return [{ type: 'dm_message', seq: row.seq, turnId: row.turnId ?? '', text: row.content }]
    case 'skill_check': {
      const frame = parseSkillCheckRow(row, log)
      return frame === null ? [] : [frame]
    }
    case 'dice_roll': {
      const frame = parseDiceRollRow(row, log)
      return frame === null ? [] : [frame]
    }
    case 'cast_spell':
    case 'spend_resource':
    case 'acquire_resource':
    case 'adjust_hp':
    case 'update_condition':
    case 'take_rest':
      return parseLedgerUpdateRow(row, log)
    case 'dm_correction': {
      // myth-d6knq — a persisted issue_correction row (tool-JSON content). Replay
      // it as a dm_correction frame carrying the row's seq, so a reconnecting
      // client (and the retry-corrected turn, which relies on the reconnect
      // whole-turn-replace) sees the correction. Drop-graceful like its siblings.
      const frame = parseDmCorrectionRow(row, log)
      return frame === null ? [] : [frame]
    }
    default:
      return []
  }
}

/** The persisted DM-row content shape: `{toolCallId, input, output}` where
 *  `output` is the snake_case tool output. We read it through narrow accessors
 *  rather than a Zod schema — this is a transport-replay reconstruction, and a
 *  malformed blob DROPS the frame (it does not fail loud like the FT context).
 *  See session/transcript-codec.ts for the canonical row codec over the SAME
 *  shape — deliberately the opposite failure posture (crash-loud for the FT
 *  history rebuild vs drop-graceful here for player-facing replay). */
function parseDmRowContent(content: string): { input: unknown; output: unknown } | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(content)
  } catch {
    return null
  }
  if (typeof parsed !== 'object' || parsed === null) return null
  const obj = parsed as { input?: unknown; output?: unknown }
  return { input: obj.input, output: obj.output }
}

function asRecord(v: unknown): Record<string, unknown> | null {
  return typeof v === 'object' && v !== null ? (v as Record<string, unknown>) : null
}

/** myth-d6knq — reconstruct a `dm_correction` frame from a persisted
 *  issue_correction row. The tool output carries `{ text }`; we read it the same
 *  drop-graceful way as the other replay rows (a corrupt/missing text drops the
 *  frame rather than failing loud). The live-published frame carries no seq; the
 *  replay frame carries the row's seq (matching the skill_check/ledger pattern). */
function parseDmCorrectionRow(
  row: SessionMessage,
  log: ReplayFrameLogger,
): Extract<ServerFrame, { type: 'dm_correction' }> | null {
  const parsed = parseDmRowContent(row.content)
  const output = parsed ? asRecord(parsed.output) : null
  if (output === null || typeof output.text !== 'string') {
    log.warn({ seq: row.seq, turnId: row.turnId }, 'replay dropped corrupt dm_correction row')
    return null
  }
  return { type: 'dm_correction', turnId: row.turnId ?? '', seq: row.seq, text: output.text }
}

/** Reconstruct a `skill_check` frame from a persisted row's JSON content. The
 *  output is the snake_case skill-check tool output; we map each field to the
 *  frame's camelCase + validate the discriminated-union members
 *  (rollType / outcomeTier). Any missing or ill-typed field → null (drop). */
function parseSkillCheckRow(
  row: SessionMessage,
  log: ReplayFrameLogger,
): Extract<ServerFrame, { type: 'skill_check' }> | null {
  const parsed = parseDmRowContent(row.content)
  const output = parsed ? asRecord(parsed.output) : null
  if (output === null) {
    log.warn({ seq: row.seq, turnId: row.turnId }, 'replay dropped corrupt skill_check row')
    return null
  }
  const rollType = output.roll_type
  const outcomeTier = output.outcome_tier
  if (
    typeof output.character_name !== 'string' ||
    typeof output.skill !== 'string' ||
    typeof output.context !== 'string' ||
    typeof output.roll !== 'number' ||
    !(typeof output.roll2 === 'number' || output.roll2 === null) ||
    (rollType !== 'normal' && rollType !== 'advantage' && rollType !== 'disadvantage') ||
    typeof output.modifier !== 'number' ||
    typeof output.total !== 'number' ||
    typeof output.dc !== 'number' ||
    (outcomeTier !== 'fail' && outcomeTier !== 'success' && outcomeTier !== 'great_success') ||
    typeof output.constraint !== 'string'
  ) {
    log.warn({ seq: row.seq, turnId: row.turnId }, 'replay dropped corrupt skill_check row')
    return null
  }
  return {
    type: 'skill_check',
    turnId: row.turnId ?? '',
    seq: row.seq,
    characterName: output.character_name,
    skill: output.skill,
    context: output.context,
    roll: output.roll,
    roll2: output.roll2,
    rollType,
    modifier: output.modifier,
    total: output.total,
    dc: output.dc,
    outcomeTier,
    constraint: output.constraint,
  }
}

/** Reconstruct a `dice_roll` frame from a persisted row's JSON content. count
 *  and sides fall back to the `input` block when absent on `output` (the dice
 *  tool echoes the request in input). results/total come from output. Any
 *  missing or ill-typed field → null (drop). */
function parseDiceRollRow(
  row: SessionMessage,
  log: ReplayFrameLogger,
): Extract<ServerFrame, { type: 'dice_roll' }> | null {
  const parsed = parseDmRowContent(row.content)
  const output = parsed ? asRecord(parsed.output) : null
  const input = parsed ? asRecord(parsed.input) : null
  if (output === null) {
    log.warn({ seq: row.seq, turnId: row.turnId }, 'replay dropped corrupt dice_roll row')
    return null
  }
  const count = typeof output.count === 'number' ? output.count : input?.count
  const sides = typeof output.sides === 'number' ? output.sides : input?.sides
  const results = output.results
  if (
    typeof count !== 'number' ||
    typeof sides !== 'number' ||
    !Array.isArray(results) ||
    !results.every((r): r is number => typeof r === 'number') ||
    typeof output.total !== 'number'
  ) {
    log.warn({ seq: row.seq, turnId: row.turnId }, 'replay dropped corrupt dice_roll row')
    return null
  }
  return {
    type: 'dice_roll',
    turnId: row.turnId ?? '',
    seq: row.seq,
    count,
    sides,
    results,
    total: output.total,
  }
}

/** The valid `kind` discriminator values a persisted `LedgerUpdatePayload`
 *  carries — mirrors the §8 `ledger_update` frame union one-for-one. */
const LEDGER_KINDS: ReadonlySet<string> = new Set([
  'hp',
  'gold',
  'item',
  'feature',
  'spell_slot',
  'condition',
  'rest',
])

/**
 * Reconstruct `ledger_update` frame(s) from a persisted ledger-tool row.
 *
 * The row's `output` is the resolver's `LedgerResolution` (a Mythrun-owned
 * object, serialized verbatim — so the payload fields are camelCase, UNLIKE the
 * snake_case SDK tool outputs of skill_check/dice_roll). Replay rules (§8):
 *
 *   - `ok:true` with a single payload → one frame (carrying the row's seq).
 *   - `ok:true` with a `take_rest` array payload → one frame PER entry (players
 *     watch their own row).
 *   - an `update_condition` payload with `changed:false` → NO frame (the same
 *     idempotent-no-op rule as live emission).
 *   - `ok:false` (a rejection) → SILENTLY skipped: an empty array, NO warn. A
 *     rejection is EXPECTED, not corrupt — distinct from the malformed-blob path.
 *   - a malformed blob / out-of-shape payload → dropped + WARNED (the existing
 *     player-facing-replay posture: drop one frame, keep the reconnect).
 */
function parseLedgerUpdateRow(
  row: SessionMessage,
  log: ReplayFrameLogger,
): Extract<ServerFrame, { type: 'ledger_update' }>[] {
  const parsed = parseDmRowContent(row.content)
  const output = parsed ? asRecord(parsed.output) : null
  if (output === null) {
    log.warn({ seq: row.seq, turnId: row.turnId }, 'replay dropped corrupt ledger_update row')
    return []
  }
  // §8: a rejection is EXPECTED, not corrupt — skip it silently (no warn). We
  // discriminate on the parsed output's `ok` field, BEFORE any field validation.
  if (output.ok === false) return []
  if (output.ok !== true) {
    log.warn({ seq: row.seq, turnId: row.turnId }, 'replay dropped corrupt ledger_update row')
    return []
  }
  // take_rest persists ONE row whose payload is an ARRAY (one entry per
  // character); every other ledger tool carries a single payload object.
  const rawPayloads = Array.isArray(output.payload) ? output.payload : [output.payload]
  const frames: Extract<ServerFrame, { type: 'ledger_update' }>[] = []
  for (const raw of rawPayloads) {
    const payload = asRecord(raw)
    if (payload === null || !isLedgerPayload(payload)) {
      log.warn({ seq: row.seq, turnId: row.turnId }, 'replay dropped corrupt ledger_update row')
      // A single malformed entry drops the WHOLE row — replay must not emit a
      // partial multi-character rest (a half-applied frame set is worse than a
      // clean drop the client backfills via REST).
      return []
    }
    // §8: a changed:false condition no-op replays NO frame (same as live emit).
    if (payload.kind === 'condition' && payload.changed === false) continue
    frames.push(payloadToLedgerFrame(payload, row))
  }
  return frames
}

/** Narrow predicate: the parsed payload object carries the two always-present
 *  `LedgerUpdatePayload` fields with the right types + a valid `kind`. The
 *  optional value fields are mapped through `numberOrUndefined` /
 *  `stringOrUndefined` below, so they don't need a guard here. */
function isLedgerPayload(
  p: Record<string, unknown>,
): p is Record<string, unknown> & { characterName: string; kind: string; summary: string } {
  return (
    typeof p.characterName === 'string' &&
    typeof p.summary === 'string' &&
    typeof p.kind === 'string' &&
    LEDGER_KINDS.has(p.kind)
  )
}

/** Map a validated payload object onto the §8 `ledger_update` wire frame,
 *  field-by-field. The optional value fields are copied only when present + of
 *  the right type (a stray ill-typed optional degrades to absent rather than
 *  dropping the frame — the always-present summary still narrates the delta). */
function payloadToLedgerFrame(
  payload: Record<string, unknown> & { characterName: string; kind: string; summary: string },
  row: SessionMessage,
): Extract<ServerFrame, { type: 'ledger_update' }> {
  // The wire `kind` is the validated string; the union narrowing happens at the
  // frame type. isLedgerPayload already gated it to LEDGER_KINDS membership.
  const kind = payload.kind as LedgerUpdatePayload['kind']
  const dice = payload.diceRolled
  return {
    type: 'ledger_update',
    turnId: row.turnId ?? '',
    seq: row.seq,
    characterName: payload.characterName,
    kind,
    summary: payload.summary,
    ...numField('hp', payload.hp),
    ...numField('maxHp', payload.maxHp),
    ...numField('gold', payload.gold),
    ...numField('slotLevel', payload.slotLevel),
    ...numField('slotsRemaining', payload.slotsRemaining),
    ...strField('itemName', payload.itemName),
    ...numField('quantity', payload.quantity),
    ...strField('featureName', payload.featureName),
    ...numField('usesRemaining', payload.usesRemaining),
    ...strField('condition', payload.condition),
    ...activeConditionsField(payload.activeConditions),
    ...(Array.isArray(dice) && dice.every((d): d is number => typeof d === 'number')
      ? { diceRolled: dice }
      : {}),
  }
}

/** myth-hlydp spread-helper: the persisted `activeConditions` array, kept only
 *  when EVERY entry is well-shaped. Same posture as the other optional value
 *  fields — an ill-typed one degrades to absent rather than dropping the whole
 *  frame (the always-present `summary` still narrates the change). Absent and
 *  empty are distinct on the wire: absent means "this tool cannot touch
 *  conditions", empty means "this character has none". */
function activeConditionsField(
  v: unknown,
): Record<string, readonly ActiveCondition[]> {
  if (!Array.isArray(v)) return {}
  const parsed: ActiveCondition[] = []
  for (const raw of v) {
    const entry = asRecord(raw)
    if (entry === null || typeof entry.condition !== 'string') return {}
    if (entry.level !== null && typeof entry.level !== 'number') return {}
    parsed.push({ condition: entry.condition, level: entry.level })
  }
  return { activeConditions: parsed }
}

/** Spread-helper: `{ [k]: v }` when `v` is a number, else `{}` (field absent).
 *  Keeps `payloadToLedgerFrame` a flat field-by-field map without a mutable
 *  accumulator + the strict-optional `exactOptionalPropertyTypes` dance. */
function numField(key: string, v: unknown): Record<string, number> {
  return typeof v === 'number' ? { [key]: v } : {}
}

function strField(key: string, v: unknown): Record<string, string> {
  return typeof v === 'string' ? { [key]: v } : {}
}
