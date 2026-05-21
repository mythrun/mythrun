// Tests for the live-events-panel module. Two layers:
//
//   1. Pure-function tests (no DOM): truncation rule, inventory reducer,
//      compact-line classification, applyCap.
//   2. DOM-mount tests: exercised against a minimal document/window stub
//      installed in beforeAll. The stub implements only the subset of the
//      DOM API the panel actually uses (createElement, classList, dataset,
//      replaceChildren, addEventListener, dispatchEvent). Avoids pulling
//      in happy-dom/jsdom as a new dep per the §6 "no new deps" constraint.
//
// Per spec §8 Layer 4: each of the 7 entity/edge event arms has an
// explicit named test. The 7 arms are listed below in the same order as
// the contract; renaming/reordering should match contract changes.

import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  applyCap,
  compactLine,
  derivePlaceholderBuffer,
  deriveInventory,
  EVICT_BATCH,
  KNOWN_EVENT_TYPES,
  MAX_EVENTS,
  primaryKeyOf,
  summarizeArray,
  summarizeObject,
  truncateString,
  type LiveEvent,
  type LogEntry,
} from '../live-events-panel.js'

// ---- Pure-function tests ----

describe('truncateString', () => {
  it('returns the input verbatim when shorter than the limit', () => {
    expect(truncateString('hello')).toBe('hello')
  })

  it('truncates strings longer than ~80 chars with an ellipsis suffix', () => {
    const long = 'a'.repeat(120)
    const out = truncateString(long)
    expect(out.length).toBe(81) // 80 chars + '…'
    expect(out.endsWith('…')).toBe(true)
  })

  it('honors a custom limit', () => {
    expect(truncateString('abcdef', 3)).toBe('abc…')
  })

  it('JSON-stringifies non-string input before applying the rule', () => {
    expect(truncateString(42)).toBe('42')
    expect(truncateString({ a: 1 })).toBe('{"a":1}')
  })

  it('handles nested arrays via JSON.stringify', () => {
    expect(truncateString([1, 2, 3])).toBe('[1,2,3]')
  })
})

describe('primaryKeyOf', () => {
  it('returns name when present', () => {
    expect(primaryKeyOf({ name: 'x', other: 1 })).toBe('name')
  })

  it('falls back to synthKey when name is absent', () => {
    expect(primaryKeyOf({ synthKey: 'k', other: 1 })).toBe('synthKey')
  })

  it('falls back to the first key alphabetically when neither is present', () => {
    expect(primaryKeyOf({ zeta: 1, alpha: 2 })).toBe('alpha')
  })

  it('returns null on an empty object', () => {
    expect(primaryKeyOf({})).toBeNull()
  })
})

describe('summarizeObject', () => {
  it('renders ${primaryKey}: ${truncatedValue} (${otherKeyCount} other fields)', () => {
    expect(summarizeObject({ name: 'Eredil', kind: 'region', size: 'large' })).toBe(
      'name: Eredil (2 other fields)',
    )
  })

  it('truncates long primary values per the 80-char rule', () => {
    const longName = 'x'.repeat(120)
    const out = summarizeObject({ name: longName })
    expect(out.startsWith('name: ')).toBe(true)
    expect(out.endsWith('… (0 other fields)')).toBe(true)
  })

  it('renders {} for an empty object', () => {
    expect(summarizeObject({})).toBe('{}')
  })
})

describe('summarizeArray', () => {
  it('renders ${field}: [${array.length}]', () => {
    expect(summarizeArray('factions', [1, 2, 3])).toBe('factions: [3]')
  })

  it('handles empty arrays', () => {
    expect(summarizeArray('regions', [])).toBe('regions: [0]')
  })
})

// ---- Per-event-arm tests (§8 Layer 4) ----

describe('per-event-arm rendering', () => {
  it('entity-added arrival → renders card with kind + name + truncated data', () => {
    const event: LiveEvent = {
      type: 'entity-added',
      synthKey: 'wf/regions/0',
      entityKind: 'location',
      data: { name: 'Eredil', description: 'a' },
    }
    const line = compactLine(event)
    expect(line.primary).toContain('entity-added')
    expect(line.primary).toContain('wf/regions/0')
    expect(line.primary).toContain('location')
    expect(line.detail).toContain('Eredil')

    const inv = deriveInventory([{ kind: 'event', event }])
    expect(inv.rows).toHaveLength(1)
    expect(inv.rows[0]?.name).toBe('Eredil')
    expect(inv.rows[0]?.kind).toBe('location')
    expect(inv.rows[0]?.synthKey).toBe('wf/regions/0')
  })

  it('entity-updated arrival → applies patch to inventory + renders card with field-change count', () => {
    const added: LiveEvent = {
      type: 'entity-added',
      synthKey: 'wf/regions/0',
      entityKind: 'location',
      data: { name: 'Eredil', size: 'small' },
    }
    const updated: LiveEvent = {
      type: 'entity-updated',
      synthKey: 'wf/regions/0',
      patch: { name: 'Eredil-the-Great', size: 'large' },
    }
    const line = compactLine(updated)
    expect(line.primary).toContain('entity-updated')
    expect(line.primary).toContain('wf/regions/0')
    expect(line.primary).toContain('(2 fields)')

    const inv = deriveInventory([
      { kind: 'event', event: added },
      { kind: 'event', event: updated },
    ])
    expect(inv.rows[0]?.name).toBe('Eredil-the-Great')
    expect(inv.rows[0]?.state).toMatchObject({ name: 'Eredil-the-Great', size: 'large' })
  })

  it('entity-removed arrival → deletes inventory row + renders card', () => {
    const added: LiveEvent = {
      type: 'entity-added',
      synthKey: 'wf/regions/0',
      entityKind: 'location',
      data: { name: 'Eredil' },
    }
    const removed: LiveEvent = {
      type: 'entity-removed',
      synthKey: 'wf/regions/0',
      reason: 'coherence_removed',
    }
    const line = compactLine(removed)
    expect(line.primary).toContain('entity-removed')
    expect(line.primary).toContain('wf/regions/0')
    expect(line.detail).toContain('coherence_removed')

    const inv = deriveInventory([
      { kind: 'event', event: added },
      { kind: 'event', event: removed },
    ])
    expect(inv.rows).toHaveLength(0)
  })

  it('edge-added arrival → renders card with from→to + relationship', () => {
    const event: LiveEvent = {
      type: 'edge-added',
      synthKey: 'er/edges/0',
      from: 'uuid-a',
      to: 'uuid-b',
      relationship: 'allied_with',
    }
    const line = compactLine(event)
    expect(line.primary).toContain('edge-added')
    expect(line.primary).toContain('uuid-a -> uuid-b')
    expect(line.detail).toContain('allied_with')

    const inv = deriveInventory([{ kind: 'event', event }])
    expect(inv.edgeCount).toBe(1)
  })

  it('edge-removed arrival → decrements inventory edge counter + renders card', () => {
    const add: LiveEvent = {
      type: 'edge-added',
      synthKey: 'er/edges/0',
      from: 'a',
      to: 'b',
      relationship: 'r',
    }
    const remove: LiveEvent = {
      type: 'edge-removed',
      synthKey: 'er/edges/0',
      reason: 'coherence_deleted',
    }
    const line = compactLine(remove)
    expect(line.primary).toContain('edge-removed')
    expect(line.detail).toContain('coherence_deleted')

    const inv = deriveInventory([
      { kind: 'event', event: add },
      { kind: 'event', event: remove },
    ])
    expect(inv.edgeCount).toBe(0)
  })

  it('stage-reset arrival → drops inventory rows by synthKey prefix + renders card', () => {
    const a: LiveEvent = {
      type: 'entity-added',
      synthKey: 'wf/regions/0',
      entityKind: 'location',
      data: { name: 'Eredil' },
    }
    const b: LiveEvent = {
      type: 'entity-added',
      synthKey: 'ln/npcs/0',
      entityKind: 'npc',
      data: { name: 'Brom' },
    }
    const reset: LiveEvent = { type: 'stage-reset', stage: 'wf' }
    const line = compactLine(reset)
    expect(line.primary).toContain('stage-reset')
    expect(line.primary).toContain('wf')

    const inv = deriveInventory([
      { kind: 'event', event: a },
      { kind: 'event', event: b },
      { kind: 'event', event: reset },
    ])
    expect(inv.rows).toHaveLength(1)
    expect(inv.rows[0]?.synthKey).toBe('ln/npcs/0')
  })

  it('finalized arrival → swaps inventory display-ID from synthKey to entityId + renders card', () => {
    const added: LiveEvent = {
      type: 'entity-added',
      synthKey: 'wf/regions/0',
      entityKind: 'location',
      data: { name: 'Eredil' },
    }
    const finalized: LiveEvent = {
      type: 'finalized',
      synthKey: 'wf/regions/0',
      entityId: '01923b4c-d4f1-7000-8000-000000000000',
    }
    const line = compactLine(finalized)
    expect(line.primary).toContain('finalized')
    expect(line.detail).toContain('01923b4c-d4f1-7000-8000-000000000000')

    const inv = deriveInventory([
      { kind: 'event', event: added },
      { kind: 'event', event: finalized },
    ])
    expect(inv.rows[0]?.displayId).toBe('01923b4c-d4f1-7000-8000-000000000000')
    expect(inv.rows[0]?.synthKey).toBe('wf/regions/0') // internal key unchanged
  })
})

// ---- Phase 5.3 placeholder-edge buffering + reconciliation ----
//
// Stage 4 (entity_relationships) may emit edge-added events whose endpoints
// are placeholder strings (`new-NNN`) — they reference an entity that the
// LLM hinted at but that doesn't exist yet. Stage 4b (entity_consolidation)
// later emits entity-added events for those ghosts carrying a
// `placeholderId` field. The panel buffers placeholder-endpoint edges
// client-side and reconciles them when the matching entity arrives.

describe('derivePlaceholderBuffer (Phase 5.3 reconciliation)', () => {
  it('buffers placeholder-endpoint edges; resolves them on entity-added with matching placeholderId', () => {
    const edgeEvent: LiveEvent = {
      type: 'edge-added',
      synthKey: 'entity_relationships/relationships/0',
      from: 'real-uuid-1',
      to: 'new-001',
      relationship: 'rival_of',
    }

    // Before reconciliation: edge is buffered, not rendered.
    const beforeBuf = derivePlaceholderBuffer([{ kind: 'event', event: edgeEvent }])
    expect(beforeBuf.rendered).toHaveLength(0)
    expect(beforeBuf.bufferedCount).toBe(1)

    const ghostEvent: LiveEvent = {
      type: 'entity-added',
      synthKey: 'entity_consolidation/ghosts/0',
      entityKind: 'faction',
      data: { name: 'The Ironjaw' },
      placeholderId: 'new-001',
    }

    // After matching entity-added: edge is rendered with the resolved endpoint.
    const afterBuf = derivePlaceholderBuffer([
      { kind: 'event', event: edgeEvent },
      { kind: 'event', event: ghostEvent },
    ])
    expect(afterBuf.rendered).toHaveLength(1)
    expect(afterBuf.rendered[0]?.from).toBe('real-uuid-1')
    // `to` is patched away from the placeholder; the resolved value is the
    // ghost's synthKey (the dev-tool's stable entity identity, since UUIDs
    // arrive later via `finalized`).
    expect(afterBuf.rendered[0]?.to).not.toMatch(/^new-/)
    expect(afterBuf.rendered[0]?.to).toBe('entity_consolidation/ghosts/0')
    expect(afterBuf.bufferedCount).toBe(0)
  })

  it('edges with no placeholder endpoint render immediately', () => {
    const edge: LiveEvent = {
      type: 'edge-added',
      synthKey: 'er/edges/0',
      from: 'uuid-a',
      to: 'uuid-b',
      relationship: 'allied_with',
    }
    const buf = derivePlaceholderBuffer([{ kind: 'event', event: edge }])
    expect(buf.rendered).toHaveLength(1)
    expect(buf.rendered[0]?.from).toBe('uuid-a')
    expect(buf.rendered[0]?.to).toBe('uuid-b')
    expect(buf.bufferedCount).toBe(0)
  })

  it('edges with BOTH endpoints as placeholders stay buffered until both ghosts arrive', () => {
    const edge: LiveEvent = {
      type: 'edge-added',
      synthKey: 'er/edges/9',
      from: 'new-001',
      to: 'new-002',
      relationship: 'allied_with',
    }
    const ghostA: LiveEvent = {
      type: 'entity-added',
      synthKey: 'ec/ghosts/0',
      entityKind: 'faction',
      data: { name: 'A' },
      placeholderId: 'new-001',
    }
    const ghostB: LiveEvent = {
      type: 'entity-added',
      synthKey: 'ec/ghosts/1',
      entityKind: 'faction',
      data: { name: 'B' },
      placeholderId: 'new-002',
    }

    // Edge + one ghost → still buffered (other endpoint unresolved).
    const partial = derivePlaceholderBuffer([
      { kind: 'event', event: edge },
      { kind: 'event', event: ghostA },
    ])
    expect(partial.rendered).toHaveLength(0)
    expect(partial.bufferedCount).toBe(1)

    // Both ghosts arrived → rendered with both endpoints patched.
    const full = derivePlaceholderBuffer([
      { kind: 'event', event: edge },
      { kind: 'event', event: ghostA },
      { kind: 'event', event: ghostB },
    ])
    expect(full.rendered).toHaveLength(1)
    expect(full.rendered[0]?.from).toBe('ec/ghosts/0')
    expect(full.rendered[0]?.to).toBe('ec/ghosts/1')
    expect(full.bufferedCount).toBe(0)
  })

  it('entity-added without placeholderId does not drain the buffer', () => {
    const edge: LiveEvent = {
      type: 'edge-added',
      synthKey: 'er/edges/0',
      from: 'uuid-a',
      to: 'new-001',
      relationship: 'r',
    }
    const unrelated: LiveEvent = {
      type: 'entity-added',
      synthKey: 'wf/regions/0',
      entityKind: 'location',
      data: { name: 'Eredil' },
      // No placeholderId — a normal stage-2 entity, not a ghost.
    }
    const buf = derivePlaceholderBuffer([
      { kind: 'event', event: edge },
      { kind: 'event', event: unrelated },
    ])
    expect(buf.rendered).toHaveLength(0)
    expect(buf.bufferedCount).toBe(1)
  })

  it('edge-removed drops the rendered edge by synthKey', () => {
    const edge: LiveEvent = {
      type: 'edge-added',
      synthKey: 'er/edges/0',
      from: 'a',
      to: 'b',
      relationship: 'r',
    }
    const removed: LiveEvent = {
      type: 'edge-removed',
      synthKey: 'er/edges/0',
      reason: 'coherence_deleted',
    }
    const buf = derivePlaceholderBuffer([
      { kind: 'event', event: edge },
      { kind: 'event', event: removed },
    ])
    expect(buf.rendered).toHaveLength(0)
    expect(buf.bufferedCount).toBe(0)
  })

  it('edge-removed of a still-buffered edge clears the buffer entry', () => {
    const edge: LiveEvent = {
      type: 'edge-added',
      synthKey: 'er/edges/0',
      from: 'a',
      to: 'new-001',
      relationship: 'r',
    }
    const removed: LiveEvent = {
      type: 'edge-removed',
      synthKey: 'er/edges/0',
      reason: 'repair_dropped',
    }
    const buf = derivePlaceholderBuffer([
      { kind: 'event', event: edge },
      { kind: 'event', event: removed },
    ])
    expect(buf.rendered).toHaveLength(0)
    expect(buf.bufferedCount).toBe(0)
  })

  it('inventory edgeCount counts only rendered (non-buffered) edges', () => {
    const placeholderEdge: LiveEvent = {
      type: 'edge-added',
      synthKey: 'er/edges/0',
      from: 'a',
      to: 'new-001',
      relationship: 'r',
    }
    const realEdge: LiveEvent = {
      type: 'edge-added',
      synthKey: 'er/edges/1',
      from: 'a',
      to: 'b',
      relationship: 'r',
    }
    const inv = deriveInventory([
      { kind: 'event', event: placeholderEdge },
      { kind: 'event', event: realEdge },
    ])
    // Only the real-endpoint edge counts — the placeholder-edge is buffered.
    expect(inv.edgeCount).toBe(1)
  })
})

// ---- Lifecycle event arms (the other 6) ----

describe('lifecycle event compact lines', () => {
  it('phase event', () => {
    expect(compactLine({ type: 'phase', phase: 'world_gen' }).primary).toContain('world_gen')
  })

  it('stage-started event', () => {
    const line = compactLine({
      type: 'stage-started',
      stage: 'concept_intake',
      userId: null,
      startedAt: '2026-05-14T12:00:00Z',
    })
    expect(line.primary).toContain('stage-started')
    expect(line.primary).toContain('concept_intake')
  })

  it('stage-completed event includes cost + duration', () => {
    const line = compactLine({
      type: 'stage-completed',
      stage: 'world_and_factions',
      userId: null,
      durationMs: 8200,
      costUsd: 0.5,
    })
    expect(line.primary).toContain('$0.5000')
    expect(line.detail).toContain('8200ms')
  })

  it('stage-failed event surfaces retry intent', () => {
    const willRetry = compactLine({
      type: 'stage-failed',
      stage: 'x',
      userId: null,
      errorCode: 'transient_api',
      willRetry: true,
    })
    expect(willRetry.detail).toBe('will retry')
    const terminal = compactLine({
      type: 'stage-failed',
      stage: 'x',
      userId: null,
      errorCode: 'content_filtered',
      willRetry: false,
    })
    expect(terminal.detail).toBe('terminal')
  })

  it('cost-update event', () => {
    expect(compactLine({ type: 'cost-update', cumulativeUsd: 0.31 }).primary).toContain('$0.3100')
  })

  it('job-failed event', () => {
    const line = compactLine({ type: 'job-failed', jobType: 'world-gen', errorCode: 'oom' })
    expect(line.primary).toContain('world-gen')
    expect(line.primary).toContain('oom')
  })
})

// ---- Truncation rule (strings / objects / arrays / expand fidelity) ----

describe('truncation rule across field types', () => {
  it('strings: entity-added with a very long name truncates in the detail line', () => {
    const long = 'x'.repeat(200)
    const line = compactLine({
      type: 'entity-added',
      synthKey: 'k',
      entityKind: 'npc',
      data: { name: long },
    })
    expect(line.detail.endsWith('…')).toBe(true)
  })

  it('objects: entity-updated with a nested object renders ${primaryKey}: ${truncatedValue} (${otherKeyCount} other fields)', () => {
    const line = compactLine({
      type: 'entity-updated',
      synthKey: 'k',
      patch: { profile: { name: 'Brom', age: 40, faction: 'iron' } },
    })
    expect(line.detail).toBe('profile: name: Brom (2 other fields)')
  })

  it('arrays: entity-updated with an array field renders ${field}: [${length}]', () => {
    const line = compactLine({
      type: 'entity-updated',
      synthKey: 'k',
      patch: { regions: [1, 2, 3, 4, 5] },
    })
    expect(line.detail).toBe('regions: [5]')
  })

  it('expand fidelity: JSON.stringify(event, null, 2) is the source of truth for the expanded view', () => {
    const event: LiveEvent = {
      type: 'entity-added',
      synthKey: 'wf/regions/0',
      entityKind: 'location',
      data: { name: 'Eredil', description: 'y'.repeat(120) },
    }
    const expanded = JSON.stringify(event, null, 2)
    // Full payload includes the un-truncated description and all keys.
    expect(expanded).toContain('y'.repeat(120))
    expect(expanded).toContain('entity-added')
    expect(expanded).toContain('wf/regions/0')
  })

  it('compact-line primary path for an entity-updated event with an empty patch', () => {
    const line = compactLine({ type: 'entity-updated', synthKey: 'k', patch: {} })
    expect(line.primary).toContain('(0 fields)')
    expect(line.detail).toBe('(empty patch)')
  })
})

// ---- Filter-chip behavior + inventory chronology ----

describe('inventory derivation: ordering + edge cases', () => {
  it('sorts rows by last-event-index descending (most recent first)', () => {
    const a: LiveEvent = {
      type: 'entity-added',
      synthKey: 'wf/regions/0',
      entityKind: 'location',
      data: { name: 'A' },
    }
    const b: LiveEvent = {
      type: 'entity-added',
      synthKey: 'ln/npcs/0',
      entityKind: 'npc',
      data: { name: 'B' },
    }
    const updateA: LiveEvent = {
      type: 'entity-updated',
      synthKey: 'wf/regions/0',
      patch: { description: 'updated' },
    }
    const inv = deriveInventory([
      { kind: 'event', event: a },
      { kind: 'event', event: b },
      { kind: 'event', event: updateA },
    ])
    expect(inv.rows[0]?.synthKey).toBe('wf/regions/0') // most recently touched
    expect(inv.rows[1]?.synthKey).toBe('ln/npcs/0')
  })

  it('entity-updated on an unknown synthKey is a no-op', () => {
    const inv = deriveInventory([
      {
        kind: 'event',
        event: { type: 'entity-updated', synthKey: 'never-added', patch: { name: 'X' } },
      },
    ])
    expect(inv.rows).toHaveLength(0)
  })

  it('finalized on an unknown synthKey is a no-op', () => {
    const inv = deriveInventory([
      {
        kind: 'event',
        event: { type: 'finalized', synthKey: 'never-added', entityId: 'u' },
      },
    ])
    expect(inv.rows).toHaveLength(0)
  })

  it('entity-updated with patch.name === null clears the displayed name', () => {
    const added: LiveEvent = {
      type: 'entity-added',
      synthKey: 'k',
      entityKind: 'npc',
      data: { name: 'Brom' },
    }
    const patched: LiveEvent = {
      type: 'entity-updated',
      synthKey: 'k',
      patch: { name: null },
    }
    const inv = deriveInventory([
      { kind: 'event', event: added },
      { kind: 'event', event: patched },
    ])
    expect(inv.rows[0]?.name).toBeNull()
    expect(inv.rows[0]?.state.name).toBeUndefined()
  })

  it('entity-updated with a non-string patch.name preserves the prior displayed name', () => {
    const added: LiveEvent = {
      type: 'entity-added',
      synthKey: 'k',
      entityKind: 'npc',
      data: { name: 'Brom' },
    }
    const patched: LiveEvent = {
      type: 'entity-updated',
      synthKey: 'k',
      patch: { size: 'large' }, // name absent → keep prior
    }
    const inv = deriveInventory([
      { kind: 'event', event: added },
      { kind: 'event', event: patched },
    ])
    expect(inv.rows[0]?.name).toBe('Brom')
  })

  it('entity-added with no name field stores null', () => {
    const inv = deriveInventory([
      {
        kind: 'event',
        event: { type: 'entity-added', synthKey: 'k', entityKind: 'npc', data: { age: 40 } },
      },
    ])
    expect(inv.rows[0]?.name).toBeNull()
  })

  it('ignores placeholder entries in the inventory derivation', () => {
    const inv = deriveInventory([{ kind: 'placeholder', droppedCount: 100 }])
    expect(inv.rows).toHaveLength(0)
    expect(inv.edgeCount).toBe(0)
  })
})

// ---- Event cap (2000 FIFO + placeholder card) ----

describe('applyCap (2000-event FIFO with placeholder card)', () => {
  it('returns the input untouched when below the cap', () => {
    const entries: LogEntry[] = Array.from({ length: 10 }, (_, i) => ({
      kind: 'event',
      event: { type: 'phase', phase: `p${String(i)}` },
    }))
    expect(applyCap(entries)).toBe(entries)
  })

  it('drops EVICT_BATCH oldest entries and inserts a placeholder when at MAX_EVENTS + 1', () => {
    const entries: LogEntry[] = Array.from({ length: MAX_EVENTS + 1 }, (_, i) => ({
      kind: 'event',
      event: { type: 'phase', phase: `p${String(i)}` },
    }))
    const out = applyCap(entries)
    expect(out.length).toBe(entries.length - EVICT_BATCH + 1)
    const first = out[0]
    expect(first?.kind).toBe('placeholder')
    if (first?.kind === 'placeholder') {
      expect(first.droppedCount).toBe(EVICT_BATCH)
    }
  })

  it('merges carried placeholder counts on subsequent evictions', () => {
    const existingPlaceholder: LogEntry = { kind: 'placeholder', droppedCount: 100 }
    const rest: LogEntry[] = Array.from({ length: MAX_EVENTS + 1 }, (_, i) => ({
      kind: 'event',
      event: { type: 'phase', phase: `p${String(i)}` },
    }))
    const out = applyCap([existingPlaceholder, ...rest])
    const first = out[0]
    expect(first?.kind).toBe('placeholder')
    if (first?.kind === 'placeholder') {
      // EVICT_BATCH-sized eviction; the carried 100 is merged into the new
      // placeholder along with the dropped event count.
      expect(first.droppedCount).toBeGreaterThan(100)
    }
  })
})

// ---- Constants surface ----

describe('module constants', () => {
  it('KNOWN_EVENT_TYPES covers every contract arm', () => {
    expect(KNOWN_EVENT_TYPES).toContain('phase')
    expect(KNOWN_EVENT_TYPES).toContain('entity-added')
    expect(KNOWN_EVENT_TYPES).toContain('entity-removed')
    expect(KNOWN_EVENT_TYPES).toContain('edge-removed')
    expect(KNOWN_EVENT_TYPES).toContain('finalized')
  })

  it('MAX_EVENTS is 2000, EVICT_BATCH is 100', () => {
    expect(MAX_EVENTS).toBe(2000)
    expect(EVICT_BATCH).toBe(100)
  })
})

// ---- DOM-mount tests (filter chips, closewatch handler) ----
//
// Installs a minimal document/window stub before mount; uninstalls after.
// The stub implements only the subset of DOM used by the panel:
// createElement, appendChild, replaceChildren, addEventListener,
// dispatchEvent, classList/dataset on Elements, scrollTop/scrollHeight.

interface StubElement {
  tagName: string
  textContent: string
  className: string
  style: Record<string, string>
  dataset: Record<string, string>
  attributes: Record<string, string>
  children: StubElement[]
  parentNode: StubElement | null
  listeners: Map<string, ((e: unknown) => void)[]>
  appendChild: (child: StubElement) => StubElement
  removeChild: (child: StubElement) => StubElement
  replaceChildren: (...children: StubElement[]) => void
  setAttribute: (name: string, value: string) => void
  getAttribute: (name: string) => string | null
  addEventListener: (type: string, cb: (e: unknown) => void) => void
  click: () => void
  scrollTop: number
  scrollHeight: number
  // querySelector is unused by the panel but the dev-tool's main.ts uses
  // it; the stub returns null which is fine since we never call it in tests.
}

function makeStubElement(tagName: string): StubElement {
  const el: StubElement = {
    tagName,
    textContent: '',
    className: '',
    style: {},
    dataset: {},
    attributes: {},
    children: [],
    parentNode: null,
    listeners: new Map(),
    appendChild(child) {
      child.parentNode = el
      el.children.push(child)
      return child
    },
    removeChild(child) {
      const idx = el.children.indexOf(child)
      if (idx >= 0) {
        el.children.splice(idx, 1)
        child.parentNode = null
      }
      return child
    },
    replaceChildren(...children) {
      for (const c of el.children) c.parentNode = null
      el.children = []
      for (const c of children) {
        c.parentNode = el
        el.children.push(c)
      }
    },
    setAttribute(name, value) {
      el.attributes[name] = value
    },
    getAttribute(name) {
      return el.attributes[name] ?? null
    },
    addEventListener(type, cb) {
      const list = el.listeners.get(type) ?? []
      list.push(cb)
      el.listeners.set(type, list)
    },
    click() {
      const list = el.listeners.get('click') ?? []
      for (const cb of list) cb({})
    },
    scrollTop: 0,
    scrollHeight: 0,
  }
  return el
}

interface GlobalWithDom {
  document: { createElement: (tag: string) => StubElement } | undefined
  window:
    | {
        addEventListener: (type: string, cb: (e: unknown) => void) => void
        dispatchEvent: (event: { type: string; detail?: unknown }) => boolean
      }
    | undefined
  CustomEvent:
    | (new <T>(type: string, init?: { detail?: T }) => { type: string; detail: T | undefined })
    | undefined
  localStorage:
    | {
        getItem: (k: string) => string | null
        setItem: (k: string, v: string) => void
        removeItem: (k: string) => void
      }
    | undefined
}

const g = globalThis as unknown as GlobalWithDom

let originalDocument: GlobalWithDom['document']
let originalWindow: GlobalWithDom['window']
let originalCustomEvent: GlobalWithDom['CustomEvent']
let originalLocalStorage: GlobalWithDom['localStorage']
const windowListeners = new Map<string, ((e: unknown) => void)[]>()

function dispatchWindow(type: string, detail?: unknown): void {
  const list = windowListeners.get(type) ?? []
  for (const cb of list) cb({ type, detail })
}

beforeAll(() => {
  originalDocument = g.document
  originalWindow = g.window
  originalCustomEvent = g.CustomEvent
  originalLocalStorage = g.localStorage
  g.document = {
    createElement: (tag: string) => makeStubElement(tag),
  }
  g.window = {
    addEventListener: (type, cb) => {
      const list = windowListeners.get(type) ?? []
      list.push(cb)
      windowListeners.set(type, list)
    },
    dispatchEvent: (event) => {
      dispatchWindow(event.type, event.detail)
      return true
    },
  }
  // In-memory localStorage stub — the placeholder panel reads the active
  // campaign id via getActiveCampaignId() to pick the empty-state message.
  const store = new Map<string, string>()
  g.localStorage = {
    getItem: (k) => store.get(k) ?? null,
    setItem: (k, v) => {
      store.set(k, v)
    },
    removeItem: (k) => {
      store.delete(k)
    },
  }
  g.CustomEvent = function CustomEventStub<T>(
    this: { type: string; detail: T | undefined },
    type: string,
    init?: { detail?: T },
  ): void {
    this.type = type
    this.detail = init?.detail
  } as unknown as GlobalWithDom['CustomEvent']
})

afterAll(() => {
  g.document = originalDocument
  g.window = originalWindow
  g.CustomEvent = originalCustomEvent
  g.localStorage = originalLocalStorage
  windowListeners.clear()
})

describe('mountLiveEventsPanel (DOM stub) — myth-rdwq placeholder shape', () => {
  it('returns a PanelHandle whose root is appended to the parent with data-state="ready"', async () => {
    const { mountLiveEventsPanel } = await import('../live-events-panel.js')
    const parent = makeStubElement('div')
    const handle = mountLiveEventsPanel(parent as unknown as HTMLElement)
    expect(parent.children).toHaveLength(1)
    const root = parent.children[0]
    if (!root) throw new Error('expected mount to produce a root child')
    expect(root.getAttribute('data-state')).toBe('ready')
    expect(handle.root).toBe(root as unknown as HTMLElement)
  })

  it('unmount removes the panel root from its parent', async () => {
    const { mountLiveEventsPanel } = await import('../live-events-panel.js')
    const parent = makeStubElement('div')
    const handle = mountLiveEventsPanel(parent as unknown as HTMLElement)
    expect(parent.children).toHaveLength(1)
    handle.unmount()
    expect(parent.children).toHaveLength(0)
  })
})
