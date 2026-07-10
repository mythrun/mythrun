import { toWikiViewModel } from '@mythrun/client-core/worldgen'
import type { WikiEntity, WikiViewModel } from '@mythrun/client-core/contract'

// Shared WorldWiki fixture (MYT-89 D4): a small relationship-BEARING world
// snapshot normalized through the REAL `toWikiViewModel`, so tests and stories
// exercise the exact model shape production hands the wiki — and RelatedFooter
// always renders REAL links. An empty-relationships fixture would silently
// exercise nothing (the D2 fixture-honesty rule), so the relationships below
// are load-bearing: every page in the fixture has related reading, and
// Sunspire is the deliberate empty-body specimen (no facts, one relationship).
// The `introduction` (myth-b9bap) mirrors what every post-migration world
// carries — its two-paragraph prose is load-bearing too (it proves the
// paragraph split renders paragraphs, not a wall).

type WikiSnapshotInput = Parameters<typeof toWikiViewModel>[0]

const SNAPSHOT: WikiSnapshotInput = {
  introduction: {
    title: 'The Ashfen Reaches',
    prose:
      '[placeholder for the first introduction paragraph — how the world functions at rest, long enough to wrap at phone width and show the prose measure]\n\n[placeholder for the second introduction paragraph — the tensions a newcomer would feel first]',
    references: [
      { entityId: 'f-guild', name: 'The Tallow Guild' },
      { entityId: 'l-reach', name: 'Ashfen Reach' },
      { entityId: 'n-vale', name: 'Maeris Vale' },
    ],
  },
  entities: [
    { id: 'f-guild', entityType: 'faction', name: 'The Tallow Guild' },
    { id: 'l-reach', entityType: 'location', name: 'Ashfen Reach' },
    { id: 'l-ward', entityType: 'location', name: 'The Drowned Ward' },
    { id: 'l-spire', entityType: 'location', name: 'Sunspire' },
    { id: 'n-vale', entityType: 'npc', name: 'Maeris Vale' },
    { id: 'i-ledger', entityType: 'item', name: 'The Salt Ledger' },
  ],
  facts: [
    {
      id: 'fact-1',
      entityId: 'f-guild',
      topic: 'Purpose',
      content:
        '[placeholder for the guild purpose — two quiet sentences long enough to wrap at phone width and show the prose measure]',
    },
    {
      id: 'fact-2',
      entityId: 'f-guild',
      topic: 'Reputation',
      content: '[placeholder for how the guild is regarded in the reach]',
    },
    {
      id: 'fact-3',
      entityId: 'l-reach',
      topic: 'Terrain',
      content: '[placeholder for the terrain of the reach]',
    },
    {
      id: 'fact-4',
      entityId: 'l-ward',
      topic: 'Note',
      content: '[placeholder for a note about the ward at high tide]',
    },
    {
      id: 'fact-5',
      entityId: 'n-vale',
      topic: 'Role',
      content: '[placeholder for what Maeris Vale does and for whom]',
    },
    {
      id: 'fact-6',
      entityId: 'i-ledger',
      topic: 'Provenance',
      content: '[placeholder for where the ledger came from]',
    },
  ],
  entityHierarchy: [{ parentEntityId: 'l-reach', childEntityId: 'l-ward' }],
  relationships: [
    { sourceEntityId: 'f-guild', targetEntityId: 'l-ward', relationshipType: 'seated_at' },
    { sourceEntityId: 'n-vale', targetEntityId: 'f-guild', relationshipType: 'sworn_to' },
    { sourceEntityId: 'i-ledger', targetEntityId: 'n-vale', relationshipType: 'kept_by' },
    { sourceEntityId: 'l-spire', targetEntityId: 'f-guild', relationshipType: 'watched_by' },
  ],
}

export const WIKI_FIXTURE_MODEL: WikiViewModel = toWikiViewModel(SNAPSHOT)

/** The same world WITHOUT an introduction — a pre-migration snapshot. The
 *  old-world specimen: the wiki must open on the browse home, gracefully. */
export const WIKI_FIXTURE_MODEL_BARE: WikiViewModel = { groups: WIKI_FIXTURE_MODEL.groups }

/** Look a fixture entity up by id (nested children included). Throws on a miss
 *  so a typo'd id fails the test loudly instead of feeding it `undefined`. */
export function wikiFixtureEntity(id: string): WikiEntity {
  const visit = (entity: WikiEntity): WikiEntity | undefined => {
    if (entity.id === id) return entity
    for (const child of entity.children ?? []) {
      const hit = visit(child)
      if (hit !== undefined) return hit
    }
    return undefined
  }
  for (const group of WIKI_FIXTURE_MODEL.groups) {
    for (const entity of group.entities) {
      const hit = visit(entity)
      if (hit !== undefined) return hit
    }
  }
  throw new Error(`wiki fixture has no entity '${id}'`)
}
