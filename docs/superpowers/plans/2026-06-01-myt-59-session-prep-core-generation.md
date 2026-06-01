# Session Prep — Core Generation Stage (MYT-59) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the session-1 session-prep generation stage — a single Opus call that turns a campaign's omniscient world state into `{ft_context, sd_playbook}` — and the shared-layer plumbing it needs, with no persistence/routes/leak-guard (those are sibling issues).

**Architecture:** A pure async serializer (`serialize-world-state-for-prep.ts`) composes existing production reads (`repo.worldInventory.load` + `renderWorldDump`, the `worlds` row, the party via `repo.characters.listForCampaign`, the chosen `starting_situation_entries[index]`) into an omniscient markdown world-state. A generation stage (`stages/session-prep.ts`) feeds that into a ported prompt template and calls the production `streamObject` wrapper on OPUS, returning the validated two-doc object + usage. Two small shared-layer changes (`ai.ts`) unblock it: a `maxOutputTokens` budget and a `session_prep` stage label.

**Tech Stack:** TypeScript (strict), Vitest (real Postgres + mocked Vercel `ai` SDK), Zod, Vercel AI SDK (`streamObject`), Anthropic Opus.

**Spec:** `docs/superpowers/specs/2026-06-01-myt-59-session-prep-design.md` (blind-reviewed). Read it first.

---

## Before you start (confirm these against a sibling — do not guess)

These three are the only things this plan does NOT give verbatim, because they weren't verified at line level. Confirm each with a 30-second grep before the task that needs it:

1. **Prompt-template loader.** Grep how an existing streaming stage loads its `.txt`: `rg "prompts/prep|loadTemplate|readFileSync" backend/src/llm/prep/stages/locations-and-npcs.ts backend/src/llm/prep/*.ts`. Use the identical helper + `PROMPTS_DIR` for the new `session-prep.txt`. (Needed in Task 4.)
2. **The repo type name.** `rg "export (type|interface) (Repo|Repository)\b|export function createRepo" backend/src/repo/index.ts`. Use that exact type for the serializer/stage `repo` param. If only `createRepo` is exported, use `type Repo = Awaited<ReturnType<typeof createRepo>>` (or the sync `ReturnType` if `createRepo` isn't async). (Needed in Tasks 3–4.)
3. **The `ai.ts` test file.** `ls backend/src/llm/__tests__/`. If `ai.test.ts` exists, add to it; else create it using the `vi.mock('ai')` pattern from `backend/src/llm/prep/stages/__tests__/world-and-factions.test.ts:36-46`. (Needed in Task 1.)

Run everything from `backend/`. Work on `main` (project convention — no feature branch unless asked). Test DB must be up (`pnpm db:up`) and `DATABASE_URL` set for the real-DB serializer test.

---

## File Structure

- **Modify** `backend/src/llm/ai.ts` — add `maxOutputTokens?: number` to `StreamObjectOpts` (147-160) + `GenerateObjectOpts` (117-139); forward it in the `sdkStreamObject` call (609-624) and the `sdkGenerateText` call inside `generateObject` (527-542); add `'session_prep'` to `VALID_STAGES` (71-80); `export` `extractStage` (223).
- **Modify** `backend/src/llm/prep/streaming-extractor.ts` — add `'session_prep'` (and the already-missing `'entity_consolidation'`) so the canonical `WorldGenStage` union (28-38) and `VALID_STAGES` stay aligned.
- **Create** `backend/src/llm/prompts/prep/session-prep.txt` — ported prompt template.
- **Create** `backend/src/llm/prep/serialize-world-state-for-prep.ts` — async omniscient serializer.
- **Create** `backend/src/llm/prep/stages/session-prep.ts` — `generateSessionPrep` + `sessionPrepSchema`.
- **Tests:** `backend/src/llm/__tests__/ai.test.ts`, `backend/src/llm/prep/__tests__/serialize-world-state-for-prep.test.ts`, `backend/src/llm/prep/stages/__tests__/session-prep.test.ts`.
- **Modify** `docs/specs/2026-04-13-world-campaign-pipeline.md` + `docs/specs/2026-04-13-multiplayer-session-runtime.md` — circular-reference fix.

Task order: **1 → 2 → 3 → 4 → 5.** Task 4 depends on 1+2+3; Task 5 is independent.

---

## Task 1: Shared LLM layer — `maxOutputTokens` forwarding + `session_prep` stage label

**Files:**
- Modify: `backend/src/llm/ai.ts`, `backend/src/llm/prep/streaming-extractor.ts`
- Test: `backend/src/llm/__tests__/ai.test.ts`

- [ ] **Step 1: Write the failing test** (in `ai.test.ts`; use the `vi.mock('ai')` pattern — see "Before you start" #3)

```ts
import { describe, it, expect, vi } from 'vitest'
import { z } from 'zod'

vi.mock('ai', async () => {
  const actual = await vi.importActual<typeof import('ai')>('ai')
  return { ...actual, streamObject: vi.fn(), generateText: vi.fn(), Output: { object: vi.fn((o: unknown) => o) } }
})
import { streamObject as sdkStreamObject } from 'ai'
import { streamObject, extractStage } from '../ai.js'
import { OPUS } from '../models.js'

const schema = z.object({ a: z.string() })

describe('streamObject wrapper — maxOutputTokens', () => {
  it('forwards maxOutputTokens to the SDK', () => {
    vi.mocked(sdkStreamObject).mockReturnValue({
      object: Promise.resolve({ a: 'x' }),
      usage: Promise.resolve({ inputTokens: 1, outputTokens: 1, totalTokens: 2 }),
      partialObjectStream: (function* () { yield { a: 'x' } })(),
    } as never)
    streamObject({ model: OPUS, schema, prompt: 'p', callSite: 'test', maxOutputTokens: 16384 })
    expect(vi.mocked(sdkStreamObject).mock.calls[0]?.[0]).toMatchObject({ maxOutputTokens: 16384 })
  })
})

describe('extractStage', () => {
  it('accepts session_prep without falling back', () => {
    expect(extractStage({ mythrun: { stage: 'session_prep' } })).toBe('session_prep')
  })
})
```

- [ ] **Step 2: Run, verify it fails**

Run: `pnpm vitest run src/llm/__tests__/ai.test.ts -t "maxOutputTokens|session_prep"`
Expected: FAIL — `extractStage` not exported / `maxOutputTokens` not on the SDK call.

- [ ] **Step 3: Implement**

In `ai.ts`, add to **both** `StreamObjectOpts<T>` and `GenerateObjectOpts<T>`:
```ts
  /** Hard output-token ceiling. Required for session-prep (two large prose
   * docs); without it the SDK default truncates. */
  readonly maxOutputTokens?: number
```
In the `sdkStreamObject({...})` object (≈609) and the `sdkGenerateText({...})` object inside `generateObject` (≈527), add the optional-spread line (matching the existing idiom):
```ts
  ...(opts.maxOutputTokens !== undefined ? { maxOutputTokens: opts.maxOutputTokens } : {}),
```
Change `function extractStage(` (≈223) to `export function extractStage(`.
In `VALID_STAGES` (≈71), add `'session_prep'` and `'entity_consolidation'` (the latter is in the union but missing from the set):
```ts
const VALID_STAGES = new Set<WorldGenStage>([
  'concept_intake', 'vocabulary_intake', 'world_and_factions',
  'locations_and_npcs', 'entity_relationships', 'entity_consolidation',
  'starting_situation', 'random_tables', 'coherence_pass', 'session_prep',
])
```
In `streaming-extractor.ts`, add `| 'session_prep'` to the `WorldGenStage` union (≈28-38).

- [ ] **Step 4: Run, verify it passes**

Run: `pnpm vitest run src/llm/__tests__/ai.test.ts -t "maxOutputTokens|session_prep"` → PASS
Run: `pnpm typecheck && pnpm lint` → clean.

- [ ] **Step 5: Commit**

```bash
git add backend/src/llm/ai.ts backend/src/llm/prep/streaming-extractor.ts backend/src/llm/__tests__/ai.test.ts
git commit -m "feat(myt-59): maxOutputTokens forwarding + session_prep stage label"
```

---

## Task 2: Prompt template

**Files:**
- Create: `backend/src/llm/prompts/prep/session-prep.txt`
- Test: `backend/src/llm/prep/stages/__tests__/session-prep.test.ts` (template-content test; the stage test joins it in Task 4)

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { resolve, dirname } from 'node:path'

const TEMPLATE = readFileSync(
  resolve(dirname(fileURLToPath(import.meta.url)), '../../prompts/prep/session-prep.txt'),
  'utf8',
)

describe('session-prep template', () => {
  it('carries the placeholders and the hard-exclusion + party + session-N framing', () => {
    expect(TEMPLATE).toContain('{{world_state}}')
    expect(TEMPLATE).toContain('{{session_number}}')
    expect(TEMPLATE).toContain('ft_context')
    expect(TEMPLATE).toContain('sd_playbook')
    // fact AND entity level exclusions (the SHOWSTOPPER fix)
    expect(TEMPLATE.toLowerCase()).toContain('discoverable')
    expect(TEMPLATE.toLowerCase()).toContain('secret')
    expect(TEMPLATE.toLowerCase()).toMatch(/never name|do not name|must not appear/)
    // party
    expect(TEMPLATE.toLowerCase()).toContain('party')
    // length discipline
    expect(TEMPLATE.toLowerCase()).toMatch(/word|length|shorter/)
  })
})
```

- [ ] **Step 2: Run, verify it fails**

Run: `pnpm vitest run src/llm/prep/stages/__tests__/session-prep.test.ts -t "template"`
Expected: FAIL — file does not exist.

- [ ] **Step 3: Write the template** (`session-prep.txt`)

Port the prototype template (`Personal/mythrun-v5/backend/src/prep/prompts/session-prep.txt`) and adapt per the spec §4.3/§5. It MUST contain:
- A system framing: "You are the Slow Thinker preparing one session for a party. Produce two things — the **Fast-Thinker context** and the **Stage-Direction playbook**." The stage uses `streamObject` with a `{ft_context, sd_playbook}` schema, so the model fills those two FIELDS directly: the template must describe what each field contains and must NOT instruct an in-prose `===STAGE_DIRECTION_PLAYBOOK===` delineator (obsolete prototype-ism; the JSON schema does the separation).
- **FT Context** section spec: `## The World`, `## The Party` (per PC: sheet, personality, session-start known facts), `## Where You Are`, `## The Situation`, `## People You Know` / `## People You Don't Know (Yet)` (with depth markers), `## Factions`, `## Places of Interest` (clue markers), `## Encounters & Set Pieces` (no DCs), `## DM Guidance`.
- **Hard exclusions** (verbatim intent): "The FT Context may contain only `known`-tier content. NEVER include `discoverable` or `secret` facts (discoverable = clue content the players must earn in play). A `secret` entity must NOT appear in the FT Context at all — not named, not as a stub; it is playbook-only. A `discoverable` entity may appear only as a depth-marked stub without its discoverable/secret facts."
- **Depth-marker protocol** + **Three-Clue Rule** + NPC knowledge boundaries (port from prototype).
- **Playbook** section spec: `## Session Goals`, `## NPC Secrets & Revelation Conditions`, `## Revelation List (Three Clue Rule)`, `## NPC Knowledge Boundaries`, `## Encounter Notes`, `## Pacing Guidance`, `## Hooks & Threads`.
- **Length constraint:** "FT Context ~2,000–3,000 words; Stage-Direction Playbook ~1,000–2,000 words and always shorter than the FT Context."
- **Invention:** "You may invent NPCs/locations/encounters the session needs; they must not contradict existing world state."
- **Session-1 / Session-N conditional:** "For session 1 the situation comes from `## The Situation` below. For later sessions, weave in the prior-session summary and active threads if provided."
- The input block: `Session number: {{session_number}}` and `World state:\n{{world_state}}`.

- [ ] **Step 4: Run, verify it passes**

Run: `pnpm vitest run src/llm/prep/stages/__tests__/session-prep.test.ts -t "template"` → PASS

- [ ] **Step 5: Commit**

```bash
git add backend/src/llm/prompts/prep/session-prep.txt backend/src/llm/prep/stages/__tests__/session-prep.test.ts
git commit -m "feat(myt-59): session-prep prompt template"
```

---

## Task 3: Async world-state serializer

**Files:**
- Create: `backend/src/llm/prep/serialize-world-state-for-prep.ts`
- Test: `backend/src/llm/prep/__tests__/serialize-world-state-for-prep.test.ts`

This test uses an **in-memory stub repo** (no DB seeding) — it verifies composition logic (world_id hop, party assembly, known-fact filtering, chosen-situation index, forward-compat source binding). End-to-end DB coverage is the MYT-64 smoke.

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect, vi } from 'vitest'
import { serializeWorldStateForPrep } from '../serialize-world-state-for-prep.js'

function stubRepo() {
  return {
    campaigns: { getWorldAndSituationIndex: vi.fn(async () => ({ world_id: 'w1', starting_situation_index: 1 })) },
    worlds: {
      getById: vi.fn(async () => ({
        id: 'w1', name: 'Saltmere', tone: 'grim', era: 'age of tides', themes: 'debt, tides',
        keyTensions: 'the guild vs the drowned', worldOverview: 'A sinking port city.',
      })),
      getStartingSituationEntries: vi.fn(async () => [
        { index: 0, locationEntityId: 'l0', prose: 'WRONG situation' },
        { index: 1, locationEntityId: 'l1', prose: 'The tide-bell tolls at dusk.' },
      ]),
    },
    worldInventory: {
      load: vi.fn(async () => ({
        entitiesById: new Map([['e1', { id: 'e1', name: 'Voss', entityType: 'npc', accessLevel: 'known' }]]),
        proseByEntityId: new Map([['e1', 'Tavern-keeper.']]),
        factsById: new Map([['f1', { id: 'f1', entityId: 'e1', content: 'Voss was a quartermaster.', topic: 'past', accessLevel: 'secret' }]]),
        relationshipsById: new Map(),
      })),
    },
    characters: {
      listForCampaign: vi.fn(async () => [
        { id: 'c1', name: 'Kael', level: 3, class: 'rogue', entityId: 'pc1' },
        { id: 'c2', name: 'Mira', level: 3, class: 'cleric', entityId: 'pc2' },
      ]),
    },
    facts: {
      listByEntities: vi.fn(async (ids: readonly string[], opts: { accessLevels: readonly string[] }) => {
        expect(opts.accessLevels).toEqual(['known']) // serializer must filter to known for PC facts
        return [{ id: 'kf1', entityId: 'pc1', topic: 'goal', accessLevel: 'known', content: 'Kael owes the guild.' }]
      }),
    },
  } as never
}

describe('serializeWorldStateForPrep', () => {
  it('composes world concept, omniscient dump, party (known facts only), and the CHOSEN situation', async () => {
    const out = await serializeWorldStateForPrep(stubRepo(), { campaignId: 'camp1', sessionNumber: 1 })
    expect(out).toContain('Saltmere')
    expect(out).toContain('A sinking port city.')
    expect(out).toContain('Voss was a quartermaster.')      // omniscient input includes secret facts
    expect(out).toContain('Kael')
    expect(out).toContain('Kael owes the guild.')            // PC known fact
    expect(out).toContain('The tide-bell tolls at dusk.')    // chosen situation (index 1)
    expect(out).not.toContain('WRONG situation')             // not index 0
  })

  it('uses an injected world-state source when provided (session-N seam)', async () => {
    const repo = stubRepo()
    const customLoad = vi.fn(async () => ({
      entitiesById: new Map(), proseByEntityId: new Map(), factsById: new Map(), relationshipsById: new Map(),
    }))
    await serializeWorldStateForPrep(repo, { campaignId: 'camp1', sessionNumber: 2, loadInventory: customLoad as never })
    expect(customLoad).toHaveBeenCalledWith('w1')
    expect((repo as { worldInventory: { load: { mock: { calls: unknown[] } } } }).worldInventory.load.mock.calls).toHaveLength(0)
  })
})
```

- [ ] **Step 2: Run, verify it fails**

Run: `pnpm vitest run src/llm/prep/__tests__/serialize-world-state-for-prep.test.ts`
Expected: FAIL — module does not exist.

- [ ] **Step 3: Implement** (`serialize-world-state-for-prep.ts`)

Use the real `Repo` type (see "Before you start" #2). `WorldInventory` is imported from the repo namespace.

```ts
import type { WorldInventory } from '../../repo/world-inventory.js'
import { renderWorldDump } from './world-dump.js'
// import type { Repo } from '../../repo/index.js'  // confirm the exported name

export interface PriorSessionContext {
  readonly previousSummaries: readonly string[]
}

export interface SerializeArgs {
  readonly campaignId: string
  readonly sessionNumber: number
  /** Forward-compat seam (spec §8): defaults to live world inventory; session N binds a snapshot loader. */
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

  // Batch the PC known-facts read (one query, not N).
  const pcEntityIds = party.map((p) => p.entityId).filter((x): x is string => x !== null)
  const knownFacts = pcEntityIds.length > 0
    ? await repo.facts.listByEntities(pcEntityIds, { accessLevels: ['known'] })
    : []
  const factsByEntity = new Map<string, { topic: string; content: string }[]>()
  for (const f of knownFacts) {
    const arr = factsByEntity.get(f.entityId) ?? []
    arr.push({ topic: f.topic, content: f.content })
    factsByEntity.set(f.entityId, arr)
  }

  const lines: string[] = []

  lines.push('## World Concept')
  lines.push(`**Name:** ${world.name}`)
  if (world.tone) lines.push(`**Tone:** ${world.tone}`)
  if (world.era) lines.push(`**Era:** ${world.era}`)
  if (world.themes) lines.push(`**Themes:** ${world.themes}`)
  if (world.keyTensions) lines.push(`**Key Tensions:** ${world.keyTensions}`)
  if (world.worldOverview) { lines.push('', '## World Overview', world.worldOverview) }
  lines.push('')

  lines.push('## World State (omniscient — all access tiers; the [access_level] markers are authoritative)')
  lines.push(renderWorldDump(inv))
  lines.push('')

  lines.push('## The Party')
  for (const pc of party) {
    lines.push(`### ${pc.name} — level ${pc.level} ${pc.class}`)
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
    if (chosen) { lines.push('## The Situation', chosen.prose, '') }
  }

  if (args.priorSessionContext && args.priorSessionContext.previousSummaries.length > 0) {
    lines.push('## Prior Sessions')
    for (const s of args.priorSessionContext.previousSummaries) lines.push(`- ${s}`)
    lines.push('')
  }

  return lines.join('\n')
}
```

- [ ] **Step 4: Run, verify it passes**

Run: `pnpm vitest run src/llm/prep/__tests__/serialize-world-state-for-prep.test.ts` → PASS
Run: `pnpm typecheck && pnpm lint` → clean.

- [ ] **Step 5: Commit**

```bash
git add backend/src/llm/prep/serialize-world-state-for-prep.ts backend/src/llm/prep/__tests__/serialize-world-state-for-prep.test.ts
git commit -m "feat(myt-59): async omniscient world-state serializer for session prep"
```

---

## Task 4: Generation stage (`generateSessionPrep` + schema)

**Files:**
- Create: `backend/src/llm/prep/stages/session-prep.ts`
- Test: `backend/src/llm/prep/stages/__tests__/session-prep.test.ts` (add to the Task-2 file)

- [ ] **Step 1: Write the failing test** (append to the existing session-prep.test.ts)

```ts
import { vi } from 'vitest'

vi.mock('ai', async () => {
  const actual = await vi.importActual<typeof import('ai')>('ai')
  return { ...actual, streamObject: vi.fn(), generateText: vi.fn(), Output: { object: vi.fn((o: unknown) => o) } }
})
vi.mock('../../serialize-world-state-for-prep.js', () => ({
  serializeWorldStateForPrep: vi.fn(async () => 'SERIALIZED WORLD STATE'),
}))
import { streamObject as sdkStreamObject } from 'ai'
import { generateSessionPrep } from '../session-prep.js'
import { OPUS } from '../../../models.js'

function makeStream(tree: unknown) {
  return {
    partialObjectStream: (function* () { yield tree })(),
    object: Promise.resolve(tree),
    usage: Promise.resolve({ inputTokens: 5000, outputTokens: 9000, totalTokens: 14000 }),
  } as never
}

describe('generateSessionPrep', () => {
  it('returns the two docs + usage and calls streamObject with the right contract', async () => {
    vi.mocked(sdkStreamObject).mockReturnValueOnce(
      makeStream({ ft_context: 'FT DOC', sd_playbook: 'SD DOC' }),
    )
    const repo = {} as never
    const result = await generateSessionPrep(repo, { campaignId: 'camp1', worldId: 'w1', sessionNumber: 1 })
    expect(result.ft_context).toBe('FT DOC')
    expect(result.sd_playbook).toBe('SD DOC')
    expect(result.usage.outputTokens).toBe(9000)

    const call = vi.mocked(sdkStreamObject).mock.calls[0]?.[0] as Record<string, unknown>
    expect(call.model).toBe(OPUS)
    expect(call.maxOutputTokens as number).toBeGreaterThanOrEqual(16384)
    expect(call.prompt as string).toContain('SERIALIZED WORLD STATE')
    const po = call.providerOptions as { mythrun: { stage: string } }
    expect(po.mythrun.stage).toBe('session_prep')
  })
})
```

- [ ] **Step 2: Run, verify it fails**

Run: `pnpm vitest run src/llm/prep/stages/__tests__/session-prep.test.ts -t "generateSessionPrep"`
Expected: FAIL — `generateSessionPrep` not defined.

- [ ] **Step 3: Implement** (`stages/session-prep.ts`) — mirror `locations-and-npcs.ts:311` for the call shape and the template-load helper (see "Before you start" #1).

```ts
import { z } from 'zod'
import type { LanguageModelUsage } from 'ai'
import { streamObject } from '../../ai.js'
import { OPUS } from '../../models.js'
import { serializeWorldStateForPrep } from '../serialize-world-state-for-prep.js'
// import { loadPrompt, PROMPTS_DIR } from '...'  // use the SAME helper a sibling stage uses
// import type { Repo } from '../../../repo/index.js'  // confirm the exported name

export const sessionPrepSchema = z.object({
  ft_context: z.string().min(200),   // presence/length floor; NOT a completeness check (spec §9)
  sd_playbook: z.string().min(100),
})
export type SessionPrep = z.infer<typeof sessionPrepSchema>

// The two prose docs are the largest single output in the app; the prototype
// pinned 16384. Without this the SDK default truncates (spec §9 SHOWSTOPPER).
const MAX_OUTPUT_TOKENS = 16384
// Deliberately the largest LLM timeout in the codebase — a single Opus call
// emitting two long prose docs (spec §9). DEFAULT_LLM_TIMEOUT_MS is 8 min.
const SESSION_PREP_TIMEOUT_MS = 9 * 60 * 1000

export interface GenerateSessionPrepArgs {
  readonly campaignId: string
  readonly worldId: string
  readonly sessionNumber: number
}

export interface SessionPrepResult {
  readonly ft_context: string
  readonly sd_playbook: string
  readonly usage: LanguageModelUsage
}

export async function generateSessionPrep(repo: Repo, args: GenerateSessionPrepArgs): Promise<SessionPrepResult> {
  const worldState = await serializeWorldStateForPrep(repo, {
    campaignId: args.campaignId,
    sessionNumber: args.sessionNumber,
  })

  // Load + render session-prep.txt with the sibling-stage template helper.
  const prompt = loadPrompt('prep/session-prep', {
    world_state: worldState,
    session_number: String(args.sessionNumber),
  })

  const result = streamObject({
    model: OPUS,
    schema: sessionPrepSchema,
    prompt,
    temperature: 0.7,
    maxRetries: 0,                       // repair chain + BullMQ stage retry own recovery
    maxOutputTokens: MAX_OUTPUT_TOKENS,
    timeoutMs: SESSION_PREP_TIMEOUT_MS,
    repairStrategy: 'haiku-then-sonnet',
    callSite: 'session-prep',
    schemaName: 'SessionPrepSchema',
    providerOptions: { mythrun: { campaignId: args.campaignId, worldId: args.worldId, stage: 'session_prep' } },
  })

  const output = await result.object
  const usage = await result.usage
  return { ft_context: output.ft_context, sd_playbook: output.sd_playbook, usage }
}
```

Note for the implementer: this stage does NOT call `runStreamingStage` (array-keyed; spec §4.2). MYT-62 will consume `result.partialObjectStream` directly — out of scope here; this function returns the awaited final object.

- [ ] **Step 4: Run, verify it passes**

Run: `pnpm vitest run src/llm/prep/stages/__tests__/session-prep.test.ts` → PASS (both template + generateSessionPrep)
Run: `pnpm typecheck && pnpm lint` → clean.

- [ ] **Step 5: Commit**

```bash
git add backend/src/llm/prep/stages/session-prep.ts backend/src/llm/prep/stages/__tests__/session-prep.test.ts
git commit -m "feat(myt-59): session-prep generation stage (streamObject on Opus)"
```

---

## Task 5: Circular-reference fix in the two production specs (spec §11)

**Files:**
- Modify: `docs/specs/2026-04-13-world-campaign-pipeline.md`, `docs/specs/2026-04-13-multiplayer-session-runtime.md`

No code/test — a documentation correctness fix. (These are not wiki sources, so `wiki:check` is unaffected — but run it anyway to confirm.)

- [ ] **Step 1: World pipeline spec** — at §"Session Prep (Streaming) — Out of This Milestone" (≈line 635), change "owned by Session Runtime" to name the **Session Prep Pipeline milestone** as owner, and at the parked-route list (≈670-673) note the four routes are now owned by **MYT-63 (Session Prep Pipeline)**, not Session Runtime.

- [ ] **Step 2: Session Runtime spec** — at the dependency line (≈7) change "World & Campaign Pipeline (session prep generation)" to "Session Prep Pipeline milestone"; at the precondition (≈96) leave the behavior ("session prep exists for the next session number") but note the generator is the Session Prep Pipeline.

- [ ] **Step 3: Verify + commit**

Run: `git diff docs/specs/` (sanity), then `pnpm wiki:check` (expect green — confirms no wiki source declared these).
```bash
git add docs/specs/2026-04-13-world-campaign-pipeline.md docs/specs/2026-04-13-multiplayer-session-runtime.md
git commit -m "docs(myt-59): re-home session-prep ownership to the Session Prep Pipeline milestone"
```

---

## Final verification (after all tasks)

```bash
cd backend && pnpm typecheck && pnpm lint && pnpm vitest run src/llm
```
Expected: all green. (Full `pnpm test` + coverage is the pre-push gate.) The real-LLM end-to-end smoke is **MYT-64**, not this issue.
