import { describe, expect, it } from 'vitest'
import {
  assistantToRows,
  rowsToConversation,
  TranscriptCorruptError,
  DM_MESSAGE_TYPES,
} from '../transcript-codec.js'
import type { AssistantMessage } from '../tiers/types.js'
import type { SessionMessage } from '../../repo/types.js'

const row = (o: Partial<SessionMessage>): SessionMessage => ({
  id: 'id',
  sessionId: 's',
  seq: 1,
  userId: null,
  messageType: 'dm_text',
  content: '',
  createdAt: new Date(0),
  turnId: 't1',
  turnOrdinal: 0,
  triggerKind: null,
  ...o,
})

const names = new Map([['u1', 'Arin']])

describe('assistantToRows', () => {
  it('maps text + tool pair into ordered rows; matches call/result on toolCallId', () => {
    const assistant: AssistantMessage = {
      role: 'assistant',
      parts: [
        { kind: 'text', text: 'The lock looks old.' },
        { kind: 'tool_call', toolCallId: 'c1', toolName: 'roll_skill_check', input: { skill: 'Stealth' } },
        { kind: 'tool_result', toolCallId: 'c1', toolName: 'roll_skill_check', output: { total: 17 } },
        { kind: 'text', text: 'You slip past.' },
      ],
    }
    expect(assistantToRows(assistant)).toEqual([
      { kind: 'dm_text', content: 'The lock looks old.' },
      {
        kind: 'skill_check',
        content: JSON.stringify({ toolCallId: 'c1', input: { skill: 'Stealth' }, output: { total: 17 } }),
      },
      { kind: 'dm_text', content: 'You slip past.' },
    ])
  })
  it('DROPS a dangling tool_call with no result (cap edge, §3.6)', () => {
    const assistant: AssistantMessage = {
      role: 'assistant',
      parts: [
        { kind: 'text', text: 'Hmm.' },
        { kind: 'tool_call', toolCallId: 'c9', toolName: 'roll_dice', input: {} },
      ],
    }
    expect(assistantToRows(assistant)).toEqual([{ kind: 'dm_text', content: 'Hmm.' }])
  })
  it('throws TranscriptCorruptError on an unknown tool name with a matching result', () => {
    const assistant: AssistantMessage = {
      role: 'assistant',
      parts: [
        { kind: 'tool_call', toolCallId: 'cx', toolName: 'no_such_tool', input: {} },
        { kind: 'tool_result', toolCallId: 'cx', toolName: 'no_such_tool', output: {} },
      ],
    }
    expect(() => assistantToRows(assistant)).toThrow(TranscriptCorruptError)
  })
})

// MYT-70 §8 — the six ledger tools persist + round-trip exactly like roll rows.
// kind === tool name for each (simplest bijection), and an ok:false (rejection)
// output is EXPECTED, not corrupt: it persists and rebuilds.
const LEDGER_TOOLS = [
  'cast_spell',
  'spend_resource',
  'acquire_resource',
  'adjust_hp',
  'update_condition',
  'take_rest',
] as const

describe('ledger tools (MYT-70 §8)', () => {
  for (const tool of LEDGER_TOOLS) {
    it(`${tool} round-trips: assistantToRows → rowsToConversation reconstructs the tool_call+tool_result pair`, () => {
      const assistant: AssistantMessage = {
        role: 'assistant',
        parts: [
          { kind: 'text', text: 'Before.' },
          { kind: 'tool_call', toolCallId: 'c1', toolName: tool, input: { character_name: 'Arin', detail: 1 } },
          { kind: 'tool_result', toolCallId: 'c1', toolName: tool, output: { ok: true, applied: true } },
          { kind: 'text', text: 'After.' },
        ],
      }
      const turnRows = assistantToRows(assistant)
      // The tool pair collapses to ONE row keyed by `tool` (kind === tool name).
      expect(turnRows).toEqual([
        { kind: 'dm_text', content: 'Before.' },
        {
          kind: tool,
          content: JSON.stringify({
            toolCallId: 'c1',
            input: { character_name: 'Arin', detail: 1 },
            output: { ok: true, applied: true },
          }),
        },
        { kind: 'dm_text', content: 'After.' },
      ])

      const rows = turnRows.map((r, i) =>
        row({ messageType: r.kind, content: r.content, seq: 10 + i, turnOrdinal: i, turnId: 'tX' }),
      )
      const conv = rowsToConversation(rows, names)
      expect(conv).toHaveLength(1)
      expect(conv[0]).toEqual({ v: 1, role: 'assistant', parts: assistant.parts })
    })
  }

  it('issue_correction (myth-d6knq) persists as a dm_correction row and round-trips', () => {
    // The FT tool MUST be registered in DM_MESSAGE_TYPES + TOOL_TO_KIND or the
    // turn crashes — assert both the row kind and the reconstruction.
    expect(DM_MESSAGE_TYPES).toContain('dm_correction')
    const assistant: AssistantMessage = {
      role: 'assistant',
      parts: [
        { kind: 'tool_call', toolCallId: 'k1', toolName: 'issue_correction', input: { text: 'Earlier I named the ferryman Coss; it is Trask.' } },
        { kind: 'tool_result', toolCallId: 'k1', toolName: 'issue_correction', output: { text: 'Earlier I named the ferryman Coss; it is Trask.' } },
      ],
    }
    const turnRows = assistantToRows(assistant)
    expect(turnRows).toEqual([
      {
        kind: 'dm_correction',
        content: JSON.stringify({
          toolCallId: 'k1',
          input: { text: 'Earlier I named the ferryman Coss; it is Trask.' },
          output: { text: 'Earlier I named the ferryman Coss; it is Trask.' },
        }),
      },
    ])
    const rows = turnRows.map((r, i) =>
      row({ messageType: r.kind, content: r.content, seq: 20 + i, turnOrdinal: i, turnId: 'tC' }),
    )
    const conv = rowsToConversation(rows, names)
    expect(conv).toEqual([{ v: 1, role: 'assistant', parts: assistant.parts }])
  })

  it('an ok:false (rejection) output persists and round-trips like any roll row', () => {
    const assistant: AssistantMessage = {
      role: 'assistant',
      parts: [
        { kind: 'tool_call', toolCallId: 'cr', toolName: 'spend_resource', input: { character_name: 'Arin' } },
        {
          kind: 'tool_result',
          toolCallId: 'cr',
          toolName: 'spend_resource',
          output: { ok: false, reason: 'insufficient resource' },
        },
      ],
    }
    const turnRows = assistantToRows(assistant)
    expect(turnRows).toEqual([
      {
        kind: 'spend_resource',
        content: JSON.stringify({
          toolCallId: 'cr',
          input: { character_name: 'Arin' },
          output: { ok: false, reason: 'insufficient resource' },
        }),
      },
    ])
    const rows = turnRows.map((r, i) =>
      row({ messageType: r.kind, content: r.content, seq: 10 + i, turnOrdinal: i, turnId: 'tR' }),
    )
    const conv = rowsToConversation(rows, names)
    expect(conv).toHaveLength(1)
    expect(conv[0]).toEqual({ v: 1, role: 'assistant', parts: assistant.parts })
  })
})

// MYT-72 §T8 — the three world_fact_lookup tools (search_lore,
// characters_known_to, faction_tree) PERSIST + round-trip. Decision: ONE
// `world_fact_lookup` kind for all three (shared read-only no-mutation
// semantics + a single relay-shaped output); the tool name rides the row JSON
// (`toolName`) so the reverse direction restores the exact `toolName`. The
// persisted relay is secret-free by construction (the ST-vet sanitizes the
// output upstream); this codec just round-trips whatever JSON is present.
const LOOKUP_TOOLS = ['search_lore', 'characters_known_to', 'faction_tree'] as const

describe('world_fact_lookup tools (MYT-72 §T8)', () => {
  for (const tool of LOOKUP_TOOLS) {
    it(`${tool} persists as a world_fact_lookup row and round-trips byte-stably`, () => {
      const assistant: AssistantMessage = {
        role: 'assistant',
        parts: [
          { kind: 'text', text: 'You recall what you know.' },
          {
            kind: 'tool_call',
            toolCallId: 'c1',
            toolName: tool,
            input: { query: 'the old council' },
          },
          {
            kind: 'tool_result',
            toolCallId: 'c1',
            toolName: tool,
            output: { results: [{ name: 'The Verdant Council', summary: 'A guild of druids.' }] },
          },
          { kind: 'text', text: 'And you share it.' },
        ],
      }
      const turnRows = assistantToRows(assistant)
      // All three tools collapse to ONE `world_fact_lookup` kind; the row JSON
      // carries `toolName` so the reverse direction restores the exact tool.
      expect(turnRows).toEqual([
        { kind: 'dm_text', content: 'You recall what you know.' },
        {
          kind: 'world_fact_lookup',
          content: JSON.stringify({
            toolCallId: 'c1',
            toolName: tool,
            input: { query: 'the old council' },
            output: { results: [{ name: 'The Verdant Council', summary: 'A guild of druids.' }] },
          }),
        },
        { kind: 'dm_text', content: 'And you share it.' },
      ])

      const rows = turnRows.map((r, i) =>
        row({ messageType: r.kind, content: r.content, seq: 10 + i, turnOrdinal: i, turnId: 'tL' }),
      )
      const conv = rowsToConversation(rows, names)
      expect(conv).toHaveLength(1)
      expect(conv[0]).toEqual({ v: 1, role: 'assistant', parts: assistant.parts })
      // Byte-stability: a second pass produces an identical serialization.
      expect(JSON.stringify(rowsToConversation(rows, names))).toBe(JSON.stringify(conv))
    })
  }

  it('falls back to search_lore when a world_fact_lookup row omits toolName (legacy/corrupt-guard)', () => {
    const rows = [
      row({
        messageType: 'world_fact_lookup',
        content: JSON.stringify({ toolCallId: 'cz', input: {}, output: {} }),
        seq: 5,
        turnId: 'tF',
        turnOrdinal: 0,
      }),
    ]
    const conv = rowsToConversation(rows, names)
    expect(conv).toHaveLength(1)
    expect(conv[0]).toEqual({
      v: 1,
      role: 'assistant',
      parts: [
        { kind: 'tool_call', toolCallId: 'cz', toolName: 'search_lore', input: {} },
        { kind: 'tool_result', toolCallId: 'cz', toolName: 'search_lore', output: {} },
      ],
    })
  })

  it('throws TranscriptCorruptError on a world_fact_lookup row whose toolName is present but not a string (corruption, §3.7)', () => {
    const rows = [
      row({
        messageType: 'world_fact_lookup',
        content: JSON.stringify({ toolCallId: 'cz', toolName: 42, input: {}, output: {} }),
        seq: 7,
        turnId: 'tG',
        turnOrdinal: 0,
      }),
    ]
    expect(() => rowsToConversation(rows, names)).toThrow(TranscriptCorruptError)
    expect(() => rowsToConversation(rows, names)).toThrow('non-string toolName')
  })
})

// MYT-75 — the two combat L1 tools persist + round-trip exactly like the
// ledger rows: kind === tool name (combat_initiate / combat_resolve map to
// initiate_combat / resolve_combat), {toolCallId, input, output} JSON.
const COMBAT_TOOLS = [
  { tool: 'initiate_combat', kind: 'combat_initiate' },
  { tool: 'resolve_combat', kind: 'combat_resolve' },
] as const

describe('combat tools (MYT-75)', () => {
  it('round-trips combat tool rows (combat_initiate / combat_resolve)', () => {
    const assistant: AssistantMessage = {
      role: 'assistant',
      parts: [
        { kind: 'tool_call', toolCallId: 'c1', toolName: 'initiate_combat', input: { enemies: [] } },
        { kind: 'tool_result', toolCallId: 'c1', toolName: 'initiate_combat', output: { ok: true } },
        { kind: 'tool_call', toolCallId: 'c2', toolName: 'resolve_combat', input: { narration: 'x' } },
        { kind: 'tool_result', toolCallId: 'c2', toolName: 'resolve_combat', output: { ok: true } },
      ],
    }
    const rows = assistantToRows(assistant)
    expect(rows.map((r) => r.kind)).toEqual(['combat_initiate', 'combat_resolve'])
  })

  for (const { tool, kind } of COMBAT_TOOLS) {
    it(`${tool} round-trips: assistantToRows → rowsToConversation reconstructs the tool_call+tool_result pair`, () => {
      const assistant: AssistantMessage = {
        role: 'assistant',
        parts: [
          { kind: 'text', text: 'Before.' },
          { kind: 'tool_call', toolCallId: 'c1', toolName: tool, input: { detail: 1 } },
          { kind: 'tool_result', toolCallId: 'c1', toolName: tool, output: { ok: true, applied: true } },
          { kind: 'text', text: 'After.' },
        ],
      }
      const turnRows = assistantToRows(assistant)
      // The tool pair collapses to ONE row keyed by `kind` (kind === tool name).
      expect(turnRows).toEqual([
        { kind: 'dm_text', content: 'Before.' },
        {
          kind,
          content: JSON.stringify({
            toolCallId: 'c1',
            input: { detail: 1 },
            output: { ok: true, applied: true },
          }),
        },
        { kind: 'dm_text', content: 'After.' },
      ])

      const rows = turnRows.map((r, i) =>
        row({ messageType: r.kind, content: r.content, seq: 10 + i, turnOrdinal: i, turnId: 'tC' }),
      )
      const conv = rowsToConversation(rows, names)
      expect(conv).toHaveLength(1)
      expect(conv[0]).toEqual({ v: 1, role: 'assistant', parts: assistant.parts })
    })
  }
})

describe('rowsToConversation', () => {
  it('round-trips deterministically (the §3.9 byte-stability requirement)', () => {
    const assistant: AssistantMessage = {
      role: 'assistant',
      parts: [
        { kind: 'text', text: 'A' },
        { kind: 'tool_call', toolCallId: 'c1', toolName: 'roll_dice', input: { count: 1, sides: 6 } },
        { kind: 'tool_result', toolCallId: 'c1', toolName: 'roll_dice', output: { results: [4], total: 4 } },
        { kind: 'text', text: 'B' },
      ],
    }
    const rows = assistantToRows(assistant).map((r, i) =>
      row({ messageType: r.kind, content: r.content, seq: 10 + i, turnOrdinal: i, turnId: 'tX' }),
    )
    const conv = rowsToConversation(rows, names)
    expect(conv).toHaveLength(1)
    expect(conv[0]).toEqual({ v: 1, role: 'assistant', parts: assistant.parts })
    expect(JSON.stringify(rowsToConversation(rows, names))).toBe(JSON.stringify(conv))
  })
  it('maps player rows with attribution and groups DM rows by turnId', () => {
    const rows = [
      row({ messageType: 'player_message', content: 'I sneak in', seq: 1, userId: 'u1', turnId: null, turnOrdinal: null }),
      row({ messageType: 'dm_text', content: 'Roll it.', seq: 2, turnId: 't1', turnOrdinal: 0 }),
      row({ messageType: 'player_message', content: 'ok', seq: 3, userId: 'u1', turnId: null, turnOrdinal: null }),
    ]
    const conv = rowsToConversation(rows, names)
    expect(conv.map((m) => m.role)).toEqual(['user', 'assistant', 'user'])
    expect(conv[0]).toMatchObject({ characterName: 'Arin', parts: [{ kind: 'text', text: 'I sneak in' }] })
  })
  it('groups two turnIds into two separate assistant messages', () => {
    const rows = [
      row({ messageType: 'dm_text', content: 'First.', seq: 1, turnId: 't1', turnOrdinal: 0 }),
      row({ messageType: 'dm_text', content: 'Still first.', seq: 2, turnId: 't1', turnOrdinal: 1 }),
      row({ messageType: 'dm_text', content: 'Second.', seq: 3, turnId: 't2', turnOrdinal: 0 }),
    ]
    const conv = rowsToConversation(rows, names)
    expect(conv).toHaveLength(2)
    expect(conv[0]).toEqual({
      v: 1,
      role: 'assistant',
      parts: [
        { kind: 'text', text: 'First.' },
        { kind: 'text', text: 'Still first.' },
      ],
    })
    expect(conv[1]).toEqual({
      v: 1,
      role: 'assistant',
      parts: [{ kind: 'text', text: 'Second.' }],
    })
  })
  it('ignores a foreign message_type row (e.g. system)', () => {
    const rows = [
      row({ messageType: 'player_message', content: 'hi', seq: 1, userId: 'u1', turnId: null, turnOrdinal: null }),
      row({ messageType: 'system', content: 'session resumed', seq: 2, userId: null, turnId: null, turnOrdinal: null }),
      row({ messageType: 'dm_text', content: 'Welcome back.', seq: 3, turnId: 't1', turnOrdinal: 0 }),
    ]
    const conv = rowsToConversation(rows, names)
    expect(conv.map((m) => m.role)).toEqual(['user', 'assistant'])
    expect(conv[0]).toMatchObject({ parts: [{ kind: 'text', text: 'hi' }] })
    expect(conv[1]).toMatchObject({ parts: [{ kind: 'text', text: 'Welcome back.' }] })
  })
  it('falls back to userId then Player when no display name maps', () => {
    const rows = [
      row({ messageType: 'player_message', content: 'a', seq: 1, userId: 'unknown-id', turnId: null, turnOrdinal: null }),
      row({ messageType: 'player_message', content: 'b', seq: 2, userId: null, turnId: null, turnOrdinal: null }),
    ]
    const conv = rowsToConversation(rows, names)
    expect(conv[0]).toMatchObject({ characterName: 'unknown-id' })
    expect(conv[1]).toMatchObject({ characterName: 'Player' })
  })
  it('throws TranscriptCorruptError on an unparseable roll row (crash-loud, §3.7)', () => {
    const rows = [row({ messageType: 'skill_check', content: 'not-json', seq: 42 })]
    expect(() => rowsToConversation(rows, names)).toThrow(TranscriptCorruptError)
    // The message carries the row locator — findable in a huge transcript.
    expect(() => rowsToConversation(rows, names)).toThrow('(seq 42)')
  })
  it('throws TranscriptCorruptError on a roll row missing toolCallId', () => {
    const rows = [
      row({ messageType: 'skill_check', content: JSON.stringify({ input: {}, output: {} }), seq: 7 }),
    ]
    expect(() => rowsToConversation(rows, names)).toThrow(TranscriptCorruptError)
    expect(() => rowsToConversation(rows, names)).toThrow('(seq 7)')
  })
})

it('DM_MESSAGE_TYPES is the closed kind set', () => {
  expect(DM_MESSAGE_TYPES).toEqual([
    'dm_text',
    'skill_check',
    'dice_roll',
    'cast_spell',
    'spend_resource',
    'acquire_resource',
    'adjust_hp',
    'update_condition',
    'take_rest',
    'world_fact_lookup',
    'combat_initiate',
    'combat_resolve',
    'dm_correction',
  ])
})
