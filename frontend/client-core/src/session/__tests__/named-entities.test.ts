import { describe, it, expect } from 'vitest'
import { renderHook } from '@testing-library/react'
import type { WorldGenSnapshot } from '../../api/campaigns.ts'
import { buildEntityIndex } from '../entity-index.ts'
import { accumulateNamedEntities, emptyNamedEntities, useNamedEntities } from '../named-entities.ts'
import type { TranscriptItem } from '../transcript-types.ts'

// ux-run3 myth-ry14g — "the transcript knows better and the sidebar should too".
// The accumulator is the transcript half of the wiki index's presence split: who
// this session has actually named, decided by the SAME mechanical matcher that
// underlines names in the prose.

const INDEX = buildEntityIndex({
  entities: [
    { id: 'n-vellin', entityType: 'npc', name: 'Vellin Ashar' },
    { id: 'n-corin', entityType: 'npc', name: 'Corin Vast' },
    { id: 'l-hall', entityType: 'location', name: 'Hall Six' },
  ],
  facts: [],
  entityHierarchy: [],
  relationships: [],
} satisfies WorldGenSnapshot)

/** The narrowed dm row — the settle test re-spreads one, so the helper must not
 *  widen to the union. */
type DmItem = Extract<TranscriptItem, { kind: 'dm' }>

let nextKey = 0
function dm(text: string, streaming = false): DmItem {
  nextKey += 1
  return { kind: 'dm', key: `dm-${String(nextKey)}`, turnId: `T${String(nextKey)}`, text, streaming }
}

function player(text: string): TranscriptItem {
  nextKey += 1
  return {
    kind: 'player',
    key: `p-${String(nextKey)}`,
    turnId: null,
    seq: nextKey,
    userId: 'u1',
    displayName: 'Ada',
    characterName: 'Kessa',
    text,
    pending: false,
  }
}

describe('accumulateNamedEntities', () => {
  it('collects the entities named in settled DM prose, in first-named order', () => {
    const items = [dm('Hall Six is quiet.'), dm('Vellin Ashar sets down the ledger.')]
    expect(accumulateNamedEntities(emptyNamedEntities, items, INDEX).ids).toEqual(['l-hall', 'n-vellin'])
  })

  it('ignores a still-streaming turn — a half-typed name is not a naming', () => {
    const items = [dm('Vellin Ash', true)]
    expect(accumulateNamedEntities(emptyNamedEntities, items, INDEX).ids).toEqual([])
  })

  it('picks the turn up once it settles', () => {
    const streaming = dm('Vellin Ashar looks up.', true)
    const first = accumulateNamedEntities(emptyNamedEntities, [streaming], INDEX)
    // The SAME row, settled — the reducer flips `streaming` in place.
    const settled: DmItem = { ...streaming, streaming: false }
    expect(accumulateNamedEntities(first, [settled], INDEX).ids).toEqual(['n-vellin'])
  })

  it('scans DM prose only — a player message is not the narration', () => {
    const items = [player('I ask Corin Vast about the key.')]
    expect(accumulateNamedEntities(emptyNamedEntities, items, INDEX).ids).toEqual([])
  })

  it('is cumulative across turns and never repeats an id', () => {
    const first = accumulateNamedEntities(emptyNamedEntities, [dm('Corin Vast waits.')], INDEX)
    const later = accumulateNamedEntities(first, [dm('Corin Vast waits still. Hall Six empties.')], INDEX)
    expect(later.ids).toEqual(['n-corin', 'l-hall'])
  })

  it('returns the SAME state object when no new row was scanned (stable identity)', () => {
    const items = [dm('Hall Six is quiet.')]
    const first = accumulateNamedEntities(emptyNamedEntities, items, INDEX)
    expect(accumulateNamedEntities(first, items, INDEX)).toBe(first)
  })

  it('keeps a scanned row scanned even when it names nobody', () => {
    const items = [dm('The rain does not let up.')]
    const first = accumulateNamedEntities(emptyNamedEntities, items, INDEX)
    expect(first.ids).toEqual([])
    expect(accumulateNamedEntities(first, items, INDEX)).toBe(first)
  })
})

// The route hook around the accumulator. Its contract is the part the wiki's
// presence split depends on: a STABLE array while nothing new is named, and a
// hard reset when the matcher identity changes (a refetched world snapshot must
// not carry the previous compile's ids forward).
describe('useNamedEntities', () => {
  it('returns no ids while the index is still loading', () => {
    const { result } = renderHook(() => useNamedEntities([dm('Corin Vast waits.')], undefined))
    expect(result.current).toEqual([])
  })

  it('accumulates across renders and keeps a stable reference when nothing new is named', () => {
    const first = [dm('Corin Vast waits.')]
    const { result, rerender } = renderHook(
      ({ items }: { items: readonly TranscriptItem[] }) => useNamedEntities(items, INDEX),
      { initialProps: { items: first } },
    )
    expect(result.current).toEqual(['n-corin'])
    const settled = result.current

    const withMore = [...first, dm('Hall Six empties.')]
    rerender({ items: withMore })
    expect(result.current).toEqual(['n-corin', 'l-hall'])

    // A re-render that names nobody new hands back the very same array.
    const grown = [...withMore, dm('The rain does not let up.')]
    rerender({ items: grown })
    expect(result.current).not.toBe(settled)
    const afterGrown = result.current
    rerender({ items: [...grown] })
    expect(result.current).toBe(afterGrown)
  })

  it('resets when the index identity changes — a refetched snapshot starts clean', () => {
    const items = [dm('Corin Vast waits.')] as readonly TranscriptItem[]
    const { result, rerender } = renderHook(
      ({ index }: { index: typeof INDEX }) => useNamedEntities(items, index),
      { initialProps: { index: INDEX } },
    )
    expect(result.current).toEqual(['n-corin'])

    // Same content, new compile: the fold re-runs from empty against the new matcher.
    const refetched = buildEntityIndex({
      entities: [{ id: 'n-corin', entityType: 'npc', name: 'Corin Vast' }],
      facts: [],
      entityHierarchy: [],
      relationships: [],
    } satisfies WorldGenSnapshot)
    rerender({ index: refetched })
    expect(result.current).toEqual(['n-corin'])
  })
})
