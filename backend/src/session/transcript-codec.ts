// backend/src/session/transcript-codec.ts
//
// MYT-68 §3.7 — the ONE formatter between session_messages rows and the FT's
// Mythrun-owned multi-part ConversationMessages. Pure functions, no I/O. Both
// directions live here so the round-trip is deterministic by construction
// (the §3.9 prompt-cache byte-stability requirement). Reconstruction of an
// incoherent row THROWS (crash-loud; the worker maps it to a fatal turn
// error) — it never silently truncates.

import type { SessionMessage } from '../repo/types.js'
import type { AssistantMessage, ContentPart, ConversationMessage } from './tiers/types.js'

export const DM_MESSAGE_TYPES = ['dm_text', 'skill_check', 'dice_roll'] as const
export type DmMessageType = (typeof DM_MESSAGE_TYPES)[number]

export interface DmTurnRow {
  readonly kind: DmMessageType
  readonly content: string
}

export class TranscriptCorruptError extends Error {
  constructor(detail: string) {
    super(`transcript corrupt: ${detail}`)
    this.name = 'TranscriptCorruptError'
  }
}

const KIND_TO_TOOL: Record<Exclude<DmMessageType, 'dm_text'>, string> = {
  skill_check: 'roll_skill_check',
  dice_roll: 'roll_dice',
}

const TOOL_TO_KIND: Record<string, Exclude<DmMessageType, 'dm_text'>> = {
  roll_skill_check: 'skill_check',
  roll_dice: 'dice_roll',
}

const DM_TYPE_SET: ReadonlySet<string> = new Set(DM_MESSAGE_TYPES)

interface RollRowJson {
  readonly toolCallId: string
  readonly input: unknown
  readonly output: unknown
}

/** Assistant parts → ordered DM rows. text → dm_text; a tool_call+tool_result
 *  pair (matched on toolCallId) → ONE roll row whose content is the canonical
 *  JSON {toolCallId, input, output}. A dangling tool_call (cap edge, §3.6) is
 *  DROPPED — the persisted turn must rebuild into a coherent history. */
export function assistantToRows(assistant: AssistantMessage): DmTurnRow[] {
  const rows: DmTurnRow[] = []
  const results = new Map<string, ContentPart & { kind: 'tool_result' }>()
  for (const part of assistant.parts) {
    if (part.kind === 'tool_result') results.set(part.toolCallId, part)
  }
  for (const part of assistant.parts) {
    if (part.kind === 'text') {
      rows.push({ kind: 'dm_text', content: part.text })
    } else if (part.kind === 'tool_call') {
      const result = results.get(part.toolCallId)
      // Dangling tool_call (no matching result, e.g. cap edge §3.6) → drop.
      if (!result) continue
      const kind = TOOL_TO_KIND[part.toolName]
      if (!kind) {
        throw new TranscriptCorruptError(`unknown tool name in assistant message: ${part.toolName}`)
      }
      const json: RollRowJson = {
        toolCallId: part.toolCallId,
        input: part.input,
        output: result.output,
      }
      rows.push({ kind, content: JSON.stringify(json) })
    }
    // tool_result parts are consumed alongside their tool_call (above); skip.
  }
  return rows
}

/** Rows (seq ASC) → ConversationMessages. Player row → one user message with
 *  attribution (attributionNames.get(userId) ?? userId ?? 'Player'); contiguous
 *  DM rows sharing a turnId → ONE assistant message (dm_text → text part;
 *  roll row JSON → tool_call part + tool_result part, toolName from kind).
 *  Foreign message_types are ignored. Deterministic.
 *
 *  `attributionNames` is the userId→CHARACTER-name map (NOT display names): the
 *  ft-system prompt tells the model to echo the attributed name into
 *  roll_skill_check.character_name, which resolves against session_participants,
 *  so the attribution must speak character names. The `userId ?? 'Player'`
 *  fallback covers a departed/unknown author with no map entry. */
export function rowsToConversation(
  rows: readonly SessionMessage[],
  attributionNames: ReadonlyMap<string, string>,
): ConversationMessage[] {
  const conversation: ConversationMessage[] = []
  let currentTurnId: string | null = null
  let currentParts: ContentPart[] = []

  const flushTurn = (): void => {
    if (currentTurnId !== null && currentParts.length > 0) {
      conversation.push({ v: 1, role: 'assistant', parts: currentParts })
    }
    currentTurnId = null
    currentParts = []
  }

  for (const row of rows) {
    if (row.messageType === 'player_message') {
      flushTurn()
      const characterName = attributionNames.get(row.userId ?? '') ?? row.userId ?? 'Player'
      conversation.push({
        v: 1,
        role: 'user',
        parts: [{ kind: 'text', text: row.content }],
        characterName,
      })
      continue
    }

    if (DM_TYPE_SET.has(row.messageType)) {
      // A new turnId (or the first DM row) starts a fresh assistant message.
      if (row.turnId !== currentTurnId) {
        flushTurn()
        currentTurnId = row.turnId
      }
      appendDmRowParts(row, currentParts)
      continue
    }

    // Foreign message_type (e.g. 'system', legacy 'dm_message') — ignored.
  }
  flushTurn()
  return conversation
}

/** One DM row → its part(s) appended to the in-progress assistant message.
 *  dm_text → a single text part; a roll row → a tool_call + tool_result pair. */
function appendDmRowParts(row: SessionMessage, parts: ContentPart[]): void {
  if (row.messageType === 'dm_text') {
    parts.push({ kind: 'text', text: row.content })
    return
  }

  const toolName = KIND_TO_TOOL[row.messageType as Exclude<DmMessageType, 'dm_text'>]
  const json = parseRollRow(row.content, row.messageType, row.seq)
  parts.push({ kind: 'tool_call', toolCallId: json.toolCallId, toolName, input: json.input })
  parts.push({ kind: 'tool_result', toolCallId: json.toolCallId, toolName, output: json.output })
}

/** Parse a roll row's canonical JSON; throws TranscriptCorruptError (crash-loud,
 *  §3.7) on unparseable content or a missing toolCallId. `seq` locates the
 *  corrupt row in a multi-thousand-row transcript. */
function parseRollRow(content: string, messageType: string, seq: number): RollRowJson {
  let parsed: unknown
  try {
    parsed = JSON.parse(content)
  } catch {
    throw new TranscriptCorruptError(`${messageType} row content is not valid JSON (seq ${String(seq)})`)
  }
  if (
    typeof parsed !== 'object' ||
    parsed === null ||
    typeof (parsed as { toolCallId?: unknown }).toolCallId !== 'string'
  ) {
    throw new TranscriptCorruptError(`${messageType} row JSON missing string toolCallId (seq ${String(seq)})`)
  }
  const obj = parsed as { toolCallId: string; input?: unknown; output?: unknown }
  return { toolCallId: obj.toolCallId, input: obj.input, output: obj.output }
}
