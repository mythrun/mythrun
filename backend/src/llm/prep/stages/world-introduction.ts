// backend/src/llm/prep/stages/world-introduction.ts
//
// Stage `world_introduction` (myth-zaqxh). Writes the INTRODUCTION page every
// generated world opens on — the first prose the player reads at the reveal.
// Positioned right after entity_relationships (reads the fully-woven graph) and
// before entity_consolidation (it is the reveal boundary — the visible wait ends
// when the intro is written).
//
// ENFORCED IGNORANCE FROM BIRTH: this page eventually faces players, so the
// generator is fed the KNOWN-tier slice ONLY — the exact projection the
// world-snapshot serves. The ['known'] filter lives in the repo reads below
// (structural), not in the prompt. The worker owns the mechanical parts: the
// title is the persisted world name (the LLM never re-invents it), and the LLM's
// reference NAMES are resolved to real entity ids here, with dangling picks
// dropped.

import type { Repo } from '../../../repo/index.js'
import type { Entity } from '../../../repo/entities.js'
import type { FactRow } from '../../../repo/facts.js'
import type { RelationshipRow } from '../../../repo/relationships.js'
import type { ProseKernelRow } from '../../../repo/prose-kernels.js'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { resolve, dirname } from 'node:path'
import { generateObject } from '../../ai.js'
import { OPUS, OPUS_ID } from '../../models.js'
import { computeCostUsd } from '../../../billing/model-pricing.js'
import { renderVocabularyRegistry } from '../vocabulary-renderer.js'
import { WorldIntroductionSchema } from '../../schemas/world-introduction.js'
import type { VocabularyRegistry } from '../../schemas/vocabulary-registry.js'

const PROMPT_TEMPLATE = readFileSync(
  resolve(dirname(fileURLToPath(import.meta.url)), '../../prompts/prep/world-introduction.txt'),
  'utf8',
)

export interface WorldIntroductionArgs {
  readonly worldId: string
  readonly worldName: string
  readonly tone: string
  readonly themes: string
  readonly vocabularyRegistry: VocabularyRegistry
}

export interface StageCostResult {
  readonly costUsd: number
  readonly inputTokens: number
  readonly outputTokens: number
}

interface PersistedReference {
  readonly entityId: string
  readonly name: string
}

// Snapshot entity-kind → the intro's rendered section heading.
const ENTITY_TYPE_HEADINGS: readonly { readonly type: string; readonly heading: string }[] = [
  { type: 'faction', heading: 'Factions & powers' },
  { type: 'location', heading: 'Places' },
  { type: 'npc', heading: 'People' },
  { type: 'item', heading: 'Things' },
]

export async function runWorldIntroductionStage(
  repo: Repo,
  args: WorldIntroductionArgs,
): Promise<StageCostResult> {
  // 1. The KNOWN-tier slice — the exact projection the snapshot serves. The
  //    ['known'] filter is HERE (structural enforced ignorance); the generator
  //    can never see discoverable/secret material.
  const entities = await repo.entities.listByWorld(args.worldId, { accessLevels: ['known'] })
  const entityIds = entities.map((e) => e.id)
  const [facts, prose, relationships] = await Promise.all([
    repo.facts.listByEntities(entityIds, { accessLevels: ['known'] }),
    repo.proseKernels.listByEntities(entityIds),
    repo.relationships.listAmong(entityIds, ['known']),
  ])

  // 2. One OPUS call — the marquee first-read prose (LLM writes prose + picks
  //    reference names). Repair chain matches the other structured stages.
  const prompt = renderPrompt(args, entities, facts, prose, relationships)
  const result = await generateObject({
    model: OPUS,
    schema: WorldIntroductionSchema,
    schemaName: 'WorldIntroductionSchema',
    prompt,
    temperature: 0.7,
    maxRetries: 0,
    callSite: 'world-introduction',
    repairStrategy: 'haiku-then-sonnet',
    providerOptions: { mythrun: { stage: 'world_introduction' } },
  })

  // 3. Resolve the LLM's reference NAMES → real {entityId, name}; DROP dangling
  //    picks and de-dupe. (entity_consolidation, which runs behind the reveal,
  //    only ADDS phantom-resolution ghosts — it never removes the entities the
  //    intro references — so these ids stay valid.)
  const references = resolveReferences(result.output.references, entities)

  // 4. Persist { prose, references }. The title is the world's name — composed at
  //    read time, never stored in the intro blob.
  await repo.transaction(async (tx) => {
    await tx.worlds.setWorldIntroduction(
      args.worldId,
      JSON.stringify({ prose: result.output.prose, references }),
    )
  })

  /* c8 ignore next 2 — `?? 0` defensive: Anthropic populates usage on every call. */
  const inputTokens = result.usage.inputTokens ?? 0
  const outputTokens = result.usage.outputTokens ?? 0
  return {
    costUsd: computeCostUsd(OPUS_ID, { inputTokens, outputTokens }),
    inputTokens,
    outputTokens,
  }
}

function resolveReferences(
  names: readonly string[],
  entities: readonly Entity[],
): PersistedReference[] {
  const byLowerName = new Map<string, Entity>()
  for (const e of entities) byLowerName.set(e.name.toLowerCase(), e)
  const seen = new Set<string>()
  const out: PersistedReference[] = []
  for (const name of names) {
    const match = byLowerName.get(name.toLowerCase())
    if (match === undefined) continue // dangling pick → drop
    if (seen.has(match.id)) continue // de-dupe
    seen.add(match.id)
    out.push({ entityId: match.id, name: match.name })
  }
  return out
}

function renderPrompt(
  args: WorldIntroductionArgs,
  entities: readonly Entity[],
  facts: readonly FactRow[],
  prose: readonly ProseKernelRow[],
  relationships: readonly RelationshipRow[],
): string {
  // The vocabulary registry is tier-filtered too — a secret term names something
  // the player must not know (mirrors the snapshot/wiki views).
  const knownVocab: VocabularyRegistry = {
    entries: args.vocabularyRegistry.entries.filter((e) => e.access_level === 'known'),
    adjacent_franchises: args.vocabularyRegistry.adjacent_franchises,
  }
  // replaceAll: worldName appears more than once in the template.
  return PROMPT_TEMPLATE.replaceAll('{{worldName}}', args.worldName)
    .replaceAll('{{tone}}', args.tone)
    .replaceAll('{{themes}}', args.themes)
    .replaceAll('{{vocabularyRegistry}}', renderVocabularyRegistry(knownVocab))
    .replaceAll('{{knownWorld}}', renderKnownWorld(entities, facts, prose, relationships))
}

function renderKnownWorld(
  entities: readonly Entity[],
  facts: readonly FactRow[],
  prose: readonly ProseKernelRow[],
  relationships: readonly RelationshipRow[],
): string {
  if (entities.length === 0) return '(no entities yet)'
  const proseById = new Map(prose.map((p) => [p.entityId, p.content]))
  const factsById = groupFacts(facts)
  const nameById = new Map(entities.map((e) => [e.id, e.name]))

  const sections: string[] = []
  for (const { type, heading } of ENTITY_TYPE_HEADINGS) {
    const rows = entities.filter((e) => e.entityType === type)
    if (rows.length === 0) continue
    const body = rows.map((e) => renderEntity(e, proseById.get(e.id), factsById.get(e.id))).join('\n')
    sections.push(`### ${heading}\n${body}`)
  }
  const relBlock = renderRelationships(relationships, nameById)
  if (relBlock) sections.push(relBlock)
  return sections.join('\n\n')
}

function groupFacts(facts: readonly FactRow[]): Map<string, FactRow[]> {
  const map = new Map<string, FactRow[]>()
  for (const f of facts) {
    const list = map.get(f.entityId)
    if (list) list.push(f)
    else map.set(f.entityId, [f])
  }
  return map
}

function renderEntity(
  entity: Entity,
  prose: string | undefined,
  facts: readonly FactRow[] | undefined,
): string {
  const head = prose ? `- **${entity.name}** — ${prose}` : `- **${entity.name}**`
  const factLines = (facts ?? []).map((f) => `    - ${f.topic}: ${f.content}`).join('\n')
  return factLines ? `${head}\n${factLines}` : head
}

function renderRelationships(
  rels: readonly RelationshipRow[],
  nameById: Map<string, string>,
): string {
  if (rels.length === 0) return ''
  const lines: string[] = []
  for (const r of rels) {
    const from = nameById.get(r.sourceEntityId)
    const to = nameById.get(r.targetEntityId)
    // Endpoints are always in the entity set — listAmong DB-filters
    // relationships to entity-set-internal pairs; the guard is defense-in-depth.
    /* c8 ignore next */
    if (from === undefined || to === undefined) continue
    const tail = r.description ? `: ${r.description}` : ''
    lines.push(`- ${from} ${r.relationshipType} ${to}${tail}`)
  }
  return `### Relationships\n${lines.join('\n')}`
}
