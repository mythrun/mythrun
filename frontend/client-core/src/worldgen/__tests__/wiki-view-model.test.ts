import { describe, it, expect } from 'vitest'
import type { WorldSnapshot } from '@mythrun/contract/rest'
import { toWikiViewModel, type WikiSnapshot } from '../wiki-view-model.ts'

// Fixtures mirror the real world-snapshot wire shape (backend Entity / FactRow /
// EntityHierarchyRow, camelCase): entities carry `entityType`; facts key onto
// `entityId`; hierarchy edges are `parentEntityId → childEntityId`. The
// endpoint's richer payload (world summary, relationships, prose, stat blocks)
// strips away at the contract's `z.object` boundary, so it is absent here.

// A world with all four lore kinds, a two-level nested-location tree, two
// same-named NPCs (forces the name→id tiebreak), and one dangling hierarchy
// edge (parent absent → child promoted to top level).
const world: WorldSnapshot = {
  entities: [
    { id: 'f1', entityType: 'faction', name: 'The Ember Court' },
    { id: 'l1', entityType: 'location', name: 'Saltmarsh' },
    { id: 'l2', entityType: 'location', name: 'Ashford' },
    { id: 'l3', entityType: 'location', name: 'The Tidewatch' },
    { id: 'l4', entityType: 'location', name: "Gull's Rest" },
    { id: 'n1', entityType: 'npc', name: 'Mira' },
    { id: 'n2', entityType: 'npc', name: 'Sentinel' },
    { id: 'n3', entityType: 'npc', name: 'Sentinel' },
    { id: 'i1', entityType: 'item', name: 'Tideglass Lantern' },
  ],
  // Deliberately out of id order: proves fact-order is normalized to id order.
  facts: [
    { id: 'fact2', entityId: 'l1', topic: 'geography', content: 'A fishing town.' },
    { id: 'fact1', entityId: 'l1', topic: 'mood', content: 'Salt hangs in the air.' },
    { id: 'factA', entityId: 'l3', topic: 'note', content: 'A stone watchtower.' },
    { id: 'fact3', entityId: 'n1', topic: 'role', content: 'The harbormaster.' },
  ],
  entityHierarchy: [
    { parentEntityId: 'l1', childEntityId: 'l3' }, // Tidewatch under Saltmarsh
    { parentEntityId: 'l3', childEntityId: 'l4' }, // Gull's Rest under Tidewatch (grandchild)
    { parentEntityId: 'ghost', childEntityId: 'i1' }, // dangling parent → i1 stays top level
  ],
}

describe('toWikiViewModel', () => {
  it('orders groups by the canonical kind order', () => {
    const vm = toWikiViewModel(world)
    expect(vm.groups.map((g) => g.kind)).toEqual(['faction', 'location', 'npc', 'item'])
  })

  it('nests child locations under their parent, not at top level', () => {
    const vm = toWikiViewModel(world)
    const locations = vm.groups.find((g) => g.kind === 'location')
    // l3 (child) and l4 (grandchild) are NOT top level; l2 sorts before l1 by name.
    expect(locations?.entities.map((e) => e.id)).toEqual(['l2', 'l1'])

    const saltmarsh = locations?.entities.find((e) => e.id === 'l1')
    expect(saltmarsh?.children?.map((c) => c.id)).toEqual(['l3'])

    const tidewatch = saltmarsh?.children?.[0]
    expect(tidewatch?.children?.map((c) => c.id)).toEqual(['l4'])

    // A leaf carries no `children` key at all.
    const gullsRest = tidewatch?.children?.[0]
    expect(gullsRest?.children).toBeUndefined()
    const ashford = locations?.entities.find((e) => e.id === 'l2')
    expect(ashford?.children).toBeUndefined()
  })

  it('attaches each entity its own facts, ordered by id, projected to {id,topic,content}', () => {
    const vm = toWikiViewModel(world)
    const locations = vm.groups.find((g) => g.kind === 'location')
    const saltmarsh = locations?.entities.find((e) => e.id === 'l1')
    expect(saltmarsh?.facts).toEqual([
      { id: 'fact1', topic: 'mood', content: 'Salt hangs in the air.' },
      { id: 'fact2', topic: 'geography', content: 'A fishing town.' },
    ])

    const tidewatch = saltmarsh?.children?.[0]
    expect(tidewatch?.facts).toEqual([{ id: 'factA', topic: 'note', content: 'A stone watchtower.' }])

    // A nested leaf and a factless entity both get an empty facts array.
    expect(tidewatch?.children?.[0]?.facts).toEqual([])
    const faction = vm.groups.find((g) => g.kind === 'faction')
    expect(faction?.entities[0]?.facts).toEqual([])
  })

  it('sorts same-named entities by id (deterministic tiebreak)', () => {
    const vm = toWikiViewModel(world)
    const npcs = vm.groups.find((g) => g.kind === 'npc')
    // Mira < Sentinel by name; the two Sentinels break the tie by id (n2 < n3).
    expect(npcs?.entities.map((e) => e.id)).toEqual(['n1', 'n2', 'n3'])
    expect(npcs?.entities.find((e) => e.id === 'n1')?.facts).toEqual([
      { id: 'fact3', topic: 'role', content: 'The harbormaster.' },
    ])
  })

  it('keeps an entity whose hierarchy parent is absent at top level', () => {
    const vm = toWikiViewModel(world)
    const items = vm.groups.find((g) => g.kind === 'item')
    expect(items?.entities.map((e) => e.id)).toEqual(['i1'])
    expect(items?.entities[0]?.children).toBeUndefined()
  })

  it('omits kinds with no top-level entities', () => {
    const factionsOnly: WorldSnapshot = {
      entities: [
        { id: 'f1', entityType: 'faction', name: 'The Ember Court' },
        { id: 'n1', entityType: 'npc', name: 'Mira' },
      ],
      facts: [],
      entityHierarchy: [],
    }
    const vm = toWikiViewModel(factionsOnly)
    // No locations, no items → those groups are absent (not empty groups).
    expect(vm.groups.map((g) => g.kind)).toEqual(['faction', 'npc'])
  })

  it('returns no groups and an empty glossary for an empty snapshot', () => {
    expect(toWikiViewModel({ entities: [], facts: [], entityHierarchy: [] })).toEqual({
      groups: [],
      glossary: [],
    })
  })

  it('builds RELATED links from relationships — de-snaked label, resolved name, both directions', () => {
    // One known-tier edge Mira ── warded_by ── Saltmarsh. It surfaces on BOTH
    // endpoints' pages with the SAME de-snaked label (v1: symmetric, no
    // inversion), each pointing at the OTHER entity (resolved id → name).
    const withRels: WikiSnapshot = {
      entities: [
        { id: 'n1', entityType: 'npc', name: 'Mira' },
        { id: 'l1', entityType: 'location', name: 'Saltmarsh' },
      ],
      facts: [],
      entityHierarchy: [],
      relationships: [{ sourceEntityId: 'n1', targetEntityId: 'l1', relationshipType: 'warded_by' }],
    }
    const vm = toWikiViewModel(withRels)
    const mira = vm.groups.find((g) => g.kind === 'npc')?.entities[0]
    const saltmarsh = vm.groups.find((g) => g.kind === 'location')?.entities[0]
    expect(mira?.related).toEqual([{ entityId: 'l1', name: 'Saltmarsh', label: 'warded by' }])
    expect(saltmarsh?.related).toEqual([{ entityId: 'n1', name: 'Mira', label: 'warded by' }])
  })

  it('sets hasBody from whether the entity carries known facts', () => {
    // Reuses the top fixture: Saltmarsh (l1) has facts; The Ember Court (f1)
    // and the leaf Gull's Rest (l4) have none.
    const vm = toWikiViewModel(world)
    const saltmarsh = vm.groups.find((g) => g.kind === 'location')?.entities.find((e) => e.id === 'l1')
    const emberCourt = vm.groups.find((g) => g.kind === 'faction')?.entities[0]
    const gullsRest = saltmarsh?.children?.[0]?.children?.[0]
    expect(saltmarsh?.hasBody).toBe(true)
    expect(emberCourt?.hasBody).toBe(false)
    expect(gullsRest?.hasBody).toBe(false)
    // A factless entity still carries an empty related list, never undefined.
    expect(emberCourt?.related).toEqual([])
  })

  it('drops a relationship whose other endpoint is absent from the snapshot', () => {
    // Two edges from Mira: one to a real entity, one to a tier-filtered ghost.
    // Only the resolvable edge surfaces — the dangling one is dropped silently.
    const danglingRel: WikiSnapshot = {
      entities: [
        { id: 'n1', entityType: 'npc', name: 'Mira' },
        { id: 'n2', entityType: 'npc', name: 'Doran' },
      ],
      facts: [],
      entityHierarchy: [],
      relationships: [
        { sourceEntityId: 'n1', targetEntityId: 'n2', relationshipType: 'allied_with' },
        { sourceEntityId: 'n1', targetEntityId: 'ghost', relationshipType: 'hunted_by' },
      ],
    }
    const vm = toWikiViewModel(danglingRel)
    const npcs = vm.groups.find((g) => g.kind === 'npc')?.entities
    const mira = npcs?.find((e) => e.id === 'n1')
    const doran = npcs?.find((e) => e.id === 'n2')
    expect(mira?.related).toEqual([{ entityId: 'n2', name: 'Doran', label: 'allied with' }])
    expect(doran?.related).toEqual([{ entityId: 'n1', name: 'Mira', label: 'allied with' }])
  })

  it('normalizes the introduction: title, paragraph-split prose, kind-resolved references', () => {
    // The snapshot's `introduction` (myth-zaqxh) becomes the wiki's front door:
    // the title carries through, the prose splits into paragraphs on newline
    // runs, and each reference keeps its WIRE name (the authored dig-deeper
    // label) plus the target entity's kind so the UI can annotate the link.
    const withIntro: WikiSnapshot = {
      introduction: {
        title: 'The Ashfen Reaches',
        prose: 'First paragraph.\n\nSecond paragraph.\nThird paragraph.',
        references: [
          { entityId: 'n1', name: 'Mira of the Marsh' },
          { entityId: 'l1', name: 'Saltmarsh' },
        ],
      },
      entities: [
        { id: 'l1', entityType: 'location', name: 'Saltmarsh' },
        { id: 'n1', entityType: 'npc', name: 'Mira' },
      ],
      facts: [],
      entityHierarchy: [],
    }
    const vm = toWikiViewModel(withIntro)
    expect(vm.introduction).toEqual({
      title: 'The Ashfen Reaches',
      paragraphs: ['First paragraph.', 'Second paragraph.', 'Third paragraph.'],
      // Wire order preserved (the intro points at them in its own order), the
      // wire NAME preserved, the kind resolved from the snapshot entity.
      references: [
        { entityId: 'n1', name: 'Mira of the Marsh', kind: 'npc' },
        { entityId: 'l1', name: 'Saltmarsh', kind: 'location' },
      ],
    })
  })

  it('drops an introduction reference that resolves to no wiki page', () => {
    // A dangling entityId (consolidated away since the intro was authored) and
    // a 'pc' target (not world lore — the wiki renders no page for it) both
    // drop silently; the resolvable reference survives.
    const withIntro: WikiSnapshot = {
      introduction: {
        title: 'The Ashfen Reaches',
        prose: 'One paragraph.',
        references: [
          { entityId: 'ghost', name: 'A Vanished Place' },
          { entityId: 'p1', name: 'The Player' },
          { entityId: 'l1', name: 'Saltmarsh' },
        ],
      },
      entities: [
        { id: 'l1', entityType: 'location', name: 'Saltmarsh' },
        { id: 'p1', entityType: 'pc', name: 'The Player' },
      ],
      facts: [],
      entityHierarchy: [],
    }
    const vm = toWikiViewModel(withIntro)
    expect(vm.introduction?.references).toEqual([
      { entityId: 'l1', name: 'Saltmarsh', kind: 'location' },
    ])
  })

  it('drops blank prose segments when splitting paragraphs', () => {
    const withIntro: WikiSnapshot = {
      introduction: {
        title: 'The Ashfen Reaches',
        prose: '  \n\nOnly paragraph.\n\n   ',
        references: [],
      },
      entities: [],
      facts: [],
      entityHierarchy: [],
    }
    expect(toWikiViewModel(withIntro).introduction?.paragraphs).toEqual(['Only paragraph.'])
  })

  it('carries no introduction for a pre-migration snapshot (the graceful absence)', () => {
    const vm = toWikiViewModel(world)
    expect(vm.introduction).toBeUndefined()
    expect('introduction' in vm).toBe(false)
  })

  it('attaches each entity its prose kernel as `body` (MYT-102)', () => {
    // Kernels key onto entities the same way facts do; an entity without one
    // carries no `body` key at all (absent, not empty).
    const withKernels: WikiSnapshot = {
      entities: [
        { id: 'n1', entityType: 'npc', name: 'Mira' },
        { id: 'l1', entityType: 'location', name: 'Saltmarsh' },
      ],
      facts: [],
      entityHierarchy: [],
      proseKernels: [{ entityId: 'n1', content: 'The harbormaster of Saltmarsh. She keeps the ledgers.' }],
    }
    const vm = toWikiViewModel(withKernels)
    const mira = vm.groups.find((g) => g.kind === 'npc')?.entities[0]
    const saltmarsh = vm.groups.find((g) => g.kind === 'location')?.entities[0]
    expect(mira?.body).toBe('The harbormaster of Saltmarsh. She keeps the ledgers.')
    expect(saltmarsh?.body).toBeUndefined()
    expect(saltmarsh !== undefined && 'body' in saltmarsh).toBe(false)
  })

  it('sets hasBody for a kernel-bearing entity even with zero facts (MYT-102)', () => {
    const kernelOnly: WikiSnapshot = {
      entities: [{ id: 'n1', entityType: 'npc', name: 'Mira' }],
      facts: [],
      entityHierarchy: [],
      proseKernels: [{ entityId: 'n1', content: 'A quiet harbormaster.' }],
    }
    expect(toWikiViewModel(kernelOnly).groups[0]?.entities[0]?.hasBody).toBe(true)
  })

  it('treats a whitespace-only kernel as absent (defensive floor)', () => {
    const blankKernel: WikiSnapshot = {
      entities: [{ id: 'n1', entityType: 'npc', name: 'Mira' }],
      facts: [],
      entityHierarchy: [],
      proseKernels: [{ entityId: 'n1', content: '   \n  ' }],
    }
    const entity = toWikiViewModel(blankKernel).groups[0]?.entities[0]
    expect(entity?.body).toBeUndefined()
    expect(entity?.hasBody).toBe(false)
  })

  it('attaches kernels to NESTED entities too (the recursion carries them)', () => {
    const nestedKernel: WikiSnapshot = {
      entities: [
        { id: 'l1', entityType: 'location', name: 'Saltmarsh' },
        { id: 'l2', entityType: 'location', name: 'The Tidewatch' },
      ],
      facts: [],
      entityHierarchy: [{ parentEntityId: 'l1', childEntityId: 'l2' }],
      proseKernels: [{ entityId: 'l2', content: 'A stone watchtower over the bay.' }],
    }
    const vm = toWikiViewModel(nestedKernel)
    const child = vm.groups[0]?.entities[0]?.children?.[0]
    expect(child?.body).toBe('A stone watchtower over the bay.')
    expect(child?.hasBody).toBe(true)
  })

  it('projects the world glossary sorted by term (MYT-102)', () => {
    const withGlossary: WikiSnapshot = {
      entities: [],
      facts: [],
      entityHierarchy: [],
      world: {
        vocabularyRegistry: {
          entries: [
            { term: 'tideglass', definition: 'Sea-cast glass the lamplighters prize.' },
            { term: 'roadwarden', definition: 'A sworn keeper of the gate roads.' },
          ],
        },
      },
    }
    expect(toWikiViewModel(withGlossary).glossary).toEqual([
      { term: 'roadwarden', definition: 'A sworn keeper of the gate roads.' },
      { term: 'tideglass', definition: 'Sea-cast glass the lamplighters prize.' },
    ])
  })

  it('sorts glossary terms on the first significant word — a leading article does not file everything under its own letter (ux-run2 myth-lbxfe)', () => {
    const articled: WikiSnapshot = {
      entities: [],
      facts: [],
      entityHierarchy: [],
      world: {
        vocabularyRegistry: {
          entries: [
            { term: 'the black tide', definition: 'The water that remembers.' },
            { term: 'iron-rain smell', definition: 'The smell before a Reckoning.' },
            { term: 'the affectionate water', definition: 'Water that follows the grieving.' },
            { term: 'a ceremony', definition: 'Any debt paid in syllables.' },
            { term: 'An Unmarked door', definition: 'A door with no ledger entry.' },
          ],
        },
      },
    }
    // Displayed terms keep their articles; the ORDER files each under its first
    // significant word: affectionate (A) < black (B) < ceremony (C) < iron (I) < Unmarked (U).
    expect(toWikiViewModel(articled).glossary.map((entry) => entry.term)).toEqual([
      'the affectionate water',
      'the black tide',
      'a ceremony',
      'iron-rain smell',
      'An Unmarked door',
    ])
  })

  it('a duplicate article-stripped key falls back to the full term — the order stays deterministic', () => {
    const duplicated: WikiSnapshot = {
      entities: [],
      facts: [],
      entityHierarchy: [],
      world: {
        vocabularyRegistry: {
          entries: [
            { term: 'The Rift', definition: 'The wound in the valley floor.' },
            { term: 'rift', definition: 'Any lesser crack the miners cut.' },
          ],
        },
      },
    }
    // Both file under "rift"; the full-term tiebreak ('The Rift' vs 'rift')
    // keeps the pair in one stable order across rebuilds.
    expect(toWikiViewModel(duplicated).glossary.map((entry) => entry.term)).toEqual([
      'rift',
      'The Rift',
    ])
  })

  it('returns an empty glossary when the snapshot carries no world (back-compat)', () => {
    expect(toWikiViewModel(world).glossary).toEqual([])
  })

  it('orders RELATED links deterministically by name, then id, then label', () => {
    // a1 links to three targets; two share the name "Anvil" (b2/b3 → id
    // tiebreak) and b2 is linked twice with different types (label tiebreak).
    const ordering: WikiSnapshot = {
      entities: [
        { id: 'a1', entityType: 'npc', name: 'Origin' },
        { id: 'b1', entityType: 'npc', name: 'Cove' },
        { id: 'b2', entityType: 'npc', name: 'Anvil' },
        { id: 'b3', entityType: 'npc', name: 'Anvil' },
      ],
      facts: [],
      entityHierarchy: [],
      relationships: [
        { sourceEntityId: 'a1', targetEntityId: 'b1', relationshipType: 'near' },
        { sourceEntityId: 'a1', targetEntityId: 'b3', relationshipType: 'near' },
        { sourceEntityId: 'a1', targetEntityId: 'b2', relationshipType: 'near' },
        { sourceEntityId: 'a1', targetEntityId: 'b2', relationshipType: 'far_from' },
      ],
    }
    const vm = toWikiViewModel(ordering)
    const origin = vm.groups.find((g) => g.kind === 'npc')?.entities.find((e) => e.id === 'a1')
    expect(origin?.related).toEqual([
      { entityId: 'b2', name: 'Anvil', label: 'far from' },
      { entityId: 'b2', name: 'Anvil', label: 'near' },
      { entityId: 'b3', name: 'Anvil', label: 'near' },
      { entityId: 'b1', name: 'Cove', label: 'near' },
    ])
  })
})
