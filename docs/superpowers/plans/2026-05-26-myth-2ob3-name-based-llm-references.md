# Name-Based LLM References Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Switch the entity_relationships (stage 4) and coherence_pass stages from UUID-based to name-based LLM I/O, with deterministic name→UUID resolution. Drop the closed `RELATIONSHIP_TYPES` enum.

**Architecture:** A new `name-resolution.ts` module produces a per-pass `NameResolutionContext` with normalized-name → UUID maps. Stage 4's Zod schema and prompt switch to name-based fields; the streaming-extractor takes optional resolver-context + pending-declarations parameters and resolves names→UUIDs server-side before publishing `edge-added` events (the wire format keeps server-minted `new-NNN` synthetic IDs for phantom edges, preserving the frontend's existing `new-`-prefix discrimination). Coherence-pass's 5 patch kinds all switch to name-based identifiers; rename patches apply LAST within a batch so other patches resolve against the pre-rename context.

**Tech Stack:** TypeScript strict, Zod 4 schemas, Vitest, pino logging, Postgres via pg, BullMQ workers, Anthropic SDK via `ai` package.

**Spec:** `docs/superpowers/specs/2026-05-26-myth-2ob3-name-based-llm-references-design.md`
**Bead:** myth-2ob3

---

## File map

### New files
- `backend/src/llm/prep/name-resolution.ts` — resolver module
- `backend/src/llm/prep/__tests__/name-resolution.test.ts` — unit tests

### Modified files
- `backend/src/llm/schemas/entity-relationships.ts` — drop enum, rename fields
- `backend/src/llm/schemas/coherence-output.ts` — 5 patch kinds → name-based
- `backend/src/llm/prompts/prep/entity-relationships.txt` — name-based + verb-shape + field ordering
- `backend/src/llm/prompts/prep/coherence-pass.txt` — name-based + rename ordering + verb-shape + stale-prose reminder
- `backend/src/llm/prep/streaming-extractor.ts` — optional resolver context + field rename in `shouldEmitEdge`/`publishEdgeAdded`
- `backend/src/llm/prep/stages/entity-relationships.ts` — wire resolver, manage pendingDeclarations, name-resolve in persist
- `backend/src/llm/prep/stages/coherence-pass.ts` — use resolver, partition rename patches to apply last
- `backend/src/llm/prep/stages/__tests__/entity-relationships.test.ts` — fixtures → names
- `backend/src/llm/prep/stages/__tests__/coherence-pass.test.ts` — fixtures → names

### Wiki
- `docs/wiki/content/.../*.html` — schema reference page that documents the 16-verb enum (locate during task 17)

---

## Task 1: Name normalization helper

**Files:**
- Create: `backend/src/llm/prep/name-resolution.ts`
- Test: `backend/src/llm/prep/__tests__/name-resolution.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// backend/src/llm/prep/__tests__/name-resolution.test.ts
import { describe, it, expect } from 'vitest'
import { normalizeName } from '../name-resolution.js'

describe('normalizeName', () => {
  it('trims leading and trailing whitespace', () => {
    expect(normalizeName('  Mother Ehren  ')).toBe('Mother Ehren')
  })

  it('collapses internal whitespace runs to a single space', () => {
    expect(normalizeName('Mother  Ehren\t\tSalt-Tongue')).toBe('Mother Ehren Salt-Tongue')
  })

  it('applies Unicode NFC normalization', () => {
    // 'é' as NFD (e + combining acute) vs NFC (single code point)
    const nfd = 'Marén'
    const nfc = 'Marén'
    expect(nfd).not.toBe(nfc)
    expect(normalizeName(nfd)).toBe(nfc)
  })

  it('preserves case (case-sensitive contract)', () => {
    expect(normalizeName('The Drowned Quarter')).toBe('The Drowned Quarter')
    expect(normalizeName('the drowned quarter')).toBe('the drowned quarter')
    expect(normalizeName('The Drowned Quarter')).not.toBe(normalizeName('the drowned quarter'))
  })

  it('is idempotent', () => {
    const input = '  Mother   Ehren  '
    const once = normalizeName(input)
    expect(normalizeName(once)).toBe(once)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd backend && pnpm exec vitest run src/llm/prep/__tests__/name-resolution.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write minimal implementation**

```ts
// backend/src/llm/prep/name-resolution.ts
//
// myth-2ob3: pure-functional name resolver shared by entity_relationships
// and coherence_pass stages. Maps LLM-emitted names to canonical UUIDs
// against a per-pass inventory snapshot.

/**
 * Normalize a name for lookup. Pure hygiene:
 *  - NFC-normalize Unicode (composed form)
 *  - trim leading/trailing whitespace
 *  - collapse internal whitespace runs (including tabs/newlines) to one space
 *
 * Case-sensitive. NO fuzzy matching, NO Levenshtein. If the LLM emits
 * "the Drowned Quarter" for an entity "The Drowned Quarter", resolution
 * still misses — that's a real model error to surface, not paper over.
 */
export function normalizeName(name: string): string {
  return name.normalize('NFC').trim().replace(/\s+/g, ' ')
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd backend && pnpm exec vitest run src/llm/prep/__tests__/name-resolution.test.ts`
Expected: PASS, 5/5.

- [ ] **Step 5: Commit**

```bash
git add backend/src/llm/prep/name-resolution.ts backend/src/llm/prep/__tests__/name-resolution.test.ts
git commit -m "feat(myth-2ob3): name-resolution module — normalizeName helper"
```

---

## Task 2: NameResolutionContext type + builder

**Files:**
- Modify: `backend/src/llm/prep/name-resolution.ts`
- Test: `backend/src/llm/prep/__tests__/name-resolution.test.ts`

- [ ] **Step 1: Write the failing test**

Append to `backend/src/llm/prep/__tests__/name-resolution.test.ts`:

```ts
import { buildResolutionContext } from '../name-resolution.js'
import type { WorldInventory } from '../world-dump.js'

function makeInv(): WorldInventory {
  return {
    entitiesById: new Map([
      ['ent-1', { id: 'ent-1', name: 'Mother Ehren', entityType: 'npc', accessLevel: 'known' }],
      ['ent-2', { id: 'ent-2', name: '  The Drowned Quarter  ', entityType: 'location', accessLevel: 'known' }],
      ['ent-dup-a', { id: 'ent-dup-a', name: 'Pell', entityType: 'npc', accessLevel: 'known' }],
      ['ent-dup-b', { id: 'ent-dup-b', name: 'Pell', entityType: 'npc', accessLevel: 'known' }],
    ]),
    proseByEntityId: new Map(),
    factsById: new Map([
      ['fact-1', { id: 'fact-1', entityId: 'ent-1', topic: 'role', content: 'Elder.', accessLevel: 'known' }],
      ['fact-2', { id: 'fact-2', entityId: 'ent-1', topic: 'history', content: 'Was once...', accessLevel: 'known' }],
      ['fact-3', { id: 'fact-3', entityId: 'ent-1', topic: 'history', content: 'Also history.', accessLevel: 'known' }],
    ]),
    relationshipsById: new Map([
      ['rel-1', { id: 'rel-1', sourceEntityId: 'ent-1', targetEntityId: 'ent-2', relationshipType: 'leads', description: 'd' }],
    ]),
  }
}

describe('buildResolutionContext', () => {
  it('maps normalized entity names to ids', () => {
    const ctx = buildResolutionContext(makeInv())
    expect(ctx.entityIdByName.get('Mother Ehren')).toBe('ent-1')
    // Whitespace normalized at build time.
    expect(ctx.entityIdByName.get('The Drowned Quarter')).toBe('ent-2')
  })

  it('records duplicate-name entities so the resolver can detect ambiguity', () => {
    const ctx = buildResolutionContext(makeInv())
    expect(ctx.ambiguousEntityNames.has('Pell')).toBe(true)
  })

  it('maps (entity name, fact topic) to fact ids; duplicate topics flagged ambiguous', () => {
    const ctx = buildResolutionContext(makeInv())
    expect(ctx.factIdByPair.get('Mother Ehren')?.get('role')).toEqual(['fact-1'])
    expect(ctx.factIdByPair.get('Mother Ehren')?.get('history')).toEqual(['fact-2', 'fact-3'])
  })

  it('maps (source, target, type) triples to relationship ids', () => {
    const ctx = buildResolutionContext(makeInv())
    expect(
      ctx.relIdByTriple.get('Mother Ehren')?.get('The Drowned Quarter')?.get('leads'),
    ).toEqual(['rel-1'])
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd backend && pnpm exec vitest run src/llm/prep/__tests__/name-resolution.test.ts`
Expected: FAIL — `buildResolutionContext is not a function`.

- [ ] **Step 3: Write minimal implementation**

Append to `backend/src/llm/prep/name-resolution.ts`:

```ts
import type { WorldInventory } from './world-dump.js'

/**
 * Per-pass resolution context. Built ONCE from a world inventory snapshot.
 * For coherence_pass, rename patches apply LAST (after all other patches
 * have used this context), so the context is never mutated mid-pass.
 */
export interface NameResolutionContext {
  /** Normalized entity name -> entityId. Excludes duplicates. */
  readonly entityIdByName: ReadonlyMap<string, string>
  /** Names that appear on multiple entities. Resolution drops with WARN. */
  readonly ambiguousEntityNames: ReadonlySet<string>
  /** Normalized entity name -> (topic -> [factIds]). >1 fact = ambiguous. */
  readonly factIdByPair: ReadonlyMap<string, ReadonlyMap<string, readonly string[]>>
  /** srcName -> tgtName -> type -> [relIds]. >1 = ambiguous. */
  readonly relIdByTriple: ReadonlyMap<
    string,
    ReadonlyMap<string, ReadonlyMap<string, readonly string[]>>
  >
}

export function buildResolutionContext(inv: WorldInventory): NameResolutionContext {
  const entityIdByName = new Map<string, string>()
  const seenNames = new Set<string>()
  const ambiguousEntityNames = new Set<string>()
  for (const e of inv.entitiesById.values()) {
    const n = normalizeName(e.name)
    if (seenNames.has(n)) {
      ambiguousEntityNames.add(n)
      entityIdByName.delete(n)
      continue
    }
    seenNames.add(n)
    if (!ambiguousEntityNames.has(n)) entityIdByName.set(n, e.id)
  }

  const factIdByPair = new Map<string, Map<string, string[]>>()
  for (const f of inv.factsById.values()) {
    const ent = inv.entitiesById.get(f.entityId)
    if (ent === undefined) continue
    const entName = normalizeName(ent.name)
    let byTopic = factIdByPair.get(entName)
    if (byTopic === undefined) {
      byTopic = new Map()
      factIdByPair.set(entName, byTopic)
    }
    const arr = byTopic.get(f.topic) ?? []
    arr.push(f.id)
    byTopic.set(f.topic, arr)
  }

  const relIdByTriple = new Map<string, Map<string, Map<string, string[]>>>()
  for (const r of inv.relationshipsById.values()) {
    const src = inv.entitiesById.get(r.sourceEntityId)
    const tgt = inv.entitiesById.get(r.targetEntityId)
    if (src === undefined || tgt === undefined) continue
    const sn = normalizeName(src.name)
    const tn = normalizeName(tgt.name)
    let byTgt = relIdByTriple.get(sn)
    if (byTgt === undefined) {
      byTgt = new Map()
      relIdByTriple.set(sn, byTgt)
    }
    let byType = byTgt.get(tn)
    if (byType === undefined) {
      byType = new Map()
      byTgt.set(tn, byType)
    }
    const arr = byType.get(r.relationshipType) ?? []
    arr.push(r.id)
    byType.set(r.relationshipType, arr)
  }

  return { entityIdByName, ambiguousEntityNames, factIdByPair, relIdByTriple }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd backend && pnpm exec vitest run src/llm/prep/__tests__/name-resolution.test.ts`
Expected: PASS, 9/9.

- [ ] **Step 5: Commit**

```bash
git add backend/src/llm/prep/name-resolution.ts backend/src/llm/prep/__tests__/name-resolution.test.ts
git commit -m "feat(myth-2ob3): NameResolutionContext + buildResolutionContext"
```

---

## Task 3: Relationship resolver (resolveRelationship)

**Files:**
- Modify: `backend/src/llm/prep/name-resolution.ts`
- Test: `backend/src/llm/prep/__tests__/name-resolution.test.ts`

- [ ] **Step 1: Write the failing test**

Append to the test file:

```ts
import { resolveRelationship } from '../name-resolution.js'

const decls = new Map<string, { synthId: string; entityType: string }>([
  ['The Whisper Council', { synthId: 'new-001', entityType: 'faction' }],
])

describe('resolveRelationship', () => {
  it('resolves both endpoints when both names are in inventory', () => {
    const ctx = buildResolutionContext(makeInv())
    const r = resolveRelationship(ctx, {
      from_name: 'Mother Ehren', to_name: 'The Drowned Quarter',
      relationship: 'leads', description: 'd',
    }, decls)
    expect(r.kind).toBe('resolved')
    if (r.kind === 'resolved') {
      expect(r.sourceEntityId).toBe('ent-1')
      expect(r.targetEntityId).toBe('ent-2')
      expect(r.relationshipType).toBe('leads')
    }
  })

  it('returns phantom_target when source is real and target is a declaration', () => {
    const ctx = buildResolutionContext(makeInv())
    const r = resolveRelationship(ctx, {
      from_name: 'Mother Ehren', to_name: 'The Whisper Council',
      relationship: 'pursues', description: 'd',
    }, decls)
    expect(r.kind).toBe('phantom_target')
  })

  it('drops with unknown_source when source name is not in inventory or declarations', () => {
    const ctx = buildResolutionContext(makeInv())
    const r = resolveRelationship(ctx, {
      from_name: 'Nobody', to_name: 'The Drowned Quarter',
      relationship: 'leads', description: 'd',
    }, decls)
    expect(r.kind).toBe('dropped')
    if (r.kind === 'dropped') expect(r.reason).toBe('unknown_source')
  })

  it('drops with ambiguous_source when source name has multiple inventory matches', () => {
    const ctx = buildResolutionContext(makeInv())
    const r = resolveRelationship(ctx, {
      from_name: 'Pell', to_name: 'The Drowned Quarter',
      relationship: 'leads', description: 'd',
    }, decls)
    expect(r.kind).toBe('dropped')
    if (r.kind === 'dropped') expect(r.reason).toBe('ambiguous_source')
  })

  it('normalizes whitespace before lookup', () => {
    const ctx = buildResolutionContext(makeInv())
    const r = resolveRelationship(ctx, {
      from_name: '  Mother  Ehren  ', to_name: 'The Drowned Quarter',
      relationship: 'leads', description: 'd',
    }, decls)
    expect(r.kind).toBe('resolved')
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd backend && pnpm exec vitest run src/llm/prep/__tests__/name-resolution.test.ts`
Expected: FAIL — `resolveRelationship is not a function`.

- [ ] **Step 3: Write minimal implementation**

Append to `backend/src/llm/prep/name-resolution.ts`:

```ts
export interface ResolvedRelationship {
  readonly kind: 'resolved'
  readonly sourceEntityId: string
  readonly targetEntityId: string
  readonly relationshipType: string
  readonly description: string
}
export interface PhantomTarget {
  readonly kind: 'phantom_target'
  readonly sourceEntityId: string
  readonly phantomName: string
  readonly synthId: string
  readonly relationshipType: string
  readonly description: string
}
export interface PhantomSource {
  readonly kind: 'phantom_source'
  readonly phantomName: string
  readonly synthId: string
  readonly targetEntityId: string
  readonly relationshipType: string
  readonly description: string
}
export interface PhantomBoth {
  readonly kind: 'phantom_both'
  readonly sourceName: string
  readonly sourceSynthId: string
  readonly targetName: string
  readonly targetSynthId: string
  readonly relationshipType: string
  readonly description: string
}
export interface DroppedRelationship {
  readonly kind: 'dropped'
  readonly reason:
    | 'unknown_source'
    | 'unknown_target'
    | 'unknown_both'
    | 'ambiguous_source'
    | 'ambiguous_target'
}
export type RelationshipResolution =
  | ResolvedRelationship
  | PhantomTarget
  | PhantomSource
  | PhantomBoth
  | DroppedRelationship

export interface EmittedRelationship {
  readonly from_name: string
  readonly to_name: string
  readonly relationship: string
  readonly description: string
}

type DeclarationsMap = ReadonlyMap<string, { readonly synthId: string; readonly entityType: string }>

function lookupEndpoint(
  ctx: NameResolutionContext,
  rawName: string,
  decls: DeclarationsMap,
): { kind: 'real'; id: string } | { kind: 'phantom'; synthId: string } | { kind: 'unknown' } | { kind: 'ambiguous' } {
  const n = normalizeName(rawName)
  if (ctx.ambiguousEntityNames.has(n)) return { kind: 'ambiguous' }
  const real = ctx.entityIdByName.get(n)
  if (real !== undefined) return { kind: 'real', id: real }
  const phantom = decls.get(n)
  if (phantom !== undefined) return { kind: 'phantom', synthId: phantom.synthId }
  return { kind: 'unknown' }
}

export function resolveRelationship(
  ctx: NameResolutionContext,
  emitted: EmittedRelationship,
  declarations: DeclarationsMap,
): RelationshipResolution {
  const from = lookupEndpoint(ctx, emitted.from_name, declarations)
  const to = lookupEndpoint(ctx, emitted.to_name, declarations)

  if (from.kind === 'ambiguous') return { kind: 'dropped', reason: 'ambiguous_source' }
  if (to.kind === 'ambiguous') return { kind: 'dropped', reason: 'ambiguous_target' }

  if (from.kind === 'real' && to.kind === 'real') {
    return {
      kind: 'resolved',
      sourceEntityId: from.id,
      targetEntityId: to.id,
      relationshipType: emitted.relationship,
      description: emitted.description,
    }
  }
  if (from.kind === 'real' && to.kind === 'phantom') {
    return {
      kind: 'phantom_target',
      sourceEntityId: from.id,
      phantomName: normalizeName(emitted.to_name),
      synthId: to.synthId,
      relationshipType: emitted.relationship,
      description: emitted.description,
    }
  }
  if (from.kind === 'phantom' && to.kind === 'real') {
    return {
      kind: 'phantom_source',
      phantomName: normalizeName(emitted.from_name),
      synthId: from.synthId,
      targetEntityId: to.id,
      relationshipType: emitted.relationship,
      description: emitted.description,
    }
  }
  if (from.kind === 'phantom' && to.kind === 'phantom') {
    return {
      kind: 'phantom_both',
      sourceName: normalizeName(emitted.from_name),
      sourceSynthId: from.synthId,
      targetName: normalizeName(emitted.to_name),
      targetSynthId: to.synthId,
      relationshipType: emitted.relationship,
      description: emitted.description,
    }
  }
  // At least one unknown endpoint.
  if (from.kind === 'unknown' && to.kind === 'unknown') {
    return { kind: 'dropped', reason: 'unknown_both' }
  }
  if (from.kind === 'unknown') return { kind: 'dropped', reason: 'unknown_source' }
  return { kind: 'dropped', reason: 'unknown_target' }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd backend && pnpm exec vitest run src/llm/prep/__tests__/name-resolution.test.ts`
Expected: PASS, 14/14.

- [ ] **Step 5: Commit**

```bash
git add backend/src/llm/prep/name-resolution.ts backend/src/llm/prep/__tests__/name-resolution.test.ts
git commit -m "feat(myth-2ob3): resolveRelationship + tagged-union outcomes"
```

---

## Task 4: Fact, prose, rename, delete-relationship resolvers

**Files:**
- Modify: `backend/src/llm/prep/name-resolution.ts`
- Test: `backend/src/llm/prep/__tests__/name-resolution.test.ts`

- [ ] **Step 1: Write the failing test**

Append to the test file:

```ts
import {
  resolveFact,
  resolveProseTarget,
  resolveRename,
  resolveDeleteRelationship,
  resolveFixRelationship,
} from '../name-resolution.js'

describe('resolveFact', () => {
  it('resolves a unique (entity, topic) pair to a fact id', () => {
    const ctx = buildResolutionContext(makeInv())
    const r = resolveFact(ctx, { entity_name: 'Mother Ehren', fact_topic: 'role' })
    expect(r.kind).toBe('resolved')
    if (r.kind === 'resolved') expect(r.factId).toBe('fact-1')
  })

  it('drops on ambiguous (multiple facts under same topic)', () => {
    const ctx = buildResolutionContext(makeInv())
    const r = resolveFact(ctx, { entity_name: 'Mother Ehren', fact_topic: 'history' })
    expect(r.kind).toBe('dropped')
    if (r.kind === 'dropped') expect(r.reason).toBe('ambiguous_fact')
  })

  it('drops on unknown entity name', () => {
    const ctx = buildResolutionContext(makeInv())
    const r = resolveFact(ctx, { entity_name: 'Nobody', fact_topic: 'role' })
    expect(r.kind).toBe('dropped')
    if (r.kind === 'dropped') expect(r.reason).toBe('unknown_entity')
  })

  it('drops on unknown topic', () => {
    const ctx = buildResolutionContext(makeInv())
    const r = resolveFact(ctx, { entity_name: 'Mother Ehren', fact_topic: 'nonexistent' })
    expect(r.kind).toBe('dropped')
    if (r.kind === 'dropped') expect(r.reason).toBe('unknown_fact')
  })
})

describe('resolveProseTarget', () => {
  it('resolves an entity by name', () => {
    const ctx = buildResolutionContext(makeInv())
    const r = resolveProseTarget(ctx, { entity_name: 'Mother Ehren' })
    expect(r.kind).toBe('resolved')
    if (r.kind === 'resolved') expect(r.entityId).toBe('ent-1')
  })

  it('drops on ambiguous entity name', () => {
    const ctx = buildResolutionContext(makeInv())
    const r = resolveProseTarget(ctx, { entity_name: 'Pell' })
    expect(r.kind).toBe('dropped')
    if (r.kind === 'dropped') expect(r.reason).toBe('ambiguous_entity')
  })
})

describe('resolveRename', () => {
  it('resolves old_name to entityId', () => {
    const ctx = buildResolutionContext(makeInv())
    const r = resolveRename(ctx, { old_name: 'Mother Ehren', new_name: 'Mother E' })
    expect(r.kind).toBe('resolved')
    if (r.kind === 'resolved') {
      expect(r.entityId).toBe('ent-1')
      expect(r.newName).toBe('Mother E')
    }
  })
})

describe('resolveFixRelationship / resolveDeleteRelationship', () => {
  it('resolves a unique (source, target, type) triple to a relationship id', () => {
    const ctx = buildResolutionContext(makeInv())
    const r = resolveFixRelationship(ctx, {
      source_name: 'Mother Ehren', target_name: 'The Drowned Quarter', current_type: 'leads',
    })
    expect(r.kind).toBe('resolved')
    if (r.kind === 'resolved') expect(r.relationshipId).toBe('rel-1')
  })

  it('drops when triple matches nothing', () => {
    const ctx = buildResolutionContext(makeInv())
    const r = resolveDeleteRelationship(ctx, {
      source_name: 'Mother Ehren', target_name: 'The Drowned Quarter', current_type: 'rivals',
    })
    expect(r.kind).toBe('dropped')
    if (r.kind === 'dropped') expect(r.reason).toBe('unknown_relationship')
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd backend && pnpm exec vitest run src/llm/prep/__tests__/name-resolution.test.ts`
Expected: FAIL — exports missing.

- [ ] **Step 3: Write minimal implementation**

Append to `backend/src/llm/prep/name-resolution.ts`:

```ts
export type FactResolution =
  | { kind: 'resolved'; factId: string; entityId: string }
  | { kind: 'dropped'; reason: 'unknown_entity' | 'ambiguous_entity' | 'unknown_fact' | 'ambiguous_fact' }

export function resolveFact(
  ctx: NameResolutionContext,
  emitted: { entity_name: string; fact_topic: string },
): FactResolution {
  const n = normalizeName(emitted.entity_name)
  if (ctx.ambiguousEntityNames.has(n)) return { kind: 'dropped', reason: 'ambiguous_entity' }
  const entityId = ctx.entityIdByName.get(n)
  if (entityId === undefined) return { kind: 'dropped', reason: 'unknown_entity' }
  const byTopic = ctx.factIdByPair.get(n)
  const matches = byTopic?.get(emitted.fact_topic) ?? []
  if (matches.length === 0) return { kind: 'dropped', reason: 'unknown_fact' }
  if (matches.length > 1) return { kind: 'dropped', reason: 'ambiguous_fact' }
  return { kind: 'resolved', factId: matches[0]!, entityId }
}

export type EntityResolution =
  | { kind: 'resolved'; entityId: string }
  | { kind: 'dropped'; reason: 'unknown_entity' | 'ambiguous_entity' }

export function resolveProseTarget(
  ctx: NameResolutionContext,
  emitted: { entity_name: string },
): EntityResolution {
  const n = normalizeName(emitted.entity_name)
  if (ctx.ambiguousEntityNames.has(n)) return { kind: 'dropped', reason: 'ambiguous_entity' }
  const id = ctx.entityIdByName.get(n)
  if (id === undefined) return { kind: 'dropped', reason: 'unknown_entity' }
  return { kind: 'resolved', entityId: id }
}

export type RenameResolution =
  | { kind: 'resolved'; entityId: string; newName: string }
  | { kind: 'dropped'; reason: 'unknown_entity' | 'ambiguous_entity' }

export function resolveRename(
  ctx: NameResolutionContext,
  emitted: { old_name: string; new_name: string },
): RenameResolution {
  const n = normalizeName(emitted.old_name)
  if (ctx.ambiguousEntityNames.has(n)) return { kind: 'dropped', reason: 'ambiguous_entity' }
  const id = ctx.entityIdByName.get(n)
  if (id === undefined) return { kind: 'dropped', reason: 'unknown_entity' }
  return { kind: 'resolved', entityId: id, newName: emitted.new_name }
}

export type RelationshipPatchResolution =
  | { kind: 'resolved'; relationshipId: string }
  | { kind: 'dropped'; reason: 'unknown_relationship' | 'ambiguous_relationship' }

function lookupRelTriple(
  ctx: NameResolutionContext,
  src: string, tgt: string, type: string,
): RelationshipPatchResolution {
  const sn = normalizeName(src)
  const tn = normalizeName(tgt)
  const arr = ctx.relIdByTriple.get(sn)?.get(tn)?.get(type) ?? []
  if (arr.length === 0) return { kind: 'dropped', reason: 'unknown_relationship' }
  if (arr.length > 1) return { kind: 'dropped', reason: 'ambiguous_relationship' }
  return { kind: 'resolved', relationshipId: arr[0]! }
}

export function resolveFixRelationship(
  ctx: NameResolutionContext,
  emitted: { source_name: string; target_name: string; current_type: string },
): RelationshipPatchResolution {
  return lookupRelTriple(ctx, emitted.source_name, emitted.target_name, emitted.current_type)
}

export function resolveDeleteRelationship(
  ctx: NameResolutionContext,
  emitted: { source_name: string; target_name: string; current_type: string },
): RelationshipPatchResolution {
  return lookupRelTriple(ctx, emitted.source_name, emitted.target_name, emitted.current_type)
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd backend && pnpm exec vitest run src/llm/prep/__tests__/name-resolution.test.ts`
Expected: PASS, 22/22.

- [ ] **Step 5: Commit**

```bash
git add backend/src/llm/prep/name-resolution.ts backend/src/llm/prep/__tests__/name-resolution.test.ts
git commit -m "feat(myth-2ob3): resolveFact/Prose/Rename/FixRelationship/DeleteRelationship"
```

---

## Task 5: Rewrite entity_relationships Zod schema

**Files:**
- Modify: `backend/src/llm/schemas/entity-relationships.ts`

- [ ] **Step 1: Write the failing test (use the existing schema test file)**

Append to `backend/src/llm/schemas/__tests__/entity-relationships.test.ts` (create if absent):

```ts
import { describe, it, expect } from 'vitest'
import {
  EntityRelationshipsSchema,
  relationshipItemSchema,
  declarationItemSchema,
} from '../entity-relationships.js'

describe('entity-relationships schema (name-based)', () => {
  it('accepts a relationship with from_name + to_name + free-text relationship', () => {
    const r = relationshipItemSchema.safeParse({
      from_name: 'Mother Ehren',
      to_name: 'The Drowned Quarter',
      relationship: 'leads',
      description: 'Mother Ehren leads the Quarter through council.',
    })
    expect(r.success).toBe(true)
  })

  it('rejects a relationship missing from_name', () => {
    const r = relationshipItemSchema.safeParse({
      to_name: 'X', relationship: 'leads', description: 'short description here',
    })
    expect(r.success).toBe(false)
  })

  it('declarationItemSchema drops placeholder_id', () => {
    const r = declarationItemSchema.safeParse({
      name: 'The Whisper Council', entity_type: 'faction',
    })
    expect(r.success).toBe(true)
  })

  it('full tree validates with name-based shape', () => {
    const r = EntityRelationshipsSchema.safeParse({
      relationships: Array.from({ length: 5 }, (_, i) => ({
        from_name: `A${String(i)}`, to_name: `B${String(i)}`,
        relationship: 'allied_with', description: 'plausible 10-plus char description',
      })),
      hierarchy_stragglers: [],
      new_entity_declarations: [],
    })
    expect(r.success).toBe(true)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd backend && pnpm exec vitest run src/llm/schemas/__tests__/entity-relationships.test.ts`
Expected: FAIL — schema still uses `from`/`to`/enum.

- [ ] **Step 3: Rewrite the schema**

Replace the body of `backend/src/llm/schemas/entity-relationships.ts` with:

```ts
// backend/src/llm/schemas/entity-relationships.ts
//
// Stage 4 (`entity_relationships`) Zod schema. Per myth-2ob3 design.
//
// LLM I/O is name-based: `from_name` + `to_name` identify endpoints by
// their normalized name as listed in the worldDump. `relationship` is
// free-text (short verb-phrase predicate; verb-shape guidance lives in
// the prompt, not the schema). The server-side resolver maps names →
// UUIDs before INSERT; unresolvable rows are dropped with a WARN.
//
// `hierarchy_stragglers` uses parent/child names (same lookup).
// `new_entity_declarations` no longer carries placeholder_id — the
// SERVER mints `new-NNN` synthetic IDs for declared phantoms and binds
// them by normalized name.
//
// `relationships.min(5)`: asserts the LLM produced something. A world
// with 30+ entities (typical after stages 2+3) but zero structured
// relationships is a quality failure — min(5) makes that fail Zod and
// trigger the repair-chain.

import { z } from 'zod'

export const declarationItemSchema = z.object({
  name: z.string().min(1).max(200),
  entity_type: z.enum(['faction', 'location', 'npc']),
})

export const relationshipItemSchema = z.object({
  from_name: z.string().min(1).max(200),
  to_name: z.string().min(1).max(200),
  relationship: z.string().min(2).max(60),
  description: z.string().min(10).max(600),
})

export const hierarchyStragglerItemSchema = z.object({
  parent_name: z.string().min(1).max(200),
  child_name: z.string().min(1).max(200),
})

export const EntityRelationshipsSchema = z.object({
  // Field order matters: declarations BEFORE relationships so the
  // mid-stream resolver finds phantoms by the time relationships
  // reference them (design §5 JSON-key-ordering mitigation).
  new_entity_declarations: z.array(declarationItemSchema).max(15),
  relationships: z.array(relationshipItemSchema).min(5).max(80),
  hierarchy_stragglers: z.array(hierarchyStragglerItemSchema).max(20),
})

export type EntityRelationshipsOutput = z.infer<typeof EntityRelationshipsSchema>
export type RelationshipItem = z.infer<typeof relationshipItemSchema>
export type HierarchyStragglerItem = z.infer<typeof hierarchyStragglerItemSchema>
export type DeclarationItem = z.infer<typeof declarationItemSchema>
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd backend && pnpm exec vitest run src/llm/schemas/__tests__/entity-relationships.test.ts`
Expected: PASS, 4/4. The old schema tests (if any reference removed exports) need to be deleted or updated.

- [ ] **Step 5: Commit**

```bash
git add backend/src/llm/schemas/entity-relationships.ts backend/src/llm/schemas/__tests__/entity-relationships.test.ts
git commit -m "feat(myth-2ob3): entity-relationships schema — name-based + free-text type"
```

---

## Task 6: Rewrite entity_relationships prompt template

**Files:**
- Modify: `backend/src/llm/prompts/prep/entity-relationships.txt`

- [ ] **Step 1: Write the prompt body**

Replace the entire contents of `backend/src/llm/prompts/prep/entity-relationships.txt` with:

```
{# Stage 4 (entity_relationships) — myth-2ob3 name-based revision.
   The worker renders the entityInventory placeholder with each entity's
   normalized name, kind, and brief prose. The LLM emits relationships
   referencing entities by their EXACT name; the server resolves names
   to UUIDs before INSERT. Unresolved names are dropped with a WARN. #}

You are formalizing the structured relationships between entities in a freshly-generated D&D 5e world. Stages 2 and 3 produced regions, factions, locations, and NPCs along with prose that often describes how those entities relate. Your job is to extract those relationships into structured form so downstream systems can reason about them mechanically.

## World Vocabulary

{{vocabularyRegistry}}

## World Summary

- **Name:** {{worldName}}
- **Tone:** {{tone}}
- **Themes:** {{themes}}
- **Key tensions:** {{keyTensions}}

## Entity Inventory

Each entity below is identified by its **name** — the exact string you must echo back when referencing this entity. Case-sensitive. Do not paraphrase, do not abbreviate, do not add articles the name didn't have. The system will silently drop any relationship that references a name not in this list.

{{entityInventory}}

## Your Task

Produce a JSON object with three arrays, in this order:

1. **`new_entity_declarations`** — up to 15 entries (may be empty). For any entity named in the prose above that is NOT in the inventory, declare it here so the system knows to create it. Use the same name spelling you'll use when referencing the entity in `relationships` below. Each declaration: `{ "name": "<exact name>", "entity_type": "faction" | "location" | "npc" }`.

2. **`relationships`** — between 5 and 80 entries. Each entry:
   - **`from_name`** — the source entity's name, exactly as listed in the inventory (or in `new_entity_declarations`).
   - **`to_name`** — the target entity's name, same constraints.
   - **`relationship`** — a short verb or verb-phrase predicate. Typically 1–3 words, snake_case preferred, ≤30 characters. Examples: `allied_with`, `pursues`, `former_servant_of`, `courted_by`, `professional_counterparty_of`, `mentors`, `betrayed_by`, `serves`, `member_of`, `leads`, `controls`. Do NOT write a full sentence here — sentence-level texture goes in `description`.
   - **`description`** — 10–600 characters of free text describing the relationship. Concrete, specific, grounded in the prose above. Do not restate the `relationship` predicate; expand on it. If the relationship is contested, asymmetric, or has nuance the verb can't capture, this is where that texture lives.

3. **`hierarchy_stragglers`** — up to 20 entries (may be empty). Each entry: `{ "parent_name": "<exact name>", "child_name": "<exact name>" }`. Use this ONLY for parent-child location containment that stage 3 missed — for example, a settlement that should be inside a region but wasn't linked. Do NOT use this for ordinary relationships; those go in `relationships`.

## Declaring missing entities (phantom references)

When the prose names a faction, location, or NPC that is NOT in the inventory above — call this a "phantom reference" — you MUST declare it in `new_entity_declarations` rather than skip the relationship. The system will create the real entity in a subsequent step.

Worked example. The inventory contains "The Long Vigil" but the prose mentions "The Ironjaw" contesting territory with it — and "The Ironjaw" is not in the inventory. The correct output is:

```
{
  "new_entity_declarations": [
    { "name": "The Ironjaw", "entity_type": "faction" }
  ],
  "relationships": [
    {
      "from_name": "The Long Vigil",
      "to_name": "The Ironjaw",
      "relationship": "rival_of",
      "description": "The Long Vigil and the Ironjaw contest territory in the Bone Reach."
    }
  ],
  "hierarchy_stragglers": []
}
```

Rules:
- Declare a phantom ONLY when the entity is named explicitly in prose AND is needed as a relationship endpoint. Don't invent entities to pad the world.
- Every name used in `relationships.from_name` or `relationships.to_name` MUST either appear in the inventory OR have a matching `new_entity_declarations` entry. Names that match neither are silently dropped.
- If your prose references an entity that's already in the inventory (even loosely), DO NOT declare a phantom for it — use the inventory entry. The system prefers inventory matches over declarations on name collision.

## Guidance

- Surface relationships the prose makes explicit. Don't invent dynamics the world doesn't describe.
- It's fine for two entities to have multiple distinct relationships (e.g., `allied_with` AND `family_member`); emit one row per logical relationship.
- The `relationship` predicate should be one the world's setting actually supports. Don't reach for generic categories when a specific one fits.
- Description should add information the predicate doesn't carry: who initiated, who benefits, what tension exists, what the relationship's history is.

Emit ONLY the JSON object. No preamble, no commentary, no markdown fences.
```

- [ ] **Step 2: Verify the file compiles + the prompt loads at runtime**

Run: `cd backend && pnpm exec tsx -e "import { readFileSync } from 'fs'; const p = readFileSync('src/llm/prompts/prep/entity-relationships.txt','utf8'); if (!p.includes('{{entityInventory}}')) throw 'missing placeholder'; console.log('ok')"`
Expected: prints `ok`.

- [ ] **Step 3: Commit**

```bash
git add backend/src/llm/prompts/prep/entity-relationships.txt
git commit -m "feat(myth-2ob3): entity-relationships prompt — name-based + verb-shape + field-order"
```

---

## Task 7: Streaming-extractor — field rename + optional resolver context

**Files:**
- Modify: `backend/src/llm/prep/streaming-extractor.ts`
- Test: `backend/src/llm/prep/__tests__/streaming-extractor.test.ts` (existing)

- [ ] **Step 1: Write the failing test**

Append to `backend/src/llm/prep/__tests__/streaming-extractor.test.ts`:

```ts
import { runStreamingStage } from '../streaming-extractor.js'
import { buildResolutionContext } from '../name-resolution.js'

describe('streaming-extractor name-based resolution (myth-2ob3)', () => {
  it('resolves edge endpoints from names to UUIDs when nameResolutionCtx is provided', async () => {
    const published: string[] = []
    const ctx = buildResolutionContext({
      entitiesById: new Map([
        ['ent-1', { id: 'ent-1', name: 'Mother Ehren', entityType: 'npc', accessLevel: 'known' }],
        ['ent-2', { id: 'ent-2', name: 'The Drowned Quarter', entityType: 'location', accessLevel: 'known' }],
      ]),
      proseByEntityId: new Map(),
      factsById: new Map(),
      relationshipsById: new Map(),
    })
    const pending = new Map<string, { synthId: string; entityType: string }>()
    async function* stream(): AsyncGenerator<unknown> {
      yield { relationships: [{
        from_name: 'Mother Ehren', to_name: 'The Drowned Quarter',
        relationship: 'leads', description: 'Mother Ehren leads the council.',
      }, {}] }
    }
    await runStreamingStage(stream(), {
      stage: 'entity_relationships',
      campaignId: 'c1',
      job: { updateProgress: async () => undefined },
      redisRealtime: { publish: async (_c: string, m: string) => { published.push(m); return 1 } },
      keyPrefix: 'test:',
      arrays: [{ path: 'relationships', kind: 'edge', role: 'edge' }],
      bypassAccessFilter: true,
      endpointTierMap: new Map([['ent-1', 'known'], ['ent-2', 'known']]),
      nameResolutionCtx: ctx,
      pendingDeclarations: pending,
    })
    const edgeMsg = published.find((m) => m.includes('"edge-added"'))
    expect(edgeMsg).toBeDefined()
    const parsed = JSON.parse(edgeMsg!) as { from: string; to: string }
    expect(parsed.from).toBe('ent-1')
    expect(parsed.to).toBe('ent-2')
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd backend && pnpm exec vitest run src/llm/prep/__tests__/streaming-extractor.test.ts`
Expected: FAIL — config fields don't exist; resolution code not present.

- [ ] **Step 3: Modify streaming-extractor**

Edit `backend/src/llm/prep/streaming-extractor.ts`:

(a) Extend the imports:

```ts
import type { NameResolutionContext } from './name-resolution.js'
import { resolveRelationship } from './name-resolution.js'
```

(b) Extend `StreamingExtractorConfig` (around line 48):

```ts
export interface StreamingExtractorConfig {
  readonly stage: WorldGenStage
  readonly campaignId: string
  readonly job: Pick<Job, 'updateProgress'>
  readonly redisRealtime: Pick<Redis, 'publish'>
  readonly keyPrefix: string
  readonly arrays: readonly ArrayConfig[]
  readonly bypassAccessFilter: boolean
  readonly endpointTierMap: ReadonlyMap<string, AccessLevel>
  readonly logger?: {
    warn: (objOrMsg: Record<string, unknown> | string, msg?: string) => void
  }
  // myth-2ob3: stage 4 passes a name-resolution context + a mutable
  // pendingDeclarations map (populated as the LLM emits items into
  // `new_entity_declarations`). When present, the extractor resolves
  // edge endpoints from names to UUIDs (or server-minted `new-NNN`
  // synthetic IDs for phantom-declared targets) before publishing
  // `edge-added`. When absent (stages 2, 3), the extractor publishes
  // raw entry fields — today's behavior.
  readonly nameResolutionCtx?: NameResolutionContext
  readonly pendingDeclarations?: Map<string, { synthId: string; entityType: string }>
}
```

(c) Rewrite `shouldEmitEdge` (around line 117):

```ts
function shouldEmitEdge(
  entry: Record<string, unknown>,
  bypass: boolean,
  endpointTierMap: ReadonlyMap<string, AccessLevel>,
  resolvedFrom: string | null,
  resolvedTo: string | null,
): boolean {
  if (resolvedFrom === null || resolvedTo === null) return false
  const rel = entry.relationship
  if (typeof rel !== 'string' || rel.length === 0) return false
  if (bypass) return true
  const fromTier = endpointTierMap.get(resolvedFrom)
  const toTier = endpointTierMap.get(resolvedTo)
  return fromTier === 'known' && toTier === 'known'
}
```

(d) Rewrite `publishEdgeAdded` (around line 158):

```ts
async function publishEdgeAdded(
  config: StreamingExtractorConfig,
  synthKey: string,
  entry: Record<string, unknown>,
  resolvedFrom: string,
  resolvedTo: string,
): Promise<void> {
  const channel = `${config.keyPrefix}pipeline:campaign:${config.campaignId}`
  await config.redisRealtime.publish(
    channel,
    JSON.stringify({
      type: 'edge-added',
      synthKey,
      from: resolvedFrom,
      to: resolvedTo,
      relationship: entry.relationship as string,
    }),
  )
}
```

(e) In the function that calls `shouldEmitEdge` / `publishEdgeAdded` (search for `shouldEmitEdge(`), wrap it so that when `config.nameResolutionCtx` is present:

```ts
function resolveEdgeEndpoints(
  config: StreamingExtractorConfig,
  entry: Record<string, unknown>,
): { from: string | null; to: string | null } {
  if (config.nameResolutionCtx === undefined || config.pendingDeclarations === undefined) {
    // Legacy path: stages 2/3 emit entry.from / entry.to as-is.
    return {
      from: typeof entry.from === 'string' && entry.from.length > 0 ? entry.from : null,
      to: typeof entry.to === 'string' && entry.to.length > 0 ? entry.to : null,
    }
  }
  // Name-based path (stage 4). Resolve via the shared module.
  if (typeof entry.from_name !== 'string' || typeof entry.to_name !== 'string') {
    return { from: null, to: null }
  }
  const res = resolveRelationship(
    config.nameResolutionCtx,
    {
      from_name: entry.from_name,
      to_name: entry.to_name,
      relationship: typeof entry.relationship === 'string' ? entry.relationship : '',
      description: typeof entry.description === 'string' ? entry.description : '',
    },
    config.pendingDeclarations,
  )
  switch (res.kind) {
    case 'resolved':
      return { from: res.sourceEntityId, to: res.targetEntityId }
    case 'phantom_target':
      return { from: res.sourceEntityId, to: res.synthId }
    case 'phantom_source':
      return { from: res.synthId, to: res.targetEntityId }
    case 'phantom_both':
      return { from: res.sourceSynthId, to: res.targetSynthId }
    case 'dropped':
      return { from: null, to: null }
  }
}
```

Then update the call-site in `maybeEmit` (the function that dispatches by `arrayCfg.role`):

```ts
if (arrayCfg.role === 'edge') {
  const { from, to } = resolveEdgeEndpoints(config, entry)
  if (!shouldEmitEdge(entry, config.bypassAccessFilter, config.endpointTierMap, from, to)) {
    emitted.add(synthKey)
    return
  }
  if (from === null || to === null) {
    emitted.add(synthKey)
    return
  }
  await publishEdgeAdded(config, synthKey, entry, from, to)
  emitted.add(synthKey)
  return
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd backend && pnpm exec vitest run src/llm/prep/__tests__/streaming-extractor.test.ts`
Expected: PASS, all tests (including the new one).

- [ ] **Step 5: Commit**

```bash
git add backend/src/llm/prep/streaming-extractor.ts backend/src/llm/prep/__tests__/streaming-extractor.test.ts
git commit -m "feat(myth-2ob3): streaming-extractor — name-based edge resolution (opt-in)"
```

---

## Task 8: Stage 4 handler — wire resolver context + pendingDeclarations

**Files:**
- Modify: `backend/src/llm/prep/stages/entity-relationships.ts`

- [ ] **Step 1: Inspect the existing handler to find the LLM-call boundary**

Search for `runStreamingStage` invocation inside `runEntityRelationshipsStage`. Read the surrounding code to locate where the inventory is loaded.

- [ ] **Step 2: Wire the resolver context build**

Inside `runEntityRelationshipsStage`, before the `streamObject` call, build the resolution context from the existing inventory load, and create a mutable `pendingDeclarations` map that the streaming-extractor can read as the LLM emits items.

Locate the line where the prompt is built and the inventory is loaded. Add:

```ts
import { loadWorldInventory } from '../world-dump.js'
import { buildResolutionContext } from '../name-resolution.js'
// ... existing imports

// (Inside runEntityRelationshipsStage, after the inventory load if present,
// or load now if not.)
const inventory = await loadWorldInventory(client, args.world.id)
const nameResolutionCtx = buildResolutionContext(inventory)
const pendingDeclarations = new Map<string, { synthId: string; entityType: string }>()
let nextSynthSerial = 1
function mintSynthId(name: string, entityType: string): string {
  const existing = pendingDeclarations.get(name)
  if (existing !== undefined) return existing.synthId
  const synthId = `new-${String(nextSynthSerial).padStart(3, '0')}`
  nextSynthSerial += 1
  pendingDeclarations.set(name, { synthId, entityType })
  return synthId
}
```

- [ ] **Step 3: Hook the declaration-stream observation**

Stage 4's prompt orders `new_entity_declarations` BEFORE `relationships`, so declarations stream in first. The streaming-extractor needs to populate `pendingDeclarations` as declarations arrive. Add to the `runStreamingStage` config's `arrays`:

```ts
arrays: [
  // Declarations arrive first; observe them into pendingDeclarations.
  {
    path: 'new_entity_declarations',
    kind: 'declaration',
    role: 'entity',
    sub_schema: declarationItemSchema,
  },
  {
    path: 'relationships',
    kind: 'edge',
    role: 'edge',
    sub_schema: relationshipItemSchema,
  },
],
nameResolutionCtx,
pendingDeclarations,
```

The extractor's existing entity-emit path doesn't know about phantom decoration; add a hook so declarations get minted as they emit. Inside the streaming-extractor's `maybeEmit` for `role: 'entity'` path, if `entry.entity_type` is set (declaration shape) AND `config.pendingDeclarations` is provided, mint a synthId:

In `streaming-extractor.ts`, inside the entity-emit branch of `maybeEmit`, add:

```ts
// myth-2ob3: declaration observation. When a declaration entry closes
// (it has name + entity_type), bind it to a synthetic ID in
// pendingDeclarations so subsequent edge resolution can find it.
if (
  config.pendingDeclarations !== undefined &&
  typeof entry.name === 'string' &&
  typeof entry.entity_type === 'string'
) {
  const name = entry.name.normalize('NFC').trim().replace(/\s+/g, ' ')
  if (!config.pendingDeclarations.has(name)) {
    const next = config.pendingDeclarations.size + 1
    const synthId = `new-${String(next).padStart(3, '0')}`
    config.pendingDeclarations.set(name, { synthId, entityType: entry.entity_type })
  }
}
```

(Remove the in-handler `mintSynthId` function; minting now lives inside the extractor's declaration hook.)

- [ ] **Step 4: Write a failing handler-level test**

Append to `backend/src/llm/prep/stages/__tests__/entity-relationships.test.ts`:

```ts
it('declarations stream before relationships and mint synth ids the edge resolver can find (myth-2ob3)', async () => {
  // Construct a mock stream that emits declarations first, then relationships
  // referencing those declarations. Assert that the edge-added event published
  // for the phantom edge carries the synth ID matching the declaration order.
  // (Use the existing test scaffolding — this is one new it() in the suite.)
  // ... fixture per existing patterns ...
})
```

(The test body uses whatever scaffolding the existing test suite already provides for stage 4. Fill in per the surrounding patterns; don't invent a new test harness.)

- [ ] **Step 5: Run tests to verify pass**

Run: `cd backend && pnpm exec vitest run src/llm/prep/stages/__tests__/entity-relationships.test.ts`
Expected: PASS, including the new test.

- [ ] **Step 6: Commit**

```bash
git add backend/src/llm/prep/stages/entity-relationships.ts backend/src/llm/prep/streaming-extractor.ts backend/src/llm/prep/stages/__tests__/entity-relationships.test.ts
git commit -m "feat(myth-2ob3): stage 4 — wire resolver context + declaration-observed synth minting"
```

---

## Task 9: Stage 4 persist step — resolve names to UUIDs at end of stream

**Files:**
- Modify: `backend/src/llm/prep/stages/entity-relationships.ts`

- [ ] **Step 1: Locate the partition logic**

Search for `partitionWithPlaceholders` (current function that splits real-UUID rows from `new-NNN` rows). Identify the inputs/outputs.

- [ ] **Step 2: Rewrite the partition to use name resolution**

Replace `partitionWithPlaceholders` with a new function:

```ts
import {
  buildResolutionContext,
  resolveRelationship,
  type NameResolutionContext,
} from '../name-resolution.js'

interface PartitionedTree {
  realRelationships: ReadonlyArray<{
    sourceIndex: number
    sourceEntityId: string
    targetEntityId: string
    relationshipType: string
    description: string
  }>
  pendingPhantoms: ReadonlyArray<{
    sourceIndex: number
    fromSynth: string | null  // null when source is a real UUID
    fromId: string | null     // null when source is a phantom
    toSynth: string | null
    toId: string | null
    relationshipType: string
    description: string
  }>
  declarations: ReadonlyArray<{ synthId: string; name: string; entityType: string }>
  droppedHallucinatedCount: number
  droppedOrphanPlaceholderCount: number
}

function partitionByNames(
  tree: EntityRelationshipsOutput,
  ctx: NameResolutionContext,
  pending: ReadonlyMap<string, { synthId: string; entityType: string }>,
): PartitionedTree {
  const real: PartitionedTree['realRelationships'] extends ReadonlyArray<infer U> ? U[] : never[] = []
  const phantoms: PartitionedTree['pendingPhantoms'] extends ReadonlyArray<infer U> ? U[] : never[] = []
  let droppedHallucinated = 0
  for (const [i, r] of tree.relationships.entries()) {
    const res = resolveRelationship(ctx, r, pending)
    switch (res.kind) {
      case 'resolved':
        real.push({
          sourceIndex: i,
          sourceEntityId: res.sourceEntityId,
          targetEntityId: res.targetEntityId,
          relationshipType: res.relationshipType,
          description: res.description,
        })
        break
      case 'phantom_target':
        phantoms.push({
          sourceIndex: i,
          fromSynth: null, fromId: res.sourceEntityId,
          toSynth: res.synthId, toId: null,
          relationshipType: res.relationshipType, description: res.description,
        })
        break
      case 'phantom_source':
        phantoms.push({
          sourceIndex: i,
          fromSynth: res.synthId, fromId: null,
          toSynth: null, toId: res.targetEntityId,
          relationshipType: res.relationshipType, description: res.description,
        })
        break
      case 'phantom_both':
        phantoms.push({
          sourceIndex: i,
          fromSynth: res.sourceSynthId, fromId: null,
          toSynth: res.targetSynthId, toId: null,
          relationshipType: res.relationshipType, description: res.description,
        })
        break
      case 'dropped':
        droppedHallucinated += 1
        break
    }
  }
  const declarations = Array.from(pending.entries()).map(([name, p]) => ({
    synthId: p.synthId, name, entityType: p.entityType,
  }))
  return {
    realRelationships: real,
    pendingPhantoms: phantoms,
    declarations,
    droppedHallucinatedCount: droppedHallucinated,
    droppedOrphanPlaceholderCount: 0,  // no orphans under name-based (declarations are minted, not referenced)
  }
}
```

- [ ] **Step 3: Update the call-site**

Replace the call to `partitionWithPlaceholders(validatedTree, entityIds)` with `partitionByNames(validatedTree, nameResolutionCtx, pendingDeclarations)`. Update downstream code that reads `.realRelationships` / `.pendingPhantoms` to use the new shape (they're equivalent — only the field names changed).

- [ ] **Step 4: Run stage tests**

Run: `cd backend && pnpm exec vitest run src/llm/prep/stages/__tests__/entity-relationships.test.ts`
Expected: PASS. Some existing tests will fail and need their fixtures updated to use the name-based output shape; update them in this same task.

- [ ] **Step 5: Commit**

```bash
git add backend/src/llm/prep/stages/entity-relationships.ts backend/src/llm/prep/stages/__tests__/entity-relationships.test.ts
git commit -m "feat(myth-2ob3): stage 4 persist — partition by names + resolver"
```

---

## Task 10: Rewrite coherence-output Zod schema

**Files:**
- Modify: `backend/src/llm/schemas/coherence-output.ts`
- Test: `backend/src/llm/schemas/__tests__/coherence-output.test.ts` (existing or new)

- [ ] **Step 1: Write failing schema tests**

Create or extend `backend/src/llm/schemas/__tests__/coherence-output.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { CoherencePatchSchema, CoherenceOutputSchema } from '../coherence-output.js'

describe('coherence-output schema (name-based)', () => {
  it('accepts fix_relationship_by_name with source/target/current_type', () => {
    const r = CoherencePatchSchema.safeParse({
      kind: 'fix_relationship_by_name',
      source_name: 'Mother Ehren',
      target_name: 'The Drowned Quarter',
      current_type: 'leads',
      newType: 'pursues',
      rationale: 'The prose makes clear she pursues but is resisted by the council.',
    })
    expect(r.success).toBe(true)
  })

  it('accepts fix_fact_by_name with entity_name + fact_topic', () => {
    const r = CoherencePatchSchema.safeParse({
      kind: 'fix_fact_by_name',
      entity_name: 'Mother Ehren',
      fact_topic: 'role',
      new_content: 'Updated role description per coherence audit.',
      rationale: 'Original fact contradicted prose.',
    })
    expect(r.success).toBe(true)
  })

  it('accepts fix_prose_by_name with entity_name', () => {
    const r = CoherencePatchSchema.safeParse({
      kind: 'fix_prose_by_name',
      entity_name: 'Mother Ehren',
      new_prose: 'A revised prose paragraph that is at least forty characters long.',
      rationale: 'Original prose referenced a renamed entity.',
    })
    expect(r.success).toBe(true)
  })

  it('accepts rename_entity_by_name with old + new', () => {
    const r = CoherencePatchSchema.safeParse({
      kind: 'rename_entity_by_name',
      old_name: 'The Drowned Quarter',
      new_name: 'The Sunken District',
      rationale: 'Renaming for clarity per setting evolution.',
    })
    expect(r.success).toBe(true)
  })

  it('accepts delete_relationship_by_name', () => {
    const r = CoherencePatchSchema.safeParse({
      kind: 'delete_relationship_by_name',
      source_name: 'Mother Ehren',
      target_name: 'The Drowned Quarter',
      current_type: 'leads',
      rationale: 'Duplicate of another relationship in the table.',
    })
    expect(r.success).toBe(true)
  })

  it('rejects the old UUID-based shape', () => {
    const r = CoherencePatchSchema.safeParse({
      kind: 'fix_relationship',
      relationshipId: '019e6131-75ac-7f97-973d-fb3550df4739',
      newType: 'pursues',
      rationale: 'old shape',
    })
    expect(r.success).toBe(false)
  })

  it('full output validates with mixed kinds, ≤40 patches', () => {
    const r = CoherenceOutputSchema.safeParse({
      patches: [
        { kind: 'rename_entity_by_name', old_name: 'A', new_name: 'B', rationale: 'twenty character rationale here' },
      ],
    })
    expect(r.success).toBe(true)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd backend && pnpm exec vitest run src/llm/schemas/__tests__/coherence-output.test.ts`
Expected: FAIL — old schema still in place.

- [ ] **Step 3: Rewrite the schema**

Replace `backend/src/llm/schemas/coherence-output.ts`:

```ts
// backend/src/llm/schemas/coherence-output.ts
//
// Stage 7 (coherence_pass) output schema. Per myth-2ob3 design.
//
// All patch kinds identify their target rows by NAME. A deterministic
// server-side resolver maps names to UUIDs before applying patches.
// Unresolvable names are dropped with structured WARNs.

import { z } from 'zod'

const fixFactPatch = z.object({
  kind: z.literal('fix_fact_by_name'),
  entity_name: z.string().min(1).max(200),
  fact_topic: z.string().min(1).max(120),
  new_content: z.string().min(10).max(2000),
  rationale: z.string().min(20).max(400),
})

const fixProsePatch = z.object({
  kind: z.literal('fix_prose_by_name'),
  entity_name: z.string().min(1).max(200),
  new_prose: z.string().min(40).max(2400),
  rationale: z.string().min(20).max(400),
})

const fixRelationshipPatch = z.object({
  kind: z.literal('fix_relationship_by_name'),
  source_name: z.string().min(1).max(200),
  target_name: z.string().min(1).max(200),
  current_type: z.string().min(2).max(60),
  newType: z.string().min(2).max(60).optional(),
  newDescription: z.string().min(10).max(600).optional(),
  rationale: z.string().min(20).max(400),
})

const renameEntityPatch = z.object({
  kind: z.literal('rename_entity_by_name'),
  old_name: z.string().min(1).max(200),
  new_name: z.string().min(1).max(200),
  rationale: z.string().min(20).max(400),
})

const deleteRelationshipPatch = z.object({
  kind: z.literal('delete_relationship_by_name'),
  source_name: z.string().min(1).max(200),
  target_name: z.string().min(1).max(200),
  current_type: z.string().min(2).max(60),
  rationale: z.string().min(20).max(400),
})

export const CoherencePatchSchema = z.discriminatedUnion('kind', [
  fixFactPatch,
  fixProsePatch,
  fixRelationshipPatch,
  renameEntityPatch,
  deleteRelationshipPatch,
])

export type CoherencePatch = z.infer<typeof CoherencePatchSchema>

export const CoherenceOutputSchema = z.object({
  patches: z.array(CoherencePatchSchema).max(40),
})

export type CoherenceOutput = z.infer<typeof CoherenceOutputSchema>
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd backend && pnpm exec vitest run src/llm/schemas/__tests__/coherence-output.test.ts`
Expected: PASS, 7/7.

- [ ] **Step 5: Commit**

```bash
git add backend/src/llm/schemas/coherence-output.ts backend/src/llm/schemas/__tests__/coherence-output.test.ts
git commit -m "feat(myth-2ob3): coherence-output schema — name-based patch kinds"
```

---

## Task 11: Rewrite coherence-pass prompt template

**Files:**
- Modify: `backend/src/llm/prompts/prep/coherence-pass.txt`

- [ ] **Step 1: Replace the prompt body**

Replace the entire contents of `backend/src/llm/prompts/prep/coherence-pass.txt` with:

```
{# Stage 7 — Coherence Pass — myth-2ob3 name-based revision.
   The worker renders the full world (entities, prose, facts, relationships)
   into {{worldDump}}. The model emits patches identified by NAME; the
   server resolves names to UUIDs before applying. Auto-fix only — no
   `warnings` arm. The model SHOULD NOT restate the full world; emit ONLY
   the patches needed to repair concrete inconsistencies it sees.
#}

You are an editorial reviewer auditing a freshly generated tabletop D&D 5e campaign world. The world was produced by an upstream pipeline of separate stages; some inconsistencies, typos, dangling references, or role conflicts may have crept in across stage boundaries. Your job is to spot those and emit a minimal list of corrections.

## World Vocabulary

{{vocabularyRegistry}}

## What you are looking for

- **Factual contradictions** between an entity's prose kernel and one of its facts (e.g., the prose says the village burned down decades ago, but a fact says the bakery is open daily).
- **Typos or malformed names** in entity names (only fix when you are confident the typo is unintentional — names with deliberate odd spellings are part of the setting).
- **Stale prose** that references an entity that has since been removed or renamed elsewhere in the world.
- **Relationship inconsistencies** — e.g., the relationship description explicitly contradicts the type+endpoints triple (says "not actually allied with X" but type is `allied_with`), or both endpoints describe each other as strangers but a relationship exists.
- **Duplicate relationships** that say the same thing in slightly different words — delete the weaker one.

## What you should NOT do

- Do NOT restate or "improve" prose that is internally consistent.
- Do NOT rewrite passages for tone or pacing — only fix concrete inconsistencies.
- Do NOT invent new entities or relationships.
- Do NOT emit a patch if you are uncertain. Imprecise emissions waste downstream work.

## How to identify targets in your patches

Identify rows by NAME, not UUID. The world dump below renders each entity, fact, and relationship; reference them by:

- **Entities** — by their `name` field (exact case-sensitive match to the world dump).
- **Facts** — by `(entity_name, fact_topic)` — the entity that owns the fact, plus the fact's topic. If multiple facts on the same entity share a topic, you cannot uniquely identify one; skip that patch.
- **Relationships** — by `(source_name, target_name, current_type)` — the source entity name, target entity name, and the relationship's current type as it appears in the dump.

A name typo or wrong topic / wrong current_type makes the patch unresolvable and the system silently drops it. Be exact.

## Important: rename ordering

If you emit a `rename_entity_by_name` patch in this response, continue to use the entity's OLD name throughout the rest of your patches. The system applies all `rename_entity_by_name` patches LAST, after every other patch has resolved against the pre-rename world. This means a `fix_prose_by_name` patch for "The Drowned Quarter" (the OLD name) WILL find and update that entity even if you also emit a rename to "The Sunken District" in the same response.

When you rename an entity, audit other entities' prose for references to the OLD name and emit `fix_prose_by_name` patches for each — renames without companion prose-fix patches leave the world incoherent.

## World dump

{{worldDump}}

## Patch kinds available

All patches identify their target by name. Each rationale is a single sentence (~20–400 chars) explaining the concrete inconsistency you are correcting. The rationale is logged for audit; it is NOT shown to the player.

- `fix_fact_by_name` — UPDATE a single fact's content. Requires `entity_name`, `fact_topic`, `new_content`, `rationale`.
- `fix_prose_by_name` — UPDATE a single entity's prose kernel. Requires `entity_name`, `new_prose`, `rationale`.
- `fix_relationship_by_name` — UPDATE a relationship's type and/or description. Requires `source_name`, `target_name`, `current_type`, optional `newType` (a short verb-phrase predicate: 1–3 words, snake_case preferred, ≤30 characters; examples: `allied_with`, `pursues`, `former_servant_of`), optional `newDescription`, `rationale`.
- `rename_entity_by_name` — UPDATE an entity's name. Requires `old_name`, `new_name`, `rationale`.
- `delete_relationship_by_name` — DELETE a relationship row. Requires `source_name`, `target_name`, `current_type`, `rationale`.

## PROSE-TIER CONSISTENCY (CRITICAL)

When patching entity prose or facts, do NOT cross tier boundaries. A `known`-tier entity's prose is the public-knowledge view — what anyone in the world casually knows. Do NOT merge `discoverable` or `secret`-tier detail from neighboring entities into a `known` entity's prose, even if doing so would "improve coherence" — the tier boundary is load-bearing, and a leak via prose is a leak.

If a patch needs information that lives in another entity, only use information from entities whose access_level is at or below the patched entity's tier. (Patches to `known` entities can only draw on `known` content. Patches to `discoverable` entities can draw on `known` or `discoverable`. Patches to `secret` entities can draw on anything.)

## Your task

Respond with ONLY a JSON object of the shape `{ "patches": [...] }` containing at most 40 patches. If you cannot find any inconsistencies worth correcting, emit `{ "patches": [] }`. No markdown fences, no commentary.
```

- [ ] **Step 2: Verify the file is loadable**

Run: `cd backend && pnpm exec tsx -e "import { readFileSync } from 'fs'; const p = readFileSync('src/llm/prompts/prep/coherence-pass.txt','utf8'); if (!p.includes('{{worldDump}}')) throw 'missing placeholder'; console.log('ok')"`
Expected: prints `ok`.

- [ ] **Step 3: Commit**

```bash
git add backend/src/llm/prompts/prep/coherence-pass.txt
git commit -m "feat(myth-2ob3): coherence-pass prompt — name-based + rename-ordering + verb-shape"
```

---

## Task 12: Coherence-pass apply step — rename partitioning + name resolution

**Files:**
- Modify: `backend/src/llm/prep/stages/coherence-pass.ts`

- [ ] **Step 1: Read the existing applyPatch to find each kind's apply function**

Search for `applyFixRelationship`, `applyFixFact`, `applyFixProse`, `applyRenameEntity`, `applyDeleteRelationship`. Read each.

- [ ] **Step 2: Rewrite the dispatch + each apply function to use the resolver**

Replace the `applyPatch` dispatch (around line 329) with:

```ts
import {
  buildResolutionContext,
  resolveFact,
  resolveProseTarget,
  resolveRename,
  resolveFixRelationship,
  resolveDeleteRelationship,
  type NameResolutionContext,
} from '../name-resolution.js'
import type { CoherencePatch } from '../../schemas/coherence-output.js'

interface ApplyContext {
  readonly inv: WorldInventory
  readonly resolver: NameResolutionContext
  readonly logger: Logger
  readonly stage: 'coherence_pass'
  readonly bypassAccessFilter: boolean
}

async function applyPatch(
  client: PoolClient,
  patch: CoherencePatch,
  ctx: ApplyContext,
): Promise<{ events: PipelineEvent[] }> {
  switch (patch.kind) {
    case 'fix_fact_by_name': {
      const res = resolveFact(ctx.resolver, patch)
      if (res.kind === 'dropped') {
        ctx.logger.warn(
          { stage: 'coherence_pass', kind: patch.kind, reason: res.reason, entity_name: patch.entity_name, fact_topic: patch.fact_topic },
          `coherence_pass: patch references unknown entity+topic; skipping`,
        )
        return { events: [] }
      }
      return applyFixFact(client, patch, res.factId, res.entityId, ctx)
    }
    case 'fix_prose_by_name': {
      const res = resolveProseTarget(ctx.resolver, patch)
      if (res.kind === 'dropped') {
        ctx.logger.warn(
          { stage: 'coherence_pass', kind: patch.kind, reason: res.reason, entity_name: patch.entity_name },
          `coherence_pass: patch references unknown entity; skipping`,
        )
        return { events: [] }
      }
      return applyFixProse(client, patch, res.entityId, ctx)
    }
    case 'fix_relationship_by_name': {
      const res = resolveFixRelationship(ctx.resolver, patch)
      if (res.kind === 'dropped') {
        ctx.logger.warn(
          { stage: 'coherence_pass', kind: patch.kind, reason: res.reason, source: patch.source_name, target: patch.target_name, type: patch.current_type },
          `coherence_pass: patch references unknown relationship triple; skipping`,
        )
        return { events: [] }
      }
      return applyFixRelationship(client, patch, res.relationshipId, ctx)
    }
    case 'rename_entity_by_name': {
      const res = resolveRename(ctx.resolver, patch)
      if (res.kind === 'dropped') {
        ctx.logger.warn(
          { stage: 'coherence_pass', kind: patch.kind, reason: res.reason, old_name: patch.old_name },
          `coherence_pass: rename patch references unknown entity; skipping`,
        )
        return { events: [] }
      }
      return applyRenameEntity(client, patch, res.entityId, ctx)
    }
    case 'delete_relationship_by_name': {
      const res = resolveDeleteRelationship(ctx.resolver, patch)
      if (res.kind === 'dropped') {
        ctx.logger.warn(
          { stage: 'coherence_pass', kind: patch.kind, reason: res.reason, source: patch.source_name, target: patch.target_name, type: patch.current_type },
          `coherence_pass: delete patch references unknown relationship; skipping`,
        )
        return { events: [] }
      }
      return applyDeleteRelationship(client, patch, res.relationshipId, ctx)
    }
  }
}
```

Update each `apply*` helper to take the resolved UUID as a parameter (instead of pulling it from the patch). Most are trivial signature changes; the internal UPDATE/DELETE SQL is unchanged.

- [ ] **Step 3: Partition rename patches to apply last**

In the coherence-pass stage handler (search for the loop `for (const patch of output.patches)`), partition first:

```ts
const inventory = await loadWorldInventory(client, args.worldId)
const resolver = buildResolutionContext(inventory)
const applyCtx: ApplyContext = {
  inv: inventory, resolver,
  logger: args.logger, stage: 'coherence_pass',
  bypassAccessFilter: args.bypassAccessFilter,
}

// myth-2ob3 §4.1: rename patches apply LAST. All other patches resolve
// against the pre-rename context.
const renamePatches: typeof output.patches = []
const otherPatches: typeof output.patches = []
for (const p of output.patches) {
  if (p.kind === 'rename_entity_by_name') renamePatches.push(p)
  else otherPatches.push(p)
}

const finalizedEvents: PipelineEvent[] = []
for (const patch of [...otherPatches, ...renamePatches]) {
  const { events } = await applyPatch(client, patch, applyCtx)
  finalizedEvents.push(...events)
}
```

- [ ] **Step 4: Update existing coherence-pass tests to use name-based patches**

In `backend/src/llm/prep/stages/__tests__/coherence-pass.test.ts`, find any test that constructs a `CoherencePatch` literal with the old shape (`relationshipId`, `entityId`, `factId`) and convert it to the name-based shape. Specific fixture replacements:

| Old | New |
|---|---|
| `{ kind: 'fix_relationship', relationshipId: 'rel-X', ... }` | `{ kind: 'fix_relationship_by_name', source_name: 'A', target_name: 'B', current_type: 'leads', ... }` |
| `{ kind: 'fix_fact', factId: 'fact-X', ... }` | `{ kind: 'fix_fact_by_name', entity_name: 'A', fact_topic: 'role', ... }` |
| `{ kind: 'fix_prose', entityId: 'ent-X', ... }` | `{ kind: 'fix_prose_by_name', entity_name: 'A', ... }` |
| `{ kind: 'rename_entity', entityId: 'ent-X', newName: 'Y', ... }` | `{ kind: 'rename_entity_by_name', old_name: 'A', new_name: 'Y', ... }` |
| `{ kind: 'delete_relationship', relationshipId: 'rel-X', ... }` | `{ kind: 'delete_relationship_by_name', source_name: 'A', target_name: 'B', current_type: 'leads', ... }` |

The test inventory fixtures need entities named "A", "B" etc. with matching IDs so the resolver finds them.

- [ ] **Step 5: Add a rename-ordering test**

```ts
it('applies rename patches LAST, so other patches resolve against pre-rename names (myth-2ob3 §4.1)', async () => {
  // Construct a patch list with: rename A→A2, then fix_prose for A.
  // After apply, both patches should have succeeded — the fix_prose
  // resolved against A (pre-rename), then the rename ran.
  // Assert: entity name is now A2; prose was updated.
  // ... use existing test scaffolding ...
})
```

- [ ] **Step 6: Run tests**

Run: `cd backend && pnpm exec vitest run src/llm/prep/stages/__tests__/coherence-pass.test.ts`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add backend/src/llm/prep/stages/coherence-pass.ts backend/src/llm/prep/stages/__tests__/coherence-pass.test.ts
git commit -m "feat(myth-2ob3): coherence-pass — name-resolver dispatch + rename-applied-last"
```

---

## Task 13: Full backend test suite + typecheck + lint

**Files:**
- (read-only verification)

- [ ] **Step 1: Run typecheck**

Run: `cd backend && pnpm typecheck`
Expected: clean, 0 errors. If there are downstream type errors (other modules importing removed exports from the rewritten schemas), fix them in this task.

- [ ] **Step 2: Run lint**

Run: `cd backend && pnpm lint`
Expected: 0 errors (pre-existing warnings ok).

- [ ] **Step 3: Run full test suite**

Run: `cd backend && pnpm test`
Expected: green, all tests pass. If integration tests outside the two stages fail because of the schema rename, fix them here.

- [ ] **Step 4: Commit any fix-ups**

```bash
git add -u
git commit -m "fix(myth-2ob3): cross-module typecheck + test fixups"
```

(Skip the commit if step 1-3 were already clean.)

---

## Task 14: Live smoke against real Anthropic

**Files:**
- (no code changes; runs the existing dev-tool flow)

- [ ] **Step 1: Start the dev server**

Verify dev server + worker running: `curl -s http://127.0.0.1:3030/health` → `{"status":"ok"}`. If not, start via `pnpm --filter @mythrun/backend dev` (background).

- [ ] **Step 2: Run a fresh world-gen via curl**

```bash
CONCEPT="A mountain monastery that sits on the only path between two warring valleys, and the monks know they cannot stay neutral much longer."
RESP=$(curl -s -X POST http://127.0.0.1:3030/api/campaigns \
  -H "x-mythrun-dev-sub: bypass:dev-user-1" \
  -H "content-type: application/json" \
  -d "{\"world\":{\"kind\":\"new\",\"source\":{\"mode\":\"freeform\",\"concept\":\"$CONCEPT\"}}}")
echo "$RESP"
CAMPAIGN=$(echo "$RESP" | jq -r '.campaignId')
echo "campaign: $CAMPAIGN"
```

Expected: HTTP 201, returns campaignId.

- [ ] **Step 3: Wait for terminal phase**

```bash
until docker compose exec -T postgres psql -U mythrun -d mythrun_dev -tA -c "SELECT status FROM worlds WHERE id IN (SELECT world_id FROM campaigns WHERE id='$CAMPAIGN');" | grep -qE "^complete$|^failed$"; do sleep 30; done
docker compose exec -T postgres psql -U mythrun -d mythrun_dev -c "SELECT stage, status, EXTRACT(EPOCH FROM (completed_at - started_at))::int AS secs, cost_usd FROM pipeline_runs WHERE world_id = (SELECT world_id FROM campaigns WHERE id='$CAMPAIGN') ORDER BY started_at;"
```

Expected: all 9 stages `completed`. Total wallclock ~12-15 min.

- [ ] **Step 4: Measure coherence-pass apply rate**

```bash
WORLD=$(docker compose exec -T postgres psql -U mythrun -d mythrun_dev -tA -c "SELECT world_id FROM campaigns WHERE id='$CAMPAIGN';")
# Count patches emitted (via the SSE/log) vs patches applied (via edge-removed / edge-added events from coherence-pass + entity name changes).
LOG=$(ls -t backend/logs/dev-*.log | head -1)
echo "Coherence drops today:"
grep "coherence_pass" "$LOG" | grep "skipping" | grep "$WORLD" | wc -l
echo "Coherence successful applies (info-level emits):"
grep "coherence_pass" "$LOG" | grep -v "level\":40" | grep "$WORLD" | wc -l
```

Expected per §9.3: ≥80% of emitted coherence patches successfully resolve. Specifically, the `unknown_relationshipId` / `unknown_entity_uuid` warnings should be ZERO; any drops should be `unknown_name` / `ambiguous_*`.

- [ ] **Step 5: Inspect a few applied patches**

```bash
# Look for relationship updates after coherence pass — relationships with id outside the stage-4 millisecond window.
docker compose exec -T postgres psql -U mythrun -d mythrun_dev -c "
SELECT s.name, r.relationship_type, t.name, LEFT(r.description, 80)
FROM relationships r
JOIN entities s ON s.id = r.source_entity_id
JOIN entities t ON t.id = r.target_entity_id
WHERE s.world_id = '$WORLD' AND r.created_at > (SELECT MAX(started_at) FROM pipeline_runs WHERE world_id = '$WORLD' AND stage = 'entity_relationships')
ORDER BY r.created_at LIMIT 10;"
```

Expected: at least a few rows from coherence-pass corrections. Manually spot-check that the description doesn't self-refute the type+endpoints (the bug we were fixing).

- [ ] **Step 6: Commit any prompt-engineering iterations**

If apply rate is <80%, examine the dropped patches' reasons and adjust the prompt's verb-shape or rename-ordering guidance. Re-run from step 2. When ≥80% achieved:

```bash
git add backend/src/llm/prompts/prep/
git commit -m "chore(myth-2ob3): prompt iteration after smoke (verb shape / name discipline)"
```

(Skip if no prompt edits needed.)

---

## Task 15: Wiki narrative update for the dropped enum

**Files:**
- Modify: `docs/wiki/content/.../*.html` (the schema reference page that lists `RELATIONSHIP_TYPES`)

- [ ] **Step 1: Locate the wiki page that documents the 16-verb enum**

Run: `grep -rln "RELATIONSHIP_TYPES\|allied_with\|opposed_to" docs/wiki/content/ | head`

- [ ] **Step 2: Update the narrative**

Replace the 16-verb closed-enum description with free-text-type narrative. The page now documents:

- `relationship_type` is free text (short verb-phrase predicate, typically 1-3 words, snake_case preferred, ≤30 chars).
- The LLM emits this directly; no closed enum.
- Common values seen in practice: `allied_with`, `opposed_to`, `controls`, `leads`, `member_of`, etc. — but these are conventions, not enforced.
- `description` carries the texture; the type is window-dressing for graph views.

- [ ] **Step 3: Accept drift + commit**

```bash
set -a && source backend/.env.development && set +a
pnpm wiki:accept-drift
git add docs/wiki/content/ docs/wiki/site/
git commit -m "docs(myth-2ob3): wiki — relationship_type is free-text post-enum drop"
```

---

## Task 16: Final verification, dev-tool verifier dispatch, push

**Files:**
- (verification + push)

- [ ] **Step 1: Run full verification pre-push**

```bash
cd backend && pnpm typecheck && pnpm lint && pnpm test
cd .. && pnpm wiki:check
```

Expected: all green.

- [ ] **Step 2: Dispatch the dev-tool verifier**

This change touches `backend/src/` reachable from a dev-tool call (the entity_relationships and coherence_pass stages). Per AUTHORING.md the dispatch is `E2E: required`. Use `subagent_type: "dev-tool-verifier"` (registered per `.claude/agents/dev-tool-verifier.md`).

In the dispatch prompt, state:

```
E2E: required — myth-2ob3 changes the LLM I/O shape for two world-gen
stages (entity_relationships, coherence_pass) and the streaming-extractor
config. This is squarely in the always-required column per
AUTHORING.md step 5. The smoke must include a fresh real-LLM world-gen
and verify coherence-pass apply rate is ≥80% (vs production baseline of
0%).
```

The verifier runs the static gate + the canonical smoke flow + writes the marker.

- [ ] **Step 3: Push**

```bash
git push origin main
```

Expected: pre-push gates green, dev-tool-verifier marker matches HEAD, push succeeds.

- [ ] **Step 4: Close the bead**

```bash
bd close myth-2ob3 --reason="Shipped: name-based LLM I/O for entity_relationships + coherence_pass. Closed-enum dropped. Resolver + tests + prompt rewrites + wiki update. Live smoke achieved ≥80% coherence-pass apply rate vs 0% baseline."
```

---

## Self-review checklist

- **Spec §2.1 (names not UUIDs in LLM I/O):** covered by Tasks 5, 6, 10, 11.
- **Spec §2.2 (drop closed enum, verb-shape in prompt):** Task 5 (schema), Task 6 (entity-relationships prompt), Task 11 (coherence prompt). Task 15 (wiki).
- **Spec §2.3 (UUIDs stay):** no schema change — nothing to do (Task 13 verifies no regressions).
- **Spec §2.4 (synthKeys unchanged):** no change needed; new code preserves existing synthKey emission paths.
- **Spec §2.5 (renames via existing entity-updated):** Task 12 (rename application; existing entity-updated event emission unchanged).
- **Spec §3.1 (no DB migration):** confirmed; no migration task needed.
- **Spec §3.2 (schema rewrites):** Task 5.
- **Spec §3.3 (coherence schema rewrites):** Task 10.
- **Spec §3.4 (phantom = server-minted new-NNN):** Task 8 (handler), Task 7 (extractor minting).
- **Spec §4 (resolver layer):** Tasks 1, 2, 3, 4.
- **Spec §4.1 (rename batch ordering):** Task 12 step 3.
- **Spec §5 (streaming-extractor):** Task 7.
- **Spec §5.1 (world-dump renderer unchanged):** no task.
- **Spec §6.1 (stage 4 apply step):** Task 9.
- **Spec §6.2 (coherence apply step):** Task 12.
- **Spec §7.1 (entity-relationships prompt):** Task 6.
- **Spec §7.2 (coherence-pass prompt):** Task 11.
- **Spec §8 (no migration):** confirmed.
- **Spec §9.1 (unit tests):** Tasks 1-4, 5, 10.
- **Spec §9.2 (integration tests):** Tasks 9 step 4, 12 step 5.
- **Spec §9.3 (live smoke):** Task 14.
- **Spec §10 (close loop):** Tasks 15 (wiki), 16 (verifier + push + bead close).

All spec sections accounted for. Plan ready for subagent-driven execution.
