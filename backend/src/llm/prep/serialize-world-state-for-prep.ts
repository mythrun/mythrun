// Async, omniscient world-state SERIALIZER for the session-prep Opus call.
//
// Composes existing production reads into a markdown world-state document:
//   1. World concept (from the worlds row — tone/era/themes/key-tensions/overview)
//   2. The omniscient world dump (renderWorldDump over worldInventory.load — ALL
//      access tiers, secrets included; this is a prep/Slow-Thinker-tier artifact,
//      NOT a Fast-Thinker read, so the [access_level] markers are authoritative)
//   3. The party — characters, each with their KNOWN-tier facts only (one batched
//      facts.listByEntities call, grouped by entityId — never N+1)
//   4. The CHOSEN starting situation (starting_situation_entries[index])
//
// Forward-compat seams (for the later session-N consumer, not exercised yet):
//   - `loadInventory` injects an alternate world-state source (default:
//     repo.worldInventory.load) so a session-N caller can feed evolved state.
//   - `priorSessionContext` appends previous-session summaries.
import type { WorldInventory } from '../../repo/world-inventory.js'
import type { Repo } from '../../repo/index.js'
import type { SessionHandoff } from '../schemas/post-session-analysis.js'
import { renderWorldDump } from './world-dump.js'

export interface PriorSessionContext {
  readonly previousSummaries: readonly string[]
  /** MYT-74b §4 — the latest ended session's handoff. Renders the opening-scene
   *  anchor (party positions, time, threads, NPC dispositions) into the prep
   *  prompt. The verbatim voice/atmosphere are NOT rendered here — the processor
   *  deterministically appends them to ft_context (§6). */
  readonly latestHandoff?: SessionHandoff
}

export interface SerializeArgs {
  readonly campaignId: string
  readonly sessionNumber: number
  /** Forward-compat seam: alternate world-state source. Defaults to the
   *  omniscient repo read (`repo.worldInventory.load`). The session-N consumer
   *  injects evolved state here. */
  readonly loadInventory?: (worldId: string) => Promise<WorldInventory>
  readonly priorSessionContext?: PriorSessionContext
}

export async function serializeWorldStateForPrep(repo: Repo, args: SerializeArgs): Promise<string> {
  const meta = await repo.campaigns.getWorldAndSituationIndex(args.campaignId)
  if (!meta) throw new Error(`session-prep: campaign not found: ${args.campaignId}`)
  const worldId = meta.world_id

  const world = await repo.worlds.getById(worldId)
  if (!world) throw new Error(`session-prep: world not found: ${worldId}`)

  const loadInventory = args.loadInventory ?? ((id: string) => repo.worldInventory.load(id))
  const inv = await loadInventory(worldId)
  const party = await repo.characters.listForCampaign(args.campaignId)

  // Batched known-tier facts for all PC entities in ONE query (no N+1), then
  // grouped by entityId for per-character rendering.
  const pcEntityIds = party.map((p) => p.entityId).filter((x): x is string => x !== null)
  const knownFacts =
    pcEntityIds.length > 0
      ? await repo.facts.listByEntities(pcEntityIds, { accessLevels: ['known'] })
      : []
  const factsByEntity = new Map<string, { topic: string; content: string }[]>()
  for (const f of knownFacts) {
    const arr = factsByEntity.get(f.entityId) ?? []
    arr.push({ topic: f.topic, content: f.content })
    factsByEntity.set(f.entityId, arr)
  }

  // myth-vb2ov — the session's WORKING SET drives which canon renders in full
  // vs. as a compact roster, keeping the serialized prep input bounded as the
  // world accumulates canon across a long campaign.
  const workingSetIds = computeWorkingSetIds(inv, pcEntityIds, args.priorSessionContext?.latestHandoff)

  const lines: string[] = []
  lines.push('## World Concept', `**Name:** ${world.name}`)
  if (world.tone) lines.push(`**Tone:** ${world.tone}`)
  if (world.era) lines.push(`**Era:** ${world.era}`)
  if (world.themes) lines.push(`**Themes:** ${world.themes}`)
  if (world.keyTensions) lines.push(`**Key Tensions:** ${world.keyTensions}`)
  if (world.worldOverview) lines.push('', '## World Overview', world.worldOverview)

  lines.push(
    '',
    '## World State (omniscient — all access tiers; the [access_level] markers are authoritative)',
    renderWorldStateDump(inv, workingSetIds),
    '',
  )

  lines.push('## The Party')
  for (const pc of party) {
    lines.push(`### ${pc.name} — level ${String(pc.level)} ${pc.class}`)
    const facts = pc.entityId ? factsByEntity.get(pc.entityId) ?? [] : []
    if (facts.length > 0) {
      lines.push('Known at session start:')
      for (const f of facts) lines.push(`- [${f.topic}] ${f.content}`)
    }
    lines.push('')
  }

  if (meta.starting_situation_index !== null) {
    const entries = await repo.worlds.getStartingSituationEntries(worldId)
    const chosen = entries[meta.starting_situation_index]
    if (chosen) lines.push('## The Situation', chosen.prose, '')
  }

  if (args.priorSessionContext && args.priorSessionContext.previousSummaries.length > 0) {
    lines.push('## Prior Sessions')
    for (const s of args.priorSessionContext.previousSummaries) lines.push(`- ${s}`)
    lines.push('')
  }

  const handoff = args.priorSessionContext?.latestHandoff
  if (handoff) {
    lines.push('## Where We Left Off')
    lines.push(`Time of day: ${handoff.timeOfDay}`)
    if (handoff.party.length > 0) {
      lines.push('Party positions:')
      for (const m of handoff.party) lines.push(`- ${m.characterName}: ${m.location} (${m.condition})`)
    }
    if (handoff.unresolvedThreads.length > 0) {
      lines.push('Unresolved threads (most urgent first):')
      for (const t of handoff.unresolvedThreads) lines.push(`- ${t}`)
    }
    if (handoff.npcs.length > 0) {
      lines.push('Returning NPCs — current disposition toward the party:')
      for (const npc of handoff.npcs) lines.push(`- ${npc.name}: ${npc.state}`)
    }
    lines.push('')
  }

  return lines.join('\n')
}

// Above this many entities the omniscient dump is tiered so prep input stays
// bounded as campaign canon accumulates (myth-vb2ov). Below it, the whole world
// renders in full — session-1 and early-campaign worlds are byte-for-byte
// unchanged.
const WORLD_DUMP_FULL_THRESHOLD = 40
// Safety valve on the working set's full-detail size. A session realistically
// touches far fewer entities than this; the cap only guards a pathological hub
// entity whose neighborhood is enormous.
const MAX_WORKING_SET_ENTITIES = 60
// Compact-roster cap for dormant entities; the remainder collapses to a tally.
const MAX_ROSTER_ENTITIES = 100

/**
 * The session's WORKING SET of entity ids = the party's world entities, the
 * entities the latest handoff names as in play (returning NPCs, key locations,
 * party positions — matched by name), and their 1-hop relationship neighbors.
 *
 * Deterministic and cheap: structural relevance only (no embeddings, no I/O),
 * which is ZFC-safe (a mechanical graph/name selection, not a content-judgment
 * heuristic) and side-effect-free in the offline prep path. Everything the model
 * needs for THIS session is anchored either to the party or to what the handoff
 * flagged as still live; the accumulated dormant tail is compacted, not dropped.
 */
function computeWorkingSetIds(
  inv: WorldInventory,
  partyEntityIds: readonly string[],
  handoff: SessionHandoff | undefined,
): Set<string> {
  const named = new Set<string>()
  if (handoff) {
    for (const npc of handoff.npcs) named.add(npc.name.toLowerCase())
    for (const loc of handoff.keyLocations) named.add(loc.name.toLowerCase())
    for (const m of handoff.party) named.add(m.location.toLowerCase())
  }
  const seed = new Set<string>(partyEntityIds)
  for (const [id, e] of inv.entitiesById) {
    if (named.has(e.name.toLowerCase())) seed.add(id)
  }

  const neighbors = new Set<string>()
  for (const r of inv.relationshipsById.values()) {
    if (seed.has(r.sourceEntityId) && inv.entitiesById.has(r.targetEntityId)) neighbors.add(r.targetEntityId)
    if (seed.has(r.targetEntityId) && inv.entitiesById.has(r.sourceEntityId)) neighbors.add(r.sourceEntityId)
  }
  const working = new Set(seed)
  // Add neighbors in a stable id order until the safety cap is reached.
  for (const id of [...neighbors].sort()) {
    if (working.size >= MAX_WORKING_SET_ENTITIES) break
    working.add(id)
  }
  return working
}

/** Subset an inventory to a set of entity ids so `renderWorldDump` emits full
 *  detail for just those (facts/relationships follow their SOURCE entity). */
function filterInventory(inv: WorldInventory, ids: ReadonlySet<string>): WorldInventory {
  return {
    entitiesById: new Map([...inv.entitiesById].filter(([id]) => ids.has(id))),
    proseByEntityId: new Map([...inv.proseByEntityId].filter(([id]) => ids.has(id))),
    factsById: new Map([...inv.factsById].filter(([, f]) => ids.has(f.entityId))),
    relationshipsById: new Map([...inv.relationshipsById].filter(([, r]) => ids.has(r.sourceEntityId))),
  }
}

/**
 * Render the omniscient world dump, tiering when the world is large: full detail
 * (prose + all facts + relationships, every access tier) for the working set,
 * and a compact one-line roster for the dormant remainder — name + type + access
 * tier only, NO facts, so accumulated canon is *referenced*, not re-emitted.
 * Below the threshold the whole world renders in full via `renderWorldDump`.
 */
function renderWorldStateDump(inv: WorldInventory, workingSetIds: ReadonlySet<string>): string {
  if (inv.entitiesById.size <= WORLD_DUMP_FULL_THRESHOLD) return renderWorldDump(inv)

  const fullDump = renderWorldDump(filterInventory(inv, workingSetIds))

  const dormant = [...inv.entitiesById.keys()].filter((id) => !workingSetIds.has(id)).sort()
  const shown = dormant.slice(0, MAX_ROSTER_ENTITIES)
  const roster: string[] = [
    '',
    "## Dormant world entities (compact roster — NOT in this session's working set)",
    'Reference only. Do NOT re-describe these; foreground the working set above. Pull an',
    'entity up into a document only if this session actually brings it into play.',
    '',
  ]
  for (const id of shown) {
    const e = inv.entitiesById.get(id)
    if (e) roster.push(`- ${e.name} (${e.entityType}) [access_level: ${e.accessLevel}]`)
  }
  const hidden = dormant.length - shown.length
  if (hidden > 0) roster.push(`- …and ${String(hidden)} more dormant entities not listed.`)
  return `${fullDump}\n${roster.join('\n')}`
}
