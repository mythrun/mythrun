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
import { renderWorldDump } from './world-dump.js'

export interface PriorSessionContext {
  readonly previousSummaries: readonly string[]
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
    renderWorldDump(inv),
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

  return lines.join('\n')
}
