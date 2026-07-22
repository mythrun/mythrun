import type { WikiEntity, WikiViewModel } from '@mythrun/client-core/contract'

// The wiki search filter (MYT-89 D2). A pure, DOM-free reshape of the view model:
// given a normalized (lower-cased, trimmed) needle, keep only the entities whose
// name matches — plus the ANCESTOR PATH of any nested match, so a deep hit never
// hides behind a non-matching parent. A self-match keeps the entity's WHOLE
// subtree (you searched for the container, you see what it holds); a parent kept
// only for a descendant keeps just the path down to the matches. The glossary
// (MYT-102) filters through the same needle on its TERM — the parity of the
// entities' name-only match, so search behaves identically across the index.
// An empty needle returns the model untouched (the caller short-circuits to the
// full tree).

/**
 * Filter one entity subtree against `needle`. Returns the (possibly pruned)
 * entity when it or a descendant matches, else `undefined`.
 */
function filterEntity(entity: WikiEntity, needle: string): WikiEntity | undefined {
  if (entity.name.toLowerCase().includes(needle)) return entity
  const kept = (entity.children ?? [])
    .map((child) => filterEntity(child, needle))
    .filter((child): child is WikiEntity => child !== undefined)
  if (kept.length === 0) return undefined
  return { ...entity, children: kept }
}

/**
 * Filter the whole model to entities matching `query` (case-insensitive name
 * match), preserving the ancestor path of any nested match and dropping groups
 * left empty — and to glossary rows whose term matches the same needle. An
 * empty/whitespace query returns the model unchanged.
 */
export function filterWikiModel(model: WikiViewModel, query: string): WikiViewModel {
  const needle = query.trim().toLowerCase()
  if (needle === '') return model
  const groups = model.groups
    .map((group) => ({
      kind: group.kind,
      entities: group.entities
        .map((entity) => filterEntity(entity, needle))
        .filter((entity): entity is WikiEntity => entity !== undefined),
    }))
    .filter((group) => group.entities.length > 0)
  const glossary = model.glossary.filter((entry) => entry.term.toLowerCase().includes(needle))
  return { groups, glossary }
}
