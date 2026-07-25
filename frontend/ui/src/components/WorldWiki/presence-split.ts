import type { WikiEntity } from '@mythrun/client-core/contract'

// presence-split (ux-run3 myth-ry14g) — the index's two halves. The run-3
// critique: twelve alphabetized bare names render the scene's antagonist and a
// session-one shopkeeper as equals, when the transcript already knows which of
// them the player just met. The play sidebar passes the ids the live session has
// named; each browse group splits into those (first) and the rest.
//
// Pure list plumbing over a membership set — no cognition, no ranking, no
// recency decay. The naming itself is done upstream by the same MECHANICAL name
// matcher that highlights entities in the prose.

/** One group's entities, partitioned. Both halves keep the group's own
 *  (name, id) order — presence reorders the BLOCKS, never within one. */
export interface PresenceSplit {
  readonly present: readonly WikiEntity[]
  readonly rest: readonly WikiEntity[]
}

/** True when this entity — or anything nested beneath it — was named. A named
 *  child lifts its whole branch, so a person met at a place travels UNDER that
 *  place instead of being torn out of the location tree. */
function wasNamed(entity: WikiEntity, ids: ReadonlySet<string>): boolean {
  if (ids.has(entity.id)) return true
  return (entity.children ?? []).some((child) => wasNamed(child, ids))
}

/** Partition a group's root entities into the named half and the remainder. */
export function splitByPresence(
  entities: readonly WikiEntity[],
  ids: ReadonlySet<string>,
): PresenceSplit {
  const present: WikiEntity[] = []
  const rest: WikiEntity[] = []
  for (const entity of entities) {
    if (wasNamed(entity, ids)) present.push(entity)
    else rest.push(entity)
  }
  return { present, rest }
}
