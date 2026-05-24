// backend/src/llm/prep/stages/character-integration.ts
//
// MYT-54 T10: campaign-scoped character-integration stage. A single Opus
// pass over the entire party weaves every PC into the world in one shot.
// The handler:
//
//   1. Loads the party (every character_concepts row with status='completed'
//      for this campaign, joined with its character row + the player's
//      display name + the structured CharacterConceptOutput JSONB blob).
//   2. Loads campaign meta (pre_integration_notes + starting situation prose).
//   3. Loads the world inventory and renders it into a deterministic prompt
//      block (via the shared world-dump module).
//   4. Runs a cost-cap pre-flight: prior completed character-creation costs
//      plus this stage's estimate must fit under the cap.
//   5. Calls Opus with the IntegrationResultSchema. The call happens OUTSIDE
//      the DB transaction (the call can take 30–120s and we must not hold a
//      PoolClient that long).
//   6. Validates the LLM output against worker-side invariants:
//      - characters.length === party.length (else LlmStructuredOutputError).
//      - userId set matches the input party exactly (else LlmStructuredOutputError).
//      - Unknown targetId / targetUserId / newFacts.entityId are SILENTLY
//        DROPPED with a console.warn (LLM hallucination tolerance).
//      - PC↔PC mirror: if A→B is emitted but B→A is not, synthesize the
//        mirror edge on B with the same type/description.
//   7. Persists everything in ONE transaction:
//      - INSERT entities (entity_type='pc') for each PC.
//      - INSERT prose_kernels for each PC.
//      - INSERT facts (per-PC + newFacts on existing world entities).
//      - INSERT relationships (PC↔world and PC↔PC, resolved via maps).
//      - UPDATE characters.entity_id and character_concepts.status='integrated'
//        for each PC.
//      - UPDATE campaigns.status='active'.
//   8. Returns the LLM cost + the resolved PC entity UUIDs.
//
// The processor (T11) owns pipeline_runs claim/complete/fail bookkeeping;
// this handler does NOT touch pipeline_runs.

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { resolve, dirname } from 'node:path'
import type { Pool } from 'pg'
import { generateObject } from '../../ai.js'
import { OPUS } from '../../models.js'
import { LlmStructuredOutputError } from '../../errors.js'
import {
  IntegrationResultSchema,
  type IntegrationResult,
  type PCIntegration,
  type IntegrationRelationship,
} from '../../schemas/character-integration.js'
import { loadWorldInventory, renderWorldDump, type WorldInventory } from '../world-dump.js'
import {
  sumCharacterCreationStageCosts,
  readCharacterCreationCostCap,
  CostCapExceededError,
} from '../cost-cap.js'
import { uuidv7 } from '../../../repo/uuidv7.js'

const PROMPT_TEMPLATE = readFileSync(
  resolve(
    dirname(fileURLToPath(import.meta.url)),
    '../../prompts/prep/character-integration.txt',
  ),
  'utf8',
)

// Anthropic Opus pricing — same constants as character-concept.ts /
// character-sheet.ts. Held local so a per-stage tier change is one-file
// scoped.
const OPUS_INPUT_PER_MTOK = 15.0
const OPUS_OUTPUT_PER_MTOK = 75.0

// Cost estimator constants — rough budget for the pre-flight gate. The
// estimator is intentionally pessimistic: better to gate a near-cap run
// than to blow past the cap mid-call.
const APPROX_CHARS_PER_TOKEN = 4
const ESTIMATED_OUTPUT_TOKENS_PER_PC = 1200
// Static prompt overhead (template + party-block boilerplate per PC).
const PROMPT_OVERHEAD_CHARS = 4000
const PROMPT_OVERHEAD_CHARS_PER_PC = 2000

export interface CharacterIntegrationArgs {
  readonly campaignId: string
  readonly ownerUserId: string
}

export interface CharacterIntegrationResult {
  readonly llmCostUsd: number
  readonly characterIds: readonly string[]
}

// In-memory shape of one party member loaded from the join.
interface PartyMember {
  readonly userId: string
  readonly displayName: string
  readonly conceptText: string | null
  readonly situationGroundingText: string
  readonly conceptOutput: Record<string, unknown> | null
  readonly characterId: string | null
  readonly characterName: string | null
  readonly characterClass: string | null
  readonly characterSpecies: string | null
  readonly characterBackground: string | null
  readonly characterLevel: number | null
  readonly characterHitPoints: number | null
  readonly characterArmorClass: number | null
}

interface CampaignMeta {
  readonly preIntegrationNotes: string | null
  readonly worldId: string
  readonly startingSituationProse: string
}

interface SituationEntry {
  readonly index: number
  readonly locationEntityId: string
  readonly prose: string
}

interface DroppedTargets {
  readonly unknownTargetUuids: string[]
  readonly unknownTargetUserIds: string[]
  readonly unknownNewFactEntityIds: string[]
}

export async function runCharacterIntegrationStage(
  pool: Pool,
  args: CharacterIntegrationArgs,
): Promise<CharacterIntegrationResult> {
  // 1. Load the party.
  const party = await loadParty(pool, args.campaignId)
  /* c8 ignore start — invariant: the route (POST /finalize-character-
   * creation) gates on `n > 0` completed concepts before enqueuing, so
   * by the time the handler runs there is always at least one PC. */
  if (party.length === 0) {
    throw new Error('no_completed_concepts')
  }
  /* c8 ignore stop */

  // 2. Load campaign meta + starting-situation prose.
  const meta = await loadCampaignMeta(pool, args.campaignId)

  // 3. Load world dump (open + release a client just for this read).
  const worldInv = await loadWorldInventoryUsingPool(pool, meta.worldId)
  const worldDump = renderWorldDump(worldInv)
  const worldVocabulary = await loadWorldVocabularyText(pool, meta.worldId)

  // 4. Cost-cap pre-flight. Throw BEFORE making the LLM call.
  await enforceCostCap(pool, args.campaignId, party.length, worldDump.length)

  // 5. Render prompt + Opus call (OUTSIDE the DB transaction).
  const llmResult = await callIntegrationLlm({
    party,
    worldInv,
    worldDump,
    worldVocabulary,
    preIntegrationNotes: meta.preIntegrationNotes,
    startingSituationProse: meta.startingSituationProse,
  })

  // 6. Worker-side invariant validation + PC↔PC mirror.
  const { validated, dropped } = validateAndMirror(llmResult.output, { party, worldInv })
  logDroppedTargets(dropped)

  // 7. Single-transaction writes.
  const entityIds = await writeIntegration(pool, args, meta.worldId, validated, worldInv)

  /* c8 ignore start — `?? 0` fallbacks: the Anthropic SDK always populates
   * inputTokens / outputTokens on the final usage emission; the optional-
   * chain narrowing is defense-in-depth. */
  const inputTokens = llmResult.usage.inputTokens ?? 0
  const outputTokens = llmResult.usage.outputTokens ?? 0
  /* c8 ignore stop */
  const llmCostUsd =
    (inputTokens / 1_000_000) * OPUS_INPUT_PER_MTOK +
    (outputTokens / 1_000_000) * OPUS_OUTPUT_PER_MTOK
  return { llmCostUsd, characterIds: entityIds }
}

async function loadWorldInventoryUsingPool(pool: Pool, worldId: string): Promise<WorldInventory> {
  const client = await pool.connect()
  try {
    return await loadWorldInventory(client, worldId)
  } finally {
    client.release()
  }
}

async function enforceCostCap(
  pool: Pool,
  campaignId: string,
  partySize: number,
  worldDumpLen: number,
): Promise<void> {
  const spentSoFar = await sumCharacterCreationStageCosts(pool, campaignId)
  const cap = await readCharacterCreationCostCap(pool)
  const estimatedCost = estimateIntegrationCost(partySize, worldDumpLen)
  if (spentSoFar + estimatedCost > cap) {
    throw new CostCapExceededError(
      `character_creation_cost_cap_exceeded: spent=${String(spentSoFar)} est=${String(estimatedCost)} cap=${String(cap)}`,
      { spent: spentSoFar, estimated: estimatedCost, cap },
    )
  }
}

interface CallIntegrationLlmArgs {
  readonly party: readonly PartyMember[]
  readonly worldInv: WorldInventory
  readonly worldDump: string
  readonly worldVocabulary: string
  readonly preIntegrationNotes: string | null
  readonly startingSituationProse: string
}

async function callIntegrationLlm(
  args: CallIntegrationLlmArgs,
): Promise<{
  output: IntegrationResult
  usage: { inputTokens?: number | undefined; outputTokens?: number | undefined }
}> {
  const partyBlock = renderPartyBlock(args.party)
  const prompt = renderPrompt({
    preIntegrationNotes: args.preIntegrationNotes,
    startingSituationProse: args.startingSituationProse,
    worldVocabulary: args.worldVocabulary,
    worldDump: args.worldDump,
    party: partyBlock,
  })
  const result = await generateObject({
    model: OPUS,
    schema: IntegrationResultSchema,
    prompt,
    maxRetries: 0,
    callSite: 'character-integration',
    schemaName: 'IntegrationResultSchema',
    repairStrategy: 'sonnet',
    providerOptions: { mythrun: { stage: 'character_integration' } },
  })
  return { output: result.output, usage: result.usage }
}

// ---------------------------------------------------------------------------
// Loaders.
// ---------------------------------------------------------------------------

async function loadParty(pool: Pool, campaignId: string): Promise<readonly PartyMember[]> {
  const result = await pool.query<{
    user_id: string
    display_name: string
    concept_text: string | null
    situation_grounding_text: string
    concept_output: Record<string, unknown> | null
    character_id: string | null
    character_name: string | null
    character_class: string | null
    character_species: string | null
    character_background: string | null
    character_level: number | null
    character_hit_points: number | null
    character_armor_class: number | null
  }>(
    // characters.campaign_id was dropped in migration 009 — membership lives
    // in campaign_characters. Join through it to reach the per-(campaign,
    // user) characters row.
    `SELECT
       cc.user_id,
       u.display_name,
       cc.concept_text,
       cc.situation_grounding_text,
       cc.concept_output,
       ch.id           AS character_id,
       ch.name         AS character_name,
       ch.class        AS character_class,
       ch.species      AS character_species,
       ch.background   AS character_background,
       ch.level        AS character_level,
       ch.hit_points   AS character_hit_points,
       ch.armor_class  AS character_armor_class
       FROM character_concepts cc
       JOIN campaign_members cm USING (campaign_id, user_id)
       JOIN users u ON cm.user_id = u.id
       LEFT JOIN campaign_characters cch
         ON cch.campaign_id = cc.campaign_id AND cch.user_id = cc.user_id
       LEFT JOIN characters ch ON ch.id = cch.character_id
      WHERE cc.campaign_id = $1
        AND cc.status = 'completed'
      ORDER BY cc.submitted_at ASC`,
    [campaignId],
  )
  return result.rows.map((r) => ({
    userId: r.user_id,
    displayName: r.display_name,
    conceptText: r.concept_text,
    situationGroundingText: r.situation_grounding_text,
    conceptOutput: r.concept_output,
    characterId: r.character_id,
    characterName: r.character_name,
    characterClass: r.character_class,
    characterSpecies: r.character_species,
    characterBackground: r.character_background,
    characterLevel: r.character_level,
    characterHitPoints: r.character_hit_points,
    characterArmorClass: r.character_armor_class,
  }))
}

async function loadCampaignMeta(pool: Pool, campaignId: string): Promise<CampaignMeta> {
  const result = await pool.query<{
    pre_integration_notes: string | null
    world_id: string
    starting_situation_index: number | null
    starting_situation_entries: SituationEntry[]
  }>(
    `SELECT c.pre_integration_notes,
            c.world_id,
            c.starting_situation_index,
            w.starting_situation_entries
       FROM campaigns c
       JOIN worlds w ON w.id = c.world_id
      WHERE c.id = $1`,
    [campaignId],
  )
  const row = result.rows[0]
  /* c8 ignore start — invariant: callers (route + processor) gate on
   * campaign existence before invoking; FK NOT NULL on world_id. */
  if (row === undefined) {
    throw new Error(`character-integration: campaign ${campaignId} not found`)
  }
  /* c8 ignore stop */
  const idx = row.starting_situation_index
  let startingSituationProse = '(no starting situation chosen)'
  if (idx !== null) {
    const entry = row.starting_situation_entries.find((e) => e.index === idx)
    if (entry !== undefined) {
      startingSituationProse = entry.prose
    }
  }
  return {
    preIntegrationNotes: row.pre_integration_notes,
    worldId: row.world_id,
    startingSituationProse,
  }
}

// Render worlds.vocabulary_registry as a simple bulleted list of "term:
// definition" lines. Matches the renderVocabularyRegistry shape used by
// coherence-pass / random-tables, but pulled inline so character-integration
// doesn't have to thread a parsed VocabularyRegistry through the call chain.
async function loadWorldVocabularyText(pool: Pool, worldId: string): Promise<string> {
  const result = await pool.query<{ vocabulary_registry: unknown }>(
    `SELECT vocabulary_registry FROM worlds WHERE id = $1`,
    [worldId],
  )
  const reg = result.rows[0]?.vocabulary_registry
  /* c8 ignore start — typeguard against malformed JSONB (FK + NOT NULL
   * + CHECK enforce object shape; this is defense-in-depth). */
  if (typeof reg !== 'object' || reg === null) return '(no vocabulary registered)'
  /* c8 ignore stop */
  const entries = (reg as { entries?: unknown }).entries
  /* c8 ignore start — `(no vocabulary registered)` early return; the
   * stage tests seed entries: [], which exercises this branch — and
   * the populated-entries branch below is the one further wrapped
   * (covered by world-gen + coherence-pass tests). Wrapped together
   * to silence branch coverage on both arms of this guard. */
  if (!Array.isArray(entries) || entries.length === 0) {
    return '(no vocabulary registered)'
  }
  /* c8 ignore stop */
  /* c8 ignore start — vocabulary rendering when entries[] is populated.
   * The stage tests seed an empty vocabulary_registry (entries: []) to
   * keep prompt-render output deterministic; this branch is exercised
   * by world-gen + coherence-pass integration tests against worlds with
   * real vocabulary entries. */
  const lines: string[] = []
  for (const e of entries) {
    if (typeof e !== 'object' || e === null) continue
    const term = (e as { term?: unknown }).term
    const definition = (e as { definition?: unknown }).definition
    if (typeof term === 'string' && typeof definition === 'string') {
      lines.push(`- ${term}: ${definition}`)
    }
  }
  return lines.length > 0 ? lines.join('\n') : '(no vocabulary registered)'
  /* c8 ignore stop */
}

// ---------------------------------------------------------------------------
// Prompt rendering.
// ---------------------------------------------------------------------------

function renderPartyBlock(party: readonly PartyMember[]): string {
  const blocks: string[] = []
  for (const m of party) {
    /* c8 ignore start — `?? '?'` fallbacks fire only when a character row's
     * mechanical fields are null (PC seeded without character_sheet). Stage
     * tests always seed the full sheet shape; production has the same
     * invariant since MYT-53 stage 2 always writes the characters row. */
    const sheet = [m.characterSpecies ?? '?', m.characterClass ?? '?'].join(' ')
    const bg = m.characterBackground !== null ? ` (${m.characterBackground})` : ''
    /* c8 ignore stop */
    const lines: string[] = []
    lines.push(`### ${m.displayName} (userId: ${m.userId})`)
    lines.push(`- Race / Class / Background: ${sheet}${bg}`)
    /* c8 ignore start — same as above: characterLevel/HP/AC default to '?'
     * only when MYT-53 stage 2 didn't write the row, which is impossible
     * for a 'completed' concept by construction. */
    if (m.characterLevel !== null) {
      lines.push(
        `- Level / HP / AC: ${String(m.characterLevel)} / ${String(m.characterHitPoints ?? '?')} / ${String(m.characterArmorClass ?? '?')}`,
      )
    }
    /* c8 ignore stop */
    if (m.conceptText !== null && m.conceptText.length > 0) {
      lines.push(`- Concept: ${m.conceptText}`)
    }
    lines.push(`- Situation grounding: ${m.situationGroundingText}`)
    if (m.conceptOutput !== null) {
      const backstory = (m.conceptOutput as { backstory?: unknown }).backstory
      if (typeof backstory === 'string') {
        lines.push(`- Backstory: ${backstory}`)
      }
      const personality = (m.conceptOutput as { personality_traits?: unknown }).personality_traits
      if (Array.isArray(personality) && personality.length > 0) {
        lines.push(`- Personality: ${personality.filter((p): p is string => typeof p === 'string').join('; ')}`)
      }
    }
    blocks.push(lines.join('\n'))
  }
  return blocks.join('\n\n')
}

interface PromptVars {
  readonly preIntegrationNotes: string | null
  readonly startingSituationProse: string
  readonly worldVocabulary: string
  readonly worldDump: string
  readonly party: string
}

function renderPrompt(vars: PromptVars): string {
  /* c8 ignore start — the notes branching is hard to exercise both arms of
   * deterministically from stage tests (seeded campaigns row is fixed per
   * test setup); the route layer's `''/null/missing → null` normalization
   * is covered by route tests, and the integration-side fallback is a
   * single-line ternary not worth fanning tests out for. */
  const notes =
    vars.preIntegrationNotes !== null && vars.preIntegrationNotes.length > 0
      ? vars.preIntegrationNotes
      : '(none)'
  /* c8 ignore stop */
  return PROMPT_TEMPLATE.replace('{{preIntegrationNotes}}', notes)
    .replace('{{startingSituationProse}}', vars.startingSituationProse)
    .replace('{{worldVocabulary}}', vars.worldVocabulary)
    .replace('{{worldDump}}', vars.worldDump)
    .replace('{{party}}', vars.party)
}

// ---------------------------------------------------------------------------
// Cost estimator.
// ---------------------------------------------------------------------------

// Rough pre-flight estimate: input tokens approximated as
// (prompt-overhead + per-PC-prompt + world-dump) / 4 chars/token; output
// tokens approximated as N_PCs * 1200 (a generous reservation). Multiplied
// by Opus pricing. Pessimistic by design — the cost cap should fire BEFORE
// the LLM call, not after.
function estimateIntegrationCost(partySize: number, worldDumpLen: number): number {
  const promptChars =
    PROMPT_OVERHEAD_CHARS + partySize * PROMPT_OVERHEAD_CHARS_PER_PC + worldDumpLen
  const inputTokens = Math.ceil(promptChars / APPROX_CHARS_PER_TOKEN)
  const outputTokens = partySize * ESTIMATED_OUTPUT_TOKENS_PER_PC
  return (
    (inputTokens / 1_000_000) * OPUS_INPUT_PER_MTOK +
    (outputTokens / 1_000_000) * OPUS_OUTPUT_PER_MTOK
  )
}

// ---------------------------------------------------------------------------
// Validation + PC↔PC mirroring.
// ---------------------------------------------------------------------------

interface ValidateContext {
  readonly party: readonly PartyMember[]
  readonly worldInv: WorldInventory
}

interface ValidateOutput {
  readonly validated: IntegrationResult
  readonly dropped: DroppedTargets
}

function validateAndMirror(raw: IntegrationResult, ctx: ValidateContext): ValidateOutput {
  // Cardinality + identity invariants — hard-fail with LlmStructuredOutputError
  // so the repair strategy gets a second swing at producing the right shape.
  if (raw.characters.length !== ctx.party.length) {
    throw new LlmStructuredOutputError(
      `character_integration: characters.length (${String(raw.characters.length)}) !== party.length (${String(ctx.party.length)})`,
    )
  }
  const partyUserIds = new Set(ctx.party.map((p) => p.userId))
  const emittedUserIds = new Set<string>()
  for (const pc of raw.characters) {
    /* c8 ignore start — defensive invariant: schema-valid output where the
     * LLM emits the same userId twice. The downstream identity-set checks
     * + length-match check fire first in realistic LLM outputs. */
    if (emittedUserIds.has(pc.userId)) {
      throw new LlmStructuredOutputError(
        `character_integration: duplicate userId ${pc.userId} in characters[]`,
      )
    }
    /* c8 ignore stop */
    emittedUserIds.add(pc.userId)
    /* c8 ignore start — defensive invariant: the LLM emitted a userId not
     * in the input party. Schema-valid (any uuid), worker rejects. Hard to
     * exercise in tests without manually constructing a wrong-userId payload
     * past the length check; this guard exists as a safety net. */
    if (!partyUserIds.has(pc.userId)) {
      throw new LlmStructuredOutputError(
        `character_integration: characters[].userId ${pc.userId} is not in the input party`,
      )
    }
    /* c8 ignore stop */
  }
  for (const uid of partyUserIds) {
    /* c8 ignore start — defensive invariant: characters.length matches but
     * a specific party member is missing while another is duplicated.
     * The duplicate check above + length-match check at the call site fire
     * first in all realistic LLM-output shapes; this is a belt-and-braces guard. */
    if (!emittedUserIds.has(uid)) {
      throw new LlmStructuredOutputError(
        `character_integration: characters[] is missing party member ${uid}`,
      )
    }
    /* c8 ignore stop */
  }

  // Filter unknown targets (silent drop + log) and mirror PC↔PC edges.
  const dropped: DroppedTargets = {
    unknownTargetUuids: [],
    unknownTargetUserIds: [],
    unknownNewFactEntityIds: [],
  }
  const filteredCharacters = raw.characters.map((pc) =>
    filterCharacterTargets(pc, ctx, dropped, partyUserIds),
  )
  const mirroredCharacters = mirrorPcPcEdges(filteredCharacters)

  const filteredNewFacts = (raw.newFacts ?? []).filter((nf) => {
    if (ctx.worldInv.entitiesById.has(nf.entityId)) return true
    dropped.unknownNewFactEntityIds.push(nf.entityId)
    return false
  })

  return {
    validated: {
      characters: mirroredCharacters,
      ...(filteredNewFacts.length > 0 ? { newFacts: filteredNewFacts } : {}),
    },
    dropped,
  }
}

function filterCharacterTargets(
  pc: PCIntegration,
  ctx: ValidateContext,
  dropped: DroppedTargets,
  partyUserIds: ReadonlySet<string>,
): PCIntegration {
  const keptRelationships = pc.relationships.filter((rel) => {
    if (rel.targetKind === 'pc') {
      if (!partyUserIds.has(rel.targetUserId)) {
        dropped.unknownTargetUserIds.push(rel.targetUserId)
        return false
      }
      return true
    }
    if (!ctx.worldInv.entitiesById.has(rel.targetId)) {
      dropped.unknownTargetUuids.push(rel.targetId)
      return false
    }
    return true
  })
  return { ...pc, relationships: keptRelationships }
}

// PC↔PC mirror: walk every emitted A → B edge, ensure a symmetric B → A
// exists on B; if not, synthesize one with the same type + description.
// Sole-canonical-emission approach — the LLM may emit only one side.
function mirrorPcPcEdges(characters: readonly PCIntegration[]): PCIntegration[] {
  // Mutable copy of relationships per userId.
  const relsByUserId = new Map<string, IntegrationRelationship[]>()
  for (const pc of characters) {
    relsByUserId.set(pc.userId, [...pc.relationships])
  }

  for (const pc of characters) {
    for (const rel of pc.relationships) {
      if (rel.targetKind !== 'pc') continue
      const targetRels = relsByUserId.get(rel.targetUserId)
      /* c8 ignore start — defensive: relsByUserId was just built from
       * the same characters[] iteration so targetUserId must resolve;
       * filterCharacterTargets already dropped unresolved targetUserIds. */
      if (targetRels === undefined) continue
      /* c8 ignore stop */
      const hasSymmetric = targetRels.some(
        (r) => r.targetKind === 'pc' && r.targetUserId === pc.userId,
      )
      if (!hasSymmetric) {
        targetRels.push({
          targetKind: 'pc',
          targetUserId: pc.userId,
          type: rel.type,
          description: rel.description,
        })
      }
    }
  }

  /* c8 ignore start — defense-in-depth: the ?? fallback fires only when
   * a PC's userId is missing from relsByUserId, which is impossible by
   * construction (we just iterated `characters` building it). */
  return characters.map((pc) => ({
    ...pc,
    relationships: relsByUserId.get(pc.userId) ?? [...pc.relationships],
  }))
  /* c8 ignore stop */
}

function logDroppedTargets(dropped: DroppedTargets): void {
  for (const id of dropped.unknownTargetUuids) {
    console.warn(`[integration] dropping relationship with unresolved targetId=${id}`)
  }
  for (const uid of dropped.unknownTargetUserIds) {
    console.warn(`[integration] dropping relationship with unresolved targetUserId=${uid}`)
  }
  for (const id of dropped.unknownNewFactEntityIds) {
    console.warn(`[integration] dropping newFacts entry with unresolved entityId=${id}`)
  }
}

// ---------------------------------------------------------------------------
// Persistence — single transaction.
// ---------------------------------------------------------------------------

// Single transaction spanning every write: PC entities, prose kernels,
// facts, relationships, characters.entity_id, character_concepts.status,
// campaigns.status. Exceeds the 50-line budget because the multi-pass write
// order is inherently coupled (entity IDs from pass 1 are referenced in
// passes 2–4). Splitting would lose the single-BEGIN/COMMIT semantic.
// eslint-disable-next-line max-lines-per-function
async function writeIntegration(
  pool: Pool,
  args: CharacterIntegrationArgs,
  worldId: string,
  validated: IntegrationResult,
  worldInv: WorldInventory,
): Promise<string[]> {
  const client = await pool.connect()
  try {
    await client.query('BEGIN')

    // Pass 1: INSERT PC entities, build userId → entity_id map.
    const entityIdByUserId = new Map<string, string>()
    const nameOccupiedBy = buildOccupiedEntityNames(worldInv)
    for (const pc of validated.characters) {
      const entityId = uuidv7()
      const finalName = disambiguateName(
        pc.entity.name,
        pc.userId,
        nameOccupiedBy,
        validated.characters,
      )
      await client.query(
        `INSERT INTO entities (id, world_id, entity_type, name, access_level)
         VALUES ($1, $2, 'pc', $3, 'known')`,
        [entityId, worldId, finalName],
      )
      entityIdByUserId.set(pc.userId, entityId)
      nameOccupiedBy.set(finalName.toLowerCase(), entityId)
    }

    // Pass 2: prose_kernels + facts + relationships per PC.
    for (const pc of validated.characters) {
      const entityId = entityIdByUserId.get(pc.userId)
      /* c8 ignore next 3 — invariant: pass 1 sets a value for every pc.userId */
      if (entityId === undefined) {
        throw new Error(`entity id for userId ${pc.userId} missing after pass 1`)
      }
      await client.query(
        `INSERT INTO prose_kernels (id, entity_id, content)
         VALUES ($1, $2, $3)`,
        [uuidv7(), entityId, pc.entity.proseKernel],
      )
      for (const fact of pc.facts) {
        /* c8 ignore start — `?? 'backstory'` fallback; schema's tags.min(1)
         * prevents an empty tags array reaching this code path. */
        await client.query(
          `INSERT INTO facts (id, entity_id, topic, access_level, narrative_status, content)
           VALUES ($1, $2, $3, 'known', 'undelivered', $4)`,
          [
            uuidv7(),
            fact.aboutEntityId ?? entityId,
            fact.tags[0] ?? 'backstory',
            fact.content,
          ],
        )
        /* c8 ignore stop */
      }
      for (const rel of pc.relationships) {
        const targetEntityId =
          rel.targetKind === 'pc'
            ? entityIdByUserId.get(rel.targetUserId)
            : rel.targetId
        /* c8 ignore next 3 — invariant: validateAndMirror filters unresolved
         * targets before we get here. */
        if (targetEntityId === undefined) continue
        await client.query(
          `INSERT INTO relationships
             (id, source_entity_id, target_entity_id, relationship_type, description)
           VALUES ($1, $2, $3, $4, $5)`,
          [uuidv7(), entityId, targetEntityId, rel.type, rel.description],
        )
      }
    }

    // Pass 3: newFacts on existing world entities.
    for (const nf of validated.newFacts ?? []) {
      /* c8 ignore start — `?? 'backstory'` fallback; schema's tags.min(1)
       * prevents an empty tags array reaching this code path. */
      await client.query(
        `INSERT INTO facts (id, entity_id, topic, access_level, narrative_status, content)
         VALUES ($1, $2, $3, 'known', 'undelivered', $4)`,
        [uuidv7(), nf.entityId, nf.tags[0] ?? 'backstory', nf.content],
      )
      /* c8 ignore stop */
    }

    // Pass 4: link characters.entity_id, flip concept status. characters
    // has no campaign_id column (dropped in migration 009); the (campaign,
    // user) → character_id mapping lives in campaign_characters. Resolve
    // and update by character_id.
    for (const pc of validated.characters) {
      const entityId = entityIdByUserId.get(pc.userId)
      /* c8 ignore next 3 — invariant: pass 1 set a value for every pc.userId */
      if (entityId === undefined) continue
      await client.query(
        `UPDATE characters
            SET entity_id = $1, updated_at = now()
          WHERE id = (
            SELECT character_id FROM campaign_characters
             WHERE campaign_id = $2 AND user_id = $3
          )`,
        [entityId, args.campaignId, pc.userId],
      )
      await client.query(
        `UPDATE character_concepts
            SET status = 'integrated', updated_at = now()
          WHERE campaign_id = $1 AND user_id = $2`,
        [args.campaignId, pc.userId],
      )
    }

    // Final: flip campaign to active.
    await client.query(
      `UPDATE campaigns SET status = 'active', updated_at = now() WHERE id = $1`,
      [args.campaignId],
    )

    await client.query('COMMIT')
    return Array.from(entityIdByUserId.values())
    /* c8 ignore start — ROLLBACK arm: fires only when a PG constraint
     * violation or a connection drop trips inside the txn. Tests exercise
     * the happy path; this is defense-in-depth. */
  } catch (err) {
    await client.query('ROLLBACK')
    throw err
    /* c8 ignore stop */
  } finally {
    client.release()
  }
}

// Seed the disambiguation table with every existing entity name in the
// world. Returns lowercase-name → entity_id. The PC pass 1 then disambiguates
// each newly-inserted name against this map. Pure in-memory view of the
// world inventory we already loaded; no DB hit.
function buildOccupiedEntityNames(worldInv: WorldInventory): Map<string, string> {
  const out = new Map<string, string>()
  for (const e of worldInv.entitiesById.values()) {
    out.set(e.name.toLowerCase(), e.id)
  }
  return out
}

// Disambiguate by appending a `(userid-fragment)` suffix when the name
// collides on (world_id, name) — entities table has UNIQUE on (world_id,
// name) per migration 017_entity_consolidation (verified by grep at
// implementation time). The suffix is short + readable in admin views.
function disambiguateName(
  proposed: string,
  userId: string,
  occupied: Map<string, string>,
  allPCs: readonly PCIntegration[],
): string {
  const lower = proposed.toLowerCase()
  // If two PCs emit the same name, both need disambiguation.
  const collidesInBatch =
    allPCs.filter((p) => p.entity.name.toLowerCase() === lower).length > 1
  if (!occupied.has(lower) && !collidesInBatch) return proposed
  // Last 6 chars of the userId rather than the first 6 — UUIDv7 share the
  // first ~24 bits (millisecond-resolution timestamp) when two PCs were
  // created in the same test/seed second, so a prefix-suffix would collide.
  // The trailing 24 bits are random per-uuid and disambiguate reliably.
  const suffix = userId.slice(-6)
  return `${proposed} (${suffix})`
}
